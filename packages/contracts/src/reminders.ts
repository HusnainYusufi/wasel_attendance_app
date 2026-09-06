import { z } from 'zod';

/**
 * Check-out reminders: the nudges a device raises on its own, before the day ends.
 *
 * The whole point of this contract is that the *server* decides when a person is
 * nudged and what the nudge says, while the *device* merely raises it. Local
 * notifications are used rather than push because the answer is fully known the
 * moment someone checks in — they arrived at 09:12, the organization's day ends
 * at 18:00, so the nudges belong at known future instants. A device alarm needs
 * no signal, no token registry and no server credentials to deliver that; a push
 * pipeline would add all three to deliver something strictly less reliable.
 *
 * What the client is *not* allowed to do is invent the times. It schedules
 * exactly what {@link ReminderScheduleDto.reminders} contains, and cancels
 * everything on check-out.
 */

export const ReminderKind = {
  /** "Are you still there?" — somewhere in the middle stretch of the shift. */
  STILL_THERE: 'STILL_THERE',
  /** "Don't forget to check out" — shortly before the expected check-out. */
  CHECKOUT_SOON: 'CHECKOUT_SOON',
} as const;
export type ReminderKind = (typeof ReminderKind)[keyof typeof ReminderKind];

export const reminderKindSchema = z.enum([ReminderKind.STILL_THERE, ReminderKind.CHECKOUT_SOON]);

/**
 * One nudge, at one instant.
 *
 * `id` is stable for the life of the shift — it is derived from the attendance
 * record and the kind, never from a counter or a random draw — so a client that
 * re-fetches after a reload, a resume or a token refresh recognises the same
 * reminder rather than scheduling a second copy of it.
 *
 * `at` is an absolute UTC instant, not a wall-clock time. The device schedules
 * against it directly; rendering it for a human is the client's job, and it must
 * do that in the organization's timezone rather than the device's.
 */
export const shiftReminderSchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  kind: reminderKindSchema,
  /** Notification title. Server-owned copy, so it cannot drift per platform. */
  title: z.string().min(1),
  /** Notification body. Times inside it are already local to the organization. */
  body: z.string().min(1),
});
export type ShiftReminder = z.infer<typeof shiftReminderSchema>;

/**
 * The complete plan for the caller's currently open shift.
 *
 * `reminders` is empty — and that is a normal, successful answer — when there is
 * no open shift at all, when the shift has already been checked out of, and when
 * every planned instant has already passed. A client receiving an empty list
 * must cancel what it had scheduled, not leave it standing: an empty plan is the
 * server saying "nothing more is due", which is exactly the state after a
 * check-out.
 *
 * `serverTime` is carried so a client can describe the wait ("next reminder in
 * about four hours") without trusting the device clock, which on a phone with a
 * wrong time would otherwise make the affordance lie.
 */
export const reminderScheduleSchema = z.object({
  serverTime: z.string(),
  reminders: z.array(shiftReminderSchema),
});
export type ReminderScheduleDto = z.infer<typeof reminderScheduleSchema>;
