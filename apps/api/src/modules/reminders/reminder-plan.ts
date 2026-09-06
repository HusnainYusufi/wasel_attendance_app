import { createHash } from 'node:crypto';
import { ReminderKind, type ShiftReminder } from '@wasel/contracts';
import { DateTime } from 'luxon';
import { workdayStartInstant } from '../attendance/work-date.js';

/**
 * When to nudge somebody who is still checked in — the whole rule, and nothing else.
 *
 * Pure: no NestJS, no Prisma, no `new Date()`. Every input that could move an
 * instant is an argument, which is what makes the two properties that matter
 * here testable at all.
 *
 * **The properties.**
 *
 * 1. _Determinism._ The same shift always yields the same instants. A client
 *    re-fetches this plan after a reload, a resume and every token refresh; if
 *    the answer wandered, the reminders would drift later on every fetch and the
 *    device would end up holding several copies of the same nudge. So the jitter
 *    is derived by hashing the attendance record id — a value that is fixed for
 *    the life of the shift — and never from `Math.random()` or from the clock.
 * 2. _Monotonicity in `now`._ Time passing may only ever *remove* reminders from
 *    the plan, never move one. That is what lets the client treat a re-fetch as
 *    "cancel everything and schedule what came back" without the schedule
 *    creeping forward each time it does so.
 *
 * **Why jitter at all.** A nudge that arrives at exactly 17:30 every single day
 * becomes furniture within a week, and furniture is ignored. Spreading each
 * reminder over a band makes it read as a prompt rather than a metronome. It is
 * deliberately *seeded* randomness: two employees on the same shift get
 * different times, the same employee gets a different time tomorrow (a new
 * record, a new id), and any one shift's times never change once decided.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Shortest gap allowed between two reminders.
 *
 * Below this the second nudge reads as a repeat of the first rather than as new
 * information, and two buzzes inside three quarters of an hour is how an
 * attendance app teaches people to swipe it away unread. When the shift is too
 * short to hold two reminders this far apart, the plan drops to one — see
 * {@link planShiftReminders}.
 */
export const MIN_REMINDER_SPACING_MS = 45 * MINUTE_MS;

/**
 * Shortest remaining window worth reminding anybody about.
 *
 * Somebody who checks in four minutes before their organization's day ends does
 * not need to be told the day is ending. There is no room to say anything they
 * could act on, so nothing is scheduled at all.
 */
export const MIN_REMINDER_WINDOW_MS = 5 * MINUTE_MS;

/** How far ahead of the expected check-out the "check out soon" band may sit. */
const CHECKOUT_LEAD_MAX_MS = 40 * MINUTE_MS;
/** …and how close to it. Under ten minutes the nudge arrives too late to be useful. */
const CHECKOUT_LEAD_MIN_MS = 10 * MINUTE_MS;

/**
 * The same band expressed as a share of the shift, for shifts short enough that
 * the absolute leads above would land before the check-in. `min()` of the two
 * keeps the band inside the shift at every length.
 */
const CHECKOUT_LEAD_MAX_FRACTION = 0.25;
const CHECKOUT_LEAD_MIN_FRACTION = 0.08;

/** The middle stretch, as a share of the shift, where "are you still there?" lands. */
const STILL_THERE_BAND_START = 0.3;
const STILL_THERE_BAND_END = 0.6;

/**
 * Nominal shift length used when the organization's own `workdayStart`→
 * `workdayEnd` pair cannot supply one.
 *
 * Reached when the two are equal, or when they are the wrong way round because a
 * night-shift tenant has left `dayStartsAt` at midnight — a misconfiguration
 * that must not take reminders down with it.
 */
const FALLBACK_SHIFT_MS = 8 * HOUR_MS;

/** A nominal day longer than this is a data error, not a policy. */
const MAX_NOMINAL_SHIFT_MS = 24 * HOUR_MS;

export interface ShiftReminderInput {
  /** The open attendance record. Its id is the jitter seed, so it must be stable. */
  attendanceRecordId: string;
  checkInAt: Date;
  /** The server clock. Only ever used to drop reminders that have already passed. */
  now: Date;
  /** The record's business date, as decided by `businessDateIn`. */
  workDate: string;
  timezone: string;
  /** Organization policy, local wall clock `HH:mm`. */
  workdayStart: string;
  workdayEnd: string;
  dayStartsAt: string;
}

/**
 * The instant a wall-clock time occurs *inside* the business day `workDate`.
 *
 * `workdayStartInstant` already answers exactly this question — it picks between
 * the occurrence on `workDate` and the one on the next calendar date by asking
 * `businessDateIn` which business day each would belong to — and it is only
 * named after `workdayStart` because that was its first caller. Reusing it for
 * `workdayEnd` is the point: an organization whose day rolls over at 20:00 and
 * ends its shift at 07:00 gets the 07:00 on the *following* calendar date, and
 * it gets it from the same code that decided the record's work date in the first
 * place. Re-deriving that here would be the second opinion about what a work
 * date is that this module exists to avoid.
 */
function wallClockInBusinessDay(
  input: Pick<ShiftReminderInput, 'workDate' | 'timezone' | 'dayStartsAt'>,
  hhmm: string,
): Date {
  return workdayStartInstant({
    workDate: input.workDate,
    timezone: input.timezone,
    workdayStart: hhmm,
    dayStartsAt: input.dayStartsAt,
  });
}

