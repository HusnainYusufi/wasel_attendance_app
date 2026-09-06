import { ReminderKind, Role } from '@wasel/contracts';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../common/auth/auth-context.js';
import { ClockService } from '../../../common/clock/clock.service.js';
import { AppException } from '../../../common/errors/app.exception.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { MAX_CARRY_OVER_SHIFT_MS } from '../../attendance/attendance.constants.js';
import { RemindersService } from '../reminders.service.js';

const ORG_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const RIYADH = 'Asia/Riyadh';

const AUTH: AuthContext = {
  userId: USER_ID,
  organizationId: ORG_ID,
  role: Role.MEMBER,
  tokenVersion: 0,
};

const POLICY = {
  timezone: RIYADH,
  workdayStart: '09:00',
  workdayEnd: '18:00',
  dayStartsAt: '00:00',
};

const wall = (iso: string): Date => DateTime.fromISO(iso, { zone: RIYADH }).toJSDate();

/** How a `@db.Date` column comes back: the calendar date at UTC midnight. */
const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

interface RecordRow {
  id: string;
  workDate: Date;
  checkInAt: Date;
  checkOutAt: Date | null;
}

function openRecord(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: RECORD_ID,
    workDate: dateColumn('2026-03-10'),
    checkInAt: wall('2026-03-10T09:12'),
    checkOutAt: null,
    ...overrides,
  };
}

class StaticClock extends ClockService {
  constructor(private readonly current: Date) {
    super();
  }
  override now(): Date {
    return new Date(this.current);
  }
}

interface HarnessOptions {
  now?: Date;
  policy?: Partial<typeof POLICY> | null;
  records?: RecordRow[];
}

function harness(options: HarnessOptions = {}) {
  const recordFindMany = vi.fn().mockResolvedValue(options.records ?? []);
  const organizationFindUnique = vi
    .fn()
    .mockResolvedValue(options.policy === null ? null : { ...POLICY, ...options.policy });

  const prisma = {
    organization: { findUnique: organizationFindUnique },
    attendanceRecord: { findMany: recordFindMany },
  };

  const service = new RemindersService(
    prisma as unknown as PrismaService,
    new StaticClock(options.now ?? wall('2026-03-10T09:13')),
  );

  return { service, recordFindMany, organizationFindUnique };
}

describe('RemindersService.schedule', () => {
  it('plans the open shift', async () => {
    const { service } = harness({ records: [openRecord()] });

    const result = await service.schedule(AUTH);

    expect(result.reminders.map((reminder) => reminder.kind)).toEqual([
      ReminderKind.STILL_THERE,
      ReminderKind.CHECKOUT_SOON,
    ]);
    expect(result.serverTime).toBe(wall('2026-03-10T09:13').toISOString());
  });

  it('returns the identical plan when the same shift is asked for twice', async () => {
    // The client re-fetches on resume and after every token refresh; two calls
    // that disagreed would leave the device holding duplicate alarms.
    const { service } = harness({ records: [openRecord()] });

    const first = await service.schedule(AUTH);
    const second = await service.schedule(AUTH);

    expect(second.reminders).toEqual(first.reminders);
  });

  it('returns nothing once the shift is checked out', async () => {
    const { service } = harness({
      records: [openRecord({ checkOutAt: wall('2026-03-10T17:05') })],
    });

    await expect(service.schedule(AUTH)).resolves.toMatchObject({ reminders: [] });
  });

  it('returns nothing when there is no record at all', async () => {
    const { service } = harness({ records: [] });

    await expect(service.schedule(AUTH)).resolves.toMatchObject({ reminders: [] });
  });

  it('scopes the lookup to the caller and their tenant', async () => {
    const { service, recordFindMany } = harness();

    await service.schedule(AUTH);

    expect(recordFindMany).toHaveBeenCalledTimes(1);
    const where = recordFindMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['userId']).toBe(USER_ID);
    expect(where['organizationId']).toBe(ORG_ID);
    // Yesterday and today, so an overnight shift is still found.
    expect(where['workDate']).toEqual({
      in: [dateColumn('2026-03-09'), dateColumn('2026-03-10')],
    });
  });

  it('never selects a column that could leak beyond the plan', async () => {
    const { service, recordFindMany } = harness();

    await service.schedule(AUTH);

    expect(recordFindMany.mock.calls[0]?.[0]?.select).toEqual({
      id: true,
      workDate: true,
      checkInAt: true,
      checkOutAt: true,
    });
  });
});

