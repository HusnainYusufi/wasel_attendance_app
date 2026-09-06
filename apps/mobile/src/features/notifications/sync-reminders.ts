import type { ShiftReminder } from '@wasel/contracts';
import {
  applyShiftReminders,
  cancelShiftReminders,
  checkReminderPermission,
  remindersSupported,
  requestReminderPermission,
  type ReminderPermission,
} from './local-notifications';
import { remindersEnabled } from './reminder-preference';
import { remindersApi } from './reminders-api';

/**
 * Why the device is (or is not) holding reminders right now.
 *
 * `blocked` and `disabled` are ordinary, expected outcomes rather than errors:
 * the first is somebody who said no to the Android permission, the second is
 * somebody who turned the feature off. Neither is worth a toast, and neither may
 * ever interfere with a punch.
 */
export type ReminderSyncState = 'unsupported' | 'disabled' | 'blocked' | 'synced' | 'failed';

export interface ReminderSyncResult {
  state: ReminderSyncState;
  permission: ReminderPermission;
  /** The plan the server returned, or empty when it was never asked. */
  reminders: ShiftReminder[];
  /** How many of them the device actually holds. */
  scheduled: number;
  /** The server's clock at the time of the plan — used to describe the wait honestly. */
  serverTime: string | null;
}

const nothing = (state: ReminderSyncState, permission: ReminderPermission): ReminderSyncResult => ({
  state,
  permission,
  reminders: [],
  scheduled: 0,
  serverTime: null,
});

export interface SyncOptions {
  /**
   * Show the Android permission dialog if it has not been answered yet.
   *
   * True in exactly one place — straight after a successful check-in — because
   * that is the only moment where the ask explains itself. Every other sync
   * (mount, resume, the settings toggle) reads the permission and lives with it.
   */
  requestPermission?: boolean;
  signal?: AbortSignal;
}

/**
 * Brings the device's scheduled notifications in line with the server's plan.
 *
 * Fetch first, apply second: a network failure therefore leaves whatever was
 * already scheduled standing, rather than stripping a user's reminders because
 * their train went into a tunnel. The apply step is a full replacement, so this
 * is safe to call as often as anything likes — on mount, on resume, after either
 * punch — and the instants never move, because the server's plan for a given
 * shift is deterministic.
 */
export async function syncShiftReminders(options: SyncOptions = {}): Promise<ReminderSyncResult> {
  if (!remindersSupported()) return nothing('unsupported', 'unavailable');

  if (!(await remindersEnabled())) {
    await cancelShiftReminders();
    return nothing('disabled', await checkReminderPermission());
  }

  let permission = await checkReminderPermission();
  if (permission === 'prompt' && options.requestPermission) {
    permission = await requestReminderPermission();
  }
  if (permission !== 'granted') {
    // A revoked permission leaves alarms that can never display. Clearing them
    // keeps `getPending()` honest for the next sync.
    await cancelShiftReminders();
    return nothing('blocked', permission);
  }

  try {
    const plan = await remindersApi.schedule(options.signal);
    const scheduled = await applyShiftReminders(plan.reminders);
    return {
      state: 'synced',
      permission,
      reminders: plan.reminders,
      scheduled,
      serverTime: plan.serverTime,
    };
  } catch {
    // Offline, cancelled, or a server that is having a bad minute. Reminders are
    // a convenience: say nothing, keep what is already scheduled, try again on
    // the next resume.
    return nothing('failed', permission);
  }
}

/** Tears every reminder down. Called the instant a check-out succeeds. */
export async function clearShiftReminders(): Promise<void> {
  await cancelShiftReminders();
}