/**
 * When this shift is expected to end.
 *
 * Normally that is the organization's `workdayEnd` on the shift's business day.
 * The interesting case is the one where that instant has already gone by when
 * the person checks in — a late arrival, an evening shift, or a tenant whose day
 * boundary sits in the evening and whose staff genuinely start after the nominal
 * end. There is then no "before check-out" window in the ordinary sense.
 *
 * Refusing to schedule anything would be the easy answer and the wrong one: the
 * people most likely to forget to check out are precisely the ones working
 * outside the normal day. So the shift is treated as a nominal-length one
 * starting when they actually arrived, where "nominal length" is the
 * organization's own `workdayStart`→`workdayEnd` span rather than a hard-coded
 * eight hours — a tenant working 08:00–14:00 gets six hours, not eight.
 *
 * The result depends only on the check-in and on organization policy, never on
 * `now`, which is what keeps the whole plan stable across re-fetches.
 */
export function expectedCheckOutInstant(input: ShiftReminderInput): Date {
  const nominalStart = wallClockInBusinessDay(input, input.workdayStart);
  const nominalEnd = wallClockInBusinessDay(input, input.workdayEnd);

  const nominalLengthMs = nominalEnd.getTime() - nominalStart.getTime();
  const shiftMs =
    nominalLengthMs > 0 && nominalLengthMs <= MAX_NOMINAL_SHIFT_MS
      ? nominalLengthMs
      : FALLBACK_SHIFT_MS;

  return nominalEnd.getTime() > input.checkInAt.getTime()
    ? nominalEnd
    : new Date(input.checkInAt.getTime() + shiftMs);
}

/**
 * A stable number in `[0, 1)` for this shift and this kind of reminder.
 *
 * SHA-256 rather than a hand-rolled hash so the distribution needs no defending,
 * and truncated to 48 bits, which `readUIntBE` can return exactly as a JavaScript
 * number. Deterministic across processes, restarts and deployments: the same
 * record id yields the same draw on every machine, forever, which is the only
 * reason this can be called once per request instead of being stored.
 */
function seededUnitInterval(recordId: string, kind: string): number {
  const digest = createHash('sha256').update(`${recordId}:${kind}`).digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/** A point in `[from, to]` chosen by `unit`, truncated to a whole minute. */
function pickInstant(fromMs: number, toMs: number, unit: number): Date {
  const chosen = fromMs + (toMs - fromMs) * unit;
  // Floored rather than rounded so the instant can only move *earlier* than the
  // band, never past its upper edge and so never past the expected check-out.
  // Whole minutes also stop a notification arriving at 17:34:27, which reads as
  // a glitch rather than as a decision.
  return new Date(Math.floor(chosen / MINUTE_MS) * MINUTE_MS);
}

function localTime(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat('HH:mm');
}

/**
 * The reminders due for one open shift, earliest first.
 *
 * Empty when the remaining window is too short to say anything useful, and empty
 * once every planned instant has passed. Callers must not schedule anything this
 * function did not return.
 */
export function planShiftReminders(input: ShiftReminderInput): ShiftReminder[] {
  const checkInMs = input.checkInAt.getTime();
  const expectedCheckOut = expectedCheckOutInstant(input);
  const spanMs = expectedCheckOut.getTime() - checkInMs;

  if (spanMs < MIN_REMINDER_WINDOW_MS) return [];

  const endMs = expectedCheckOut.getTime();
  const soonAt = pickInstant(
    endMs - Math.min(CHECKOUT_LEAD_MAX_MS, spanMs * CHECKOUT_LEAD_MAX_FRACTION),
    endMs - Math.min(CHECKOUT_LEAD_MIN_MS, spanMs * CHECKOUT_LEAD_MIN_FRACTION),
    seededUnitInterval(input.attendanceRecordId, ReminderKind.CHECKOUT_SOON),
  );
  const stillAt = pickInstant(
    checkInMs + spanMs * STILL_THERE_BAND_START,
    checkInMs + spanMs * STILL_THERE_BAND_END,
    seededUnitInterval(input.attendanceRecordId, ReminderKind.STILL_THERE),
  );

  const planned: ShiftReminder[] = [];

  // Ordering is by construction — the "still there" band ends at 60% of the
  // shift and the "check out soon" band cannot begin before 75% of it — so this
  // gate is about *spacing*, not about sorting. On a shift too short to hold
  // both this far apart, the one that survives is the actionable one: being told
  // to check out is something a person can do, being asked whether they are
  // still there is not.
  if (soonAt.getTime() - stillAt.getTime() >= MIN_REMINDER_SPACING_MS) {
    planned.push({
      id: `${input.attendanceRecordId}:${ReminderKind.STILL_THERE}`,
      at: stillAt.toISOString(),
      kind: ReminderKind.STILL_THERE,
      title: 'Are you still there?',
      body:
        `You checked in at ${localTime(input.checkInAt, input.timezone)} and are still ` +
        'checked in. Remember to check out when you leave.',
    });
  }

  planned.push({
    id: `${input.attendanceRecordId}:${ReminderKind.CHECKOUT_SOON}`,
    at: soonAt.toISOString(),
    kind: ReminderKind.CHECKOUT_SOON,
    title: "Don't forget to check out",
    body: `Your workday ends at ${localTime(expectedCheckOut, input.timezone)}. Tap to check out.`,
  });

  // Nothing in the past. A device cannot raise a notification for an instant that
  // has gone, and asking it to would either fire immediately or be dropped
  // silently depending on the platform — neither of which is what the plan says.
  const nowMs = input.now.getTime();
  return planned.filter((reminder) => Date.parse(reminder.at) > nowMs);
}
