import {
  AttendanceSource,
  AttendanceStatus,
  ErrorCode,
  PunchOutcome,
  PunchType,
  Role,
  type PunchRequest,
} from '@wasel/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../common/auth/auth-context.js';
import { ClockService } from '../../../common/clock/clock.service.js';
import { AppException } from '../../../common/errors/app.exception.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { ClientInfo } from '../../auth/client-context.js';
import { AttendanceEventService } from '../attendance-event.service.js';
import { MAX_CARRY_OVER_SHIFT_MS } from '../attendance.constants.js';
import { AttendanceService } from '../attendance.service.js';
import type { AttendanceRecordRow } from '../attendance.mapper.js';

const ORG_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const HQ = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Head Office',
  latitude: 24.7136,
  longitude: 46.6753,
  radiusMeters: 150,
};
const WAREHOUSE = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Warehouse',
  latitude: 24.8,
  longitude: 46.6753,
  radiusMeters: 150,
};

const AUTH: AuthContext = {
  userId: USER_ID,
  organizationId: ORG_ID,
  role: Role.MEMBER,
  tokenVersion: 0,
};
const CLIENT: ClientInfo = { ipAddress: '203.0.113.7', userAgent: 'vitest' };

/** 09:20 local in Riyadh — five minutes past a 09:00 start with fifteen of grace. */
const NOW = new Date('2026-03-01T06:20:00.000Z');

const POLICY = {
  timezone: 'Asia/Riyadh',
  workdayStart: '09:00',
  // The default boundary. A 09:00–17:00 tenant is a calendar-day tenant, and
  // every assertion below is the behaviour that shipped before the boundary
  // became configurable.
  dayStartsAt: '00:00',
  lateGraceMinutes: 15,
  maxAccuracyMeters: 100,
  // The default, and the behaviour every assertion in this file was written
  // against. The non-enforcing tenant is exercised in its own describe block
  // below, by overriding this.
  enforceGeofence: true,
};

const SITE_SUMMARY = { id: HQ.id, name: HQ.name };

const AT_HQ: PunchRequest = { latitude: HQ.latitude, longitude: HQ.longitude, accuracy: 8 };
const AT_HOME: PunchRequest = { latitude: 24.75, longitude: 46.72, accuracy: 8 };

class StaticClock extends ClockService {
  constructor(private readonly current: Date) {
    super();
  }
  override now(): Date {
    return new Date(this.current);
  }
}

/** A `P2002` shaped the way the driver adapter reports one, for the race branch. */
function uniqueViolation(fields: string[]): Error & { name: string; code: string; meta: unknown } {
  return Object.assign(new Error('Unique constraint failed'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
    meta: { target: fields },
  });
}

function recordRow(overrides: Partial<AttendanceRecordRow> = {}): AttendanceRecordRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    organizationId: ORG_ID,
    userId: USER_ID,
    workDate: new Date('2026-03-01T00:00:00.000Z'),
    checkInAt: new Date('2026-03-01T06:20:00.000Z'),
    checkInSiteId: HQ.id,
    checkInLatitude: HQ.latitude,
    checkInLongitude: HQ.longitude,
    checkInAccuracyM: 8,
    checkInDistanceM: 0,
    checkOutAt: null,
    checkOutSiteId: null,
    checkOutLatitude: null,
    checkOutLongitude: null,
    checkOutAccuracyM: null,
    // Provenance. Present on every row so that a hand-entered record is never
    // identified by the *absence* of a field — a punched record says PUNCH.
    source: AttendanceSource.PUNCH,
    enteredById: null,
    enteredAt: null,
    note: null,
    checkOutDistanceM: null,
    status: AttendanceStatus.INCOMPLETE,
    workedMinutes: null,
    lateMinutes: 5,
    createdAt: NOW,
    updatedAt: NOW,
    checkInSite: SITE_SUMMARY,
    checkOutSite: null,
    ...overrides,
  };
}

interface Harness {
  service: AttendanceService;
  siteFindMany: ReturnType<typeof vi.fn>;
  recordFindMany: ReturnType<typeof vi.fn>;
  recordCreate: ReturnType<typeof vi.fn>;
  recordUpdateMany: ReturnType<typeof vi.fn>;
  recordCount: ReturnType<typeof vi.fn>;
  eventCreate: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  now?: Date;
  policy?: Partial<typeof POLICY>;
  sites?: Array<typeof HQ>;
  existing?: AttendanceRecordRow[];
  updatedCount?: number;
}