describe('RemindersService.schedule — the overnight shift', () => {
  const nightPolicy = { timezone: RIYADH, workdayStart: '23:00', workdayEnd: '07:00' };

  it('plans a shift carried over from the previous business date', async () => {
    const { service } = harness({
      policy: nightPolicy,
      now: wall('2026-03-11T00:30'),
      records: [
        openRecord({ workDate: dateColumn('2026-03-10'), checkInAt: wall('2026-03-10T23:10') }),
      ],
    });

    const result = await service.schedule(AUTH);

    // Measured against the business date the record carries, not against today:
    // its 07:00 end is a few hours away, so the plan is live.
    expect(result.reminders.map((reminder) => reminder.kind)).toEqual([
      ReminderKind.STILL_THERE,
      ReminderKind.CHECKOUT_SOON,
    ]);
  });

  it('ignores a carried-over shift once the carry-over window has closed', async () => {
    const staleCheckIn = wall('2026-03-10T23:10');
    const { service } = harness({
      policy: nightPolicy,
      now: new Date(staleCheckIn.getTime() + MAX_CARRY_OVER_SHIFT_MS + 60_000),
      records: [openRecord({ workDate: dateColumn('2026-03-10'), checkInAt: staleCheckIn })],
    });

    await expect(service.schedule(AUTH)).resolves.toMatchObject({ reminders: [] });
  });

  it('ignores yesterday’s unclosed record once today has one of its own', async () => {
    // The attendance module's rule: a record for the current business date
    // withdraws the carry-over, and yesterday's stays open for an administrator
    // to settle. Reminders must agree, or the app would nudge somebody the
    // punch endpoints consider checked out.
    const { service } = harness({
      now: wall('2026-03-10T10:00'),
      records: [
        openRecord({
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          workDate: dateColumn('2026-03-09'),
          checkInAt: wall('2026-03-09T23:00'),
        }),
        openRecord({
          workDate: dateColumn('2026-03-10'),
          checkInAt: wall('2026-03-10T08:00'),
          checkOutAt: wall('2026-03-10T09:30'),
        }),
      ],
    });

    await expect(service.schedule(AUTH)).resolves.toMatchObject({ reminders: [] });
  });
});

describe('RemindersService.schedule — the tenant', () => {
  it('reads only the workday policy from the organization', async () => {
    const { service, organizationFindUnique } = harness();

    await service.schedule(AUTH);

    expect(organizationFindUnique).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: { timezone: true, workdayStart: true, workdayEnd: true, dayStartsAt: true },
    });
  });

  it('refuses the request when the tenant has vanished under the token', async () => {
    const { service } = harness({ policy: null });

    await expect(service.schedule(AUTH)).rejects.toBeInstanceOf(AppException);
  });

  it('uses the organization timezone rather than the process one', async () => {
    const { service } = harness({
      policy: { timezone: 'America/Los_Angeles' },
      now: new Date('2026-03-10T17:13:00.000Z'),
      records: [openRecord({ checkInAt: new Date('2026-03-10T17:12:00.000Z') })],
    });

    const result = await service.schedule(AUTH);

    // 17:12Z is 09:12 in Los Angeles, so the 18:00 end is 01:00Z the next day
    // and both reminders fall on the far side of midnight UTC.
    expect(result.reminders).toHaveLength(2);
    for (const reminder of result.reminders) {
      expect(Date.parse(reminder.at)).toBeLessThan(Date.parse('2026-03-11T01:00:00.000Z'));
      expect(Date.parse(reminder.at)).toBeGreaterThan(Date.parse('2026-03-10T17:12:00.000Z'));
    }
  });
});
