import { SegmentedControl } from '../../design';
import { formatTime } from '../../lib/datetime';
import { useShiftReminders, type ShiftReminders } from './useShiftReminders';
import styles from './RemindersSetting.module.css';

type Choice = 'on' | 'off';

const CHOICES = [
  { value: 'on' as const, label: 'On' },
  { value: 'off' as const, label: 'Off' },
];

/** Where the plugin does not exist there is nothing to switch on. */
const UNAVAILABLE_CHOICES = CHOICES.map((choice) => ({ ...choice, disabled: true }));

export interface RemindersSettingProps {
  /** The organization timezone, so "next reminder at 17:46" means their 17:46. */
  timezone: string;
}

/**
 * The reminders switch, and an honest account of whether reminders can actually
 * arrive.
 *
 * A toggle on its own would be a lie on three devices out of ten: the Android
 * permission may never have been asked for, it may have been denied, or this may
 * be the browser build where local notifications do not exist at all. Each of
 * those is stated in plain words underneath, because "On" while the system is
 * silently dropping every notification is exactly the kind of quiet wrongness an
 * attendance app cannot afford.
 *
 * Self-contained by design — it owns its own state and its own sync — so it can
 * be dropped into the account sheet with one import and no wiring.
 */
export function RemindersSetting({ timezone }: RemindersSettingProps) {
  const reminders = useShiftReminders();

  const status = describeState(reminders);

  return (
    <section className={styles.section} aria-busy={reminders.loading}>
      <div className={styles.header}>
        <span className={styles.title}>Check-out reminders</span>
        {/* Nothing here when the user has switched reminders off: the control
            immediately below already says so, and an "OFF" pill beside it is
            the same word twice. */}
        {status ? <span className={`${styles.state} ${status.tone}`}>{status.label}</span> : null}
      </div>

      <SegmentedControl<Choice>
        label="Check-out reminders"
        fullWidth
        options={reminders.supported ? CHOICES : UNAVAILABLE_CHOICES}
        value={reminders.enabled ? 'on' : 'off'}
        onChange={(choice) => reminders.setEnabled(choice === 'on')}
      />

      <p className={styles.hint}>{describeHint(reminders, timezone)}</p>
    </section>
  );
}

/**
 * Whether a reminder could actually arrive — the one fact a switch cannot show.
 *
 * Null while reminders are switched off, because the switch is already saying it.
 */
function describeState(reminders: ShiftReminders): { label: string; tone: string } | null {
  if (!reminders.supported) return { label: 'App only', tone: styles.stateMuted ?? '' };
  if (!reminders.enabled) return null;
  if (reminders.permission === 'granted') return { label: 'Allowed', tone: styles.stateOk ?? '' };
  if (reminders.permission === 'denied') return { label: 'Blocked', tone: styles.stateWarn ?? '' };
  return { label: 'Not asked', tone: styles.stateWarn ?? '' };
}

/**
 * One sentence, and it must be true.
 *
 * The order matters: the reasons a reminder cannot arrive come before the
 * description of when it would. Telling somebody their next nudge is at 17:46
 * when the permission is denied is worse than saying nothing.
 */
function describeHint(reminders: ShiftReminders, timezone: string): string {
  if (!reminders.supported) {
    return 'Reminders are delivered by the Android app. This browser cannot show them.';
  }
  if (!reminders.enabled) {
    return 'You will not be reminded to check out. Your attendance is recorded either way.';
  }
  if (reminders.permission === 'denied') {
    return 'Notifications are blocked for this app. Allow them in Android Settings → Apps → Legend Attendance → Notifications.';
  }
  if (reminders.permission === 'prompt') {
    return 'Android will ask you to allow notifications the next time you check in.';
  }
  if (reminders.nextAt !== null) {
    const when = formatTime(reminders.nextAt, timezone);
    // The count is read from what the device actually holds rather than
    // asserted: a check-in late in the day leaves room for only one nudge, and
    // promising two would be a small, checkable lie.
    return reminders.scheduled > 1
      ? `${reminders.scheduled} reminders before your day ends, the next around ${when}. Times vary a little each day.`
      : `One reminder before your day ends, around ${when}. Times vary a little each day.`;
  }
  if (reminders.state === 'failed') {
    return 'Could not reach the server just now. Anything already scheduled still stands.';
  }
  return 'Nothing scheduled — you are not checked in. Reminders are set when you check in.';
}
