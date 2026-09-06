# @wasel/mobile

React 19 + Vite + Capacitor 8 client for Wasel Attendance. Ships as an Android
APK via CI; runs in any modern browser for development and review.

This package is the **foundation**: design system, API transport, session
handling, routing shell. The feature screens are written on top of it and every
seam they need is listed below.

---

## Run it

```bash
pnpm --filter @wasel/mobile dev        # http://localhost:5173
pnpm --filter @wasel/mobile typecheck  # tsc --noEmit
pnpm --filter @wasel/mobile lint       # eslint, zero warnings tolerated
pnpm --filter @wasel/mobile build      # typecheck + vite build → dist/
```

Copy `.env.example` to `.env.local`. `VITE_API_BASE_URL` must include the
`/api/v1` prefix and, for any real device build, must be an absolute origin the
handset can reach — on a phone `localhost` is the phone.

For browser development you may instead set `VITE_API_BASE_URL=/api/v1` and let
the Vite dev server proxy `/api` to `VITE_DEV_API_PROXY_TARGET`, which sidesteps
CORS entirely.

### Kitchen sink

`/__kitchen-sink` renders every primitive in every state, with a theme switch
and live in-browser contrast measurements. It is registered only under
`import.meta.env.DEV`, and its dynamic import sits inside that branch, so the
whole screen is eliminated from a production bundle.

---

## Layout

```
src/
  design/           the design system — screens import from '@/design' only
    styles/         tokens.css · typography.css · reset.css · global.css
    components/     Button, Input, Select, Card, Sheet, Toast, Spinner,
                    Skeleton, EmptyState, Badge, SegmentedControl, Avatar,
                    ListItem
    layout/         AppShell (tab bar), Screen (page scaffold), Splash, Logo
    theme/          ThemeProvider + useTheme
    hooks/          useMediaQuery, usePrefersReducedMotion, useScrollLock,
                    useFocusTrap, useIsMounted
    icons/          hand-drawn 24px icon set, currentColor
  api/              transport + typed bindings to @wasel/contracts
  auth/             session context, persistence, route guards
  routes/           route table, layouts, screen placeholders
  dev/              kitchen sink (dev-only)
```

---

## Design tokens

**No component may contain a hex value, an rgb(), or a magic pixel number.**
Everything comes from `src/design/styles/tokens.css`, in two tiers:

- `--palette-*` — raw ramps (brand, neutral, success, warning, danger),
  generated in OKLCH at even perceptual steps. Never referenced by a component.
- `--color-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--font-*`,
  `--duration-*`, `--ease-*`, `--z-*`, `--safe-*` — the semantic layer that
  components consume.

### Theming

Tokens are declared once using CSS `light-dark()`, resolved against
`color-scheme`. `:root` declares `color-scheme: light dark`, so the OS
preference applies with no JavaScript in the loop. `ThemeProvider` narrows it by
setting `data-theme="light" | "dark"` on `<html>`; the `system` preference
removes the attribute entirely. A small inline script in `index.html` applies a
stored override before first paint, so a manual choice never flashes.

There is no duplicated dark-mode block and therefore nothing to drift.
Baseline for `light-dark()`: Chrome/Android WebView 123, Safari 17.5, Firefox 120.

### Contrast

Every text/background pairing in the semantic layer is verified. Measured live
in Chromium on `/__kitchen-sink`:

| Pair                                      | Light       | Dark          |
| ----------------------------------------- | ----------- | ------------- |
| `--color-text` on `--color-bg`            | 14.73:1     | 18.81:1       |
| `--color-text` on `--color-bg-elevated`   | 15.78:1     | 17.06:1       |
| `--color-text-muted` on elevated          | 7.38:1      | 8.49:1        |
| `--color-text-subtle` on elevated         | 5.11:1      | 5.63:1        |
| `--color-accent-text` on bg               | 6.36:1      | 11.12:1       |
| `--color-accent-fg` on `--color-accent`   | 5.04:1      | 8.03:1        |
| `--color-danger-fg` on `--color-danger`   | 5.21:1      | 7.59:1        |
| `--color-success-fg` on `--color-success` | 5.09:1      | 7.66:1        |
| `--color-warning-fg` on `--color-warning` | 5.31:1      | 10.26:1       |
| soft `-fg` on each soft fill              | 6.88–8.77:1 | 10.72–11.46:1 |

`--color-border-strong` — the token that bounds a control — is held to the 3:1
non-text minimum (3.25:1 light, 3.58:1 dark). Disabled controls are exempt under
WCAG 1.4.3 and are deliberately below it.

### Typography

