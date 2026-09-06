import { AttendanceStatus, PunchType, Role, UserStatus } from '@wasel/contracts';
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
        enforceGeofence: true,
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
      enforceGeofence: true,
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
        checkOutAccuracyM: null,
        checkOutDistanceM: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
      }),
    );

    expect(row.checkOutAt).toBeNull();
    expect(row.checkOutSiteName).toBeNull();
    expect(row.checkOutDistanceM).toBeNull();
    expect(row.checkOutAccuracyM).toBeNull();
    expect(row.workedMinutes).toBeNull();
  });

  it('carries the distance and the accuracy of both punches', () => {
    expect(toReportRow(reportRecord())).toMatchObject({
      checkInDistanceM: 20,
      checkInAccuracyM: 12,
      checkOutDistanceM: 31,
      checkOutAccuracyM: 14,
      outOfRange: [],
    });
  });

  it('names the punch that landed outside its own fence', () => {
    const row = toReportRow(reportRecord({ checkInDistanceM: 791_043.2 }));

    // The comparison is distance against *that site's* radius, which is why the
    // radius rides along on the join.
    expect(row.outOfRange).toEqual([PunchType.CHECK_IN]);
    expect(row.checkInDistanceM).toBe(791_043.2);
  });

  it('flags both punches when both were outside', () => {
    expect(
      toReportRow(reportRecord({ checkInDistanceM: 400, checkOutDistanceM: 900 })).outOfRange,
    ).toEqual([PunchType.CHECK_IN, PunchType.CHECK_OUT]);
  });

  it('treats the fence line itself as inside', () => {
    // The stored distance is truncated to a tenth and never rounded up, so a
    // punch the server accepted at exactly the radius must not be reported as a
    // violation by the file that documents it.
    expect(toReportRow(reportRecord({ checkInDistanceM: 150 })).outOfRange).toEqual([]);
    expect(toReportRow(reportRecord({ checkInDistanceM: 150.1 })).outOfRange).toEqual([
      PunchType.CHECK_IN,
    ]);
  });

  it('flags nothing for a record with no site', () => {
    const row = toReportRow(
      reportRecord({ checkInSite: null, checkInDistanceM: null, checkOutSite: null }),
    );

    // A fence that does not exist cannot be outside of. Flagging here would make
    // the column mean "this tenant has no sites" instead of "look at this row".
    expect(row.outOfRange).toEqual([]);
    expect(row.checkInSiteName).toBeNull();
    expect(row.checkInDistanceM).toBeNull();
    // Still recorded: the accuracy is a property of the device, not of the sites.
    expect(row.checkInAccuracyM).toBe(12);
  });
});
