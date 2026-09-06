/**
 * Domain constants and enumerations shared by the API and the mobile client.
 *
 * These are plain `const` objects rather than TypeScript `enum`s so that the
 * values survive `isolatedModules`, are tree-shakeable, and serialise to exactly
 * the strings stored in PostgreSQL.
 */

export const Role = {
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const PunchType = {
  CHECK_IN: 'CHECK_IN',
  CHECK_OUT: 'CHECK_OUT',
} as const;
export type PunchType = (typeof PunchType)[keyof typeof PunchType];

export const PunchOutcome = {
  ACCEPTED: 'ACCEPTED',
  REJECTED_OUT_OF_RANGE: 'REJECTED_OUT_OF_RANGE',
  REJECTED_NO_ACTIVE_SITE: 'REJECTED_NO_ACTIVE_SITE',
  REJECTED_ALREADY_CHECKED_IN: 'REJECTED_ALREADY_CHECKED_IN',
  REJECTED_NOT_CHECKED_IN: 'REJECTED_NOT_CHECKED_IN',
  REJECTED_ALREADY_CHECKED_OUT: 'REJECTED_ALREADY_CHECKED_OUT',
  REJECTED_LOW_ACCURACY: 'REJECTED_LOW_ACCURACY',
  /**
   * The punch never reached the attendance rules: the principal was
   * authenticated, and then refused for being suspended. Filed because "a
   * suspended employee kept trying to punch in at the office at 06:00" is a
   * question only the event log can answer.
   */
  REJECTED_ACCOUNT_SUSPENDED: 'REJECTED_ACCOUNT_SUSPENDED',
  /**
   * A check-in refused because a shift opened on an earlier business day is
   * still open. Kept apart from `REJECTED_ALREADY_CHECKED_IN` because the two
   * describe different situations to an auditor: a double tap, versus somebody
   * starting a second shift on top of one they never closed.
   */
  REJECTED_SHIFT_STILL_OPEN: 'REJECTED_SHIFT_STILL_OPEN',
  /** A check-out that would have stored a zero-minute day. */
  REJECTED_SHIFT_TOO_SHORT: 'REJECTED_SHIFT_TOO_SHORT',
} as const;
export type PunchOutcome = (typeof PunchOutcome)[keyof typeof PunchOutcome];

export const AttendanceStatus = {
  PRESENT: 'PRESENT',
  LATE: 'LATE',
  INCOMPLETE: 'INCOMPLETE',
} as const;
export type AttendanceStatus = (typeof AttendanceStatus)[keyof typeof AttendanceStatus];

export const ExportFormat = {
  CSV: 'csv',
  XLSX: 'xlsx',
} as const;
export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

// ---------------------------------------------------------------------------
// Physical / policy limits
// ---------------------------------------------------------------------------

/** Geofence radius bounds, metres. Below ~20 m consumer GPS cannot resolve reliably. */
export const SITE_RADIUS_MIN_M = 20;
export const SITE_RADIUS_MAX_M = 10_000;
export const SITE_RADIUS_DEFAULT_M = 150;

/**
 * Hard ceiling on an accepted GPS accuracy radius, metres. A fix reported with a
 * 5 km error radius is compatible with being anywhere in the city, so treating it
 * as "inside the geofence" would make the geofence decorative.
 */
export const ACCURACY_CEILING_M = 5_000;
export const ACCURACY_DEFAULT_MAX_M = 100;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

/**
 * Default local wall-clock time at which an organization's business day rolls
 * over. `00:00` — local midnight — is exactly what the system did before the
 * boundary became configurable, so an organization that never touches the
 * setting sees no change at all in how its days are cut. Every tenant whose
 * shifts cross midnight has to choose a boundary deliberately, because only
 * they know where their night ends.
 */
export const DAY_STARTS_AT_DEFAULT = '00:00';

/**
 * Shortest shift a check-out may close, minutes.
 *
 * Its only job is to make a zero-minute day unstorable: a check-in immediately
 * followed by a mis-tapped check-out used to become a `PRESENT` day of no work
 * *and* lock the employee out of the day they were about to start. It is not an
 * opinion about what counts as a day's work — that is what `workedMinutes` in
 * the report is for.
 */
export const MIN_SHIFT_MINUTES = 1;

/** Upper bound on an export window, days. Guards against unbounded table scans. */
export const EXPORT_MAX_RANGE_DAYS = 366;

/** Attendance history the mobile client may page through. */
export const HISTORY_MAX_RANGE_DAYS = 366;
