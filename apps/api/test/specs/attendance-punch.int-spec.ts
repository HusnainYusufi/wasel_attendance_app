import {
  AttendanceStatus,
  ErrorCode,
  PunchOutcome,
  PunchType,
  SITE_RADIUS_MIN_M,
  punchResponseSchema,
} from '@wasel/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AttendanceEventService } from '../../src/modules/attendance/attendance-event.service.js';
import { AttendanceModule } from '../../src/modules/attendance/attendance.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { HQ, createSite, pointAtDistance, punchAt } from '../support/attendance.js';
import {
  FixedClockService,
  createOrganization,
  createTestApp,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

const CHECK_IN = '/attendance/check-in';
const CHECK_OUT = '/attendance/check-out';

/** 09:20 local in Riyadh: five minutes past a 09:00 start with fifteen of grace. */
const MORNING = new Date('2026-03-01T06:20:00.000Z');

describe('attendance punches', () => {
  let ctx: TestApp;
  const clock = new FixedClockService(MORNING);

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AttendanceModule],
      // The suite signs in many users, and it moves the clock by hours — an
      // access token minted at the frozen instant must outlive that.
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

  /** An actor in a Riyadh tenant with one 150 m geofence around the head office. */
  async function riyadhActor(
    organization: Record<string, unknown> = {},
  ): Promise<AuthenticatedActor> {
    const actor = await createUserAndLogin(ctx, {
      organization: { timezone: 'Asia/Riyadh', ...organization },
    });
    await createSite(ctx, actor.organization.id);
    return actor;
  }

  const events = () => ctx.prisma.attendanceEvent.findMany();
  const soleEvent = () => ctx.prisma.attendanceEvent.findFirstOrThrow();
  /** The one rejected attempt, for a scenario whose accepted punches are noise. */
  const soleRejection = () =>
    ctx.prisma.attendanceEvent.findFirstOrThrow({
      where: { outcome: { not: PunchOutcome.ACCEPTED } },
    });

  describe('check-in', () => {
    it('opens the day and answers the contract shape', async () => {
      const actor = await riyadhActor();

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(() => punchResponseSchema.parse(response.body)).not.toThrow();
      expect(response.body).toMatchObject({
        outcome: PunchOutcome.ACCEPTED,
        type: PunchType.CHECK_IN,
        site: { name: 'Head Office' },
        distanceM: 0,
      });
      expect(response.body.record).toMatchObject({
        workDate: '2026-03-01',
        checkInAt: MORNING.toISOString(),
        checkOutAt: null,
        status: AttendanceStatus.INCOMPLETE,
        lateMinutes: 5,
      });
    });

    it('writes one attendance record, scoped to the caller tenant', async () => {
      const actor = await riyadhActor();
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record).toMatchObject({
        organizationId: actor.organization.id,
        userId: actor.user.id,
        checkInAt: MORNING,
        checkOutAt: null,
        status: AttendanceStatus.INCOMPLETE,
        lateMinutes: 5,
        workedMinutes: null,
      });
      expect(record.workDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('audits the accepted punch with everything an investigator needs', async () => {
      const actor = await riyadhActor();

      await actor
        .post(CHECK_IN)
        .set('User-Agent', 'WaselApp/1.0 (Android 14)')
        .send({ ...punchAt(HQ, 9.5), deviceTime: '2026-03-01T09:20:00.000+03:00' })
        .expect(201);

      const event = await soleEvent();
      expect(event).toMatchObject({
        organizationId: actor.organization.id,
        userId: actor.user.id,
        type: PunchType.CHECK_IN,
        outcome: PunchOutcome.ACCEPTED,
        latitude: HQ.latitude,
        longitude: HQ.longitude,
        accuracyM: 9.5,
        distanceM: 0,
        deviceTime: new Date('2026-03-01T06:20:00.000Z'),
        userAgent: 'WaselApp/1.0 (Android 14)',
      });
      expect(event.siteId).not.toBeNull();
      expect(event.ipAddress).not.toBeNull();
      expect(event.workDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('refuses a fix too imprecise to place the device inside the fence', async () => {
      const actor = await riyadhActor({ maxAccuracyMeters: 100 });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ, 3000)).expect(422);

      expect(response.body.code).toBe(ErrorCode.LOW_GPS_ACCURACY);
      // Standing at the office with a ±3 km fix proves nothing, so the geofence
      // is never even consulted for the verdict.
      expect(await soleEvent()).toMatchObject({
        outcome: PunchOutcome.REJECTED_LOW_ACCURACY,
        accuracyM: 3000,
        distanceM: 0,
      });
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it.each([
      ['exactly at the limit', 100, 201],
      ['one metre beyond it', 101, 422],
    ])('treats an accuracy %s as %i', async (_name, accuracy, status) => {
      const actor = await riyadhActor({ maxAccuracyMeters: 100 });
      await actor.post(CHECK_IN).send(punchAt(HQ, accuracy)).expect(status);
    });

    it('refuses to punch a tenant with no site at all', async () => {
      const actor = await createUserAndLogin(ctx, { organization: { timezone: 'Asia/Riyadh' } });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(422);

      expect(response.body.code).toBe(ErrorCode.NO_ACTIVE_SITE);
      expect(await soleEvent()).toMatchObject({
        outcome: PunchOutcome.REJECTED_NO_ACTIVE_SITE,
        siteId: null,
        distanceM: null,
      });
    });

    it.each([
      ['deactivated', { isActive: false }],
      ['soft-deleted', { deletedAt: new Date('2026-02-01T00:00:00.000Z') }],
    ])('ignores a %s site entirely', async (_name, state) => {
      const actor = await createUserAndLogin(ctx, { organization: { timezone: 'Asia/Riyadh' } });
      await createSite(ctx, actor.organization.id, state);

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(422);
      expect(response.body.code).toBe(ErrorCode.NO_ACTIVE_SITE);
    });

    it('does not let a decommissioned office keep accepting punches next to a live one', async () => {
      const actor = await createUserAndLogin(ctx, { organization: { timezone: 'Asia/Riyadh' } });
      await createSite(ctx, actor.organization.id, { name: 'Old Office', isActive: false });
      await createSite(ctx, actor.organization.id, {
        name: 'New Office',
        ...pointAtDistance(HQ, 5000),
      });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(422);

      // The nearest *active* site is five kilometres away, so that is the one the
      // user is measured against and told about.
      expect(response.body.code).toBe(ErrorCode.OUT_OF_RANGE);
      expect(response.body.message).toContain('New Office');
    });

    it('tells an out-of-range user how far they are and from which site', async () => {
      const actor = await riyadhActor();

      const response = await actor
        .post(CHECK_IN)
        .send(punchAt(pointAtDistance(HQ, 1200)))
        .expect(422);

      expect(response.body.code).toBe(ErrorCode.OUT_OF_RANGE);
      expect(response.body.message).toContain('Head Office');
      expect(response.body.message).toContain('1.2 km');
      const event = await soleEvent();
      expect(event.outcome).toBe(PunchOutcome.REJECTED_OUT_OF_RANGE);
      expect(event.distanceM).toBeCloseTo(1200, 0);
    });

    it.each([
      ['just inside the fence line', -0.5, 201],
      ['just outside it', 0.5, 422],
    ])('places a device %s (%i m) at %i', async (_name, offset, status) => {
      const actor = await riyadhActor();
      const site = await ctx.prisma.site.findFirstOrThrow();

      await actor
        .post(CHECK_IN)
        .send(punchAt(pointAtDistance(HQ, site.radiusMeters + offset)))
        .expect(status);
    });

    it.each([
      ['inside', SITE_RADIUS_MIN_M - 1, 201],
      ['outside', SITE_RADIUS_MIN_M + 1, 422],
    ])('honours a fence at the schema minimum radius — %s', async (_name, distance, status) => {
      const actor = await createUserAndLogin(ctx, { organization: { timezone: 'Asia/Riyadh' } });
      await createSite(ctx, actor.organization.id, { radiusMeters: SITE_RADIUS_MIN_M });

      await actor
        .post(CHECK_IN)
        .send(punchAt(pointAtDistance(HQ, distance)))
        .expect(status);
    });

    it('refuses a second check-in on the same work date', async () => {
      const actor = await riyadhActor();
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(409);

      expect(response.body.code).toBe(ErrorCode.ALREADY_CHECKED_IN);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
      expect((await events()).map((event) => event.outcome)).toEqual([
        PunchOutcome.ACCEPTED,
        PunchOutcome.REJECTED_ALREADY_CHECKED_IN,
      ]);
    });

    it('lets exactly one of three simultaneous check-ins win', async () => {
      const actor = await riyadhActor();

      // Issued before any is awaited: this is the double-tap race the unique
      // index on (userId, workDate) exists to lose safely.
      const responses = await Promise.all(
        Array.from({ length: 3 }, () => actor.post(CHECK_IN).send(punchAt(HQ))),
      );

      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(2);
      for (const loser of responses.filter((response) => response.status === 409)) {
        expect(loser.body.code).toBe(ErrorCode.ALREADY_CHECKED_IN);
      }
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
      // Every attempt is audited, including the two that lost.
      expect(await ctx.prisma.attendanceEvent.count()).toBe(3);
    });

    it('cannot see another tenant site, however close it is', async () => {
      const neighbour = await createOrganization(ctx, { timezone: 'Asia/Riyadh' });
      await createSite(ctx, neighbour.id);
      const actor = await createUserAndLogin(ctx, { organization: { timezone: 'Asia/Riyadh' } });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(422);
      expect(response.body.code).toBe(ErrorCode.NO_ACTIVE_SITE);
    });
  });

  /**
   * The customer this mode exists for has employees 791 km from the nearest
   * office. Every assertion here is about the same principle: with
   * `enforceGeofence: false` location becomes a *record* and stops being a gate,
   * and nothing about what gets written down is lost in the trade.
   */
  describe('a tenant that does not enforce its geofence', () => {
    /** Far enough that no plausible fence could contain it. */
    const FAR_AWAY_M = 791_000;

    async function openActor(
      organization: Record<string, unknown> = {},
    ): Promise<AuthenticatedActor> {
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'Asia/Riyadh', enforceGeofence: false, ...organization },
      });
      await createSite(ctx, actor.organization.id);
      return actor;
    }

    it('accepts a punch 791 km away and records where it happened', async () => {
      const actor = await openActor();
      const point = pointAtDistance(HQ, FAR_AWAY_M);

      const response = await actor.post(CHECK_IN).send(punchAt(point, 14)).expect(201);

      // Accepted, and still measured: the nearest site and the distance to it are
      // exactly what an administrator opens the report to see.
      expect(response.body.outcome).toBe(PunchOutcome.ACCEPTED);
      expect(response.body.site.name).toBe('Head Office');
      expect(response.body.distanceM).toBeCloseTo(FAR_AWAY_M, -1);

      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.checkInLatitude).toBeCloseTo(point.latitude, 6);
      expect(record.checkInLongitude).toBeCloseTo(point.longitude, 6);
      expect(record.checkInAccuracyM).toBe(14);
      expect(record.checkInSiteId).not.toBeNull();
      expect(record.checkInDistanceM).toBeCloseTo(FAR_AWAY_M, -1);

      // The outcome stays ACCEPTED. The stored distance already says "and they
      // were 791 km away"; a separate outcome would make the enum a derived
      // field instead of the decision record it is.
      const event = await soleEvent();
      expect(event.outcome).toBe(PunchOutcome.ACCEPTED);
      expect(event.distanceM).toBeCloseTo(FAR_AWAY_M, -1);
      expect(event.accuracyM).toBe(14);
      expect(event.siteId).toBe(record.checkInSiteId);
    });

    it('accepts a fix far too vague to place anyone, and writes the accuracy down', async () => {
      // The accuracy gate only ever existed to stop a wide error radius faking
      // its way *inside* a fence. With no fence it refuses honest punches from
      // someone whose phone reports +/-3 km indoors, and nothing else.
      const actor = await openActor({ maxAccuracyMeters: 100 });

      await actor.post(CHECK_IN).send(punchAt(HQ, 3000)).expect(201);

      expect(await ctx.prisma.attendanceRecord.findFirstOrThrow()).toMatchObject({
        checkInAccuracyM: 3000,
      });
      expect(await soleEvent()).toMatchObject({
        outcome: PunchOutcome.ACCEPTED,
        accuracyM: 3000,
      });
    });

    it('accepts a punch in a tenant that has no sites at all', async () => {
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'Asia/Riyadh', enforceGeofence: false },
      });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(() => punchResponseSchema.parse(response.body)).not.toThrow();
      expect(response.body.site).toBeNull();
      expect(response.body.distanceM).toBeNull();
      expect(response.body.record.checkInSite).toBeNull();
      expect(response.body.record.checkInDistanceM).toBeNull();

      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.checkInSiteId).toBeNull();
      expect(record.checkInDistanceM).toBeNull();
      // The coordinates and the accuracy are still recorded. They are facts
      // about the device, not about the organization's sites.
      expect(record.checkInLatitude).toBeCloseTo(HQ.latitude, 6);
      expect(record.checkInAccuracyM).toBe(8);
    });

    it('closes a shift from 791 km away, and records that distance too', async () => {
      const actor = await openActor();
      const point = pointAtDistance(HQ, FAR_AWAY_M);
      await actor.post(CHECK_IN).send(punchAt(point)).expect(201);
      clock.set(new Date(MORNING.getTime() + 8 * 60 * 60 * 1000));

      const response = await actor.post(CHECK_OUT).send(punchAt(point, 22)).expect(200);

      expect(response.body.distanceM).toBeCloseTo(FAR_AWAY_M, -1);
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.checkOutDistanceM).toBeCloseTo(FAR_AWAY_M, -1);
      expect(record.checkOutAccuracyM).toBe(22);
      expect(record.workedMinutes).toBe(480);
    });

    it('keeps every rule that is not about location', async () => {
      const actor = await openActor();
      await actor
        .post(CHECK_IN)
        .send(punchAt(pointAtDistance(HQ, FAR_AWAY_M)))
        .expect(201);

      // A second check-in is still a duplicate, and a check-out one second later
      // is still too short to be a shift. Standing down the fence stands down the
      // fence, not the day's state machine.
      const duplicate = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(409);
      expect(duplicate.body.code).toBe(ErrorCode.ALREADY_CHECKED_IN);

      const tooShort = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(409);
      expect(tooShort.body.code).toBe(ErrorCode.SHIFT_TOO_SHORT);
    });

    it('offers a check-out to a tenant with no site to close against', async () => {
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'Asia/Riyadh', enforceGeofence: false },
      });
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      const status = await actor.get('/attendance/status').expect(200);

      // With enforcement on this is deliberately withdrawn, because the punch
      // would answer 422 NO_ACTIVE_SITE. With it off there is no gate to fail,
      // and withholding the button would strand the shift permanently open.
      expect(status.body).toMatchObject({
        enforceGeofence: false,
        canCheckIn: false,
        canCheckOut: true,
      });
    });
  });

  /**
   * The regression that matters most: switching the setting on restores every
   * refusal, unchanged, including for the tenant shapes the new mode introduced.
   */
  describe('the same punches against a tenant that does enforce it', () => {
    it.each([
      ['791 km from the only site', 791_000, 8, ErrorCode.OUT_OF_RANGE],
      ['a 3 km error radius at the office', 0, 3000, ErrorCode.LOW_GPS_ACCURACY],
    ])('still refuses %s', async (_name, distance, accuracy, code) => {
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'Asia/Riyadh', enforceGeofence: true, maxAccuracyMeters: 100 },
      });
      await createSite(ctx, actor.organization.id);

      const response = await actor
        .post(CHECK_IN)
        .send(punchAt(pointAtDistance(HQ, distance), accuracy))
        .expect(422);

      expect(response.body.code).toBe(code);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('still refuses a tenant with no active site', async () => {
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'Asia/Riyadh', enforceGeofence: true },
      });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(422);

      expect(response.body.code).toBe(ErrorCode.NO_ACTIVE_SITE);
      expect(await soleEvent()).toMatchObject({
        outcome: PunchOutcome.REJECTED_NO_ACTIVE_SITE,
        siteId: null,
        distanceM: null,
      });
    });
  });

  describe('work dates', () => {
    it('files an evening punch in a positive offset under tomorrow', async () => {
      // 01:30 on the 2nd in Riyadh. The UTC date is still the 1st.
      clock.set(new Date('2026-03-01T22:30:00.000Z'));
      const actor = await riyadhActor();

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(response.body.record.workDate).toBe('2026-03-02');
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.workDate.toISOString().slice(0, 10)).toBe('2026-03-02');
    });

    it('files an evening punch in a negative offset under yesterday', async () => {
      // 21:30 on the 1st in New York; the UTC date has already rolled to the 2nd.
      clock.set(new Date('2026-03-02T02:30:00.000Z'));
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'America/New_York' },
      });
      await createSite(ctx, actor.organization.id);

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      expect(response.body.record.workDate).toBe('2026-03-01');
    });

    it('classifies lateness against the offset in force on a DST transition day', async () => {
      // 2026-03-08 is when New York springs forward. 14:30Z is 10:30 EDT — ninety
      // minutes after a 09:00 start, so 75 past a 15-minute grace. Code that froze
      // the offset at EST would read 09:30 and report 15.
      clock.set(new Date('2026-03-08T14:30:00.000Z'));
      const actor = await createUserAndLogin(ctx, {
        organization: { timezone: 'America/New_York', workdayStart: '09:00', lateGraceMinutes: 15 },
      });
      await createSite(ctx, actor.organization.id);

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(response.body.record).toMatchObject({ workDate: '2026-03-08', lateMinutes: 75 });
    });

    it('is on time inside the grace window', async () => {
      clock.set(new Date('2026-03-01T06:15:00.000Z'));
      const actor = await riyadhActor({ workdayStart: '09:00', lateGraceMinutes: 15 });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      expect(response.body.record.lateMinutes).toBe(0);
    });
  });

  describe('check-out', () => {
    async function checkedIn(organization: Record<string, unknown> = {}) {
      const actor = await riyadhActor(organization);
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      return actor;
    }

    it('closes the day and records the shift length', async () => {
      const actor = await checkedIn();
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      expect(() => punchResponseSchema.parse(response.body)).not.toThrow();
      expect(response.body.record).toMatchObject({
        checkOutAt: '2026-03-01T14:20:00.000Z',
        workedMinutes: 480,
        // The day opened five minutes past grace, so it closes as LATE.
        status: AttendanceStatus.LATE,
        lateMinutes: 5,
      });
      expect(response.body.record.checkOutSite).toMatchObject({ name: 'Head Office' });
    });

    it('closes as PRESENT when the day opened on time', async () => {
      clock.set(new Date('2026-03-01T06:00:00.000Z'));
      const actor = await checkedIn();
      clock.set(new Date('2026-03-01T14:00:00.000Z'));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);
      expect(response.body.record.status).toBe(AttendanceStatus.PRESENT);
    });

    it('stores the check-out site, coordinates, accuracy and distance', async () => {
      const actor = await checkedIn();
      const other = await createSite(ctx, actor.organization.id, {
        name: 'Annexe',
        ...pointAtDistance(HQ, 400),
      });
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      await actor
        .post(CHECK_OUT)
        .send(punchAt(pointAtDistance(HQ, 420), 11))
        .expect(200);

      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.checkOutSiteId).toBe(other.id);
      expect(record.checkOutAccuracyM).toBe(11);
      expect(record.checkOutDistanceM).toBeCloseTo(20, 0);
      expect(record.checkOutLatitude).toBeCloseTo(pointAtDistance(HQ, 420).latitude, 9);
    });

    it('says "not checked in" when there is nothing open', async () => {
      const actor = await riyadhActor();

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(409);

      expect(response.body.code).toBe(ErrorCode.NOT_CHECKED_IN);
      expect(await soleEvent()).toMatchObject({
        type: PunchType.CHECK_OUT,
        outcome: PunchOutcome.REJECTED_NOT_CHECKED_IN,
      });
    });

    it('refuses a second check-out', async () => {
      const actor = await checkedIn();
      clock.set(new Date('2026-03-01T14:20:00.000Z'));
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(409);

      expect(response.body.code).toBe(ErrorCode.ALREADY_CHECKED_OUT);
      expect(
        await ctx.prisma.attendanceEvent.count({
          where: { outcome: PunchOutcome.REJECTED_ALREADY_CHECKED_OUT },
        }),
      ).toBe(1);
    });

    it('applies the same geofence gate, and leaves the record untouched', async () => {
      const actor = await checkedIn();
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      const response = await actor
        .post(CHECK_OUT)
        .send(punchAt(pointAtDistance(HQ, 900)))
        .expect(422);

      expect(response.body.code).toBe(ErrorCode.OUT_OF_RANGE);
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.checkOutAt).toBeNull();
      expect(record.status).toBe(AttendanceStatus.INCOMPLETE);
    });

    it('applies the same accuracy gate', async () => {
      const actor = await checkedIn({ maxAccuracyMeters: 50 });
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ, 500)).expect(422);
      expect(response.body.code).toBe(ErrorCode.LOW_GPS_ACCURACY);
    });

    it('cannot close a shift that belongs to another tenant', async () => {
      const theirs = await checkedIn();
      const mine = await riyadhActor();
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      // The record exists and is open — but not for this principal, and the
      // lookup is scoped by both `userId` and `organizationId`.
      const response = await mine.post(CHECK_OUT).send(punchAt(HQ)).expect(409);

      expect(response.body.code).toBe(ErrorCode.NOT_CHECKED_IN);
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow({
        where: { userId: theirs.user.id },
      });
      expect(record.checkOutAt).toBeNull();
    });

    it('refuses a check-out taken in the same second as the check-in', async () => {
      const actor = await checkedIn();

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(409);

      expect(response.body.code).toBe(ErrorCode.SHIFT_TOO_SHORT);
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      // Accepting used to store `workedMinutes: 0, status: PRESENT` — counted by
      // the report exactly like a full day — and, because the day was now
      // closed, locked the employee out of the day they were about to work.
      expect(record).toMatchObject({
        checkOutAt: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
      });
      expect(await soleRejection()).toMatchObject({
        outcome: PunchOutcome.REJECTED_SHIFT_TOO_SHORT,
      });
    });

    it('accepts the shortest shift it will store, and never stores zero', async () => {
      const actor = await checkedIn();
      clock.set(new Date(MORNING.getTime() + 60_000));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      expect(response.body.record.workedMinutes).toBe(1);
    });

    it('lets exactly one of three simultaneous check-outs win', async () => {
      const actor = await checkedIn();
      clock.set(new Date('2026-03-01T14:20:00.000Z'));

      const responses = await Promise.all(
        Array.from({ length: 3 }, () => actor.post(CHECK_OUT).send(punchAt(HQ))),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 409)).toHaveLength(2);
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      expect(record.workedMinutes).toBe(480);
    });
  });

  /**
   * A tenant whose day genuinely crosses midnight: 23:00 start, no grace, and a
   * business day that rolls over at 20:00 — in the middle of its off-hours,
   * which is the only place a boundary can go for a night shift.
   */
  describe('a night shift, with the business day cut at 20:00', () => {
    const NIGHT = { workdayStart: '23:00', lateGraceMinutes: 0, dayStartsAt: '20:00' };

    it.each([
      ['23:00, on the hour', '2026-03-01T20:00:00.000Z', 0],
      ['23:10', '2026-03-01T20:10:00.000Z', 10],
      ['00:30, after midnight', '2026-03-01T21:30:00.000Z', 90],
      ['02:00, three hours in', '2026-03-01T23:00:00.000Z', 180],
    ])('scores a check-in at %s as %i minutes late', async (_name, now, lateMinutes) => {
      clock.set(new Date(now));
      const actor = await riyadhActor(NIGHT);

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      // Cut at local midnight, the anchor jumped forward a whole day at 00:00
      // and the last two of these scored 0: being *more* late produced a better
      // record, and nobody on a night shift could ever be marked late.
      expect(response.body.record).toMatchObject({ workDate: '2026-03-01', lateMinutes });
    });

    it('files the whole night under one business date', async () => {
      clock.set(new Date('2026-03-01T20:10:00.000Z'));
      const actor = await riyadhActor(NIGHT);
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      // 05:00 local on the 2nd — a new calendar date, the same business day.
      clock.set(new Date('2026-03-02T02:00:00.000Z'));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      expect(response.body.record).toMatchObject({
        workDate: '2026-03-01',
        workedMinutes: 350,
        status: AttendanceStatus.LATE,
        lateMinutes: 10,
      });
      const records = await ctx.prisma.attendanceRecord.findMany();
      expect(records).toHaveLength(1);
      expect(records[0]?.workDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('does not burn the next night on a punch made after midnight', async () => {
      // The second half of the same root cause: filed under the wrong date, a
      // 00:30 check-in used to occupy the slot the *next* shift needed, and that
      // shift was refused as a duplicate.
      clock.set(new Date('2026-03-01T21:30:00.000Z'));
      const actor = await riyadhActor(NIGHT);
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      clock.set(new Date('2026-03-02T01:00:00.000Z'));
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      // 23:00 local on the 2nd: the following night.
      clock.set(new Date('2026-03-02T20:00:00.000Z'));
      const next = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(next.body.record).toMatchObject({ workDate: '2026-03-02', lateMinutes: 0 });
      expect(await ctx.prisma.attendanceRecord.count()).toBe(2);
    });

    it('leaves a 09:00 tenant untouched, early arrival included', async () => {
      // The regression that matters most: the boundary defaults to local
      // midnight, so a daytime organization cuts its days exactly as before —
      // and 08:00 is still *today*, which a naive "the day starts at
      // workdayStart" rule would file under yesterday.
      clock.set(new Date('2026-03-01T05:00:00.000Z'));
      const actor = await riyadhActor({ workdayStart: '09:00', lateGraceMinutes: 15 });

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(response.body.record).toMatchObject({ workDate: '2026-03-01', lateMinutes: 0 });
    });
  });

  describe('the overnight shift', () => {
    /** Checked in at 23:50 local on the 1st, inside a generous night-shift grace. */
    async function nightShift(): Promise<AuthenticatedActor> {
      clock.set(new Date('2026-03-01T20:50:00.000Z'));
      const actor = await riyadhActor({ workdayStart: '23:00', lateGraceMinutes: 60 });
      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      return actor;
    }

    it('closes the shift it belongs to rather than losing it to the calendar', async () => {
      const actor = await nightShift();
      // 00:10 local on the 2nd: a new work date, the same twenty-minute shift.
      clock.set(new Date('2026-03-01T21:10:00.000Z'));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      expect(response.body.record).toMatchObject({
        workDate: '2026-03-01',
        workedMinutes: 20,
        status: AttendanceStatus.PRESENT,
      });
      // One shift, one row: the check-out did not invent a record for the 2nd.
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
    });

    it('files the audit row under the day the punch actually happened', async () => {
      const actor = await nightShift();
      clock.set(new Date('2026-03-01T21:10:00.000Z'));
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      const event = await ctx.prisma.attendanceEvent.findFirstOrThrow({
        where: { type: PunchType.CHECK_OUT },
      });
      expect(event.workDate.toISOString().slice(0, 10)).toBe('2026-03-02');
    });

    it('refuses to attach a punch to a shift nobody was working', async () => {
      const actor = await nightShift();
      // Nineteen hours later — beyond the carry-over cap.
      clock.set(new Date('2026-03-02T15:50:00.000Z'));

      const response = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(409);

      expect(response.body.code).toBe(ErrorCode.NOT_CHECKED_IN);
      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow();
      // The abandoned day stays INCOMPLETE for an administrator to settle rather
      // than silently becoming a nineteen-hour shift.
      expect(record.checkOutAt).toBeNull();
      expect(record.status).toBe(AttendanceStatus.INCOMPLETE);
    });

    it('refuses to open a second day on top of a shift that is still open', async () => {
      const actor = await nightShift();
      // 09:00 local on the 2nd. The night shift was never closed.
      clock.set(new Date('2026-03-02T06:00:00.000Z'));

      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(409);

      // Accepting this used to be permanently destructive: a record now exists
      // for the current work date, which makes yesterday's row ineligible for
      // the carry-over branch for ever. There was no path back.
      expect(response.body.code).toBe(ErrorCode.SHIFT_STILL_OPEN);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
      expect(await soleRejection()).toMatchObject({
        type: PunchType.CHECK_IN,
        outcome: PunchOutcome.REJECTED_SHIFT_STILL_OPEN,
      });
    });

    it('closes the stranded shift instead, and keeps it to one row', async () => {
      // The full sequence from the report: in at 23:50, then at 00:10 the client
      // offers a check-in the server used to accept.
      const actor = await nightShift();
      clock.set(new Date('2026-03-01T21:10:00.000Z'));

      const status = await actor.get('/attendance/status').expect(200);
      expect(status.body).toMatchObject({ canCheckIn: false, canCheckOut: true });

      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(409);
      const checkOut = await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      expect(checkOut.body.record).toMatchObject({
        workDate: '2026-03-01',
        workedMinutes: 20,
        status: AttendanceStatus.PRESENT,
      });
      // One shift, one row — not a stranded INCOMPLETE beside a fabricated
      // zero-minute PRESENT day.
      const records = await ctx.prisma.attendanceRecord.findMany();
      expect(records).toHaveLength(1);
      expect(records[0]?.checkOutAt).toEqual(new Date('2026-03-01T21:10:00.000Z'));
    });

    it('lets the next day open once the previous shift is closed', async () => {
      const actor = await nightShift();
      clock.set(new Date('2026-03-01T21:10:00.000Z'));
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);
      clock.set(new Date('2026-03-02T06:00:00.000Z'));

      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);
      clock.set(new Date('2026-03-02T14:00:00.000Z'));
      await actor.post(CHECK_OUT).send(punchAt(HQ)).expect(200);

      const [first, second] = await ctx.prisma.attendanceRecord.findMany({
        orderBy: { workDate: 'asc' },
      });
      expect(first?.workedMinutes).toBe(20);
      expect(second?.workedMinutes).toBe(480);
    });
  });

  describe('the accepted punch is atomic with its audit row', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rolls the record back when the event insert inside the transaction fails', async () => {
      const actor = await riyadhActor();
      // A site id that does not exist: the insert fails the foreign key *inside*
      // the transaction, which is the only way to observe the guarantee. A test
      // that stubs `$transaction` as `work(prisma)` cannot — it would pass
      // identically with the event write moved outside the transaction, which is
      // exactly the regression this is here to catch.
      const events = ctx.app.get(AttendanceEventService);
      const real = events.buildData.bind(events);
      vi.spyOn(events, 'buildData').mockImplementation((attempt) => ({
        ...real(attempt),
        siteId: '00000000-0000-4000-8000-000000000000',
      }));

      // 409 rather than 500 because the kernel maps a foreign-key violation
      // there; what matters is that the punch failed and left nothing behind.
      const response = await actor.post(CHECK_IN).send(punchAt(HQ)).expect(409);
      expect(response.body.code).toBe(ErrorCode.CONFLICT);

      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
      expect(await ctx.prisma.attendanceEvent.count()).toBe(0);
    });

    it('still writes the record when nothing fails', async () => {
      // The control: without the sabotage the same request commits both rows, so
      // the assertion above is about atomicity rather than about a broken app.
      const actor = await riyadhActor();

      await actor.post(CHECK_IN).send(punchAt(HQ)).expect(201);

      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
      expect(await ctx.prisma.attendanceEvent.count()).toBe(1);
    });
  });

  describe('malformed payloads', () => {
    let actor: AuthenticatedActor;

    beforeEach(async () => {
      actor = await riyadhActor();
    });

    it.each([
      ['no accuracy', { latitude: HQ.latitude, longitude: HQ.longitude }],
      ['no coordinates', { accuracy: 10 }],
      ['a latitude beyond the pole', { ...punchAt(HQ), latitude: 91 }],
      ['a longitude beyond the meridian', { ...punchAt(HQ), longitude: 181 }],
      ['coordinates as strings', { latitude: '24.7136', longitude: '46.6753', accuracy: 10 }],
      ['an accuracy of zero', punchAt(HQ, 0)],
      ['a negative accuracy', punchAt(HQ, -5)],
      ['an accuracy past the physical ceiling', punchAt(HQ, 50_000)],
      ['a device time that is not a timestamp', { ...punchAt(HQ), deviceTime: 'yesterday' }],
    ])('rejects %s as a 400', async (_name, body) => {
      const response = await actor.post(CHECK_IN).send(body).expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details.length).toBeGreaterThan(0);
    });

    it('rejects a body that is not even JSON', async () => {
      await actor
        .post(CHECK_IN)
        .set('Content-Type', 'application/json')
        .send('{"latitude": NaN, "longitude": 46.6, "accuracy": 10}')
        .expect(400);
    });

    it('never records an event for a payload the schema refused', async () => {
      await actor.post(CHECK_IN).send({ latitude: 91, longitude: 0, accuracy: 10 }).expect(400);

      // There are no trustworthy coordinates to file, and the columns are NOT
      // NULL. The request never reaches the service.
      expect(await ctx.prisma.attendanceEvent.count()).toBe(0);
    });
  });
});
