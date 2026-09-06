import { DateTime } from 'luxon';

/**
 * Calendar arithmetic in the organization's timezone.
 *
 * Everything in this file is pure and free of NestJS, so the boundaries that
 * actually break attendance systems — midnight in a positive offset, midnight in
 * a negative one, and the two days a year a wall clock skips or repeats an hour —
 * are unit-testable without an HTTP server or a database.
 *
 * The rule these helpers exist to enforce (CONVENTIONS §2.3): `workDate` is the
 * local calendar date in the **organization's** IANA zone, derived from the
 * server clock. `new Date().toISOString().slice(0, 10)` is the bug this replaces;
 * it yields the UTC date, which for `Asia/Riyadh` rolls over three hours late and
 * files every evening punch under the wrong day.
 *
 * The second rule, and the one local midnight alone cannot express: a *business
 * day* is not always a calendar day. An organization whose shift starts at 23:00
 * works one night across two calendar dates, and cutting its day at local
 * midnight splits every shift in half — the same person is filed under two
 * dates, and the second half is measured against a `workdayStart` that has not
 * happened yet, so arriving three hours late scores zero. `dayStartsAt` is where
 * a tenant says its day rolls over; `00:00` reduces every function here to the
 * pure calendar-date behaviour, which is why it is the default.
 */

const MS_PER_MINUTE = 60_000;

/** `HH:mm`, as stored in `Organization.workdayStart` / `workdayEnd`. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

function assertValid(dt: DateTime, subject: string): DateTime {
  // Luxon never throws on a bad zone or a malformed literal; it returns an
  // invalid DateTime whose `toISODate()` is null. Silently continuing from one
  // produces a plausible-looking wrong date, which is the exact failure mode
  // CONVENTIONS calls the worst kind. Fail loudly instead: the global filter
  // renders it as INTERNAL_ERROR without leaking the cause.
  if (!dt.isValid) throw new RangeError(`${subject}: ${dt.invalidReason ?? 'invalid'}`);
  return dt;
}

/** The local calendar date, `YYYY-MM-DD`, that the instant `at` falls on in `timezone`. */
export function workDateIn(at: Date, timezone: string): string {
  const local = assertValid(
    DateTime.fromJSDate(at, { zone: timezone }),
    `Unusable organization timezone "${timezone}"`,
  );
  return local.toISODate() as string;
}

/**
 * The **business date** the instant `at` belongs to, per the tenant's boundary.
 *
 * The business day labelled `D` runs from `dayStartsAt` on calendar date `D`
 * until `dayStartsAt` on `D + 1`. So an instant whose local wall clock is before
 * the boundary belongs to the previous date, and everything else belongs to its
 * own. With the default `00:00` boundary the first case is unreachable and this
 * is exactly {@link workDateIn} — which is what keeps a 09:00–17:00 tenant, and
 * every row it has already written, behaving identically.
 *
 * Note what this is *not*: "the day starts at `workdayStart`". That rule would
 * file an 08:00 arrival at a 09:00 office under yesterday, which is both wrong
 * and the sort of wrong that only shows up in somebody's pay.
 */
export function businessDateIn(at: Date, timezone: string, dayStartsAt: string): string {
  const calendarDate = workDateIn(at, timezone);
  const boundary = wallClockInstant(calendarDate, dayStartsAt, timezone);
  return at.getTime() < boundary.getTime() ? shiftWorkDate(calendarDate, -1) : calendarDate;
}

/** The calendar date `days` before or after `workDate`. Leap years and month ends included. */
export function shiftWorkDate(workDate: string, days: number): string {
  const date = assertValid(
    DateTime.fromISO(workDate, { zone: 'utc' }),
    `Unusable work date "${workDate}"`,
  );
  return date.plus({ days }).toISODate() as string;
}

/**
 * The value to store in a `@db.Date` column for `workDate`.
 *
 * Postgres `date` holds only year-month-day; Prisma's pg adapter writes and reads
 * it through a `Date` pinned to **UTC midnight**. Encoding it the same way on the
 * way in is what makes the round trip exact — and is the one place where a UTC
 * date is correct, because the value is a calendar-date carrier rather than an
 * instant. The local date it stands for was already decided by {@link workDateIn}.
 */
export function workDateToColumn(workDate: string): Date {
  const date = assertValid(
    DateTime.fromISO(workDate, { zone: 'utc' }),
    `Unusable work date "${workDate}"`,
  );
  return date.toJSDate();
}

/** Inverse of {@link workDateToColumn}: the `YYYY-MM-DD` a `@db.Date` column stands for. */
export function workDateFromColumn(value: Date): string {
  const date = assertValid(
    DateTime.fromJSDate(value, { zone: 'utc' }),
    'Unusable stored work date',
  );
  return date.toISODate() as string;
}

