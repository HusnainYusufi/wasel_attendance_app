import { useCallback, useEffect, useRef, useState } from 'react';
import { remindersSupported, type ReminderPermission } from './local-notifications';
import { remindersEnabled, setRemindersEnabled } from './reminder-preference';
import { clearShiftReminders, syncShiftReminders, type ReminderSyncState } from './sync-reminders';

export interface ShiftRemindersState {
  /** False in the browser, where local notifications do not exist. */
  supported: boolean;
  enabled: boolean;
  permission: ReminderPermission;
  state: ReminderSyncState;
  /** How many reminders the device is currently holding. */
  scheduled: number;
  /** The next one's instant, ISO, or null. */
  nextAt: string | null;
  /** The server's clock when the plan was fetched — for describing the wait. */
  serverTime: string | null;
  /** Still resolving the first read; the affordance shows nothing definite yet. */
  loading: boolean;
}

export interface ShiftReminders extends ShiftRemindersState {
  setEnabled: (next: boolean) => void;
  /** Ask for permission (once, in context) and schedule. Never awaited by a punch. */
  afterCheckIn: () => void;
  /** Cancel everything, immediately and offline. */
  afterCheckOut: () => void;
  refresh: () => void;
}

const INITIAL: ShiftRemindersState = {
  supported: remindersSupported(),
  enabled: true,
  permission: 'unavailable',
  state: 'unsupported',
  scheduled: 0,
  nextAt: null,
  serverTime: null,
  loading: true,
};

/**
 * Keeps this device's check-out reminders in step with the server's plan.
 *
 * Three triggers, and they exist for three different failure modes:
 *
 * - **On mount**, because a schedule fetched days ago is stale and the app may
 *   have been reinstalled or its notifications cleared since.
 * - **On resume**, because a device that was switched off missed the alarms it
 *   was holding, and because the shift may have been closed on another device.
 *   Capacitor's App plugin is not a dependency of this project, so the portable
 *   signal is `visibilitychange` — which the Android WebView raises when the
 *   activity comes back to the foreground, and the browser raises on tab focus.
 * - **After a punch**, because that is the moment the plan actually changes.
 *
 * Every path is fire-and-forget. Nothing here is ever awaited by a check-in: a
 * permission dialog the user ignores, or a reminders endpoint that is down, must
 * not delay or fail the punch that has already been recorded.
 */
export function useShiftReminders(): ShiftReminders {
  const [state, setState] = useState<ShiftRemindersState>(INITIAL);
  // A latch, not a loading flag: a resume that lands while a sync is in flight
  // would otherwise cancel and re-schedule the same alarms twice over.
  const running = useRef(false);
  // Set when a *permission-asking* sync arrives while one is already running.
  // A second plain sync can simply be dropped — it would compute the same plan —
  // but a check-in's ask must not be, or the one moment where the dialog makes
  // sense would be lost to a resume that happened to land a beat earlier.
  const queuedAsk = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const execute = useCallback(async (requestPermission: boolean) => {
    const enabled = await remindersEnabled();
    const result = await syncShiftReminders({ requestPermission });
    if (!mounted.current) return;
    setState({
      supported: remindersSupported(),
      enabled,
      permission: result.permission,
      state: result.state,
      scheduled: result.scheduled,
      nextAt: result.reminders[0]?.at ?? null,
      serverTime: result.serverTime,
      loading: false,
    });
  }, []);

  const run = useCallback(
    async (requestPermission: boolean) => {
      if (running.current) {
        if (requestPermission) queuedAsk.current = true;
        return;
      }
      running.current = true;
      try {
        let ask = requestPermission;
        // Drains the queue in the same pass rather than through a second entry
        // point, so there is exactly one place a sync can be in flight.
        for (;;) {
          await execute(ask);
          if (!queuedAsk.current) break;
          queuedAsk.current = false;
          ask = true;
        }
      } finally {
        running.current = false;
      }
    },
    [execute],
  );

  useEffect(() => {
    void run(false);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void run(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [run]);

  const setEnabled = useCallback(
    (next: boolean) => {
      // Optimistic: the switch answers the tap immediately, and the sync that
      // follows corrects `permission` and `scheduled` a moment later.
      setState((current) => ({ ...current, enabled: next }));
      // `next` doubles as the request-permission flag, deliberately. Switching
      // reminders *on* is the second moment where asking explains itself — the
      // user has just asked for notifications — and switching them off must
      // never raise a dialog about a feature that is being turned away.
      void setRemindersEnabled(next).then(() => run(next));
    },
    [run],
  );

  const afterCheckIn = useCallback(() => {
    void run(true);
  }, [run]);

  const afterCheckOut = useCallback(() => {
    // Cancelled locally rather than by re-fetching an empty plan: it is instant,
    // it works with no signal, and the shift is definitively over.
    void clearShiftReminders().then(() =>
      setState((current) => ({ ...current, scheduled: 0, nextAt: null })),
    );
  }, []);

  const refresh = useCallback(() => {
    void run(false);
  }, [run]);

  return { ...state, setEnabled, afterCheckIn, afterCheckOut, refresh };
}
