import { z } from 'zod';
import {
  inclusiveDayCount,
  isoDateSchema,
  paginationQuerySchema,
  timeOfDaySchema,
  uuidSchema,
} from './common.js';
import { AttendanceStatus, EXPORT_MAX_RANGE_DAYS } from './constants.js';

/**
 * Manual attendance entry — an administrator recording or correcting a day.
 *
 * This is the most abusable surface in an attendance product: typing in a day
 * somebody did not work is exactly what an attendance record exists to prevent.
 * The shapes here are built around that, and two of the choices are the whole
 * point of the file.
 *
 * **A manual row names its author.** {@link AttendanceSource} rides on every
 * record that crosses the API, so a reader can never mistake a hand-typed day
 * for a punch — and `enteredBy` says *which* administrator typed it.
 *
 * **Times are wall clocks, not instants.** A request carries `HH:mm` in the
 * organization's own zone and the server resolves it with the same Luxon
 * helpers a punch uses. The alternative — an ISO instant from the client —
 * would put a second opinion about "what time is it in Riyadh on 1 March" in a
 * phone, and payroll would eventually be wrong in a way nobody could explain.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * How a record came to exist.
 *
 * `PUNCH` is the employee's own account of their day. `MANUAL` means an
 * administrator entered or last edited it, and it is a one-way door: correcting
 * a punched record flips it, because the row is no longer purely the employee's
 * own account of their day and an attendance sheet that hid that would be lying
 * by omission.
 */
export const AttendanceSource = {
  PUNCH: 'PUNCH',
  MANUAL: 'MANUAL',
} as const;
export type AttendanceSource = (typeof AttendanceSource)[keyof typeof AttendanceSource];

/** `AttendanceRecord.note` is a `VarChar(255)`; a longer note must be refused, not truncated. */
export const ATTENDANCE_NOTE_MAX_LENGTH = 255;

/**
 * Why this record was entered by hand.
 *
 * Required on **every** manual write, creation and correction alike. A `MANUAL`
 * row with no reason is the one shape that makes the audit trail useless: it
 * records that somebody typed a day in, and nothing about why — which is the
 * only question anyone reviewing it will ask.
 */
export const attendanceNoteSchema = z
  .string()
  .trim()
  .min(3, 'Say why this was entered by hand — at least 3 characters')
  .max(ATTENDANCE_NOTE_MAX_LENGTH, `Note must be at most ${ATTENDANCE_NOTE_MAX_LENGTH} characters`);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The shift as a human writes it on a timesheet: a date, a time in, a time out.
 *
 * `checkOutNextDay` is stated rather than inferred. An overnight shift — in at
 * 23:50, out at 00:10 — is the case that breaks every implicit rule: "the
 * check-out is the next occurrence of that clock" silently turns a mistyped
 * 08:00/07:00 pair into a 23-hour day, and "a smaller time means tomorrow"
 * cannot tell a genuine 23:50 → 00:10 night from a transposed pair of digits.
 * One boolean removes the guesswork, and the server still bounds the result by
 * the same carry-over window the punch path uses.
 */
export const createAttendanceEntryRequestSchema = z
  .object({
    userId: uuidSchema,
    /**
     * The business date the record is filed under, in the organization's zone.
     *
     * Not derived from the times: the tenant decides where its business day is
     * cut (`Organization.dayStartsAt`), and a night-shift tenant's 02:00 belongs
     * to the date before it. The server resolves the wall clock *into* this
     * business day, then asserts the two agree.
     */
    workDate: isoDateSchema,
    /** Local wall clock in the organization's timezone, `HH:mm`. */
    checkInTime: timeOfDaySchema,
    /** Local wall clock, or `null` to leave the day open (an `INCOMPLETE` record). */
    checkOutTime: timeOfDaySchema.nullable(),
    /** True when the check-out falls on the calendar day after the check-in. */
    checkOutNextDay: z.boolean(),
    note: attendanceNoteSchema,
  })
  .refine((v) => v.checkOutTime !== null || !v.checkOutNextDay, {
    message: 'A day with no check-out cannot end on the next day',
    path: ['checkOutNextDay'],
  })
  .refine((v) => v.checkOutTime === null || v.checkOutNextDay || v.checkOutTime >= v.checkInTime, {
    // `HH:mm` sorts lexicographically exactly as it sorts chronologically, so
    // this is a real comparison and not a string coincidence.
    //
    // Deliberately `>=` and not `>`. A check-out *earlier* in the day than the
    // check-in is a transposition the client should be told about by field, and
    // no timezone is needed to see it. A check-out at the *same* minute is a
    // different failure — a zero-length day — and that one belongs to the
    // server, which answers it with `SHIFT_TOO_SHORT` and the attendance
    // module's own `MIN_SHIFT_MS`. Refusing it here as well would fork one rule
    // into two, and the copy in this file would be the one that never learned
    // that the minimum had moved.
    //
    // The same reasoning keeps the rest out: "inside the carry-over window" and
    // "not in the future" need the tenant's zone and the server clock, so a
    // schema that guessed at them would be a second opinion about a work day.
    message: 'Check-out must not be earlier in the day than check-in',
    path: ['checkOutTime'],
  });
