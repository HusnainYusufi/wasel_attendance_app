# Wasel Attendance — engineering conventions

**Every contributor (human or agent) must follow this document.** It defines the
seams between modules so that independently-written code composes without
rework. Where this document and your instinct disagree, this document wins; if
it is genuinely wrong, say so rather than silently diverging.

---

## 1. Repository layout

```
apps/api            NestJS + Prisma + PostgreSQL
apps/mobile         React + Vite + Capacitor (Android APK via CI)
packages/contracts  @wasel/contracts — Zod schemas + inferred types (SHARED)
docs/               architecture & conventions
```

`@wasel/contracts` is the **single source of truth** for every request and
response shape. Never redeclare a DTO locally. If a shape is missing, add it to
the contracts package — do not invent a parallel type.

---

## 2. Non-negotiable invariants

These exist because violating any one of them produces a _silent_ correctness
bug — the worst kind in an attendance system, because the data still looks
plausible.

1. **Tenancy.** Every query touching a tenant table filters on
   `organizationId`. Never trust an id from the request body to imply its
   tenant; always constrain by the authenticated user's `organizationId`. A bare
   `findUnique({ where: { id } })` on a tenant table is a bug.

2. **Time.** The server clock is authoritative. `deviceTime` from the client is
   recorded for tamper analysis and **never** used to compute `workDate` — a
   user could otherwise backdate attendance by changing their phone's clock.

3. **Work dates.** `workDate` is the local calendar date in the
   **organization's** IANA timezone. Compute it with Luxon
   (`DateTime.fromJSDate(now, { zone: org.timezone }).toISODate()`), never with
   `toISOString().slice(0, 10)`, which silently yields the UTC date and rolls
   over at the wrong moment for every non-UTC tenant.

4. **Concurrency.** Two simultaneous check-ins must not create two rows. Rely on
   the `@@unique([userId, workDate])` index and handle Prisma error `P2002` — do
   not "check then insert", which is a race.

5. **Audit.** Every punch attempt is persisted to `attendance_events`,
   **including rejections**. A rejected punch is the single most interesting row
   for an auditor. Never drop one.

6. **Secrets.** Never log a password, password hash, access token, refresh token
   or `Authorization` header. The logger has a redaction list; extend it rather
   than working around it.

---

## 3. API kernel (owned by `src/common`, `src/config`, `src/prisma`)

Modules consume these. Do not reimplement them.

### Errors

```ts
// src/common/errors/app.exception.ts
import { ErrorCode } from '@wasel/contracts';

export class AppException extends HttpException {
  constructor(
    status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  );
}

// Named helpers — prefer these over constructing AppException directly.
export const Errors = {
  validation(details): AppException,          // 400 VALIDATION_FAILED
  invalidCredentials(): AppException,         // 401 INVALID_CREDENTIALS
  unauthenticated(code?, msg?): AppException, // 401
  forbidden(msg?): AppException,              // 403 FORBIDDEN
  notFound(entity): AppException,             // 404 NOT_FOUND
  conflict(code, msg): AppException,          // 409
  unprocessable(code, msg): AppException,     // 422
  rateLimited(): AppException,                // 429
};
```

Throw `AppException` (via `Errors.*`) for every expected failure. Never throw a
bare `Error` for a condition the client should understand, and never let a
Prisma error reach the client — the global filter maps unknown errors to a
generic `INTERNAL_ERROR` so schema details cannot leak.

All non-2xx responses use the `ApiErrorBody` envelope from `@wasel/contracts`.

### Validation

```ts
// src/common/pipes/zod-validation.pipe.ts
ZodBody(schema); // param decorator: validated request body
ZodQuery(schema); // param decorator: validated query string
ZodParam(schema); // param decorator: validated route param
```

Validation failures become `400 VALIDATION_FAILED` with a `details[]` array of
`{ path, message }`. Controllers receive already-parsed, fully-typed values.

### Prisma

```ts
// src/prisma/prisma.service.ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy
```

Prisma 7 requires a **driver adapter**: the client is constructed with
`new PrismaPg({ connectionString })` from `@prisma/adapter-pg`. There is no
`url` in `schema.prisma`; migration URLs come from `prisma.config.ts`.

### Clock

```ts
// src/common/clock/clock.service.ts
@Injectable()
export class ClockService {
  now(): Date;
}
```

**Never call `new Date()` directly in a service.** Inject `ClockService`. Tests
override it to freeze time; code that calls `new Date()` is untestable around
midnight boundaries, which is precisely where attendance bugs live.

### Auth surface (provided by the auth module, consumed by everything)

```ts
@Public()                        // opt a route out of authentication
@Roles(Role.ADMIN)               // require a role (implies authenticated)
@CurrentUser() user: AuthContext // injected authenticated principal

interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  tokenVersion: number;
}
```

`JwtAuthGuard` is registered **globally**; routes are authenticated by default
and must opt out with `@Public()`. Defaulting to open and opting in to
protection is how endpoints get shipped unguarded.

---

## 4. Module conventions

```
src/modules/<name>/
  <name>.module.ts
  <name>.controller.ts      thin: validate → delegate → map. No business logic.
  <name>.service.ts         all business logic; unit-testable
  <name>.mapper.ts          Prisma row → contract DTO
  __tests__/                unit tests, colocated
```

- Controllers never touch `PrismaService` directly.
- Services never return raw Prisma rows across a module boundary — map to the
  contract DTO. Raw rows leak `passwordHash`, and that is how it reaches a log.
- Dates crossing the API boundary are ISO 8601 strings, not `Date` objects.

---

## 5. Testing

- **Unit** (`vitest --project unit`): pure logic, mocked Prisma. Fast, no I/O.
- **Integration** (`vitest --project integration`): real PostgreSQL on
  `TEST_DATABASE_URL` (port **5434**), real HTTP via supertest, truncating
  between tests.

Every module ships tests for: the happy path, each rejection branch, the
authorisation boundary (member cannot reach admin routes; tenant A cannot read
tenant B), and the relevant edge case — midnight/timezone rollover for
attendance, token reuse for auth, empty result sets for exports.

Assert on **behaviour and `code`**, never on prose message text.

---

## 6. Style

- TypeScript `strict`, plus `noUncheckedIndexedAccess`. No `any`; use `unknown`
  and narrow. No non-null `!` assertions except immediately after an explicit
  guard.
- Comments explain **why**, not what. Do not narrate the obvious.
- No dead code, no commented-out blocks, no TODOs left behind.
- Prettier: 100 cols, single quotes, trailing commas.

---

## 7. Mobile

- React 19 + Vite + TypeScript. Routing via `react-router-dom`. Server state via
  TanStack Query. No component library — a small hand-built design system.
- **Design tokens only.** No hard-coded hex values or magic pixel numbers in
  components; consume CSS custom properties from the token layer.
- Must be flawless at 360×640 (small Android) through 430×932 (large phone), and
  must respect safe-area insets — Capacitor renders under the status bar.
- Every interactive element: visible focus ring, ≥44×44px hit target, an
  accessible name, and a disabled/loading state that cannot be double-submitted.
- All API access goes through the generated client; components never call
  `fetch` directly.
