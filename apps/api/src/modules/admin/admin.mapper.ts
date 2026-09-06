import type { Prisma } from '@prisma/client';
import { PunchType } from '@wasel/contracts';
import type {
  AttendanceStatus,
  OrganizationDto,
  ReportRow,
  Role,
  SiteDto,
  UserDto,
  UserStatus,
} from '@wasel/contracts';
import { toIsoDate } from './admin.time.js';

/**
 * Prisma row → contract DTO, and the column selections those DTOs are built
 * from.
 *
 * The selections are the load-bearing half. `passwordHash`, `tokenVersion`,
 * `failedLoginAttempts` and `lockedUntil` are absent from `ADMIN_USER_SELECT` by
 * construction, so no query written against it can hand a digest to a caller,
 * to a log, or into an exported spreadsheet.
 */

export const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  employeeCode: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export const ADMIN_SITE_SELECT = {
  id: true,
  name: true,
  address: true,
  latitude: true,
  longitude: true,
  radiusMeters: true,
  isActive: true,
  createdAt: true,
} as const satisfies Prisma.SiteSelect;

export const ADMIN_ORGANIZATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  workdayStart: true,
  workdayEnd: true,
  dayStartsAt: true,
  lateGraceMinutes: true,
  maxAccuracyMeters: true,
  enforceGeofence: true,
} as const satisfies Prisma.OrganizationSelect;

/**
 * One report line, joined to the employee and to both sites.
 *
 * The joins are declared here, once, so the paged JSON report and the streamed
 * export read exactly the same shape — an export whose columns disagree with the
 * screen it was exported from is worse than no export.
 */
export const REPORT_RECORD_SELECT = {
  id: true,
  workDate: true,
  userId: true,
  checkInAt: true,
  checkInAccuracyM: true,
  checkInDistanceM: true,
  checkOutAt: true,
  checkOutAccuracyM: true,
  checkOutDistanceM: true,
  status: true,
  workedMinutes: true,
  lateMinutes: true,
  user: { select: { fullName: true, email: true, employeeCode: true } },
  // `radiusMeters` rides along on both joins so the report can say *whether* a
  // punch was outside its fence, not merely how far away it was. The comparison
  // has to happen somewhere, and doing it once on the server is what stops the
  // export and every screen showing a report from each growing their own copy of
  // it — two copies of one rule eventually disagree, and the disagreement would
  // be about whose attendance is suspect.
  checkInSite: { select: { name: true, radiusMeters: true } },
  checkOutSite: { select: { name: true, radiusMeters: true } },
} as const satisfies Prisma.AttendanceRecordSelect;

export type AdminUserRow = {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string | null;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export type AdminSiteRow = {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
  createdAt: Date;
};

export type AdminOrganizationRow = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  dayStartsAt: string;
  lateGraceMinutes: number;
  maxAccuracyMeters: number;
  enforceGeofence: boolean;
};

export type ReportSite = { name: string; radiusMeters: number };

export type ReportRecord = {
  id: string;
  workDate: Date;
  userId: string;
  checkInAt: Date;
  checkInAccuracyM: number;
  checkInDistanceM: number | null;
  checkOutAt: Date | null;
  checkOutAccuracyM: number | null;
  checkOutDistanceM: number | null;
  status: AttendanceStatus;
  workedMinutes: number | null;
  lateMinutes: number;
  user: { fullName: string; email: string; employeeCode: string | null };
  /** Null when the tenant had no site to measure this punch against. */
  checkInSite: ReportSite | null;
  checkOutSite: ReportSite | null;
};

/**
 * Was this punch outside the fence it was measured against?
 *
 * `false` for a punch with no site: a fence that does not exist cannot be
 * outside of, and flagging every punch in a site-less organization would make
 * the column mean "this tenant has no sites" instead of "look at this row".
 *
 * The radius is the site's radius **now**, not the one in force at punch time —
 * that is not stored, and storing it would be a second source of truth for a
 * number an administrator can already see on the site. The consequence is worth
 * stating: widening a geofence retroactively un-flags old punches. It is the
 * same property the whole report has, where `checkInSiteName` is also the site's
 * current name.
 */
export function isOutOfRange(distanceM: number | null, site: ReportSite | null): boolean {
  if (site === null || distanceM === null) return false;
  return distanceM > site.radiusMeters;
}

export function toUserDto(row: AdminUserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    employeeCode: row.employeeCode,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSiteDto(row: AdminSiteRow): SiteDto {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMeters: row.radiusMeters,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toOrganizationDto(row: AdminOrganizationRow): OrganizationDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    workdayStart: row.workdayStart,
    workdayEnd: row.workdayEnd,
    dayStartsAt: row.dayStartsAt,
    lateGraceMinutes: row.lateGraceMinutes,
    maxAccuracyMeters: row.maxAccuracyMeters,
    enforceGeofence: row.enforceGeofence,
  };
}

export function toReportRow(row: ReportRecord): ReportRow {
  return {
    id: row.id,
    workDate: toIsoDate(row.workDate),
    userId: row.userId,
    userFullName: row.user.fullName,
    userEmail: row.user.email,
    employeeCode: row.user.employeeCode,
    checkInAt: row.checkInAt.toISOString(),
    checkInSiteName: row.checkInSite?.name ?? null,
    checkInDistanceM: row.checkInDistanceM,
    checkInAccuracyM: row.checkInAccuracyM,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    checkOutSiteName: row.checkOutSite?.name ?? null,
    checkOutDistanceM: row.checkOutDistanceM,
    checkOutAccuracyM: row.checkOutAccuracyM,
    outOfRange: outOfRangePunches(row),
    status: row.status,
    workedMinutes: row.workedMinutes,
    lateMinutes: row.lateMinutes,
  };
}

/** Which of a record's two punches landed outside their own site's radius. */
export function outOfRangePunches(row: ReportRecord): PunchType[] {
  const punches: PunchType[] = [];
  if (isOutOfRange(row.checkInDistanceM, row.checkInSite)) punches.push(PunchType.CHECK_IN);
  if (isOutOfRange(row.checkOutDistanceM, row.checkOutSite)) punches.push(PunchType.CHECK_OUT);
  return punches;
}
