import { describe, expect, it } from 'vitest';
import {
  accuracySchema,
  buildPageMeta,
  dateRangeSchema,
  emailSchema,
  employeeCodeSchema,
  inclusiveDayCount,
  isoDateSchema,
  latitudeSchema,
  longitudeSchema,
  paginationQuerySchema,
  passwordSchema,
  timeOfDaySchema,
  timezoneSchema,
} from '../common.js';
import { loginRequestSchema, changePasswordRequestSchema } from '../auth.js';
import { attendanceHistoryQuerySchema, punchRequestSchema } from '../attendance.js';
import {
  createSiteRequestSchema,
  exportQuerySchema,
  updateOrganizationRequestSchema,
  updateSiteRequestSchema,
  updateUserRequestSchema,
} from '../admin.js';

describe('emailSchema', () => {
  it('normalises to a single canonical form', () => {
    // Without this, `Ali@x.com` and `ali@x.com` become two accounts that can
    // both "successfully" register and only one of which can ever log in.
    expect(emailSchema.parse('  Ali@Example.COM ')).toBe('ali@example.com');
  });

  it.each(['nope', 'a@', '@b.com', 'a b@c.com', ''])('rejects %j', (bad) => {
    expect(emailSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an over-long address', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it.each([
    ['too short', 'Ab1'],
    ['no digit', 'abcdefghijkl'],
    ['no letter', '1234567890'],
    ['over max length', `A1${'x'.repeat(200)}`],
  ])('rejects %s', (_label, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });

  it('accepts a reasonable password', () => {
    expect(passwordSchema.safeParse('Attendance1').success).toBe(true);
  });
});

describe('loginRequestSchema', () => {
  it('does not apply the creation policy to login', () => {
    // Enforcing the *new-password* policy at login would reject legitimate
    // pre-existing credentials and leak which stored passwords are old.
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'old' }).success).toBe(true);
  });

  it('still requires a non-empty password', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
});

describe('changePasswordRequestSchema', () => {
  it('rejects reusing the current password', () => {
    const r = changePasswordRequestSchema.safeParse({
      currentPassword: 'Attendance1',
      newPassword: 'Attendance1',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a genuine change', () => {
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'Attendance1',
        newPassword: 'Attendance2',
      }).success,
    ).toBe(true);
  });
});