export type CreateAttendanceEntryRequest = z.infer<typeof createAttendanceEntryRequestSchema>;

/**
 * A correction.
 *
 * `note` is required even though every other field is optional, because a
 * correction *is* a manual write: it flips the record to `MANUAL` and stamps the
 * administrator's name on it, and doing that without a reason is what makes an
 * audit trail unreadable a year later.
 *
 * `userId` and `workDate` are absent on purpose. Moving a record to another
 * person or another day is not a correction of that record — it is the deletion
 * of one day and the creation of another, and forcing it through those two
 * endpoints leaves two audit rows saying exactly that instead of one row that
 * quietly changed whose day it was.
 */
export const updateAttendanceEntryRequestSchema = z
  .object({
    checkInTime: timeOfDaySchema.optional(),
    /** `null` reopens the day: the check-out is cleared and the record becomes `INCOMPLETE`. */
    checkOutTime: timeOfDaySchema.nullable().optional(),
    checkOutNextDay: z.boolean().optional(),
    note: attendanceNoteSchema,
  })
  .refine((v) => v.checkOutNextDay === undefined || typeof v.checkOutTime === 'string', {
    // `checkOutNextDay` is a modifier on a check-out time, not a field of its
    // own. Alone it would ask the server to move a stored instant by a day
    // without restating the clock it should land on, which is the sort of edit
    // that looks like it worked and silently did not.
    message: 'Send `checkOutNextDay` together with the check-out time it applies to',
    path: ['checkOutNextDay'],
  });
export type UpdateAttendanceEntryRequest = z.infer<typeof updateAttendanceEntryRequestSchema>;

/**
 * A window of an organization's attendance, optionally narrowed to one employee
 * or to one source.
 *
 * The `source` filter is what makes "show me every day somebody typed in this
 * month" a single request rather than an eyeball exercise over a report.
 */
export const listAttendanceEntriesQuerySchema = paginationQuerySchema
  .extend({
    from: isoDateSchema,
    to: isoDateSchema,
    userId: uuidSchema.optional(),
    source: z.enum([AttendanceSource.PUNCH, AttendanceSource.MANUAL]).optional(),
  })
  .refine((v) => v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] })
  .refine((v) => inclusiveDayCount(v.from, v.to) <= EXPORT_MAX_RANGE_DAYS, {
    message: `Range must not exceed ${EXPORT_MAX_RANGE_DAYS} days`,
    path: ['to'],
  });
export type ListAttendanceEntriesQuery = z.infer<typeof listAttendanceEntriesQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The administrator behind a manual row. Enough to name them, and nothing more. */
export const attendanceEntryActorSchema = z.object({
  id: uuidSchema,
  fullName: z.string(),
});
export type AttendanceEntryActor = z.infer<typeof attendanceEntryActorSchema>;

/**
 * One attendance day, as an administrator sees it.
 *
 * Deliberately carries `source`, `enteredBy`, `enteredAt` and `note` on **every**
 * row, not only the manual ones. A field that appears only when something was
 * typed in would make its absence the signal, and an absent field is exactly
 * what a client forgets to render.
 */
export const attendanceEntrySchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  userFullName: z.string(),
  userEmail: z.string(),
  employeeCode: z.string().nullable(),
  /** Local calendar date, `YYYY-MM-DD`, in the organization's timezone. */
  workDate: z.string(),
  checkInAt: z.string(),
  checkOutAt: z.string().nullable(),
  status: z.enum([AttendanceStatus.PRESENT, AttendanceStatus.LATE, AttendanceStatus.INCOMPLETE]),
  workedMinutes: z.number().int().nullable(),
  lateMinutes: z.number().int(),
  /** `MANUAL` for a row an administrator entered or last corrected. */
  source: z.enum([AttendanceSource.PUNCH, AttendanceSource.MANUAL]),
  /** The administrator who last entered or edited it; `null` for an untouched punch. */
  enteredBy: attendanceEntryActorSchema.nullable(),
  enteredAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type AttendanceEntryDto = z.infer<typeof attendanceEntrySchema>;
