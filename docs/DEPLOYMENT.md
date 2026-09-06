# Deployment

Two artefacts ship independently: the **API** (a container) and the **Android
APK** (built by GitHub Actions). The APK has the API's base URL compiled into it,
so deploy the API first and know its public URL before building a release APK.

---

## 1. API

### Environment

Every variable is validated at boot; the process **exits** rather than starting
in a half-configured state. Copy `.env.example` and fill it in.

Generate real secrets — never ship the placeholders:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
```

In production the API additionally refuses to boot if:

- either JWT secret is shorter than 32 characters or still matches the
  `.env.example` placeholder,
- `CORS_ORIGINS` is `*`.

`CORS_ORIGINS` must list the origins the app actually calls from. For a Capacitor
Android build that is:

```
CORS_ORIGINS=https://localhost,capacitor://localhost
```

Add your web origin too if you also serve the PWA (e.g.
`https://attendance.example.com`).

### Migrations

`prisma migrate deploy` applies committed migrations without ever generating or
resetting. Run it as a release step, before the new version starts serving:

```bash
pnpm --filter @wasel/api db:migrate:deploy
```

Never run `migrate dev` or `db push` against production — the first can author a
new migration from local drift, the second can drop columns to force the schema
to match.

### Seeding the first admin

The seed is idempotent and creates the organization plus one admin from
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`:

```bash
pnpm --filter @wasel/api db:seed
```

**Change that password immediately after the first sign-in.** The seeded
credentials are in your shell history and your `.env`.

### Health checks

Point your platform's probes at:

| Probe     | Path                   | Meaning                       |
| --------- | ---------------------- | ----------------------------- |
| liveness  | `/api/v1/health/live`  | process is up                 |
| readiness | `/api/v1/health/ready` | database reachable; can serve |

Use readiness for load-balancer membership so a node with a broken database
connection is pulled out instead of serving errors.

---

## 2. Android APK

### One-time: create a signing keystore

An Android app's identity **is** its signing key. If you lose this keystore you
cannot ship an update to an existing installation — users must uninstall and
reinstall, losing local state. Back it up somewhere durable and private.

```bash
keytool -genkeypair -v \
  -keystore wasel-release.jks \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -alias wasel
```

### One-time: configure the repository

**Settings → Secrets and variables → Actions**

Variables:

| Variable            | Example                              |
| ------------------- | ------------------------------------ |
| `VITE_API_BASE_URL` | `https://api.attendance.example.com` |

Secrets:

| Secret                      | How to produce it                       |
| --------------------------- | --------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | `base64 -i wasel-release.jks \| pbcopy` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password                   |
| `ANDROID_KEY_ALIAS`         | `wasel`                                 |
| `ANDROID_KEY_PASSWORD`      | the key password                        |

`VITE_API_BASE_URL` is **required** — the workflow fails fast without it rather
than producing an APK that points at `localhost` and fails on every device.

### Building

| Trigger         | Produces                                         |
| --------------- | ------------------------------------------------ |
| push to `main`  | debug APK artifact (installable for testing)     |
| manual run      | same, with an optional API URL override          |
| push a `v*` tag | signed release APK, attached to a GitHub Release |

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Download the APK from the run's **Artifacts** section, or from the Release page
for a tagged build.

If the signing secrets are absent the workflow still succeeds and produces the
debug APK, emitting a notice that the signed build was skipped. That is
deliberate: a contributor without access to the keystore should not see a red
build.

### Installing a debug APK on a device

Enable _Install unknown apps_ for your file manager or browser, then open the
APK. Over ADB:

```bash
adb install -r app-debug.apk
```

Debug and release APKs are signed by different keys and therefore **cannot be
installed over one another** — uninstall first when switching.

### Why `apps/mobile/android/` is not committed

It is generated from the web build plus `capacitor.config.ts` by `cap add
android`, and CI regenerates it on every run. Committing it would mean a
hand-edited native project drifting out of sync with the Capacitor config, which
is a slow and confusing class of bug. If you ever need a native change that
survives regeneration, express it in `capacitor.config.ts` or a Capacitor plugin.