/**
 * A Prisma stand-in carrying only the surface this service touches.
 *
 * Hand-written rather than generated, because what these tests are about is the
 * *order* the gates run in and the audit row each one leaves behind — and a mock
 * that records its calls is what makes both assertable. The real
 * `AttendanceEventService` is wired in on purpose, so the event shape under test
 * is the one production writes.
 */
function harness(options: HarnessOptions = {}): Harness {
  const siteFindMany = vi.fn().mockResolvedValue(options.sites ?? [HQ]);
  const recordFindMany = vi.fn().mockResolvedValue(options.existing ?? []);
  const recordCreate = vi
    .fn()
    .mockImplementation(({ data }: { data: AttendanceRecordRow }) =>
      Promise.resolve(recordRow({ ...data, checkInSite: { id: HQ.id, name: HQ.name } })),
    );
  const recordUpdateMany = vi.fn().mockResolvedValue({ count: options.updatedCount ?? 1 });
  const recordCount = vi.fn().mockResolvedValue(0);
  const eventCreate = vi.fn().mockResolvedValue({});

  const prisma = {
    organization: { findUnique: vi.fn().mockResolvedValue({ ...POLICY, ...options.policy }) },
    site: { findMany: siteFindMany },
    attendanceRecord: {
      findMany: recordFindMany,
      create: recordCreate,
      updateMany: recordUpdateMany,
      count: recordCount,
      // Re-reads the row *after* the update, exactly as the real client does.
      // Returning the pre-update row instead would let every check-out assertion
      // pass against mock arguments while `PunchResponse.record` shipped a stale
      // record — a regression no assertion on `updateMany` can see.
      findUniqueOrThrow: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const before = options.existing?.find((row) => row.id === where.id) ?? recordRow();
        const patch =
          (recordUpdateMany.mock.calls.at(-1)?.[0] as { data?: Partial<AttendanceRecordRow> })
            ?.data ?? {};
        return Promise.resolve(
          recordRow({
            ...before,
            ...patch,
            checkOutSite: patch.checkOutSiteId === undefined ? before.checkOutSite : SITE_SUMMARY,
          }),
        );
      }),
    },
    attendanceEvent: { create: eventCreate },
    $transaction: vi.fn((work: unknown) =>
      typeof work === 'function'
        ? (work as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(work as Promise<unknown>[]),
    ),
  };

  const service = new AttendanceService(
    prisma as unknown as PrismaService,
    new AttendanceEventService(prisma as unknown as PrismaService),
    new StaticClock(options.now ?? NOW),
  );

  return {
    service,
    siteFindMany,
    recordFindMany,
    recordCreate,
    recordUpdateMany,
    recordCount,
    eventCreate,
  };
}

/** The one audit row the attempt should have written. */
function soleEvent(h: Harness): Record<string, unknown> {
  expect(h.eventCreate).toHaveBeenCalledTimes(1);
  return (h.eventCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
}

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    return error as AppException;
  }
  throw new Error('Expected the punch to be rejected');
}

