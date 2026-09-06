<div align="center">

# Wasel Attendance

**Geofenced attendance, built to be trusted.**

Employees check in and out with one tap. Admins export the sheet.
Everything else is machinery in service of those two sentences.

</div>

---

## What it is

A mobile attendance system in three parts:

| Package              | What it is                                                       |
| -------------------- | ---------------------------------------------------------------- |
| `apps/api`           | NestJS + Prisma + PostgreSQL. The system of record.              |
| `apps/mobile`        | React + Vite + Capacitor. Ships as an Android APK from CI.       |
| `packages/contracts` | Zod schemas shared by both. One source of truth for every shape. |

**Members** see one screen and one confident action: check in, or check out.
**Admins** get the same app with extra tabs — users, sites, and the export.

### The design idea

An attendance record is only worth as much as its credibility. So the parts that
protect credibility are not afterthoughts:

- **Location is verified server-side.** The device's coordinates are checked
  against the site geofence by the API, not the app. A patched client cannot
  talk its way in.
- **GPS accuracy is a first-class gate.** A fix reading "at the office ± 3 km" is
  compatible with being anywhere in the city, so it is rejected rather than
  quietly accepted.
- **The server clock is authoritative.** Device time is recorded for tamper
  analysis and never used to decide the work date — otherwise changing your
  phone's clock would rewrite your attendance.
- **Rejected attempts are stored, not dropped.** `attendance_events` is an
  append-only log of every punch attempt including failures, because "did anyone
  try to check in from home?" is the question an auditor actually asks.
- **The distance you see is the distance we enforce.** Client and server run the
  same haversine implementation from `@wasel/contracts`, so the app can never
  tell you you are 45 m away while the server disagrees.

---

## Quick start

Requires Node 22+, pnpm 9+, and Docker.

```bash
pnpm install
pnpm db:up          # PostgreSQL on :5432, plus a disposable test DB on :5434
cp .env.example .env
pnpm db:migrate
pnpm db:seed        # creates the organization and its first admin
```

Then, in two terminals:

```bash
pnpm dev:api        # http://localhost:3000/api/v1  ·  docs at /api/docs
pnpm dev:mobile     # http://localhost:5173
```

Sign in with the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from your `.env`, and
change that password immediately.

> The seeded site is a geofence around the coordinates in `prisma/seed.ts`. To
> check in from your own location, either edit the seed or move the site in
> **Admin → Sites** — the app will tell you exactly how far outside the fence you
> are.

---

## Commands

| Command                | What it does                          |
| ---------------------- | ------------------------------------- |
| `pnpm dev:api`         | API in watch mode                     |
| `pnpm dev:mobile`      | Mobile app in Vite dev server         |
| `pnpm build`           | Build every workspace                 |
| `pnpm test`            | Every test suite                      |
| `pnpm typecheck`       | Typecheck every workspace             |
| `pnpm lint`            | Lint every workspace                  |
| `pnpm format`          | Prettier, write                       |
| `pnpm db:up` / `:down` | Start / stop PostgreSQL               |
| `pnpm db:migrate`      | Create and apply a migration          |
| `pnpm db:seed`         | Seed the organization and first admin |
| `pnpm db:studio`       | Prisma Studio                         |

API tests are split: `test:unit` needs nothing, `test:int` runs against the real
PostgreSQL on port 5434 (`pnpm db:up` first). A real database is the point —
unique constraints, transactions and concurrent check-ins cannot be tested
against a mock.

---

## Architecture

```
                      ┌──────────────────────────┐
   Android APK  ───▶  │  apps/mobile             │
   (Capacitor)        │  React · Vite · TanStack │
                      └────────────┬─────────────┘
                                   │  HTTPS · Bearer + refresh rotation
                                   ▼
                      ┌──────────────────────────┐
                      │  apps/api                │
                      │  NestJS · Prisma         │
                      │  argon2id · RBAC · audit │
                      └────────────┬─────────────┘
                                   ▼
                      ┌──────────────────────────┐
                      │  PostgreSQL              │
                      └──────────────────────────┘

              packages/contracts — Zod schemas + geofence math
                    imported by BOTH sides, so a breaking
                    change fails the build on both at once
```

### Data model

`Organization` owns everything; every tenant row carries `organizationId` and
every query scopes on it, which makes cross-tenant access a structural
impossibility rather than a matter of discipline.

- **`AttendanceRecord`** — one row per user per work date. The unique index on
  `(userId, workDate)` is the concurrency guard: two simultaneous check-ins
  collide in the database, not in application logic.
- **`AttendanceEvent`** — append-only log of every attempt, accepted or rejected.
- **`Session`** — one row per refresh-token issuance, storing only a SHA-256
  hash. Rotation marks the old token used; presenting it again revokes the whole
  family, because a replayed refresh token means it was stolen.
- **`AuditLog`** — who did what, from where.

Work dates are local calendar dates in the **organization's** timezone, computed
with Luxon. `toISOString().slice(0,10)` would silently give the UTC date and roll
over at the wrong moment for every tenant that isn't on UTC.

### Night shifts: `dayStartsAt`

An organization's business day runs from `dayStartsAt` to `dayStartsAt`, not
midnight to midnight. The default `00:00` is exactly the calendar day, so a
9-to-5 office needs no thought.

A night shift does. For a 23:00–07:00 team, leave it at midnight and the shift
splits across two work dates: whoever clocks on at 02:00 is filed under the wrong
day, scored against a workday start that has not happened yet — so **three hours
late records as on time** — and is then locked out of the next night. Set
`dayStartsAt` to something in the evening (`20:00`, say) and the whole night is
one business day, with lateness measured from the 23:00 that actually preceded it.

It is deliberately not constrained against `workdayStart`/`workdayEnd`: the
boundary is about when the day rolls over, not when work begins.

---

## Shipping the APK

Push a tag and GitHub Actions builds it:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

`main` builds an installable debug APK on every push; a `v*` tag produces a
signed release APK attached to a GitHub Release. Set the `VITE_API_BASE_URL`
repository variable first — the workflow fails fast without it rather than
shipping an APK that points at `localhost`.

Full setup, including keystore generation: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## Documentation

- **[docs/CONVENTIONS.md](docs/CONVENTIONS.md)** — engineering contract: the
  invariants, the kernel seams, testing standards. Read before contributing.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — deploying the API and building
  signed APKs.
- **[apps/api/test/README.md](apps/api/test/README.md)** — the test harness.
- **[apps/mobile/README.md](apps/mobile/README.md)** — design system and app seams.
- **`/api/docs`** — live OpenAPI, generated from the same Zod schemas the API
  validates with, so it cannot drift from the implementation.
