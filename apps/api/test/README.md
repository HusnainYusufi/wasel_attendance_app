# API test infrastructure

Two Vitest projects, one config (`apps/api/vitest.config.ts`).

| Project       | Files                   | I/O                                       |
| ------------- | ----------------------- | ----------------------------------------- |
| `unit`        | `src/**/*.spec.ts`      | none — pure logic, mocked collaborators   |
| `integration` | `test/**/*.int-spec.ts` | real PostgreSQL, real HTTP over supertest |

```bash
pnpm test          # unit only — fast, safe with no database
pnpm test:int      # integration only
pnpm test:all      # both (equivalently: pnpm exec vitest run)
pnpm test:cov      # both, with v8 coverage
```

## Writing a unit test

Colocate it with the code under test, per `docs/CONVENTIONS.md` §4:

```
src/modules/attendance/__tests__/attendance.service.spec.ts
```

Nothing in a unit test may touch the network, the filesystem or a database. Inject
`ClockService` (never call `new Date()`) and freeze it with `FixedClockService`
from `test/support`.

## Writing an integration test

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/index.js';

describe('sites', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close(); // always: it closes the server and the Prisma pool
  });
  beforeEach(async () => {
    await ctx.truncate();
  });

  it('creates a site', async () => {
    await ctx.http.post('/api/v1/sites').send({ name: 'HQ' }).expect(201);
  });
});
```

`createTestApp()` boots **the real application** — it calls the same
`configureApp()` that `src/main.ts` does, so your test exercises the global
prefix, the security headers, the CORS policy, the body-size limit, the throttler
and the exception filter. A hand-assembled `Test.createTestingModule(...)` agrees
with production only by luck; prefer this.

### What it gives you

| Field        | Purpose                                                         |
| ------------ | --------------------------------------------------------------- |
| `app`        | The `INestApplication`, for `app.get(...)` / `app.resolve(...)` |
| `http`       | supertest agent bound to the real HTTP server                   |
| `prisma`     | `PrismaService`, for arranging fixtures and asserting rows      |
| `logs`       | Everything the logger wrote — `logs.raw()`, `logs.records()`    |
| `truncate()` | Empties every table                                             |
| `close()`    | Shuts the app down cleanly                                      |

### Options

```ts
await createTestApp({
  // Extra modules mounted alongside AppModule (e.g. a probe controller).
  imports: [ProbeModule],

  // Environment applied only while the app is being built, then restored.
  // Configuration is resolved once at boot, so this is how you exercise a
  // different CORS allowlist, rate limit, log level or Swagger setting.
  env: { RATE_LIMIT_MAX: '3' },

  // Provider overrides — e.g. simulating a dead database.
  configure: (builder) =>
    builder.overrideProvider(PrismaService).useValue({
      ping: () => Promise.reject(new Error('down')),
      onModuleInit: () => Promise.resolve(),
      onModuleDestroy: () => Promise.resolve(),
    }),
});
```

### Asserting on logs

`logs` is a real pino destination, so assertions run against the bytes pino would
have written — including redaction. This is how "the password never reaches the
log" is proved rather than asserted:

```ts
await ctx.http.post('/api/v1/auth/login').send({ email, password: 'hunter2' });
expect(ctx.logs.raw()).not.toContain('hunter2');
```

Log level defaults to `info`. Raise it per test with `env: { LOG_LEVEL: 'debug' }`.

## The database

- **Which one.** `TEST_DATABASE_URL` — `postgresql://wasel:wasel_test_password@localhost:5434/wasel_attendance_test`
  from `docker compose` (`pnpm db:up`). The harness _overwrites_ `DATABASE_URL`
  with it rather than defaulting it, so a populated `.env` can never point the
  truncating suite at a development database.
- **Migrations.** `test/setup/global-setup.ts` runs `prisma migrate deploy` once
  per run — the same DDL production receives, so a broken or out-of-order
  migration fails here rather than on deploy.
- **Truncation.** `truncateAll()` discovers tables from `pg_tables` and empties
  them in a single `TRUNCATE ... RESTART IDENTITY CASCADE`, skipping
  `_prisma_migrations`. Discovering them beats a hand-maintained list, which stops
  truncating the day somebody adds a model and turns into cross-test
  contamination that reads as flakiness.
- **Serialisation.** `fileParallelism: false` is set run-wide: the integration
  project shares one database, and two files truncating concurrently would delete
  each other's fixtures. Each file still gets its own worker, so module state does
  not leak between files. Vitest applies pool settings run-wide rather than per
  project, so the unit project inherits this too.

## Running without a `.env` (CI)

`test/setup/test-env.ts` supplies test-only defaults for every variable except
`TEST_DATABASE_URL`, and never overrides a value the environment already provides.
A CI job therefore needs only:

```bash
export TEST_DATABASE_URL=postgresql://wasel:wasel_test_password@localhost:5434/wasel_attendance_test
pnpm --filter @wasel/api test:all
```

`TEST_DATABASE_URL` has no default on purpose: guessing a database to connect to
is how a test suite ends up truncating somebody's development data.

## Decorators and the transform

Vite transforms TypeScript with Oxc (previously esbuild), and neither implements
`emitDecoratorMetadata` — without it every NestJS constructor injection in the
suite fails to resolve. The config therefore sets `oxc: false` and hands the
transform to `unplugin-swc`. Do not remove either half.