describe('check-in', () => {
  it('creates the day and its audit row in a single transaction', async () => {
    const h = harness();

    const response = await h.service.checkIn(AUTH, AT_HQ, CLIENT);

    expect(response).toMatchObject({
      outcome: PunchOutcome.ACCEPTED,
      type: PunchType.CHECK_IN,
      site: { id: HQ.id, name: HQ.name },
      distanceM: 0,
    });
    // Both writes go through the same transaction callback, so an accepted punch
    // can never be left without its audit row.
    expect(h.recordCreate).toHaveBeenCalledTimes(1);
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.ACCEPTED, siteId: HQ.id });
  });

  it('stores the work date computed in the organization zone, not the UTC date', async () => {
    // 01:30 on the 2nd in Riyadh; the UTC date is still the 1st.
    const h = harness({ now: new Date('2026-03-01T22:30:00.000Z') });

    await h.service.checkIn(AUTH, AT_HQ, CLIENT);

    const { data } = h.recordCreate.mock.calls[0]?.[0] as { data: { workDate: Date } };
    expect(data.workDate.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('ignores deviceTime entirely when deciding the work date', async () => {
    const h = harness();

    // A phone whose clock says last week must not be able to backdate a punch.
    await h.service.checkIn(AUTH, { ...AT_HQ, deviceTime: '2026-02-20T09:00:00.000Z' }, CLIENT);

    const { data } = h.recordCreate.mock.calls[0]?.[0] as { data: { workDate: Date } };
    expect(data.workDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    // It is still recorded, because a lying clock is exactly what an auditor wants.
    expect(soleEvent(h)['deviceTime']).toEqual(new Date('2026-02-20T09:00:00.000Z'));
  });

  it('classifies punctuality from the organization wall clock', async () => {
    const h = harness();

    await h.service.checkIn(AUTH, AT_HQ, CLIENT);

    const { data } = h.recordCreate.mock.calls[0]?.[0] as {
      data: { lateMinutes: number; status: string };
    };
    // 09:20 local against a 09:00 start with 15 minutes of grace.
    expect(data.lateMinutes).toBe(5);
    // The day is INCOMPLETE until it is closed; `lateMinutes` carries the verdict.
    expect(data.status).toBe(AttendanceStatus.INCOMPLETE);
  });

  it('only ever measures against active, non-deleted sites in the caller tenant', async () => {
    const h = harness();

    await h.service.checkIn(AUTH, AT_HQ, CLIENT);

    expect(h.siteFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, isActive: true, deletedAt: null },
      }),
    );
  });

  it('rejects a fix too imprecise to prove anything, before judging the fence', async () => {
    const h = harness();

    const error = await failure(h.service.checkIn(AUTH, { ...AT_HOME, accuracy: 3000 }, CLIENT));

    expect(error.getStatus()).toBe(422);
    expect(error.code).toBe(ErrorCode.LOW_GPS_ACCURACY);
    // The user is also nowhere near the office, but accuracy is judged first: a
    // ±3 km fix is not evidence of being anywhere in particular.
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_LOW_ACCURACY });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it('records where a low-accuracy attempt was made, not just that it failed', async () => {
    const h = harness();

    await failure(h.service.checkIn(AUTH, { ...AT_HQ, accuracy: 3000 }, CLIENT));

    // "±3 km, standing at the office" and "±3 km, forty kilometres away" are very
    // different stories, and the outcome code alone cannot tell them apart.
    expect(soleEvent(h)).toMatchObject({ siteId: HQ.id, distanceM: 0, accuracyM: 3000 });
  });

  it('accepts a fix exactly at the accuracy limit', async () => {
    const h = harness();

    await expect(
      h.service.checkIn(AUTH, { ...AT_HQ, accuracy: 100 }, CLIENT),
    ).resolves.toMatchObject({ outcome: PunchOutcome.ACCEPTED });
  });

  it('refuses to punch a tenant that has no active site', async () => {
    const h = harness({ sites: [] });

    const error = await failure(h.service.checkIn(AUTH, AT_HQ, CLIENT));

    expect(error.getStatus()).toBe(422);
    expect(error.code).toBe(ErrorCode.NO_ACTIVE_SITE);
    expect(soleEvent(h)).toMatchObject({
      outcome: PunchOutcome.REJECTED_NO_ACTIVE_SITE,
      siteId: null,
      distanceM: null,
    });
  });

  it('tells an out-of-range user how far they are and from which site', async () => {
    const h = harness();

    const error = await failure(h.service.checkIn(AUTH, AT_HOME, CLIENT));

    expect(error.getStatus()).toBe(422);
    expect(error.code).toBe(ErrorCode.OUT_OF_RANGE);
    // A bare "out of range" is a support ticket; the site and the distance are
    // the two facts that let the user act.
    expect(error.message).toContain('Head Office');
    expect(error.message).toMatch(/\d/);
    expect(soleEvent(h)).toMatchObject({
      outcome: PunchOutcome.REJECTED_OUT_OF_RANGE,
      siteId: HQ.id,
    });
  });

  it('measures against the nearest site when a tenant has several', async () => {
    const h = harness({ sites: [WAREHOUSE, HQ] });

    await expect(h.service.checkIn(AUTH, AT_HQ, CLIENT)).resolves.toMatchObject({
      site: { name: 'Head Office' },
    });
  });

  it('refuses a second check-in on the same work date', async () => {
    const h = harness({ existing: [recordRow()] });

    const error = await failure(h.service.checkIn(AUTH, AT_HQ, CLIENT));

    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(ErrorCode.ALREADY_CHECKED_IN);
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_ALREADY_CHECKED_IN });
  });

  it('loses the double-tap race at the unique index, not in application logic', async () => {
    const h = harness();
    // Both requests saw an empty day; the index is what arbitrates.
    h.recordCreate.mockRejectedValue(uniqueViolation(['userId', 'workDate']));

    const error = await failure(h.service.checkIn(AUTH, AT_HQ, CLIENT));

    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(ErrorCode.ALREADY_CHECKED_IN);
    // The loser is audited too: a punch attempt that left no row is a dropped
    // audit entry, which CONVENTIONS §2.5 forbids.
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_ALREADY_CHECKED_IN });
  });

  it('does not mistake an unrelated unique violation for a duplicate check-in', async () => {
    const h = harness();
    h.recordCreate.mockRejectedValue(uniqueViolation(['organizationId', 'name']));

    await expect(h.service.checkIn(AUTH, AT_HQ, CLIENT)).rejects.not.toBeInstanceOf(AppException);
  });
});

