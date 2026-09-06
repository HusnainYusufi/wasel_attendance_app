import type { Prisma } from '@prisma/client';
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
  checkOutAt: true,
  status: true,
  workedMinutes: true,
  lateMinutes: true,
  user: { select: { fullName: true, email: true, employeeCode: true } },
  checkInSite: { select: { name: true } },
  checkOutSite: { select: { name: true } },
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
};

export type ReportRecord = {
  id: string;
  workDate: Date;
  userId: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  status: AttendanceStatus;
  workedMinutes: number | null;
  lateMinutes: number;
  user: { fullName: string; email: string; employeeCode: string | null };
  checkInSite: { name: string };
  checkOutSite: { name: string } | null;
};

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
    checkInSiteName: row.checkInSite.name,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    checkOutSiteName: row.checkOutSite?.name ?? null,
    status: row.status,
    workedMinutes: row.workedMinutes,
    lateMinutes: row.lateMinutes,
  };
}
