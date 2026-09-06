import { randomUUID } from 'node:crypto';
import type { AttendanceEvent, AttendanceRecord, Site } from '@prisma/client';
import { AttendanceStatus, PunchOutcome, PunchType, SITE_RADIUS_DEFAULT_M } from '@wasel/contracts';
import type { TestApp } from '../support/index.js';

/**
 * Attendance fixtures for the admin suite.
 *
 * The admin module reads `attendance_records` and `attendance_events` but never
 * writes them — the attendance module owns that — so these helpers insert rows
 * directly. They are deliberately local to this suite rather than added to
 * `test/support`, which the attendance module's own suite also depends on.
 */

export interface SeedSiteOptions {
  name?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  isActive?: boolean;
  deletedAt?: Date | null;
}

export function seedSite(
  ctx: TestApp,
  organizationId: string,
  options: SeedSiteOptions = {},
): Promise<Site> {
  return ctx.prisma.site.create({
    data: {
      organizationId,
      name: options.name ?? `Site ${randomUUID().slice(0, 8)}`,
      latitude: options.latitude ?? 24.7136,
      longitude: options.longitude ?? 46.6753,
      radiusMeters: options.radiusMeters ?? SITE_RADIUS_DEFAULT_M,
      ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
      ...(options.deletedAt === undefined ? {} : { deletedAt: options.deletedAt }),
    },
  });
}

export interface SeedRecordOptions {
  organizationId: string;
  userId: string;
  siteId: string;
  /** `YYYY-MM-DD` in the organization's zone. */
  workDate: string;
  checkInAt?: Date;
  checkOutAt?: Date | null;
  checkOutSiteId?: string | null;
  status?: AttendanceStatus;
  workedMinutes?: number | null;
  lateMinutes?: number;
}

export function seedAttendanceRecord(
  ctx: TestApp,
  options: SeedRecordOptions,
): Promise<AttendanceRecord> {
  const checkInAt = options.checkInAt ?? new Date(`${options.workDate}T05:00:00.000Z`);
  const checkOutAt =
    options.checkOutAt === undefined
      ? new Date(`${options.workDate}T13:00:00.000Z`)
      : options.checkOutAt;

  return ctx.prisma.attendanceRecord.create({
    data: {
      organizationId: options.organizationId,
      userId: options.userId,
      // A `date` column: midnight UTC is how the driver represents a calendar day.
      workDate: new Date(`${options.workDate}T00:00:00.000Z`),
      checkInAt,
      checkInSiteId: options.siteId,
      checkInLatitude: 24.7136,
      checkInLongitude: 46.6753,
      checkInAccuracyM: 12,
      checkInDistanceM: 20,
      checkOutAt,
      checkOutSiteId: checkOutAt === null ? null : (options.checkOutSiteId ?? options.siteId),
      ...(checkOutAt === null
        ? {}
        : {
            checkOutLatitude: 24.7136,
            checkOutLongitude: 46.6753,
            checkOutAccuracyM: 12,
            checkOutDistanceM: 20,
          }),
      status:
        options.status ??
        (checkOutAt === null ? AttendanceStatus.INCOMPLETE : AttendanceStatus.PRESENT),
      workedMinutes:
        options.workedMinutes === undefined
          ? checkOutAt === null
            ? null
            : 480
          : options.workedMinutes,
      lateMinutes: options.lateMinutes ?? 0,
    },
  });
}

export interface SeedEventOptions {
  organizationId: string;
  userId: string;
  workDate: string;
  outcome?: PunchOutcome;
  type?: PunchType;
  siteId?: string | null;
}

export function seedAttendanceEvent(
  ctx: TestApp,
  options: SeedEventOptions,
): Promise<AttendanceEvent> {
  return ctx.prisma.attendanceEvent.create({
    data: {
      organizationId: options.organizationId,
      userId: options.userId,
      workDate: new Date(`${options.workDate}T00:00:00.000Z`),
      type: options.type ?? PunchType.CHECK_IN,
      outcome: options.outcome ?? PunchOutcome.ACCEPTED,
      latitude: 24.7136,
      longitude: 46.6753,
      accuracyM: 15,
      distanceM: 900,
      siteId: options.siteId ?? null,
    },
  });
}