describe('check-out', () => {
  const openToday = recordRow();
  const closedToday = recordRow({
    checkOutAt: new Date('2026-03-01T14:00:00.000Z'),
    checkOutSiteId: HQ.id,
    checkOutSite: { id: HQ.id, name: HQ.name },
    workedMinutes: 460,
    status: AttendanceStatus.PRESENT,
  });

  it('closes the open day and records the shift length', async () => {
    const h = harness({ now: new Date('2026-03-01T14:20:00.000Z'), existing: [openToday] });

    await h.service.checkOut(AUTH, AT_HQ, CLIENT);

    const [call] = h.recordUpdateMany.mock.calls;
    const { where, data } = call?.[0] as {
      where: Record<string, unknown>;
      data: { workedMinutes: number; status: string };
    };
    // `checkOutAt: null` in the filter is the arbiter for a double tap.
    expect(where).toMatchObject({ id: openToday.id, userId: USER_ID, checkOutAt: null });
    expect(data.workedMinutes).toBe(480);
    expect(data.status).toBe(AttendanceStatus.LATE);
    expect(soleEvent(h)).toMatchObject({
      outcome: PunchOutcome.ACCEPTED,
      type: PunchType.CHECK_OUT,
    });
  });

  it('answers with the record as it now stands, not as it was', async () => {
    const h = harness({ now: new Date('2026-03-01T14:20:00.000Z'), existing: [openToday] });

    const response = await h.service.checkOut(AUTH, AT_HQ, CLIENT);

    // The DTO is what the client renders; asserting only on the `updateMany`
    // arguments would pass just as happily if the response carried the row from
    // before the update — still open, still INCOMPLETE, no worked minutes.
    expect(response.record).toMatchObject({
      id: openToday.id,
      workDate: '2026-03-01',
      checkOutAt: '2026-03-01T14:20:00.000Z',
      checkOutSite: { name: 'Head Office' },
      workedMinutes: 480,
      status: AttendanceStatus.LATE,
      lateMinutes: 5,
    });
    expect(response).toMatchObject({
      outcome: PunchOutcome.ACCEPTED,
      type: PunchType.CHECK_OUT,
      distanceM: 0,
    });
  });

  it('refuses a check-out taken in the same breath as the check-in', async () => {
    // `now` is `openToday.checkInAt`: the double tap that used to store a
    // zero-minute PRESENT day and lock the employee out of the day they were
    // about to work.
    const h = harness({ existing: [openToday] });

    const error = await failure(h.service.checkOut(AUTH, AT_HQ, CLIENT));

    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(ErrorCode.SHIFT_TOO_SHORT);
    // The shift stays open, which is the only recoverable outcome.
    expect(h.recordUpdateMany).not.toHaveBeenCalled();
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_SHIFT_TOO_SHORT });
  });

  it('accepts the shortest shift it will store, and never stores zero', async () => {
    const h = harness({
      now: new Date(openToday.checkInAt.getTime() + 60_000),
      existing: [openToday],
    });

    const response = await h.service.checkOut(AUTH, AT_HQ, CLIENT);

    expect(response.record.workedMinutes).toBe(1);
  });

  it('reports PRESENT when the day was opened on time', async () => {
    const h = harness({
      now: new Date('2026-03-01T14:20:00.000Z'),
      existing: [recordRow({ lateMinutes: 0 })],
    });

    await h.service.checkOut(AUTH, AT_HQ, CLIENT);

    const { data } = h.recordUpdateMany.mock.calls[0]?.[0] as { data: { status: string } };
    expect(data.status).toBe(AttendanceStatus.PRESENT);
  });

  it('says "not checked in" rather than "out of range" when there is nothing open', async () => {
    const h = harness();

    // The user is at home *and* never checked in. Reporting the geofence would
    // send them chasing the wrong problem.
    const error = await failure(h.service.checkOut(AUTH, AT_HOME, CLIENT));

    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(ErrorCode.NOT_CHECKED_IN);
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_NOT_CHECKED_IN });
  });

  it('refuses a second check-out on a day already closed', async () => {
    const h = harness({ existing: [closedToday] });

    const error = await failure(h.service.checkOut(AUTH, AT_HQ, CLIENT));

    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(ErrorCode.ALREADY_CHECKED_OUT);
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_ALREADY_CHECKED_OUT });
  });

  it('loses a simultaneous check-out at the conditional update', async () => {
    const h = harness({
      now: new Date('2026-03-01T14:20:00.000Z'),
      existing: [openToday],
      updatedCount: 0,
    });

    const error = await failure(h.service.checkOut(AUTH, AT_HQ, CLIENT));

    expect(error.code).toBe(ErrorCode.ALREADY_CHECKED_OUT);
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_ALREADY_CHECKED_OUT });
  });

  it('still applies the accuracy and geofence gates', async () => {
    const h = harness({ now: new Date('2026-03-01T14:20:00.000Z'), existing: [openToday] });

    const error = await failure(h.service.checkOut(AUTH, AT_HOME, CLIENT));

    expect(error.code).toBe(ErrorCode.OUT_OF_RANGE);
    expect(soleEvent(h)).toMatchObject({
      outcome: PunchOutcome.REJECTED_OUT_OF_RANGE,
      type: PunchType.CHECK_OUT,
    });
    expect(h.recordUpdateMany).not.toHaveBeenCalled();
  });
});