`--font-sans` is a system stack; no webfont, because a font that arrives on the
second paint is worse than one that was already there. Use the `u-*` utility
classes for body copy (`u-display`, `u-title-1..3`, `u-body`, `u-body-sm`,
`u-caption`, `u-overline`, `u-muted`, `u-subtle`, `u-truncate`,
`u-visually-hidden`).

**`u-tabular` is mandatory for the clock, durations, distances and any column of
figures.** Proportional digits change width as they tick, so `09:59 → 10:00`
visibly shifts the line and reads as a rendering glitch.

### Motion and safe areas

Decorative animation is collapsed to a single frame under
`prefers-reduced-motion` by the reset — behaviour is preserved, movement is not.
Use `usePrefersReducedMotion()` only for motion CSS cannot switch off (a rAF
loop, a scroll animation).

Capacitor renders under the status bar. Any surface anchored to a screen edge
must add the relevant `--safe-top` / `--safe-bottom` / `--safe-left` /
`--safe-right` inset. `Screen` and `AppShell` already do.

---

## Seams — what the screens agent builds against

### Layout

```tsx
import { Screen } from '@/design';

<Screen
  title="Today"                  // renders the page's single <h1>
  eyebrow?="Member"
  subtitle?={<>…</>}             // full width, below the title row
  action?={<IconButton …/>}      // trailing control in the title row
  onBack?={() => navigate(-1)}
>
  {children}                     {/* column, gap --space-5 */}
</Screen>
```

`AppShell` is already wired in `routes/RootLayout.tsx`; add or reorder tabs
there. Tabs come from `TabItem { to, label, icon, end? }`.

### Primitives

```tsx
<Button variant="primary|secondary|ghost|danger|success"
        size="sm|md|lg|xl" loading fullWidth iconStart iconEnd />
<IconButton label="…" icon={<Icon/>} size="sm|md|lg" variant="plain|outlined" />
<Input label hint error size="md|lg" iconStart revealToggle optionalText />
<Select label hint error>…<option/></Select>
<Card variant="elevated|outlined|plain|accent" padding="none|sm|md|lg" interactive />
<CardHeader title subtitle action />
<Sheet open onClose title description placement="bottom|center" footer dismissible />
<Badge tone="neutral|accent|success|warning|danger" variant="soft|solid|outline" size dot />
<SegmentedControl<T> label options={[{value,label,meta?,disabled?}]} value onChange fullWidth />
<Avatar name src size="xs|sm|md|lg|xl" />
<List inset><li><ListItem title description leading trailing chevron interactive /></li></List>
<Spinner size="sm|md|lg|xl" label? />
<Skeleton shape="text|rect|rounded|circle" width height />
<EmptyState icon title description action tone="neutral|danger" compact />
```

Guarantees every one of these already makes, so screens need not re-solve them:

- `:focus-visible` ring on every interactive element, never clipped.
- ≥44×44px hit target even where the drawn control is smaller (expanded with a
  pseudo-element, so visual density is unaffected).
- `Button loading` sets `disabled` **and** `aria-busy`, so a double tap during an
  in-flight mutation cannot submit twice.
- `Input` wires `aria-describedby` to whichever of hint/error is rendered, sets
  `aria-invalid`, announces errors with `role="alert"`, and uses a ≥16px font so
  iOS does not zoom the viewport on focus.
- `Sheet` traps focus, restores it on close, closes on `Escape`, locks
  background scroll (refcounted for stacked overlays) and animates out even
  under `prefers-reduced-motion`.
- `SegmentedControl` is a real `radiogroup` with roving tabindex and arrow-key
  navigation.

`buttonClassNames({ variant, size, fullWidth })` styles a react-router `<Link>`
as a button without giving the design system a router dependency.

### Toasts

```tsx
const toast = useToast();
toast.show({ title, description?, tone?: 'neutral'|'success'|'warning'|'danger',
             duration?: number /* 0 pins */, action?: { label, onClick } });
```

`danger` uses `role="alert"` and stays on screen longer; everything else is
polite. Three visible at once, oldest dropped.

### Theme

```tsx
const { preference, resolved, setPreference } = useTheme();
// preference: 'system' | 'light' | 'dark'   resolved: 'light' | 'dark'
```

### API

```tsx
import {
  authApi,
  attendanceApi,
  adminApi,
  queryKeys,
  isApiError,
  isErrorCode,
  isOffline,
  fieldErrors,
  toDisplayMessage,
} from '@/api';
```

Never call `fetch` from a component. Every binding takes an optional
`AbortSignal` so TanStack Query can cancel a superseded request.

**Branch on `error.code`, never on `error.message`.**

```tsx
if (isErrorCode(error, ErrorCode.OUT_OF_RANGE)) …
if (isErrorCode(error, ErrorCode.LOW_GPS_ACCURACY)) …
const errors = fieldErrors(error);        // { 'email': 'Enter a valid…' } for a 400
if (isOffline(error)) …                    // NetworkError | TimeoutError
```

