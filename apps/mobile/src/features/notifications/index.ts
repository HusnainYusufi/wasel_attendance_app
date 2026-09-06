/**
 * Check-out reminders.
 *
 * The server owns *when* somebody is nudged and *what* the nudge says; this
 * feature only raises what it is told to, cancels on check-out, and keeps the
 * device in step on every resume. Nothing outside this folder needs to know how
 * local notifications work.
 */
export { RemindersSetting, type RemindersSettingProps } from './RemindersSetting';
export { useShiftReminders, type ShiftReminders } from './useShiftReminders';
export { remindersEnabled, setRemindersEnabled } from './reminder-preference';
export { syncShiftReminders, clearShiftReminders, type ReminderSyncResult } from './sync-reminders';
export { remindersSupported, type ReminderPermission } from './local-notifications';