describe('the overnight shift', () => {
  // Checked in at 23:50 local on the 1st; it is now 00:10 local on the 2nd.
  const yesterdayOpen = recordRow({
    workDate: new Date('2026-03-01T00:00:00.000Z'),
    checkInAt: new Date('2026-03-01T20:50:00.000Z'),
    lateMinutes: 0,
  });
  const JUST_AFTER_MIDNIGHT = new Date('2026-03-01T21:10:00.000Z');

  it('closes the previous work date rather than losing the punch to the calendar', async () => {
    const h = harness({ now: JUST_AFTER_MIDNIGHT, existing: [yesterdayOpen] });

    await h.service.checkOut(AUTH, AT_HQ, CLIENT);

    const { where, data } = h.recordUpdateMany.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { workedMinutes: number };
    };
    expect(where.id).toBe(yesterdayOpen.id);
    expect(data.workedMinutes).toBe(20);
  });

  it('files the audit row under the work date the attempt happened on', async () => {
    const h = harness({ now: JUST_AFTER_MIDNIGHT, existing: [yesterdayOpen] });

    await h.service.checkOut(AUTH, AT_HQ, CLIENT);

    // The record it closed belongs to the 1st; the attempt itself happened on the
    // 2nd, and the event log records when things happened.
    expect(soleEvent(h)['workDate']).toEqual(new Date('2026-03-02T00:00:00.000Z'));
  });

  it('refuses to attach a punch to a shift nobody was working', async () => {
    const h = harness({
      now: new Date(yesterdayOpen.checkInAt.getTime() + MAX_CARRY_OVER_SHIFT_MS + 60_000),
      existing: [yesterdayOpen],
    });

    const error = await failure(h.service.checkOut(AUTH, AT_HQ, CLIENT));

    // Beyond the cap the record stays INCOMPLETE for an administrator to settle;
    // silently manufacturing a nineteen-hour day would be worse than a refusal.
    expect(error.code).toBe(ErrorCode.NOT_CHECKED_IN);
    expect(h.recordUpdateMany).not.toHaveBeenCalled();
  });

  it('treats a fresh check-in as evidence the previous shift ended', async () => {
    const h = harness({
      now: new Date('2026-03-02T14:00:00.000Z'),
      existing: [
        yesterdayOpen,
        recordRow({
          id: '66666666-6666-4666-8666-666666666666',
          workDate: new Date('2026-03-02T00:00:00.000Z'),
          checkInAt: new Date('2026-03-02T06:00:00.000Z'),
          checkOutAt: new Date('2026-03-02T13:00:00.000Z'),
          checkOutSite: { id: HQ.id, name: HQ.name },
        }),
      ],
    });

    const error = await failure(h.service.checkOut(AUTH, AT_HQ, CLIENT));

    // Today's record is closed, and yesterday's must not absorb today's punch.
    expect(error.code).toBe(ErrorCode.ALREADY_CHECKED_OUT);
  });

  it('offers only the check-out while a carried-over shift is still open', async () => {
    const h = harness({ now: JUST_AFTER_MIDNIGHT, existing: [yesterdayOpen] });

    const status = await h.service.status(AUTH);

    // `canCheckIn` used to be true here, and acting on it opened a second record
    // that made this one permanently ineligible for the carry-over branch: a
    // night's work stranded as INCOMPLETE next to a fabricated zero-minute day.
    expect(status).toMatchObject({ workDate: '2026-03-02', canCheckIn: false, canCheckOut: true });
    // `canCheckOut` is true exactly when `today` is a record with no check-out —
    // here, yesterday's, so the screen can say what the user is still inside of.
    expect(status.today).toMatchObject({ workDate: '2026-03-01', checkOutAt: null });
  });

  it('refuses a check-in that would strand the open shift', async () => {
    const h = harness({ now: JUST_AFTER_MIDNIGHT, existing: [yesterdayOpen] });

    const error = await failure(h.service.checkIn(AUTH, AT_HQ, CLIENT));

    // A dedicated code, not ALREADY_CHECKED_IN: the user has *not* opened this
    // work date, and what resolves it is a check-out rather than waiting.
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe(ErrorCode.SHIFT_STILL_OPEN);
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(soleEvent(h)).toMatchObject({ outcome: PunchOutcome.REJECTED_SHIFT_STILL_OPEN });
  });
});

