import { z } from 'zod';
import {
  emailSchema,
  employeeCodeSchema,
  fullNameSchema,
  isoDateSchema,
  latitudeSchema,
  longitudeSchema,
  paginationQuerySchema,
  passwordSchema,
  timeOfDaySchema,
  timezoneSchema,
  uuidSchema,
  inclusiveDayCount,
} from './common.js';
import { AttendanceSource } from './attendance-entry.js';
import {
  ACCURACY_CEILING_M,
  AttendanceStatus,
  ExportFormat,
  EXPORT_MAX_RANGE_DAYS,
  PunchType,
  Role,
  SITE_RADIUS_MAX_M,
  SITE_RADIUS_MIN_M,
  UserStatus,
} from './constants.js';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const createUserRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: fullNameSchema,
  employeeCode: employeeCodeSchema.optional().transform((v) => (v ? v : undefined)),
  role: z.enum([Role.ADMIN, Role.MEMBER]).default(Role.MEMBER),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    /**
     * The sign-in identifier, correctable.
     *
     * Without this an address typed wrong at creation could only be fixed by
     * deleting the account and making a new one — which orphans every attendance
     * record onto the soft-deleted row and leaves the person missing from their
     * own history.
     *
     * Deliberately the same {@link emailSchema} the create request uses, so the
     * trimmed-lowercase normalisation applies here too. Bypassing it would let a
     * rename to `Ali@x.com` slip past a `(organizationId, email)` index that
     * already holds `ali@x.com`, producing exactly the two-accounts-one-human
     * split the normalisation exists to prevent.
     */
    email: emailSchema.optional(),
    fullName: fullNameSchema.optional(),
    employeeCode: employeeCodeSchema.nullable().optional(),
    role: z.enum([Role.ADMIN, Role.MEMBER]).optional(),
    status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const resetUserPasswordRequestSchema = z.object({ newPassword: passwordSchema });
export type ResetUserPasswordRequest = z.infer<typeof resetUserPasswordRequestSchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  role: z.enum([Role.ADMIN, Role.MEMBER]).optional(),
  status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const userSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  fullName: z.string(),
  employeeCode: z.string().nullable(),
  role: z.enum([Role.ADMIN, Role.MEMBER]),
  status: z.enum([UserStatus.ACTIVE, UserStatus.SUSPENDED]),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userSchema>;

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/**
 * The site fields that carry no default.
 *
 * Kept separate so the update schema can be built without them. `.partial()`
 * makes a key optional but does **not** strip its `.default()`, so deriving the
 * patch schema from `createSiteRequestSchema` would inject `isActive: true` into
 * every request — silently reactivating a geofence whenever an admin edited an
 * unrelated field on a site they had deliberately closed.
 */
const siteMutableFields = {
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  address: z.string().trim().max(255).optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  radiusMeters: z
    .number()
    .int()
    .min(SITE_RADIUS_MIN_M, `Radius must be at least ${SITE_RADIUS_MIN_M} metres`)
    .max(SITE_RADIUS_MAX_M, `Radius must be at most ${SITE_RADIUS_MAX_M} metres`),
};

export const createSiteRequestSchema = z.object({
  ...siteMutableFields,
  isActive: z.boolean().default(true),
});
export type CreateSiteRequest = z.infer<typeof createSiteRequestSchema>;

export const updateSiteRequestSchema = z
  .object({ ...siteMutableFields, isActive: z.boolean() })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });
export type UpdateSiteRequest = z.infer<typeof updateSiteRequestSchema>;

export const siteSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  address: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  radiusMeters: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type SiteDto = z.infer<typeof siteSchema>;

// ---------------------------------------------------------------------------
// Organization settings
// ---------------------------------------------------------------------------

