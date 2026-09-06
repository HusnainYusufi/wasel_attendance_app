import { Preferences } from '@capacitor/preferences';
import type { AuthTokens, AuthUser } from '@wasel/contracts';

const SESSION_KEY = 'wasel.session';

export interface StoredSession {
  tokens: AuthTokens;
  user: AuthUser;
}

/**
 * Token persistence.
 *
 * Capacitor Preferences is the primary store: on Android it is
 * `SharedPreferences`, which survives app updates and is not readable by other
 * apps. In a plain browser the plugin is unimplemented, so every call falls back
 * to `localStorage` — the same code path runs in both, which is what makes the
 * browser kitchen-sink and dev sessions faithful to the device build.
 *
 * A refresh token is bearer credential material. It is never logged, never put
 * in a URL, and never written anywhere but here.
 */

async function writeRaw(value: string): Promise<void> {
  try {
    await Preferences.set({ key: SESSION_KEY, value });
    return;
  } catch {
    // Plugin unavailable (browser) — fall through.
  }
  try {
    window.localStorage.setItem(SESSION_KEY, value);
  } catch {
    // Storage denied (private mode, locked-down WebView). The session still
    // works for this launch; it simply will not survive a restart.
  }
}

async function readRaw(): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key: SESSION_KEY });
    if (value !== null && value !== undefined) return value;
  } catch {
    // Plugin unavailable — fall through.
  }
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

async function removeRaw(): Promise<void> {
  try {
    await Preferences.remove({ key: SESSION_KEY });
  } catch {
    // Plugin unavailable — still clear the fallback below.
  }
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing further to do; the in-memory session is already cleared.
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { tokens?: unknown; user?: unknown };
  const tokens = candidate.tokens as Partial<AuthTokens> | undefined;
  const user = candidate.user as Partial<AuthUser> | undefined;
  return (
    typeof tokens?.accessToken === 'string' &&
    typeof tokens?.refreshToken === 'string' &&
    typeof user?.id === 'string' &&
    typeof user?.role === 'string'
  );
}

export async function loadSession(): Promise<StoredSession | null> {
  const raw = await readRaw();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // A shape change between app versions must log the user out cleanly, not
    // crash the launch path with an undefined property read.
    if (!isStoredSession(parsed)) {
      await removeRaw();
      return null;
    }
    return parsed;
  } catch {
    await removeRaw();
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await writeRaw(JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await removeRaw();
}
