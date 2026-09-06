import { z } from 'zod';
import {
  accuracySchema,
  isoDateSchema,
  latitudeSchema,
  longitudeSchema,
  paginationQuerySchema,
  uuidSchema,
} from './common.js';
import { AttendanceStatus, HISTORY_MAX_RANGE_DAYS, PunchOutcome, PunchType } from './constants.js';
import { inclusiveDayCount } from './common.js';

// --- Requests --------------------------------------------------------------

/**
 * A punch payload. `deviceTime` is recorded for tamper analysis but is never
 * used to decide the work date — the server clock is authoritative, otherwise a
 * user could backdate attendance by changing their phone's clock.
 */
export const punchRequestSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracy: accuracySchema,
  deviceTime: z.iso.datetime({ offset: true }).optional(),
});
export type PunchRequest = z.infer<typeof punchRequestSchema>;

export const attendanceHistoryQuerySchema = paginationQuerySchema
  .extend({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: '`from` must be on or before `to`',
    path: ['from'],
  })
  .refine((v) => !v.from || !v.to || inclusiveDayCount(v.from, v.to) <= HISTORY_MAX_RANGE_DAYS, {
    message: `Range must not exceed ${HISTORY_MAX_RANGE_DAYS} days`,
    path: ['to'],
  })
  // A lone bound is an *unbounded* range, and the cap above cannot see it:
  // `?from=1900-01-01` asks the database to count every row the user has ever
  // had. The page size bounds what comes back, not what is counted. Omitting
  // both bounds is still fine — that is "my most recent days", which the
  // `(userId, workDate desc)` index answers from the top.
  .refine((v) => v.to === undefined || v.from !== undefined, {
    message: 'Provide `from` alongside `to`, or omit both',
    path: ['from'],
  })
  .refine((v) => v.from === undefined || v.to !== undefined, {
    message: 'Provide `to` alongside `from`, or omit both',
    path: ['to'],
  });
export type AttendanceHistoryQuery = z.infer<typeof attendanceHistoryQuerySchema>;

// --- Responses -------------------------------------------------------------

export const siteSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
});
export type SiteSummary = z.infer<typeof siteSummarySchema>;

export const attendanceRecordSchema = z.object({
  id: uuidSchema,
  /** Local calendar date, YYYY-MM-DD, in the organization timezone. */
  workDate: z.string(),
  checkInAt: z.string(),
  /**
   * The site the punch was measured against, or `null`.
   *
   * Nullable for the same reason `checkOutSite` always was: a site is a *point
   * of reference*, not a precondition. An organization that does not enforce a
   * geofence may legitimately have no sites at all, and a punch made in that
   * tenant is a complete, valid record with nowhere to measure from. Forcing a
   * site here would either forbid that tenant from recording attendance or
   * require inventing a site nobody works at.
   */
  checkInSite: siteSummarySchema.nullable(),
  /** Metres from {@link attendanceRecordSchema.checkInSite}; `null` when there was none. */
  checkInDistanceM: z.number().nullable(),
  checkOutAt: z.string().nullable(),
  checkOutSite: siteSummarySchema.nullable(),
  checkOutDistanceM: z.number().nullable(),
  status: z.enum([AttendanceStatus.PRESENT, AttendanceStatus.LATE, AttendanceStatus.INCOMPLETE]),
  workedMinutes: z.number().int().nullable(),
  lateMinutes: z.number().int(),
});
export type AttendanceRecordDto = z.infer<typeof attendanceRecordSchema>;

/**
 * Everything the home screen needs in a single round trip: what the user may do
 * next, and why. `canCheckIn`/`canCheckOut` are computed server-side so the
 * button state can never disagree with what the server will accept.
 */
export const attendanceStatusSchema = z.object({
  serverTime: z.string(),
  timezone: z.string(),
  workDate: z.string(),
  canCheckIn: z.boolean(),
  canCheckOut: z.boolean(),
  today: attendanceRecordSchema.nullable(),
  sites: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      radiusMeters: z.number().int(),
    }),
  ),
  maxAccuracyMeters: z.number().int(),
  /**
   * Whether the tenant refuses punches taken outside a geofence.
   *
   * Carried so the client knows which mode it is in rather than inferring it
   * from a rejection it has not made yet. When `false` the distance panel is a
   * *record* of where the user is, not a gate they have to pass, and the punch
   * button is never withheld for being far away or for an imprecise fix.
   */
  enforceGeofence: z.boolean(),
});
export type AttendanceStatusDto = z.infer<typeof attendanceStatusSchema>;

export const punchResponseSchema = z.object({
  outcome: z.enum([PunchOutcome.ACCEPTED]),
  type: z.enum([PunchType.CHECK_IN, PunchType.CHECK_OUT]),
  record: attendanceRecordSchema,
  /**
   * Site the punch was matched to, and how far away the device was.
   *
   * Both `null` together, and only when the tenant does not enforce a geofence
   * and has no sites to measure against — there is then no nearest site, and
   * saying so is more honest than naming an arbitrary one.
   */
  site: siteSummarySchema.nullable(),
  distanceM: z.number().nullable(),
});
export type PunchResponse = z.infer<typeof punchResponseSchema>;