export const updateOrganizationRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    timezone: timezoneSchema.optional(),
    workdayStart: timeOfDaySchema.optional(),
    workdayEnd: timeOfDaySchema.optional(),
    /**
     * Local wall-clock time the business day rolls over. Deliberately *not*
     * constrained against `workdayStart`/`workdayEnd`: a night-shift tenant
     * wants the boundary in the middle of its off-hours, which for a 23:00 start
     * means somewhere in the afternoon, and any rule tying the two together
     * would forbid exactly the configuration this field exists to allow.
     */
    dayStartsAt: timeOfDaySchema.optional(),
    lateGraceMinutes: z.number().int().min(0).max(720).optional(),
    maxAccuracyMeters: z.number().int().min(10).max(ACCURACY_CEILING_M).optional(),
    /**
     * Whether a punch outside every geofence is refused.
     *
     * Switching it off turns location from a gate into a record: coordinates,
     * accuracy, the nearest site and the distance to it are still stored on
     * every punch, and none of them can refuse one. It exists because a fence
     * is the wrong tool for a workforce that is legitimately hundreds of
     * kilometres from the nearest office — the alternative being that those
     * employees cannot record attendance at all.
     */
    enforceGeofence: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  })
  .refine((v) => !v.workdayStart || !v.workdayEnd || v.workdayStart < v.workdayEnd, {
    message: 'Workday start must be before workday end',
    path: ['workdayEnd'],
  });
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

export const organizationSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  workdayStart: z.string(),
  workdayEnd: z.string(),
  /** `HH:mm` local. The instant the tenant's business day rolls over. */
  dayStartsAt: z.string(),
  lateGraceMinutes: z.number().int(),
  maxAccuracyMeters: z.number().int(),
  /**
   * Whether punches outside every geofence are refused. `true` preserves the
   * original behaviour; `false` makes location a recorded fact rather than a
   * precondition, and also stands down the accuracy gate, which only ever
   * existed to stop a wide fix faking its way *inside* a fence.
   */
  enforceGeofence: z.boolean(),
});
export type OrganizationDto = z.infer<typeof organizationSchema>;

// ---------------------------------------------------------------------------
// Reporting & export
// ---------------------------------------------------------------------------

const rangeShape = {
  from: isoDateSchema,
  to: isoDateSchema,
  userId: uuidSchema.optional(),
};

const withRangeRules = <T extends z.ZodType<{ from: string; to: string }>>(schema: T) =>
  schema
    .refine((v) => v.from <= v.to, { message: '`from` must be on or before `to`', path: ['from'] })
    .refine((v) => inclusiveDayCount(v.from, v.to) <= EXPORT_MAX_RANGE_DAYS, {
      message: `Range must not exceed ${EXPORT_MAX_RANGE_DAYS} days`,
      path: ['to'],
    });

export const attendanceReportQuerySchema = withRangeRules(paginationQuerySchema.extend(rangeShape));
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

/**
 * Which attendance sheet to build.
 *
 * A second axis alongside `format`, not a second endpoint: the range, the
 * tenancy predicate, the keyset stream and the streaming discipline are
 * identical either way, and only the columns differ. Splitting the route would
 * have meant two copies of every one of those properties, and the export path's
 * hard-won ones — CSV-injection neutralisation, backpressure, the stall deadline
 * — are exactly the kind that rot in the copy nobody audited.
 *
 * `detailed` is the sheet that has always existed: sites, distances, GPS
 * accuracy, geofence flags, late minutes. `minified` is the payroll extract —
 * who, which day, in, out, hours — and nothing else, because the reader of that
 * sheet is transcribing four numbers into another system and every extra column
 * is a chance to read the wrong one.
 */
export const ExportVariant = {
  DETAILED: 'detailed',
  MINIFIED: 'minified',
} as const;
export type ExportVariant = (typeof ExportVariant)[keyof typeof ExportVariant];

/**
 * The column headers each variant produces, in order.
 *
 * Published in the contract rather than left inside the API because the client
 * shows them *before* the download: an administrator who picks the wrong sheet
 * finds out after a multi-second export and a file they then have to delete, so
 * the picker states what each option actually contains. Having the client
 * hard-code its own copy of that list is how the promise and the file drift
 * apart, which is why this is the same array both sides read — the API asserts
 * its real headers against it.
 *
 * Base names only: the two instant columns gain the organization's timezone in
 * the file itself, because a bare `08:47` is ambiguous the moment the sheet
 * leaves the machine that made it.
 */
