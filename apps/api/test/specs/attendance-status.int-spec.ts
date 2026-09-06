import type { AttendanceRecord } from '@prisma/client';
import {
  AttendanceStatus,
  ErrorCode,
  HISTORY_MAX_RANGE_DAYS,
  PAGE_SIZE_MAX,
  PunchOutcome,
  PunchType,
  UserStatus,
  attendanceRecordSchema,
  attendanceStatusSchema,
} from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AttendanceModule } from '../../src/modules/attendance/attendance.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { HQ, createSite, punchAt } from '../support/attendance.js';
import {
  FixedClockService,
  createOrganization,
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

const STATUS = '/attendance/status';
const HISTORY = '/attendance/history';
const CHECK_IN = '/attendance/check-in';
const CHECK_OUT = '/attendance/check-out';

/** 09:20 local in Riyadh. */
const MORNING = new Date('2026-03-01T06:20:00.000Z');

describe('attendance status and history', () => {
  let ctx: TestApp;
  const clock = new FixedClockService(MORNING);

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AttendanceModule],
      env: { RATE_LIMIT_MAX: '100000', JWT_ACCESS_TTL: '30d' },
      configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    clock.set(MORNING);
  });

  async function riyadhActor(
    organization: Record<string, unknown> = {},
  ): Promise<AuthenticatedActor> {
    const actor = await createUserAndLogin(ctx, {
      organization: { timezone: 'Asia/Riyadh', ...organization },
    });
    await createSite(ctx, actor.organization.id);
    return actor;
  }

  /**
   * Seeds a finished day directly.
   *
   * History is a read path; driving it through the punch endpoints would make
   * every assertion about paging depend on the geofence and the clock as well.
   */
  async function seedDay(
    organizationId: string,
    userId: string,
    workDate: string,
    overrides: Partial<AttendanceRecord> = {},
  ): Promise<AttendanceRecord> {
    const site = await ctx.prisma.site.findFirstOrThrow({ where: { organizationId } });
    return ctx.prisma.attendanceRecord.create({
      data: {
        organizationId,
        userId,
        workDate: new Date(`${workDate}T00:00:00.000Z`),
        checkInAt: new Date(`${workDate}T06:00:00.000Z`),
        checkInSiteId: site.id,
        checkInLatitude: HQ.latitude,
        checkInLongitude: HQ.longitude,
        checkInAccuracyM: 8,
        checkInDistanceM: 4.2,
        checkOutAt: new Date(`${workDate}T14:00:00.000Z`),
        checkOutSiteId: site.id,
        checkOutLatitude: HQ.latitude,
        checkOutLongitude: HQ.longitude,
        checkOutAccuracyM: 9,
        checkOutDistanceM: 6.1,
        status: AttendanceStatus.PRESENT,
        workedMinutes: 480,
        lateMinutes: 0,
        ...overrides,
      },
    });
  }

  describe('GET /attendance/status', () => {
    it('answers the contract shape', async () => {
      const actor = await riyadhActor();

      const response = await actor.get(STATUS).expect(200);

      expect(() => attendanceStatusSchema.parse(response.body)).not.toThrow();
    });

    it('reports the server clock, the tenant zone and today in that zone', async () => {
      const actor = await riyadhActor({ maxAccuracyMeters: 75 });

      const response = await actor.get(STATUS).expect(200);

      expect(response.body).toMatchObject({
        serverTime: MORNING.toISOString(),
        timezone: 'Asia/Riyadh',
        workDate: '2026-03-01',
        maxAccuracyMeters: 75,
        canCheckIn: true,
        canCheckOut: false,
        today: null,
      });
    });

    it('reports the work date in the tenant zone, not in UTC', async () => {
      clock.set(new Date('2026-03-01T22:30:00.000Z'));
      const actor = await riyadhActor();

      const response = await actor.get(STATUS).expect(200);
      expect(response.body.workDate).toBe('2026-03-02');
    });

    it('publishes the active fences the client previews distances against', async () => {
      const actor = await createUserAndLogin(ctx, { organization: { timezone: 'Asia/Riyadh' } });
      await createSite(ctx, actor.organization.id, { name: 'Head Office', radiusMeters: 120 });
      await createSite(ctx, actor.organization.id, { name: 'Retired', isActive: false });
      await createSite(ctx, actor.organization.id, { name: 'Removed', deletedAt: MORNING });

      const response = await actor.get(STATUS).expect(200);

      expect(response.body.sites).toEqual([
        {
          id: expect.any(String),
          name: 'Head Office',
          latitude: HQ.latitude,
          longitude: HQ.longitude,
          radiusMeters: 120,
        },
      ]);
    });

    it('never publishes another tenant sites', async () => {
      const neighbour = await createOrganization(ctx, { timezone: 'Asia/Riyadh' });
      await createSite(ctx, neighbour.id, { name: 'Their Office' });
      const actor = await riyadhActor();

      const response = await actor.get(STATUS).expect(200);

      expect(response.body.sites).toHaveLength(1);
      expect(response.body.sites[0].name).toBe('Head Office');
    });

    it('flips to check-out only, the moment the day is open', async () => {
      const actor = await riyadhActor();
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      const response = await actor.get(STATUS).expect(200);

      expect(response.body).toMatchObject({ canCheckIn: false, canCheckOut: true });
      expect(response.body.today).toMatchObject({
        workDate: '2026-03-01',
        checkOutAt: null,
        status: AttendanceStatus.INCOMPLETE,
      });
    });

    it('offers nothing once the day is finished', async () => {
      const actor = await riyadhActor();
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      clock.set(new Date('2026-03-01T14:20:00.000Z'));
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      const response = await actor.get(STATUS).expect(200);

      expect(response.body).toMatchObject({ canCheckIn: false, canCheckOut: false });
      expect(response.body.today.status).toBe(AttendanceStatus.LATE);
    });

    it('offers only the check-out during an overnight shift, and says what is open', async () => {
      clock.set(new Date('2026-03-01T20:50:00.000Z'));
      const actor = await riyadhActor({ workdayStart: '23:00', lateGraceMinutes: 60 });
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      clock.set(new Date('2026-03-01T21:10:00.000Z'));

      const response = await actor.get(STATUS).expect(200);

      expect(response.body).toMatchObject({
        workDate: '2026-03-02',
        // Not `true`. The shift opened at 23:50 is still open, and a check-in on
        // top of it strands that shift permanently — see the punch suite.
        canCheckIn: false,
        canCheckOut: true,
      });
      // The invariant the client relies on: `canCheckOut` is true exactly when
      // `today` is a record with no check-out. It carries its own work date, so a
      // screen can say "checked in 23:50 yesterday" rather than showing an
      // enabled button with nothing behind it.
      expect(response.body.today).toMatchObject({ workDate: '2026-03-01', checkOutAt: null });
    });

    it('withdraws the check-out when every site has been deactivated mid-shift', async () => {
      const actor = await riyadhActor();
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      await ctx.prisma.site.updateMany({
        where: { organizationId: actor.organization.id },
        data: { isActive: false },
      });
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      const response = await actor.get(STATUS).expect(200);

      // The endpoint would answer 422 NO_ACTIVE_SITE, so the button must not
      // promise it. Exactly what the server would do with the punch:
      expect(response.body).toMatchObject({ canCheckIn: false, canCheckOut: false, sites: [] });
      const refused = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(422);
      expect(refused.body.code).toBe(ErrorCode.NO_ACTIVE_SITE);
    });

    it('withdraws the check-out offer once the carry-over window has passed', async () => {
      clock.set(new Date('2026-03-01T20:50:00.000Z'));
      const actor = await riyadhActor({ workdayStart: '23:00', lateGraceMinutes: 60 });
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      clock.set(new Date('2026-03-02T15:50:00.000Z'));

      const response = await actor.get(STATUS).expect(200);

      // Exactly what the server would do with a punch: the button cannot promise
      // an action the endpoint is about to refuse.
      expect(response.body).toMatchObject({
        canCheckIn: true,
        canCheckOut: false,
        today: null,
      });
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(409);
    });
  });

  describe('GET /attendance/history', () => {
    it('answers an empty page for a user who has never punched', async () => {
      const actor = await riyadhActor();

      const response = await actor.get(HISTORY).expect(200);

      expect(response.body).toEqual({
        data: [],
        meta: {
          page: 1,
          pageSize: 25,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrevious: false,
        },
      });
    });

    it('returns records newest first, in the contract shape', async () => {
      const actor = await riyadhActor();
      for (const day of ['2026-02-25', '2026-02-27', '2026-02-26']) {
        await seedDay(actor.organization.id, actor.user.id, day);
      }

      const response = await actor.get(HISTORY).expect(200);

      expect(response.body.data.map((record: { workDate: string }) => record.workDate)).toEqual([
        '2026-02-27',
        '2026-02-26',
        '2026-02-25',
      ]);
      expect(() => attendanceRecordSchema.parse(response.body.data[0])).not.toThrow();
      expect(response.body.data[0]).toMatchObject({
        checkOutAt: '2026-02-27T14:00:00.000Z',
        workedMinutes: 480,
        status: AttendanceStatus.PRESENT,
        checkInSite: { name: 'Head Office' },
      });
    });

    it('pages, and describes the page it returned', async () => {
      const actor = await riyadhActor();
      for (let day = 1; day <= 5; day += 1) {
        await seedDay(actor.organization.id, actor.user.id, `2026-02-0${day}`);
      }

      const first = await actor.get(`${HISTORY}?page=1&pageSize=2`).expect(200);
      const last = await actor.get(`${HISTORY}?page=3&pageSize=2`).expect(200);

      expect(first.body.data.map((r: { workDate: string }) => r.workDate)).toEqual([
        '2026-02-05',
        '2026-02-04',
      ]);
      expect(first.body.meta).toEqual({
        page: 1,
        pageSize: 2,
        total: 5,
        totalPages: 3,
        hasNext: true,
        hasPrevious: false,
      });
      expect(last.body.data).toHaveLength(1);
      expect(last.body.meta).toMatchObject({ hasNext: false, hasPrevious: true });
    });

    it('filters by an inclusive date range', async () => {
      const actor = await riyadhActor();
      for (const day of ['2026-02-01', '2026-02-10', '2026-02-20']) {
        await seedDay(actor.organization.id, actor.user.id, day);
      }

      const response = await actor.get(`${HISTORY}?from=2026-02-10&to=2026-02-20`).expect(200);

      expect(response.body.data.map((r: { workDate: string }) => r.workDate)).toEqual([
        '2026-02-20',
        '2026-02-10',
      ]);
      expect(response.body.meta.total).toBe(2);
    });

    it('answers an empty page for a range that contains nothing', async () => {
      const actor = await riyadhActor();
      await seedDay(actor.organization.id, actor.user.id, '2026-02-10');

      const response = await actor.get(`${HISTORY}?from=2025-01-01&to=2025-01-31`).expect(200);

      expect(response.body.data).toEqual([]);
      expect(response.body.meta.total).toBe(0);
    });

    it('shows an open day as INCOMPLETE with no check-out', async () => {
      const actor = await riyadhActor();
      await seedDay(actor.organization.id, actor.user.id, '2026-02-10', {
        checkOutAt: null,
        checkOutSiteId: null,
        checkOutLatitude: null,
        checkOutLongitude: null,
        checkOutAccuracyM: null,
        checkOutDistanceM: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
        lateMinutes: 22,
      });

      const response = await actor.get(HISTORY).expect(200);

      expect(response.body.data[0]).toMatchObject({
        checkOutAt: null,
        checkOutSite: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
        // Punctuality survives an unclosed day.
        lateMinutes: 22,
      });
    });

    it('never shows one colleague the attendance of another', async () => {
      const mine = await riyadhActor();
      const colleague = await createUserAndLogin(ctx, { organizationId: mine.organization.id });
      await seedDay(mine.organization.id, mine.user.id, '2026-02-10');
      await seedDay(mine.organization.id, colleague.user.id, '2026-02-11');

      const response = await mine.get(HISTORY).expect(200);

      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].workDate).toBe('2026-02-10');
    });

    it('never shows one tenant the attendance of another', async () => {
      const mine = await riyadhActor();
      const theirs = await riyadhActor();
      await seedDay(theirs.organization.id, theirs.user.id, '2026-02-10');

      const response = await mine.get(HISTORY).expect(200);
      expect(response.body).toMatchObject({ data: [], meta: { total: 0 } });
    });

    it.each([
      ['an inverted range', '?from=2026-03-01&to=2026-02-01'],
      ['a range wider than the cap', `?from=2020-01-01&to=2026-01-01`],
      ['a page size past the ceiling', `?pageSize=${PAGE_SIZE_MAX + 1}`],
      ['a page below one', '?page=0'],
      ['a page that is not a number', '?page=first'],
      ['a malformed date', '?from=2026-02-31'],
    ])('rejects %s as a 400', async (_name, query) => {
      const actor = await riyadhActor();

      const response = await actor.get(`${HISTORY}${query}`).expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('accepts a range exactly at the cap', async () => {
      const actor = await riyadhActor();
      // The cap is inclusive of both bounds, so the widest legal range is one day
      // short of the raw day count.
      const to = new Date(Date.UTC(2026, 0, 1) + (HISTORY_MAX_RANGE_DAYS - 1) * 86_400_000);
      await actor.get(`${HISTORY}?from=2026-01-01&to=${to.toISOString().slice(0, 10)}`).expect(200);
    });
  });

  describe('the authorisation boundary', () => {
    it.each([
      ['GET', STATUS],
      ['POST', CHECK_IN],
      ['POST', CHECK_OUT],
      ['GET', HISTORY],
    ])('refuses %s %s with no credential', async (method, path) => {
      const request =
        method === 'GET'
          ? ctx.http.get(`/api/v1${path}`)
          : ctx.http.post(`/api/v1${path}`).send(punchAt(HQ));

      const response = await request.expect(401);
      expect(response.body.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('locks a suspended user out of every attendance route', async () => {
      const actor = await riyadhActor();
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { status: UserStatus.SUSPENDED },
      });

      for (const response of [
        await actor.get(STATUS).expect(403),
        await actor.get(HISTORY).expect(403),
        await actor.post(CHECK_IN).send(punchAt(HQ)).expect(403),
        await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(403),
      ]) {
        expect(response.body.code).toBe(ErrorCode.ACCOUNT_SUSPENDED);
      }
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('audits a suspended user punch, which is the row §2.5 exists for', async () => {
      const actor = await riyadhActor();
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { status: UserStatus.SUSPENDED },
      });

      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(403);
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(403);

      // The refusal happens in the authentication guard, above the service, and
      // used to leave no trace at all — with both the user and the tenant known.
      // "A suspended employee kept trying to punch in, from the office" is a
      // question only this table can answer.
      const events = await ctx.prisma.attendanceEvent.findMany({ orderBy: { createdAt: 'asc' } });
      expect(events.map((event) => [event.type, event.outcome])).toEqual([
        [PunchType.CHECK_IN, PunchOutcome.REJECTED_ACCOUNT_SUSPENDED],
        [PunchType.CHECK_OUT, PunchOutcome.REJECTED_ACCOUNT_SUSPENDED],
      ]);
      expect(events[0]).toMatchObject({
        organizationId: actor.organization.id,
        userId: actor.user.id,
        latitude: HQ.latitude,
        longitude: HQ.longitude,
        // Where they were standing, not merely that they were refused.
        distanceM: 0,
      });
      expect(events[0]?.siteId).not.toBeNull();
    });

    it('files nothing for a suspended user whose payload was not a punch', async () => {
      const actor = await riyadhActor();
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { status: UserStatus.SUSPENDED },
      });

      await actor.post(CHECK_IN).send({ latitude: 91, longitude: 0, accuracy: 10 }).expect(403);

      // The coordinate columns are NOT NULL and there is nothing trustworthy to
      // put in them; filing zeroes would be inventing a location. The request log
      // still records the attempt.
      expect(await ctx.prisma.attendanceEvent.count()).toBe(0);
    });

    it('refuses a soft-deleted user, whose history must still survive them', async () => {
      const actor = await riyadhActor();
      await seedDay(actor.organization.id, actor.user.id, '2026-02-10');
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { deletedAt: MORNING },
      });

      await actor.get(HISTORY).expect(401);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
    });

    it('does not authenticate a user that never signed in', async () => {
      const seeded = await createUser(ctx, { organization: { timezone: 'Asia/Riyadh' } });
      await createSite(ctx, seeded.organization.id);

      await ctx.http.get(`/api/v1${STATUS}`).set('Authorization', 'Bearer not-a-token').expect(401);
    });
  });
});

describe('the published attendance surface', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AttendanceModule],
      env: { SWAGGER_ENABLED: 'true' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('publishes exactly the four paths the mobile client is written against', async () => {
    const response = await ctx.http.get('/api/docs-json').expect(200);
    const paths = response.body.paths as Record<string, Record<string, unknown>>;

    // `apps/mobile/src/api/endpoints.ts` hard-codes these; renaming one is a
    // breaking change that would only surface as a 404 on a shipped APK.
    expect(Object.keys(paths['/api/v1/attendance/status'] ?? {})).toEqual(['get']);
    expect(Object.keys(paths['/api/v1/attendance/check-in'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/api/v1/attendance/check-out'] ?? {})).toEqual(['post']);
    expect(Object.keys(paths['/api/v1/attendance/history'] ?? {})).toEqual(['get']);
  });

  it('documents every punch rejection the client branches on', async () => {
    const response = await ctx.http.get('/api/docs-json').expect(200);
    const checkIn = response.body.paths['/api/v1/attendance/check-in'].post as {
      responses: Record<string, unknown>;
    };

    expect(Object.keys(checkIn.responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '422',
    ]);
  });
});