describe('a night shift, under a business-day boundary', () => {
  /** 23:00–07:00 in Riyadh, no grace, the day rolling over at 20:00. */
  const NIGHT = { workdayStart: '23:00', dayStartsAt: '20:00', lateGraceMinutes: 0 };

  /** The `attendanceRecord.create` arguments a check-in produced. */
  async function openedDay(now: string): Promise<{ workDate: Date; lateMinutes: number }> {
    const h = harness({ now: new Date(now), policy: NIGHT });
    await h.service.checkIn(AUTH, AT_HQ, CLIENT);
    return (h.recordCreate.mock.calls[0]?.[0] as { data: { workDate: Date; lateMinutes: number } })
      .data;
  }

  it.each([
    ['23:00, on the hour', '2026-03-01T20:00:00.000Z', 0],
    ['23:10', '2026-03-01T20:10:00.000Z', 10],
    ['00:30, after midnight', '2026-03-01T21:30:00.000Z', 90],
    ['02:00, three hours in', '2026-03-01T23:00:00.000Z', 180],
  ])('scores a check-in at %s as %i minutes late', async (_name, now, expected) => {
    // Cut at local midnight, the anchor jumped forward a whole day at 00:00 and
    // the last two scored 0 — arriving later produced a better record.
    expect((await openedDay(now)).lateMinutes).toBe(expected);
  });

  it.each([
    ['2026-03-01T20:00:00.000Z'],
    ['2026-03-01T20:10:00.000Z'],
    ['2026-03-01T21:30:00.000Z'],
    ['2026-03-01T23:00:00.000Z'],
  ])('files a check-in at %s under the one business date', async (now) => {
    expect((await openedDay(now)).workDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers everything the home screen needs from the server clock', async () => {
    const h = harness();

    const status = await h.service.status(AUTH);

    expect(status).toMatchObject({
      serverTime: NOW.toISOString(),
      timezone: 'Asia/Riyadh',
      workDate: '2026-03-01',
      canCheckIn: true,
      canCheckOut: false,
      today: null,
      maxAccuracyMeters: 100,
      // Carried so the client knows which mode it is in without having to
      // provoke a rejection to find out.
      enforceGeofence: true,
    });
    expect(status.sites).toEqual([HQ]);
  });

  it('closes the check-in button the moment the day is open', async () => {
    const h = harness({ existing: [recordRow()] });

    const status = await h.service.status(AUTH);

    expect(status).toMatchObject({ canCheckIn: false, canCheckOut: true });
  });

  it('withdraws the check-out when every site has been deactivated', async () => {
    const h = harness({ existing: [recordRow()], sites: [] });

    const status = await h.service.status(AUTH);

    // A check-out passes the same geofence gate as any other punch, so with no
    // active site the endpoint answers 422 NO_ACTIVE_SITE. Offering the button
    // anyway left the shift unclosable by the control that claimed to close it.
    expect(status).toMatchObject({ canCheckIn: false, canCheckOut: false });
    expect(status.today).not.toBeNull();
  });

  it('keeps the check-out when the tenant does not enforce a geofence', async () => {
    const h = harness({
      existing: [recordRow()],
      sites: [],
      policy: { enforceGeofence: false },
    });

    const status = await h.service.status(AUTH);

    // The withdrawal above is entirely about a gate the punch would fail. There
    // is no such gate here, so removing the button would only strand the open
    // shift — in exactly the organization this mode exists for.
    expect(status).toMatchObject({ canCheckOut: true, enforceGeofence: false });
  });

  it('closes both buttons once the day is finished', async () => {
    const h = harness({
      existing: [
        recordRow({
          checkOutAt: new Date('2026-03-01T14:00:00.000Z'),
          checkOutSite: { id: HQ.id, name: HQ.name },
        }),
      ],
    });

    const status = await h.service.status(AUTH);

    expect(status).toMatchObject({ canCheckIn: false, canCheckOut: false });
    expect(status.today?.checkOutAt).toBe('2026-03-01T14:00:00.000Z');
  });
});

describe('history', () => {
  it('is scoped to the caller, in their own tenant, newest first', async () => {
    const h = harness();
    h.recordCount.mockResolvedValue(3);
    h.recordFindMany.mockResolvedValue([recordRow()]);

    const page = await h.service.history(AUTH, { page: 2, pageSize: 25 });

    // Two calls reach findMany in a page request: the day resolver is not one of
    // them, so the last call is the page itself.
    const args = h.recordFindMany.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(args['where']).toEqual({ userId: USER_ID, organizationId: ORG_ID });
    expect(args['orderBy']).toEqual([{ workDate: 'desc' }, { checkInAt: 'desc' }]);
    expect(args).toMatchObject({ skip: 25, take: 25 });
    expect(page.meta).toEqual({
      page: 2,
      pageSize: 25,
      total: 3,
      totalPages: 1,
      hasNext: false,
      hasPrevious: true,
    });
  });

  it('translates a date range into the column carrier', async () => {
    const h = harness();

    await h.service.history(AUTH, { page: 1, pageSize: 25, from: '2026-02-01', to: '2026-02-28' });

    const args = h.recordFindMany.mock.calls.at(-1)?.[0] as {
      where: { workDate: { gte: Date; lte: Date } };
    };
    expect(args.where.workDate.gte.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(args.where.workDate.lte.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('omits the date filter entirely when no range is asked for', async () => {
    const h = harness();

    await h.service.history(AUTH, { page: 1, pageSize: 25 });

    const args = h.recordFindMany.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> };
    expect(args.where).not.toHaveProperty('workDate');
  });
});