describe('accuracySchema', () => {
  it('rejects zero — a real GNSS fix always carries an error estimate', () => {
    expect(accuracySchema.safeParse(0).success).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5, 5001])('rejects %s', (bad) => {
    expect(accuracySchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a typical phone fix', () => {
    expect(accuracySchema.safeParse(12.5).success).toBe(true);
  });
});

describe('coordinate schemas', () => {
  it.each([91, -91, Number.NaN, Number.POSITIVE_INFINITY])('rejects latitude %s', (bad) => {
    expect(latitudeSchema.safeParse(bad).success).toBe(false);
  });

  it.each([181, -181, Number.NaN])('rejects longitude %s', (bad) => {
    expect(longitudeSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts the exact bounds', () => {
    expect(latitudeSchema.safeParse(90).success).toBe(true);
    expect(latitudeSchema.safeParse(-90).success).toBe(true);
    expect(longitudeSchema.safeParse(180).success).toBe(true);
  });

  it('rejects the string "0" rather than silently coercing', () => {
    // A client sending strings must fail loudly; coercion here would let a
    // malformed payload write nonsense coordinates.
    expect(latitudeSchema.safeParse('0').success).toBe(false);
  });
});

describe('timezoneSchema', () => {
  it.each(['Asia/Riyadh', 'UTC', 'America/New_York', 'Europe/London'])('accepts %s', (tz) => {
    expect(timezoneSchema.safeParse(tz).success).toBe(true);
  });

  it.each(['Mars/Phobos', 'Not/A/Zone', ''])('rejects %j', (tz) => {
    expect(timezoneSchema.safeParse(tz).success).toBe(false);
  });
});

describe('timeOfDaySchema', () => {
  it.each(['00:00', '09:30', '23:59'])('accepts %s', (t) => {
    expect(timeOfDaySchema.safeParse(t).success).toBe(true);
  });

  it.each(['24:00', '25:00', '9:30', '09:60', '0930'])('rejects %j', (t) => {
    expect(timeOfDaySchema.safeParse(t).success).toBe(false);
  });
});

describe('isoDateSchema', () => {
  it.each(['2026-03-01', '2024-02-29'])('accepts %s', (d) => {
    expect(isoDateSchema.safeParse(d).success).toBe(true);
  });

  it.each(['2026-13-01', '2026-02-30', '2026-3-1', '01/03/2026'])('rejects %j', (d) => {
    expect(isoDateSchema.safeParse(d).success).toBe(false);
  });
});

describe('employeeCodeSchema', () => {
  it('accepts codes with safe punctuation', () => {
    expect(employeeCodeSchema.safeParse('EMP-001_A.2').success).toBe(true);
  });

  it('rejects codes with characters that break CSV/spreadsheet round-trips', () => {
    expect(employeeCodeSchema.safeParse('EMP,001').success).toBe(false);
    expect(employeeCodeSchema.safeParse('EMP 001').success).toBe(false);
  });
});

describe('inclusiveDayCount', () => {
  it.each([
    ['2026-03-01', '2026-03-01', 1],
    ['2026-03-01', '2026-03-31', 31],
    ['2025-12-31', '2026-01-01', 2],
    ['2024-02-01', '2024-03-01', 30], // leap year
    ['2025-02-01', '2025-03-01', 29], // non-leap
  ])('counts %s..%s as %i days', (from, to, expected) => {
    expect(inclusiveDayCount(from, to)).toBe(expected);
  });

  it('is unaffected by daylight-saving transitions', () => {
    // Computed in UTC on purpose: a local-time implementation returns 30 or 32
    // here depending on the machine's timezone.
    expect(inclusiveDayCount('2026-03-01', '2026-03-31')).toBe(31);
    expect(inclusiveDayCount('2026-10-01', '2026-10-31')).toBe(31);
  });
});

describe('dateRangeSchema', () => {
  it('rejects a reversed range', () => {
    expect(dateRangeSchema.safeParse({ from: '2026-03-10', to: '2026-03-01' }).success).toBe(false);
  });

  it('accepts a single-day range', () => {
    expect(dateRangeSchema.safeParse({ from: '2026-03-01', to: '2026-03-01' }).success).toBe(true);
  });
});

describe('paginationQuerySchema', () => {
  it('applies defaults', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('coerces query-string values, which always arrive as strings', () => {
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it.each([0, -1, 1.5])('rejects page %s', (page) => {
    expect(paginationQuerySchema.safeParse({ page }).success).toBe(false);
  });

  it('caps pageSize so a client cannot request the whole table', () => {
    expect(paginationQuerySchema.safeParse({ pageSize: 1000 }).success).toBe(false);
  });
});

describe('buildPageMeta', () => {
  it('computes a middle page', () => {
    expect(buildPageMeta(2, 25, 60)).toEqual({
      page: 2,
      pageSize: 25,
      total: 60,
      totalPages: 3,
      hasNext: true,
      hasPrevious: true,
    });
  });

  it('reports no navigation for an empty result set', () => {
    expect(buildPageMeta(1, 25, 0)).toEqual({
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    });
  });

  it('reports the last page correctly on an exact boundary', () => {
    const meta = buildPageMeta(2, 25, 50);
    expect(meta.totalPages).toBe(2);
    expect(meta.hasNext).toBe(false);
  });
});

describe('punchRequestSchema', () => {
  it('requires accuracy — a punch without fix quality cannot be trusted', () => {
    expect(punchRequestSchema.safeParse({ latitude: 24.7, longitude: 46.6 }).success).toBe(false);
  });

  it('accepts a valid punch', () => {
    expect(
      punchRequestSchema.safeParse({ latitude: 24.7, longitude: 46.6, accuracy: 8 }).success,
    ).toBe(true);
  });

  it('accepts an offset-bearing device time', () => {
    expect(
      punchRequestSchema.safeParse({
        latitude: 24.7,
        longitude: 46.6,
        accuracy: 8,
        deviceTime: '2026-03-01T08:00:00+03:00',
      }).success,
    ).toBe(true);
  });

  it('rejects a device time without an offset', () => {
    expect(
      punchRequestSchema.safeParse({
        latitude: 24.7,
        longitude: 46.6,
        accuracy: 8,
        deviceTime: '2026-03-01T08:00:00',
      }).success,
    ).toBe(false);
  });
});

describe('attendanceHistoryQuerySchema', () => {
  it('allows an open-ended query', () => {
    expect(attendanceHistoryQuerySchema.safeParse({}).success).toBe(true);
  });

  it('rejects a range beyond the cap', () => {
    expect(
      attendanceHistoryQuerySchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success,
    ).toBe(false);
  });

  it.each([
    ['a lone `from`', { from: '1900-01-01' }],
    ['a lone `to`', { to: '2026-01-01' }],
  ])('rejects %s, which the cap cannot see', (_label, query) => {
    // `?from=1900-01-01` asks for an uncapped count(*); the day-count refine
    // only fires when both bounds are present.
    expect(attendanceHistoryQuerySchema.safeParse(query).success).toBe(false);
  });

  it('names the missing bound so the client can fix it', () => {
    const result = attendanceHistoryQuerySchema.safeParse({ from: '1900-01-01' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['to']);
  });

  it('still accepts a range exactly at the cap', () => {
    expect(
      attendanceHistoryQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success,
    ).toBe(true);
  });
});

describe('admin schemas', () => {
  it('enforces the geofence radius floor', () => {
    // Below ~20 m consumer GPS cannot resolve reliably, so a tighter fence would
    // reject people who are genuinely standing in the office.
    expect(
      createSiteRequestSchema.safeParse({ name: 'HQ', latitude: 1, longitude: 1, radiusMeters: 5 })
        .success,
    ).toBe(false);
  });

  it('rejects an empty patch rather than issuing a no-op write', () => {
    expect(updateUserRequestSchema.safeParse({}).success).toBe(false);
  });

  it('lets an administrator correct an email, through the same normalisation', () => {
    // Without this the only way to fix a typo'd address was to delete the account
    // and make another, which orphans every attendance record onto the
    // soft-deleted row.
    expect(updateUserRequestSchema.parse({ email: '  Ali@Example.COM ' })).toEqual({
      email: 'ali@example.com',
    });

    // Reusing `emailSchema` is the point rather than a convenience: a patch path
    // with looser normalisation would slip `Ali@x.com` past a
    // `(organizationId, email)` index that already holds `ali@x.com`, and the
    // tenant ends up with two accounts for one human, one of which can never sign
    // in.
    expect(updateUserRequestSchema.safeParse({ email: 'not-an-address' }).success).toBe(false);
    expect(
      updateUserRequestSchema.safeParse({ email: `${'a'.repeat(250)}@example.com` }).success,
    ).toBe(false);
  });

  it('still treats an email-only patch as a real patch', () => {
    // The "at least one field" guard reads `Object.values`, so a new optional key
    // has to be visible to it or an email-only edit would be rejected as empty.
    expect(updateUserRequestSchema.safeParse({ email: 'ali@example.com' }).success).toBe(true);
  });

  it('does not inject an isActive default into a site patch', () => {
    // `.partial()` makes a key optional but does NOT strip its `.default()`.
    // Deriving the patch schema from the create schema therefore put
    // `isActive: true` into every request, silently reactivating a geofence when
    // an admin edited an unrelated field on a site they had deliberately closed —
    // and it defeated the empty-patch guard, since `{}` parsed to a non-empty object.
    const patched = updateSiteRequestSchema.parse({ name: 'Renamed' });
    expect(patched).toEqual({ name: 'Renamed' });
    expect('isActive' in patched).toBe(false);

    expect(updateSiteRequestSchema.safeParse({}).success).toBe(false);

    // An explicit value must still come through, in both directions.
    expect(updateSiteRequestSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(updateSiteRequestSchema.parse({ isActive: true })).toEqual({ isActive: true });
  });

  it('still applies the isActive default when creating a site', () => {
    expect(
      createSiteRequestSchema.parse({
        name: 'HQ',
        latitude: 24.7,
        longitude: 46.6,
        radiusMeters: 150,
      }).isActive,
    ).toBe(true);
  });

  it('rejects an inverted workday', () => {
    expect(
      updateOrganizationRequestSchema.safeParse({ workdayStart: '18:00', workdayEnd: '09:00' })
        .success,
    ).toBe(false);
  });

  it('caps the export range to bound the query', () => {
    expect(exportQuerySchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success).toBe(
      false,
    );
  });

  it('defaults the export format to xlsx', () => {
    expect(exportQuerySchema.parse({ from: '2026-03-01', to: '2026-03-31' }).format).toBe('xlsx');
  });

  it('rejects a reversed export range', () => {
    expect(exportQuerySchema.safeParse({ from: '2026-03-31', to: '2026-03-01' }).success).toBe(
      false,
    );
  });
});
