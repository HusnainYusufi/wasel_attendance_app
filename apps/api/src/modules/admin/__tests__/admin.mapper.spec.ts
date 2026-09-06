import { AttendanceStatus, Role, UserStatus } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_USER_SELECT,
  toOrganizationDto,
  toReportRow,
  toSiteDto,
  toUserDto,
} from '../admin.mapper.js';
import { reportRecord } from './fixtures.js';

describe('ADMIN_USER_SELECT', () => {
  it('cannot select a secret', () => {
    // The selection is the security boundary: a column absent here cannot reach
    // a response, a log or an exported spreadsheet, whatever a caller asks for.
    for (const column of ['passwordHash', 'tokenVersion', 'failedLoginAttempts', 'lockedUntil']) {
      expect(ADMIN_USER_SELECT).not.toHaveProperty(column);
    }
  });
});

describe('toUserDto', () => {
  it('renders dates as ISO strings and preserves a null last login', () => {
    const dto = toUserDto({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'sara@wasel.test',
      fullName: 'Sara Haddad',
      employeeCode: 'EMP-1',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      lastLoginAt: null,
      createdAt: new Date('2026-01-05T09:00:00.000Z'),
    });

    expect(dto).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'sara@wasel.test',
      fullName: 'Sara Haddad',
      employeeCode: 'EMP-1',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      lastLoginAt: null,
      createdAt: '2026-01-05T09:00:00.000Z',
    });
  });
});

describe('toSiteDto', () => {
  it('maps the geofence verbatim', () => {
    const dto = toSiteDto({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Head Office',
      address: null,
      latitude: 24.7136,
      longitude: 46.6753,
      radiusMeters: 150,
      isActive: true,
      createdAt: new Date('2026-01-05T09:00:00.000Z'),
    });

    expect(dto).toMatchObject({ latitude: 24.7136, longitude: 46.6753, radiusMeters: 150 });
    expect(dto.createdAt).toBe('2026-01-05T09:00:00.000Z');
  });
});

describe('toOrganizationDto', () => {
  it('exposes the policy the mobile client needs and nothing else', () => {
    expect(
      toOrganizationDto({
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Wasel',
        slug: 'wasel',
        timezone: 'Asia/Riyadh',
        workdayStart: '08:00',
        workdayEnd: '17:00',
        dayStartsAt: '00:00',
        lateGraceMinutes: 15,
        maxAccuracyMeters: 100,
      }),
    ).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Wasel',
      slug: 'wasel',
      timezone: 'Asia/Riyadh',
      workdayStart: '08:00',
      workdayEnd: '17:00',
      dayStartsAt: '00:00',
      lateGraceMinutes: 15,
      maxAccuracyMeters: 100,
    });
  });
});

describe('toReportRow', () => {
  it('flattens the joins and renders the work date as a calendar day', () => {
    expect(toReportRow(reportRecord())).toMatchObject({
      workDate: '2026-03-01',
      userFullName: 'Sara Haddad',
      userEmail: 'sara@wasel.test',
      employeeCode: 'EMP-1',
      checkInAt: '2026-03-01T05:47:00.000Z',
      checkInSiteName: 'Head Office',
      checkOutAt: '2026-03-01T14:03:00.000Z',
      checkOutSiteName: 'Head Office',
      status: AttendanceStatus.PRESENT,
    });
  });

  it('leaves an open shift null rather than inventing a check-out', () => {
    const row = toReportRow(
      reportRecord({
        checkOutAt: null,
        checkOutSite: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
      }),
    );

    expect(row.checkOutAt).toBeNull();
    expect(row.checkOutSiteName).toBeNull();
    expect(row.workedMinutes).toBeNull();
  });
});
