import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { ShiftReminder } from '@wasel/contracts';

/**
 * The device half of check-out reminders: raise exactly what the server planned,
 * and nothing else.
 *
 * Every call here is guarded twice — by `isNativePlatform()`, because the plugin
 * has no browser implementation and would throw on the first line in the dev
 * kitchen sink, and by `try/catch`, because an OEM WebView refusing a call must
 * never take a screen down with it. Reminders are a convenience; the punch is
 * the product.
 */

/**
 * A reserved block of notification ids this feature owns.
 *
 * Android identifies a pending notification by a plain integer, so cancelling
 * "the reminders" means knowing which integers are ours. Owning a fixed block
 * beats remembering what was scheduled last time: nothing is persisted, nothing
 * can go stale, and a re-install or a cleared storage cannot strand an alarm
 * that no longer has anything behind it. Sixteen slots is far more than the plan
 * will ever hold, and leaves room to grow without renumbering.
 */
const REMINDER_ID_BASE = 9000;
const REMINDER_ID_SLOTS = 16;

/**
 * Android 8+ posts every notification through a channel. The plugin creates a
 * default one, but naming ours means the reminders appear in the system
 * notification settings as "Check-out reminders" — which is where somebody who
 * finds them annoying will go to silence them, and they should find a switch
 * that is about exactly this and nothing else.
 */
const CHANNEL_ID = 'checkout-reminders';

export type ReminderPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

/** False in a browser, where the plugin is unimplemented. Never throws. */
export function remindersSupported(): boolean {
  return Capacitor.isNativePlatform();
}

function toPermission(state: string): ReminderPermission {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'prompt';
}

export async function checkReminderPermission(): Promise<ReminderPermission> {
  if (!remindersSupported()) return 'unavailable';
  try {
    const status = await LocalNotifications.checkPermissions();
    return toPermission(status.display);
  } catch {
    return 'unavailable';
  }
}

/**
 * Asks for the notification permission — Android 13+ requires it at runtime.
 *
 * Called after a successful check-in, never at launch, so the system dialog
 * arrives with obvious context: the user has just told the app they are at work,
 * and the app is offering to remind them to leave. A denial is a final answer
 * for this call; it returns `denied` and nothing further happens.
 */
export async function requestReminderPermission(): Promise<ReminderPermission> {
  if (!remindersSupported()) return 'unavailable';
  try {
    const status = await LocalNotifications.requestPermissions();
    return toPermission(status.display);
  } catch {
    return 'unavailable';
  }
}

async function ensureChannel(): Promise<void> {
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Check-out reminders',
      description: 'Nudges to check out before your workday ends.',
      // 3 = DEFAULT: makes a sound and appears in the shade, but does not take
      // over the screen. A heads-up banner for "are you still there?" would be
      // out of proportion to what it asks.
      importance: 3,
      visibility: 1,
    });
  } catch {
    // Channel creation is Android-only and idempotent; a failure here at worst
    // means the notifications land on the plugin's default channel.
  }
}

/** Cancels every reminder this feature owns. Safe to call when none are scheduled. */
export async function cancelShiftReminders(): Promise<void> {
  if (!remindersSupported()) return;
  try {
    const pending = await LocalNotifications.getPending();
    const ours = pending.notifications.filter(
      (notification) =>
        notification.id >= REMINDER_ID_BASE &&
        notification.id < REMINDER_ID_BASE + REMINDER_ID_SLOTS,
    );
    if (ours.length === 0) return;
    await LocalNotifications.cancel({ notifications: ours.map(({ id }) => ({ id })) });
  } catch {
    // Nothing else to try. The worst case is a stale reminder firing once, which
    // the next successful sync clears.
  }
}

/**
 * Replaces the scheduled reminders with `reminders`, and returns how many stood.
 *
 * Cancel-then-schedule rather than diff-and-patch: the server's plan is a
 * complete statement of what should be pending, the instants for a given shift
 * never move, and re-applying an identical plan is therefore a no-op the user
 * cannot perceive. An empty list is a valid plan and means "cancel everything" —
 * which is exactly the state after a check-out.
 */
export async function applyShiftReminders(reminders: ShiftReminder[]): Promise<number> {
  if (!remindersSupported()) return 0;

  await cancelShiftReminders();

  const due = reminders
    .map((reminder) => ({ reminder, at: new Date(reminder.at) }))
    // A plan fetched before the device slept can contain instants that have
    // since passed. Android would fire those immediately, so a "don't forget to
    // check out" would arrive at 21:00 for a day that ended at 18:00.
    .filter(({ at }) => Number.isFinite(at.getTime()) && at.getTime() > Date.now())
    .slice(0, REMINDER_ID_SLOTS);

  if (due.length === 0) return 0;

  await ensureChannel();

  try {
    await LocalNotifications.schedule({
      notifications: due.map(({ reminder, at }, index) => ({
        id: REMINDER_ID_BASE + index,
        title: reminder.title,
        body: reminder.body,
        channelId: CHANNEL_ID,
        // The times are deliberately jittered by the server, so a minute either
        // way is meaningless — and asking for an exact alarm on Android 12+
        // throws the user into the system "Alarms & reminders" settings screen
        // in the middle of checking in. An inexact alarm needs no permission and
        // no interruption.
        isExactNotification: false,
        schedule: {
          at,
          // Doze can otherwise hold an inexact alarm until the device is next
          // used, which for a phone left on a desk is exactly the case where the
          // reminder matters most.
          allowWhileIdle: true,
        },
      })),
    });
    return due.length;
  } catch {
    // Permission revoked between the check and the call, or the platform
    // refused. Nothing is scheduled and nothing is broken.
    return 0;
  }
}