## Conventions worth keeping

- Assert on **behaviour and `code`**, never on prose message text.
- Cover the happy path, each rejection branch, the authorisation boundary
  (a member cannot reach an admin route; tenant A cannot read tenant B), and the
  relevant edge case — midnight/timezone rollover for attendance, token reuse for
  auth, empty result sets for exports.
- Always `await ctx.close()` in `afterAll`. Skipping it leaks a connection pool
  per file and produces open-handle warnings at the end of the run.

## Authenticating in an integration test

`test/support/auth.ts` mints credentials the way production does — a real row, a
real argon2 digest produced by the application's own `PasswordService`, and a real
`POST /api/v1/auth/login`. Nothing forges a token, so a suite cannot pass against
a credential the guard would reject.

Mount `AuthModule` (it registers the global guards) and seed after `truncate()`:

```ts
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { createTestApp, createUser, createUserAndLogin } from '../support/index.js';

ctx = await createTestApp({ imports: [AuthModule] });

const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
await admin.get('/sites').expect(200); // → GET /api/v1/sites, bearer token attached
```

### `createUserAndLogin(ctx, options?) → AuthenticatedActor`

Creates an organization (unless `organizationId` is given), creates a user, logs
in, and returns everything a test needs.

| Field                             | Purpose                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `user`, `organization`            | The Prisma rows, for asserting on and for `organizationId` reuse |
| `password`                        | The plaintext, for a re-login or a change-password test          |
| `accessToken`, `refreshToken`     | Raw tokens, for header-shape and rotation tests                  |
| `tokens`, `authUser`              | Exactly what `POST /auth/login` returned                         |
| `get/post/put/patch/delete(path)` | Supertest builders with the bearer token already set             |
| `authorize(request)`              | Adds the bearer token to a request built some other way          |

Paths passed to the verb helpers are relative to the API prefix — `get('/sites')`
hits `/api/v1/sites`. An absolute `/api/v1/...` also works.

`options` (all optional): `organizationId`, `organization` (name, `timezone`,
workday policy), `email`, `password`, `fullName`, `employeeCode`, `role`,
`status`, `tokenVersion`, `deletedAt`, `failedLoginAttempts`, `lockedUntil`.

### The other helpers

- **`createUser(ctx, options?)`** — seeds without signing in. Use it for the
  fixtures a login must _reject_: `status: UserStatus.SUSPENDED`, `deletedAt: new
Date()`, an already-locked account.
- **`createOrganization(ctx, options?)`** — a second tenant, for the cross-tenant
  boundary test every module owes. Two actors in different organizations:

  ```ts
  const mine = await createUserAndLogin(ctx);
  const theirs = await createUserAndLogin(ctx); // its own organization
  await theirs.get(`/sites/${siteInMyOrg}`).expect(404);
  ```

- **`authorizedRequests(ctx, accessToken)`** — the same verb helpers for a token
  obtained another way, such as one returned by a manual refresh.
- **`TEST_PASSWORD`** — the default plaintext (`CorrectHorse7`), which satisfies
  the contract's password policy.

### Two things that will otherwise cost you an afternoon

- **The login endpoint is rate limited harder than the rest of the API**
  (`RATE_LIMIT_MAX / 10` per window, per IP — see `LoginThrottleGuard`). Every
  supertest request comes from the same address, so a suite that signs in more
  than a handful of users needs a bigger budget:

  ```ts
  ctx = await createTestApp({ imports: [AuthModule], env: { RATE_LIMIT_MAX: '100000' } });
  ```

  `createUserAndLogin` recognises the 429 and says so, rather than failing as a
  confusing "login returned 429".

- **Seed after `truncate()`, not before.** `beforeEach` empties every table, so a
  user created in `beforeAll` is gone by the first test.

### Attendance fixtures

`test/support/attendance.ts` seeds the geofencing side. It is imported directly
rather than re-exported from `support/index.js`, so two suites adding helpers at
the same time do not collide on one barrel file.

| Export                                 | Purpose                                                    |
| -------------------------------------- | ---------------------------------------------------------- |
| `HQ`                                   | The origin every geofence fixture is measured from         |
| `createSite(ctx, orgId, options?)`     | A site, including an inactive or soft-deleted one          |
| `pointAtDistance(origin, m, bearing?)` | A point exactly `m` metres away — for fence-boundary tests |
| `punchAt(point, accuracy?)`            | A punch body at `point`                                    |

`pointAtDistance` is the inverse of the contract's own `distanceInMeters`, on the
same sphere, so a test can say "half a metre outside a 150 m fence" instead of
guessing at decimal degrees — an offset in degrees is a different distance at
every latitude.

### Freezing time

Token lifetimes, the lockout window and session expiry all read `ClockService`,
so they are testable without sleeping:

```ts
const clock = new FixedClockService(new Date('2026-03-01T09:00:00.000Z'));
ctx = await createTestApp({
  imports: [AuthModule],
  configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
});

const actor = await createUserAndLogin(ctx);
clock.advanceMs(16 * 60_000);
await actor.get('/auth/me').expect(401); // TOKEN_EXPIRED
```