Failure classes: `ApiError` (HTTP, carries `status`, `code`, `details`,
`requestId`), `NetworkError`, `TimeoutError`, `RequestCanceledError`. A
cancellation is not a failure — never surface it.

Query keys come from `queryKeys.*`; invalidating `queryKeys.attendance.all`
after a punch is enough to refresh both status and history.

Paths live in `src/api/endpoints.ts`. These are the canonical `/api/v1` routes:

|                                                                                                                   |     |
| ----------------------------------------------------------------------------------------------------------------- | --- |
| `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout`                                                   |     |
| `GET /auth/me` · `POST /auth/change-password`                                                                     |     |
| `GET /attendance/status` · `POST /attendance/check-in` · `POST /attendance/check-out` · `GET /attendance/history` |     |
| `GET /admin/overview` · `GET,POST /admin/users` · `PATCH /admin/users/:id` · `POST /admin/users/:id/password`     |     |
| `GET,POST /admin/sites` · `PATCH,DELETE /admin/sites/:id`                                                         |     |
| `GET,PATCH /admin/organization`                                                                                   |     |
| `GET /admin/reports/attendance` · `GET /admin/reports/export`                                                     |     |

If the API lands a different path, change it in `endpoints.ts` and nowhere else.

#### Token refresh

`ApiClient` refreshes the access token automatically on a 401 and retries the
original request once. The refresh is **single-flight**: concurrent 401s await
one shared promise, and a request whose 401 arrives _after_ another caller's
refresh already landed retries with the new token instead of triggering a second
rotation. Refresh tokens rotate server-side, so two parallel refreshes would
burn each other's token — the failure mode is the user being signed out exactly
as they tap CHECK IN.

When refresh genuinely fails (revoked, expired, reused) the client clears the
session and fires `onSignOut`, which `AuthProvider` turns into a clean global
sign-out: tokens erased, query cache cleared, guards redirect to `/sign-in`. A
_network_ failure during refresh is rethrown as-is rather than treated as a
sign-out, so being briefly offline does not evict a valid session.

### Auth

```tsx
const { status, user, isAdmin, signIn, signOut, updateUser } = useAuth();
// status: 'loading' | 'authenticated' | 'unauthenticated'
```

Tokens persist through `@capacitor/preferences`, falling back to `localStorage`
when the plugin is unavailable, so the same code runs on device and in the
browser. On launch the stored session is restored optimistically — the app is
usable immediately — and verified in the background with `GET /auth/me`; only a
403 (or a failed refresh) evicts it.

Guards: `RequireAuth`, `RequireAdmin`, `RequireGuest`. All three render
`<Splash />` while `status === 'loading'`, which is what stops an
already-authenticated user seeing the sign-in screen flash on every cold start.
`RequireAuth` carries the attempted location in router state so a deep link
resumes after sign-in.

### Routes

`src/routes/paths.ts` is the single source of URLs — navigate with `paths.*`,
never a string literal.

| Path            | File                                   | Guard          |
| --------------- | -------------------------------------- | -------------- |
| `/sign-in`      | `routes/screens/SignInScreen.tsx`      | `RequireGuest` |
| `/`             | `routes/screens/HomeScreen.tsx`        | `RequireAuth`  |
| `/history`      | `routes/screens/HistoryScreen.tsx`     | `RequireAuth`  |
| `/admin`        | `routes/screens/AdminScreen.tsx`       | `RequireAdmin` |
| `/admin/users`  | `routes/screens/AdminUsersScreen.tsx`  | `RequireAdmin` |
| `/admin/sites`  | `routes/screens/AdminSitesScreen.tsx`  | `RequireAdmin` |
| `/admin/export` | `routes/screens/AdminExportScreen.tsx` | `RequireAdmin` |
| `*`             | `routes/screens/NotFoundScreen.tsx`    | —              |

**Every one of these is a placeholder.** Replace the file body; keep the
filename and the default export and nothing else in the shell changes. Each
placeholder lists the data and design seams that screen should use.

---

## Capacitor

`capacitor.config.ts` sets appId `com.wasel.attendance`, appName
`Wasel Attendance`, webDir `dist`. Installed plugins: `android`, `geolocation`,
`preferences`, `status-bar`, `splash-screen`, `haptics`, `filesystem`, `share`.

`android/` is **not** committed and must not be generated here — this machine
has no Java or Android SDK. CI runs `npx cap add android` against this config.

```bash
pnpm --filter @wasel/mobile android:build   # vite build && cap sync android
```

`src/native.ts` runs the native shell setup before React mounts, guarded by
`Capacitor.isNativePlatform()` so the browser path is untouched.
