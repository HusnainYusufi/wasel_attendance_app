import { AttendanceStatus } from '@wasel/contracts';
import type { ReportRecord } from '../admin.mapper.js';

/** A complete, checked-out attendance line. Override only what a test is about. */
export function reportRecord(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    // A `@db.Date` column arrives as midnight UTC.
    workDate: new Date('2026-03-01T00:00:00.000Z'),
    userId: '22222222-2222-4222-8222-222222222222',
    checkInAt: new Date('2026-03-01T05:47:00.000Z'),
    checkInAccuracyM: 12,
    checkInDistanceM: 20,
    checkOutAt: new Date('2026-03-01T14:03:00.000Z'),
    checkOutAccuracyM: 14,
    checkOutDistanceM: 31,
    status: AttendanceStatus.PRESENT,
    workedMinutes: 496,
    lateMinutes: 0,
    user: { fullName: 'Sara Haddad', email: 'sara@wasel.test', employeeCode: 'EMP-1' },
    // Both punches comfortably inside the fence, so a test about anything else
    // is not silently also a test about being out of range.
    checkInSite: { name: 'Head Office', radiusMeters: 150 },
    checkOutSite: { name: 'Head Office', radiusMeters: 150 },
    ...overrides,
  };
}