/**
 * The instant at which the wall clock reads `hhmm` on `workDate` in `timezone`.
 *
 * On a spring-forward day the requested wall-clock time may not exist (02:30 in
 * `America/New_York` on the second Sunday in March); Luxon resolves the gap
 * forward, which is the interpretation that keeps a 09:00 workday start at the
 * first moment 09:00 could be observed.
 *
 * On a **fall-back** day the opposite happens and the requested time exists
 * *twice* — 01:30 occurs once at −04:00 and again, an hour later, at −05:00.
 * Luxon resolves the overlap to the **earlier** offset, which is the only choice
 * that keeps the workday start monotonic (picking the later one would move the
 * start of the day an hour into it). The consequence is real and deliberate: for
 * a `workdayStart` inside the repeated hour, two check-ins whose wall clocks
 * both read 01:35 are scored 0 and 60 minutes late, because they are genuinely
 * an hour apart. There is no answer that makes both reads agree — the wall clock
 * is simply not injective that hour — so the anchor is pinned to the first
 * reading and the lateness is measured from it. See `work-date.spec.ts`.
 */
export function wallClockInstant(workDate: string, hhmm: string, timezone: string): Date {
  if (!TIME_OF_DAY.test(hhmm)) {
    throw new RangeError(`Unusable workday time "${hhmm}": expected 24-hour HH:mm`);
  }
  const local = assertValid(
    DateTime.fromISO(`${workDate}T${hhmm}`, { zone: timezone }),
    `Unusable workday start for "${workDate}" in "${timezone}"`,
  );
  return local.toJSDate();
}

export interface WorkdayAnchorInput {
  /** The business date, as decided by {@link businessDateIn}. */
  workDate: string;
  timezone: string;
  /** Local wall-clock `HH:mm` the workday begins. */
  workdayStart: string;
  /** Local wall-clock `HH:mm` the business day rolls over. */
  dayStartsAt: string;
}

/**
 * The instant work was due to begin on the business day `workDate`.
 *
 * `workdayStart` is a wall-clock time, so it occurs on both calendar dates the
 * business day can span; exactly one of those occurrences is *inside* the
 * business day, and that is the one lateness is measured from. Rather than
 * reason about the window's endpoints — which drift by an hour twice a year —
 * the candidate is chosen by asking {@link businessDateIn} which business day it
 * would itself fall on. That makes the anchor consistent with the rule that
 * assigned `workDate` in the first place, by construction.
 *
 * For the default `00:00` boundary the answer is always `workdayStart` on
 * `workDate`, which is precisely what this module did before.
 */
export function workdayStartInstant(input: WorkdayAnchorInput): Date {
  const onWorkDate = wallClockInstant(input.workDate, input.workdayStart, input.timezone);
  if (businessDateIn(onWorkDate, input.timezone, input.dayStartsAt) === input.workDate) {
    return onWorkDate;
  }

  // `workdayStart` falls before the boundary, so the occurrence that belongs to
  // this business day is the one on the following calendar date — a 23:00 start
  // under a 20:00 boundary keeps the first branch; an 02:00 start takes this one.
  const onNextDate = wallClockInstant(
    shiftWorkDate(input.workDate, 1),
    input.workdayStart,
    input.timezone,
  );
  return businessDateIn(onNextDate, input.timezone, input.dayStartsAt) === input.workDate
    ? onNextDate
    : // Unreachable for any boundary a tenant can configure: the two candidates
      // are a calendar day apart and the business day is at least 23 hours long,
      // so one of them lands inside it. Falling back to the occurrence on
      // `workDate` keeps the function total rather than throwing at 02:00 on a
      // DST morning.
      onWorkDate;
}

export interface LatenessInput extends WorkdayAnchorInput {
  checkInAt: Date;
  /** Minutes after `workdayStart` that are still on time. */
  graceMinutes: number;
}

/**
 * Minutes past the end of the grace window, per the `lateMinutes` column
 * ("Minutes past (workdayStart + grace). 0 when on time.").
 *
 * The grace boundary is inclusive — arriving at exactly `workdayStart + grace` is
 * on time — and any overshoot rounds **up**. Rounding down would report 0 for a
 * check-in thirty seconds late, contradicting the `LATE` status derived from the
 * same number and quietly extending every organization's grace by 59 seconds.
 *
 * Arriving *before* the anchor is 0, not a negative number: `lateMinutes` counts
 * lateness, and an 08:00 arrival at a 09:00 office is early, not −60 late.
 */
export function lateMinutesFor(input: LatenessInput): number {
  const start = workdayStartInstant(input);
  const deadline = start.getTime() + input.graceMinutes * MS_PER_MINUTE;
  const overshoot = input.checkInAt.getTime() - deadline;
  return overshoot > 0 ? Math.ceil(overshoot / MS_PER_MINUTE) : 0;
}

/**
 * Whole minutes between two instants, never negative.
 *
 * Rounded rather than truncated: this is the length of a shift, and truncating
 * loses up to a minute on every single record — a systematic under-count across a
 * payroll period rather than noise that cancels.
 */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / MS_PER_MINUTE));
}

/**
 * Parses a client-supplied ISO instant, or null if it is unusable.
 *
 * Only ever stored for tamper analysis — never used to decide a work date — so a
 * device clock set to the year 1900 must be recorded, not rejected.
 */
export function parseInstant(iso: string | undefined): Date | null {
  if (iso === undefined) return null;
  const parsed = DateTime.fromISO(iso, { setZone: true });
  return parsed.isValid ? parsed.toJSDate() : null;
}