export const EXPORT_VARIANT_COLUMNS: Readonly<Record<ExportVariant, readonly string[]>> = {
  [ExportVariant.DETAILED]: [
    'Work date',
    'Employee code',
    'Full name',
    'Email',
    'Check-in',
    'Check-in site',
    'Check-in distance from site',
    'Check-in GPS accuracy (radius)',
    'Check-out',
    'Check-out site',
    'Check-out distance from site',
    'Check-out GPS accuracy (radius)',
    'Outside geofence',
    'Entered by hand',
    'Reason for manual entry',
    'Status',
    'Worked minutes',
    'Late minutes',
  ],
  [ExportVariant.MINIFIED]: ['Work date', 'Employee', 'Check-in', 'Check-out', 'Total hours'],
};

export const exportQuerySchema = withRangeRules(
  z.object({
    ...rangeShape,
    format: z.enum([ExportFormat.CSV, ExportFormat.XLSX]).default(ExportFormat.XLSX),
    /**
     * Defaulted to `detailed`, which is what every caller that predates this
     * parameter asked for and got. A default of `minified` would silently
     * shorten the sheet an existing bookmark, script or saved link produces.
     */
    variant: z
      .enum([ExportVariant.DETAILED, ExportVariant.MINIFIED])
      .default(ExportVariant.DETAILED),
  }),
);
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const reportRowSchema = z.object({
  id: uuidSchema,
  workDate: z.string(),
  /**
   * How the row came to exist. Carried on **every** row, punched ones included,
   * so a hand-entered record is never identified by the absence of a field —
   * a reader of a payroll sheet must be able to see which days a human typed.
   */
  source: z.enum([AttendanceSource.PUNCH, AttendanceSource.MANUAL]),
  /** The administrator who entered or last corrected it. Null for a real punch. */
  enteredByName: z.string().nullable(),
  /** Why it was entered by hand. Null for a real punch. */
  note: z.string().nullable(),
  userId: uuidSchema,
  userFullName: z.string(),
  userEmail: z.string(),
  employeeCode: z.string().nullable(),
  checkInAt: z.string(),
  /** Null when the tenant had no site to measure the punch against. */
  checkInSiteName: z.string().nullable(),
  /** Metres from the check-in site's centre. Null when there was no site. */
  checkInDistanceM: z.number().nullable(),
  /** The device's reported error radius at check-in, metres. Always recorded. */
  checkInAccuracyM: z.number(),
  checkOutAt: z.string().nullable(),
  checkOutSiteName: z.string().nullable(),
  checkOutDistanceM: z.number().nullable(),
  checkOutAccuracyM: z.number().nullable(),
  /**
   * The punches that landed outside their own site's radius.
   *
   * Derived on the server rather than left to each reader, because the radius
   * lives on the site and the distance on the record: a client that joined them
   * itself would be reimplementing the comparison in every surface that shows a
   * report, and the two copies would eventually disagree. Empty when both
   * punches were inside, and empty for a punch with no site — a fence that does
   * not exist cannot be outside of.
   */
  outOfRange: z.array(z.enum([PunchType.CHECK_IN, PunchType.CHECK_OUT])),
  status: z.enum([AttendanceStatus.PRESENT, AttendanceStatus.LATE, AttendanceStatus.INCOMPLETE]),
  workedMinutes: z.number().int().nullable(),
  lateMinutes: z.number().int(),
});
export type ReportRow = z.infer<typeof reportRowSchema>;

export const reportSummarySchema = z.object({
  totalRecords: z.number().int(),
  presentCount: z.number().int(),
  lateCount: z.number().int(),
  incompleteCount: z.number().int(),
  distinctUsers: z.number().int(),
  totalWorkedMinutes: z.number().int(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

/** Dashboard tiles for "today" in the organization's timezone. */
export const adminOverviewSchema = z.object({
  workDate: z.string(),
  timezone: z.string(),
  totalActiveUsers: z.number().int(),
  checkedInCount: z.number().int(),
  checkedOutCount: z.number().int(),
  lateCount: z.number().int(),
  absentCount: z.number().int(),
  rejectedAttemptsToday: z.number().int(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
