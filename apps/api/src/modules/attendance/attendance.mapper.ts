import type { Prisma } from '@prisma/client';
import {
  AttendanceStatus,
  type AttendanceRecordDto,
  type GeofenceSite,
  type SiteSummary,
} from '@wasel/contracts';
import { workDateFromColumn } from './work-date.js';

/**
 * The site columns a punch needs. `name` is here because an `OUT_OF_RANGE`
 * rejection has to say *which* site the user missed, and a bare "out of range" is
 * a support ticket.
 */
export const GEOFENCE_SITE_SELECT = {
  id: true,
  name: true,
  latitude: true,
  longitude: true,
  radiusMeters: true,
} as const satisfies Prisma.SiteSelect;

/** Only what a `SiteSummary` needs; nothing about a site's address or activity leaks. */
const SITE_SUMMARY_SELECT = { id: true, name: true } as const satisfies Prisma.SiteSelect;

/** Every attendance read joins both sites, because the DTO names both of them. */
export const ATTENDANCE_RECORD_INCLUDE = {
  checkInSite: { select: SITE_SUMMARY_SELECT },
  checkOutSite: { select: SITE_SUMMARY_SELECT },
} as const satisfies Prisma.AttendanceRecordInclude;

export type AttendanceRecordRow = Prisma.AttendanceRecordGetPayload<{
  include: typeof ATTENDANCE_RECORD_INCLUDE;
}>;

export type GeofenceSiteRow = Prisma.SiteGetPayload<{ select: typeof GEOFENCE_SITE_SELECT }>;

/**
 * Row → contract DTO. The only shape that leaves this module.
 *
 * `checkInSite` is nullable here for the same reason `checkOutSite` always was:
 * a site is the point a punch was *measured from*, not a precondition for it. An
 * organization that does not enforce a geofence may have no sites at all, and a
 * punch made there is a complete record with nowhere to measure from.
 *
 * Two conversions are load-bearing. Instants become ISO 8601 strings, per
 * CONVENTIONS §4 — a `Date` crossing the API boundary serialises differently
 * depending on who calls `JSON.stringify`. And `workDate` is decoded from its
 * UTC-midnight carrier rather than formatted from an instant, so the calendar
 * date a client renders is exactly the one the check-in decided in the
 * organization's zone.
 */
export function toAttendanceRecordDto(row: AttendanceRecordRow): AttendanceRecordDto {
  return {
    id: row.id,
    workDate: workDateFromColumn(row.workDate),
    checkInAt: row.checkInAt.toISOString(),
    checkInSite: row.checkInSite ? toSiteSummary(row.checkInSite) : null,
    checkInDistanceM: row.checkInDistanceM,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    checkOutSite: row.checkOutSite ? toSiteSummary(row.checkOutSite) : null,
    checkOutDistanceM: row.checkOutDistanceM,
    status: row.status,
    workedMinutes: row.workedMinutes,
    lateMinutes: row.lateMinutes,
  };
}

export function toSiteSummary(site: { id: string; name: string }): SiteSummary {
  return { id: site.id, name: site.name };
}

/** The shape `findNearestSite` consumes, so client and server run identical maths. */
export function toGeofenceSite(site: GeofenceSiteRow): GeofenceSite {
  return {
    id: site.id,
    name: site.name,
    latitude: site.latitude,
    longitude: site.longitude,
    radiusMeters: site.radiusMeters,
  };
}

/**
 * The day's derived state.
 *
 * `INCOMPLETE` is not a placeholder — it is what a day with no check-out *is*, and
 * it is the third member of the partition the admin report counts
 * (`presentCount + lateCount + incompleteCount = totalRecords`). Storing
 * `PRESENT` on a record nobody ever closed would make a forgotten check-out
 * indistinguishable from a full day's work.
 *
 * Punctuality is not lost while a shift is open: `lateMinutes` is computed once
 * at check-in and never changes, so a client can show "late by 12 min" on a
 * record that is still `INCOMPLETE`.
 *
 * It takes no duration on purpose. A closed day used to be storable with
 * `workedMinutes: 0` and counted in `presentCount` exactly like a full one, and
 * the fix for that is upstream: `checkOut` refuses to close a shift shorter than
 * `MIN_SHIFT_MS`, so an accepted check-out always stores at least one minute.
 * Classifying it here instead would have needed a fourth status — breaking the
 * partition the admin report counts on — or overloaded `INCOMPLETE`, which
 * already means something precise and different.
 */
export function statusFor(checkOutAt: Date | null, lateMinutes: number): AttendanceStatus {
  if (checkOutAt === null) return AttendanceStatus.INCOMPLETE;
  return lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.PRESENT;
}
