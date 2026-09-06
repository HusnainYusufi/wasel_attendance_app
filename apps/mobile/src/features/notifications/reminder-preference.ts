import { Preferences } from '@capacitor/preferences';

const ENABLED_KEY = 'wasel.reminders.enabled';

/**
 * Whether this device wants check-out reminders. On by default.
 *
 * Deliberately a *device* preference rather than an organization setting or a
 * column on the user. Two reasons. The thing being switched off is a buzz on
 * this handset, and this handset is where a person looks for that switch —
 * beside the notification permission it depends on. And a server-side flag would
 * be a schema change plus an admin control that, in practice, nobody would ever
 * tune: the honest default (on, two nudges) is the one almost every tenant wants,
 * and the minority who do not want them are individuals, not organizations.
 *
 * Same storage strategy as the session: Capacitor Preferences on device,
 * `localStorage` in the browser, and a failure to read is not a reason to stop —
 * it just means the default applies.
 */

async function readRaw(): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key: ENABLED_KEY });
    if (value !== null && value !== undefined) return value;
  } catch {
    // Plugin unavailable (browser) — fall through to the web fallback.
  }
  try {
    return window.localStorage.getItem(ENABLED_KEY);
  } catch {
    return null;
  }
}

async function writeRaw(value: string): Promise<void> {
  try {
    await Preferences.set({ key: ENABLED_KEY, value });
    return;
  } catch {
    // Plugin unavailable — fall through.
  }
  try {
    window.localStorage.setItem(ENABLED_KEY, value);
  } catch {
    // Storage denied. The choice holds for this launch and no longer; a
    // reminder preference is not worth failing a screen over.
  }
}

/** On unless the user has explicitly turned reminders off. */
export async function remindersEnabled(): Promise<boolean> {
  return (await readRaw()) !== 'false';
}

export async function setRemindersEnabled(enabled: boolean): Promise<void> {
  await writeRaw(enabled ? 'true' : 'false');
}
