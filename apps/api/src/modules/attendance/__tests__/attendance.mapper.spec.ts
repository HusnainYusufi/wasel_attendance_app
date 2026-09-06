import { AttendanceStatus, attendanceRecordSchema, findNearestSite } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import {
  statusFor,
  toAttendanceRecordDto,
  toGeofenceSite,
  toSiteSummary,
  type AttendanceRecordRow,
} from '../attendance.mapper.js';

const SITE_IN = { id: '11111111-1111-4111-8111-111111111111', name: 'Head Office' };
const SITE_OUT = { id: '22222222-2222-4222-8222-222222222222', name: 'Warehouse' };

function row(overrides: Partial<AttendanceRecordRow> = {}): AttendanceRecordRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    organizationId: '44444444-4444-4444-8444-444444444444',
    userId: '55555555-5555-4555-8555-555555555555',
    workDate: new Date('2026-03-02T00:00:00.000Z'),
    checkInAt: new Date('2026-03-01T22:30:00.000Z'),
    checkInSiteId: SITE_IN.id,
    checkInLatitude: 24.7136,
    checkInLongitude: 46.6753,
    checkInAccuracyM: 8,
    checkInDistanceM: 12.4,
    checkOutAt: null,
    checkOutSiteId: null,
    checkOutLatitude: null,
    checkOutLongitude: null,
    checkOutAccuracyM: null,
    checkOutDistanceM: null,
    status: AttendanceStatus.INCOMPLETE,
    workedMinutes: null,
    lateMinutes: 0,
    createdAt: new Date('2026-03-01T22:30:00.000Z'),
    updatedAt: new Date('2026-03-01T22:30:00.000Z'),
    checkInSite: SITE_IN,
    checkOutSite: null,
    ...overrides,
  };
}

describe('toAttendanceRecordDto', () => {
  it('produces exactly the contract shape', () => {
    expect(() => attendanceRecordSchema.parse(toAttendanceRecordDto(row()))).not.toThrow();
  });

  it('decodes the work date from its column carrier rather than from the check-in instant', () => {
    // The check-in happened on 2026-03-01 in UTC but belongs to 2026-03-02 in the
    // organization's zone. Formatting `checkInAt` would silently undo that.
    const dto = toAttendanceRecordDto(row());
    expect(dto.workDate).toBe('2026-03-02');
    expect(dto.checkInAt).toBe('2026-03-01T22:30:00.000Z');
  });

  it('leaves every check-out field null while the shift is open', () => {
    const dto = toAttendanceRecordDto(row());
    expect(dto).toMatchObject({
      checkOutAt: null,
      checkOutSite: null,
      checkOutDistanceM: null,
      workedMinutes: null,
      status: AttendanceStatus.INCOMPLETE,
    });
  });

  it('carries both sites once the day is closed', () => {
    const dto = toAttendanceRecordDto(
      row({
        checkOutAt: new Date('2026-03-02T07:05:00.000Z'),
        checkOutSiteId: SITE_OUT.id,
        checkOutSite: SITE_OUT,
        checkOutDistanceM: 31.2,
        workedMinutes: 515,
        lateMinutes: 4,
        status: AttendanceStatus.LATE,
      }),
    );

    expect(dto.checkInSite).toEqual(SITE_IN);
    expect(dto.checkOutSite).toEqual(SITE_OUT);
    expect(dto.checkOutAt).toBe('2026-03-02T07:05:00.000Z');
    expect(dto).toMatchObject({
      workedMinutes: 515,
      lateMinutes: 4,
      status: AttendanceStatus.LATE,
    });
  });

  it('exposes no column the contract does not declare', () => {
    // A DTO that leaks raw columns is how an internal id reaches a client and
    // then a bug report; the contract's own key set is the assertion.
    expect(Object.keys(toAttendanceRecordDto(row())).sort()).toEqual(
      Object.keys(attendanceRecordSchema.shape).sort(),
    );
  });
});

describe('statusFor', () => {
  it('is INCOMPLETE until the day is closed, whatever the punctuality', () => {
    expect(statusFor(null, 0)).toBe(AttendanceStatus.INCOMPLETE);
    expect(statusFor(null, 42)).toBe(AttendanceStatus.INCOMPLETE);
  });

  it('resolves to PRESENT or LATE on check-out, from the minutes recorded at check-in', () => {
    const closed = new Date('2026-03-02T07:05:00.000Z');
    expect(statusFor(closed, 0)).toBe(AttendanceStatus.PRESENT);
    expect(statusFor(closed, 1)).toBe(AttendanceStatus.LATE);
  });
});

describe('toGeofenceSite', () => {
  const site = {
    id: SITE_IN.id,
    name: SITE_IN.name,
    latitude: 24.7136,
    longitude: 46.6753,
    radiusMeters: 150,
  };

  it('hands the contract everything its geofence maths needs', () => {
    expect(toGeofenceSite(site)).toEqual(site);
  });

  it('treats a distance exactly equal to the radius as inside the fence', () => {
    // The boundary semantics the service depends on: `distanceM <= radiusMeters`.
    // Zero distance against a zero radius is the one case floating point cannot
    // nudge either way, which is what makes this assertion exact.
    const match = findNearestSite({ latitude: site.latitude, longitude: site.longitude }, [
      toGeofenceSite({ ...site, radiusMeters: 0 }),
    ]);
    expect(match).toMatchObject({ distanceM: 0, withinFence: true });
  });

  it('returns the nearest site even when it is out of range, so the user can be told how far', () => {
    const match = findNearestSite({ latitude: 24.8, longitude: 46.6753 }, [toGeofenceSite(site)]);
    expect(match?.withinFence).toBe(false);
    expect(match?.site.name).toBe('Head Office');
    expect(match?.distanceM).toBeGreaterThan(9000);
  });
});

describe('toSiteSummary', () => {
  it('narrows a site to the two fields the contract publishes', () => {
    const row = { ...SITE_IN, latitude: 1, longitude: 2, radiusMeters: 150, isActive: true };
    expect(toSiteSummary(row)).toEqual(SITE_IN);
  });
});
