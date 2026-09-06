import {
  AttendanceSource,
  AttendanceStatus,
  ErrorCode,
  MIN_SHIFT_MINUTES,
  Role,
  attendanceEntrySchema,
  type AttendanceEntryDto,
} from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import { MAX_CARRY_OVER_SHIFT_HOURS } from '../../src/modules/attendance/attendance.constants.js';
import { AttendanceModule } from '../../src/modules/attendance/attendance.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { seedAttendanceRecord } from '../fixtures/admin-fixtures.js';
import { HQ, createSite, punchAt } from '../support/attendance.js';
import {
  FixedClockService,
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

const ENTRIES = '/admin/attendance';
const RIYADH = 'Asia/Riyadh';

/**
 * 09:20 on the Riyadh wall clock, Tuesday 10 March 2026 — five minutes past a
 * 09:00 start with fifteen minutes of grace, so a punch made *now* is on time.
 * Every manual entry in this file is for an earlier day, because that is the
 * only kind this endpoint accepts.
 */
const NOW = new Date('2026-03-10T06:20:00.000Z');
const TODAY = '2026-03-10';
const PAST = '2026-03-03';

const NOTE = 'Phone died before the check-out';

/** A complete, ordinary day: in at 08:47, out at 17:30, both on `PAST`. */
const DAY = {
  workDate: PAST,
  checkInTime: '08:47',
  checkOutTime: '17:30',
  checkOutNextDay: false,
  note: NOTE,
};

describe('admin manual attendance entry', () => {
  let ctx: TestApp;
  const clock = new FixedClockService(NOW);

  /** The administrator doing the entering, and the employee it is entered for. */
  let admin: AuthenticatedActor;
  let employeeId: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AdminModule, AttendanceModule],
      // The suite signs in a lot of actors and moves the clock across days; an
      // access token minted at the frozen instant has to outlive that.
      env: { RATE_LIMIT_MAX: '100000', JWT_ACCESS_TTL: '30d' },
      configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    clock.set(NOW);
    admin = await createUserAndLogin(ctx, {
      role: Role.ADMIN,
      organization: { timezone: RIYADH },
    });
    const employee = await createUser(ctx, { organizationId: admin.organization.id });
    employeeId = employee.user.id;
  });

  const create = (body: Record<string, unknown> = {}) =>
    admin.post(ENTRIES).send({ userId: employeeId, ...DAY, ...body });

  const stored = (id: string) => ctx.prisma.attendanceRecord.findUniqueOrThrow({ where: { id } });

  const auditRows = (action: string) =>
    ctx.prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

  // -------------------------------------------------------------------------
  // POST /admin/attendance
  // -------------------------------------------------------------------------

  describe('POST /admin/attendance', () => {
    it('records the day and answers the contract shape', async () => {
      const response = await create().expect(201);

      expect(() => attendanceEntrySchema.parse(response.body)).not.toThrow();
      expect(response.body).toMatchObject({
        userId: employeeId,
        workDate: PAST,
        // 08:47 Riyadh is 05:47 UTC. The wall clock the administrator typed is
        // resolved in the *organization's* zone, never the server's.
        checkInAt: '2026-03-03T05:47:00.000Z',
        checkOutAt: '2026-03-03T14:30:00.000Z',
        status: AttendanceStatus.PRESENT,
        workedMinutes: 523,
        lateMinutes: 0,
        source: AttendanceSource.MANUAL,
        note: NOTE,
      });
      expect(response.body.enteredBy).toMatchObject({
        id: admin.user.id,
        fullName: admin.user.fullName,
      });
      expect(response.body.enteredAt).toBe(NOW.toISOString());
    });

    it('stores all four provenance columns, not merely the ones it returns', async () => {
      const response = await create().expect(201);
      const row = await stored(response.body.id);

      expect(row).toMatchObject({
        source: AttendanceSource.MANUAL,
        enteredById: admin.user.id,
        enteredAt: NOW,
        note: NOTE,
      });
    });

    it('records no location rather than inventing one', async () => {
      // An accuracy of zero is precisely what the punch contract treats as a
      // synthesised fix, and a manual row *is* synthesised. Naming a site would
      // put something an auditor could mistake for evidence on a record nobody
      // was ever measured for.
      const response = await create().expect(201);
      const row = await stored(response.body.id);

      expect(row).toMatchObject({
        checkInSiteId: null,
        checkInDistanceM: null,
        checkInAccuracyM: 0,
        checkOutSiteId: null,
        checkOutDistanceM: null,
      });
    });

    it('marks a late arrival exactly as a punch at that moment would', async () => {
      // The equivalence this whole feature turns on. A member punches in at the
      // frozen instant; two days later an administrator types the *same* wall
      // clock in for somebody else. Both rows must agree about the work date and
      // the late minutes, or payroll has two answers and no way to choose.
      const site = await createSite(ctx, admin.organization.id);
      const puncher = await createUserAndLogin(ctx, { organizationId: admin.organization.id });
      await puncher.post('/attendance/check-in').send(punchAt(HQ)).expect(201);
      const punched = await ctx.prisma.attendanceRecord.findFirstOrThrow({
        where: { userId: puncher.user.id },
      });
      expect(site.id).toBe(punched.checkInSiteId);

      clock.set(new Date('2026-03-12T06:20:00.000Z'));
      const typed = await create({
        workDate: TODAY,
        // 09:20 Riyadh — the same wall clock the punch above landed on.
        checkInTime: '09:20',
        checkOutTime: null,
        checkOutNextDay: false,
      }).expect(201);

      expect(typed.body.workDate).toBe(TODAY);
      expect(typed.body.checkInAt).toBe(punched.checkInAt.toISOString());
      expect(typed.body.lateMinutes).toBe(punched.lateMinutes);
      expect(typed.body.lateMinutes).toBe(5);
      expect(typed.body.status).toBe(AttendanceStatus.INCOMPLETE);
    });

    it('leaves a day open when there is no check-out to record', async () => {
      const response = await create({ checkOutTime: null }).expect(201);

      expect(response.body).toMatchObject({
        checkOutAt: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
      });
    });

    it('records an overnight shift against the day it began on', async () => {
      const response = await create({
        checkInTime: '23:50',
        checkOutTime: '00:10',
        checkOutNextDay: true,
      }).expect(201);

      expect(response.body).toMatchObject({
        workDate: PAST,
        checkInAt: '2026-03-03T20:50:00.000Z',
        checkOutAt: '2026-03-03T21:10:00.000Z',
        workedMinutes: 20,
      });
    });

    it('files a night-shift 02:00 under the business day that owns it', async () => {
      // `dayStartsAt: 14:00` means business day 3 March runs from 3 March 14:00
      // to 4 March 14:00, so "02:00 on the 3rd" is 02:00 on the *4th* calendar
      // day. Resolved by the attendance module's own helper, not re-derived here.
      const night = await createUserAndLogin(ctx, {
        role: Role.ADMIN,
        organization: { timezone: RIYADH, dayStartsAt: '14:00', workdayStart: '23:00' },
      });
      const worker = await createUser(ctx, { organizationId: night.organization.id });

      const response = await night
        .post(ENTRIES)
        .send({
          userId: worker.user.id,
          workDate: PAST,
          checkInTime: '02:00',
          checkOutTime: '06:00',
          checkOutNextDay: false,
          note: NOTE,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        workDate: PAST,
        // 02:00 Riyadh on 4 March = 23:00 UTC on 3 March.
        checkInAt: '2026-03-03T23:00:00.000Z',
        checkOutAt: '2026-03-04T03:00:00.000Z',
        workedMinutes: 240,
      });
    });

    it('reports a date that already has a record as a conflict, not a 500', async () => {
      await create().expect(201);
      const response = await create({ note: 'Second attempt at the same day' }).expect(409);

      expect(response.body.code).toBe(ErrorCode.CONFLICT);
      expect(response.body.message).toContain(PAST);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
    });

    it('conflicts with a day the employee punched themselves', async () => {
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employeeId,
        siteId: null,
        workDate: PAST,
      });

      const response = await create().expect(409);
      expect(response.body.code).toBe(ErrorCode.CONFLICT);
    });

    it('refuses a check-out earlier in the day than the check-in', async () => {
      const response = await create({ checkInTime: '17:30', checkOutTime: '08:47' }).expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details.map((d: { path: string }) => d.path)).toContain('checkOutTime');
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it(`refuses a shift shorter than ${MIN_SHIFT_MINUTES} minute`, async () => {
      // The same rule and the same code the punch path gives a check-out that
      // arrives in the same breath as its check-in.
      const response = await create({ checkInTime: '08:47', checkOutTime: '08:47' }).expect(409);

      expect(response.body.code).toBe(ErrorCode.SHIFT_TOO_SHORT);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('accepts a shift of exactly the minimum length', async () => {
      const response = await create({ checkInTime: '08:47', checkOutTime: '08:48' }).expect(201);
      expect(response.body.workedMinutes).toBe(MIN_SHIFT_MINUTES);
    });

    it(`refuses a carried-over shift longer than ${MAX_CARRY_OVER_SHIFT_HOURS} hours`, async () => {
      const response = await create({
        checkInTime: '00:05',
        checkOutTime: '23:00',
        checkOutNextDay: true,
      }).expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details.map((d: { path: string }) => d.path)).toContain('checkOutTime');
    });

    it('refuses a future work date', async () => {
      const response = await create({ workDate: '2026-03-11' }).expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details.map((d: { path: string }) => d.path)).toContain('workDate');
    });

    it('refuses times later today than the server clock', async () => {
      const response = await create({
        workDate: TODAY,
        checkInTime: '08:00',
        checkOutTime: '17:30',
      }).expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details.map((d: { path: string }) => d.path)).toContain('checkOutTime');
    });

    it('allows a same-day correction for hours that have already passed', async () => {
      const response = await create({
        workDate: TODAY,
        checkInTime: '08:00',
        checkOutTime: '09:00',
      }).expect(201);

      expect(response.body.workDate).toBe(TODAY);
      expect(response.body.lateMinutes).toBe(0);
    });

    it('will not record a day for an employee in another tenant', async () => {
      const other = await createUserAndLogin(ctx);

      const response = await admin
        .post(ENTRIES)
        .send({ userId: other.user.id, ...DAY })
        .expect(404);

      expect(response.body.code).toBe(ErrorCode.NOT_FOUND);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('will not record a day for somebody who has left', async () => {
      const departed = await createUser(ctx, {
        organizationId: admin.organization.id,
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      });

      await admin
        .post(ENTRIES)
        .send({ userId: departed.user.id, ...DAY })
        .expect(404);
    });

    it('writes an audit row naming the administrator and the day', async () => {
      const response = await create().expect(201);
      const [row, ...rest] = await auditRows('admin.attendance.created');

      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        entityType: 'AttendanceRecord',
        entityId: response.body.id,
        actorId: admin.user.id,
        organizationId: admin.organization.id,
      });
      expect(row?.metadata).toMatchObject({
        userId: employeeId,
        workDate: PAST,
        checkInAt: '2026-03-03T05:47:00.000Z',
        note: NOTE,
      });
    });

    it('writes no audit row for a refused entry', async () => {
      await create({ workDate: '2026-03-11' }).expect(400);
      expect(await auditRows('admin.attendance.created')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/attendance/:id
  // -------------------------------------------------------------------------

  describe('PATCH /admin/attendance/:id', () => {
    /** A record the employee punched themselves, on `PAST`, never closed. */
    async function punchedRecord(): Promise<string> {
      const record = await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employeeId,
        siteId: null,
        workDate: PAST,
        checkInAt: new Date('2026-03-03T05:47:00.000Z'),
        checkOutAt: null,
        status: AttendanceStatus.INCOMPLETE,
        workedMinutes: null,
      });
      return record.id;
    }

    it('closes a day the employee forgot to check out of', async () => {
      const id = await punchedRecord();

      const response = await admin
        .patch(`${ENTRIES}/${id}`)
        .send({ checkOutTime: '17:30', note: 'Forgot to check out' })
        .expect(200);

      expect(response.body).toMatchObject({
        checkInAt: '2026-03-03T05:47:00.000Z',
        checkOutAt: '2026-03-03T14:30:00.000Z',
        workedMinutes: 523,
        status: AttendanceStatus.PRESENT,
      });
    });

    it('flips a punched record to MANUAL and stamps who corrected it', async () => {
      const id = await punchedRecord();
      expect((await stored(id)).source).toBe(AttendanceSource.PUNCH);

      const response = await admin
        .patch(`${ENTRIES}/${id}`)
        .send({ checkOutTime: '17:30', note: 'Forgot to check out' })
        .expect(200);

      expect(response.body.source).toBe(AttendanceSource.MANUAL);
      expect(await stored(id)).toMatchObject({
        source: AttendanceSource.MANUAL,
        enteredById: admin.user.id,
        enteredAt: NOW,
        note: 'Forgot to check out',
      });
    });

    it('flips to MANUAL even when only the note changed', async () => {
      // No exception for a "harmless" edit: reaching this endpoint *is* an
      // administrative touch, and an exception is one more rule to get wrong.
      const id = await punchedRecord();

      const response = await admin
        .patch(`${ENTRIES}/${id}`)
        .send({ note: 'Confirmed with the site supervisor' })
        .expect(200);

      expect(response.body.source).toBe(AttendanceSource.MANUAL);
      expect(response.body.checkInAt).toBe('2026-03-03T05:47:00.000Z');
      expect(response.body.checkOutAt).toBeNull();
    });

    it('keeps the coordinates the employee actually punched from', async () => {
      // They are evidence of what happened. `source: MANUAL` is what tells a
      // reader those columns no longer all describe one event.
      const record = await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employeeId,
        siteId: null,
        workDate: PAST,
        checkInAt: new Date('2026-03-03T05:47:00.000Z'),
        checkOutAt: null,
        checkInAccuracyM: 9,
      });

      await admin
        .patch(`${ENTRIES}/${record.id}`)
        .send({ checkInTime: '09:00', note: 'Clocked in at the gate, not the desk' })
        .expect(200);

      expect(await stored(record.id)).toMatchObject({
        checkInLatitude: record.checkInLatitude,
        checkInLongitude: record.checkInLongitude,
        checkInAccuracyM: 9,
      });
    });

    it('recomputes lateness from the corrected check-in', async () => {
      const id = await punchedRecord();

      const response = await admin
        .patch(`${ENTRIES}/${id}`)
        .send({ checkInTime: '10:00', note: 'Arrived after the depot run' })
        .expect(200);

      // 09:00 start plus 15 minutes of grace; 10:00 is 45 minutes past it.
      expect(response.body.lateMinutes).toBe(45);
      expect(response.body.status).toBe(AttendanceStatus.INCOMPLETE);
    });

    it('reopens a day, clearing the whole check-out half of the record', async () => {
      const created = await create().expect(201);

      const response = await admin
        .patch(`${ENTRIES}/${created.body.id}`)
        .send({ checkOutTime: null, note: 'Entered against the wrong day' })
        .expect(200);

      expect(response.body).toMatchObject({
        checkOutAt: null,
        workedMinutes: null,
        status: AttendanceStatus.INCOMPLETE,
      });
      expect(await stored(created.body.id)).toMatchObject({
        checkOutAt: null,
        checkOutSiteId: null,
        checkOutLatitude: null,
        checkOutAccuracyM: null,
      });
    });

    it('leaves the untouched end of the shift exactly where it was', async () => {
      const created = await create().expect(201);

      const response = await admin
        .patch(`${ENTRIES}/${created.body.id}`)
        .send({ checkInTime: '09:15', note: 'Started later than first recorded' })
        .expect(200);

      expect(response.body.checkOutAt).toBe(created.body.checkOutAt);
      expect(response.body.checkInAt).toBe('2026-03-03T06:15:00.000Z');
    });

    it(`refuses a correction that would leave under ${MIN_SHIFT_MINUTES} minute`, async () => {
      const created = await create().expect(201);

      const response = await admin
        .patch(`${ENTRIES}/${created.body.id}`)
        .send({ checkInTime: '17:30', note: 'Mistyped' })
        .expect(409);

      expect(response.body.code).toBe(ErrorCode.SHIFT_TOO_SHORT);
      expect((await stored(created.body.id)).source).toBe(AttendanceSource.MANUAL);
    });

    it('refuses a correction with no reason', async () => {
      const created = await create().expect(201);

      const response = await admin
        .patch(`${ENTRIES}/${created.body.id}`)
        .send({ checkOutTime: '18:00' })
        .expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details.map((d: { path: string }) => d.path)).toContain('note');
    });

    it('will not correct a record in another tenant', async () => {
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const outsider = await createUser(ctx, { organizationId: other.organization.id });
      const theirs = await seedAttendanceRecord(ctx, {
        organizationId: other.organization.id,
        userId: outsider.user.id,
        siteId: null,
        workDate: PAST,
      });

      const response = await admin
        .patch(`${ENTRIES}/${theirs.id}`)
        .send({ checkOutTime: '18:00', note: 'Not mine to edit' })
        .expect(404);

      expect(response.body.code).toBe(ErrorCode.NOT_FOUND);
      expect(await stored(theirs.id)).toMatchObject({ source: AttendanceSource.PUNCH });
    });

    it('answers a 404 for a record that never existed', async () => {
      await admin
        .patch(`${ENTRIES}/00000000-0000-4000-8000-000000000000`)
        .send({ note: 'Nothing here' })
        .expect(404);
    });

    it('rejects an id that is not a uuid before it reaches the database', async () => {
      const response = await admin
        .patch(`${ENTRIES}/not-a-uuid`)
        .send({ note: 'Nothing here' })
        .expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('writes an audit row carrying what the record said before', async () => {
      const id = await punchedRecord();

      await admin
        .patch(`${ENTRIES}/${id}`)
        .send({ checkOutTime: '17:30', note: 'Forgot to check out' })
        .expect(200);

      const [row] = await auditRows('admin.attendance.updated');
      expect(row).toMatchObject({ entityType: 'AttendanceRecord', entityId: id });
      expect(row?.metadata).toMatchObject({
        previousSource: AttendanceSource.PUNCH,
        previousCheckOutAt: '',
        checkOutAt: '2026-03-03T14:30:00.000Z',
        note: 'Forgot to check out',
      });
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/attendance/:id
  // -------------------------------------------------------------------------

  describe('DELETE /admin/attendance/:id', () => {
    it('removes the record', async () => {
      const created = await create().expect(201);

      await admin.delete(`${ENTRIES}/${created.body.id}`).expect(204);

      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('frees the date, so the day can be recorded again', async () => {
      const created = await create().expect(201);
      await admin.delete(`${ENTRIES}/${created.body.id}`).expect(204);

      await create({ note: 'Re-entered with the right hours' }).expect(201);
    });

    it('removes a punched record too, and says so in the trail', async () => {
      const record = await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employeeId,
        siteId: null,
        workDate: PAST,
      });

      await admin.delete(`${ENTRIES}/${record.id}`).expect(204);

      const [row] = await auditRows('admin.attendance.deleted');
      expect(row?.metadata).toMatchObject({
        source: AttendanceSource.PUNCH,
        userId: employeeId,
        workDate: PAST,
      });
    });

    it('keeps the whole record in the audit row, since nothing else will', async () => {
      const created = await create().expect(201);
      await admin.delete(`${ENTRIES}/${created.body.id}`).expect(204);

      const [row] = await auditRows('admin.attendance.deleted');
      expect(row).toMatchObject({ entityId: created.body.id, actorId: admin.user.id });
      expect(row?.metadata).toMatchObject({
        checkInAt: '2026-03-03T05:47:00.000Z',
        checkOutAt: '2026-03-03T14:30:00.000Z',
        lateMinutes: 0,
        note: NOTE,
      });
    });

    it('will not remove a record in another tenant', async () => {
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const outsider = await createUser(ctx, { organizationId: other.organization.id });
      const theirs = await seedAttendanceRecord(ctx, {
        organizationId: other.organization.id,
        userId: outsider.user.id,
        siteId: null,
        workDate: PAST,
      });

      const response = await admin.delete(`${ENTRIES}/${theirs.id}`).expect(404);

      expect(response.body.code).toBe(ErrorCode.NOT_FOUND);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
    });

    it('writes no audit row when there was nothing to delete', async () => {
      await admin.delete(`${ENTRIES}/00000000-0000-4000-8000-000000000000`).expect(404);
      expect(await auditRows('admin.attendance.deleted')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/attendance
  // -------------------------------------------------------------------------

  describe('GET /admin/attendance', () => {
    const range = 'from=2026-03-01&to=2026-03-31';

    it('lists the range newest first, with provenance on every row', async () => {
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employeeId,
        siteId: null,
        workDate: '2026-03-01',
      });
      await create().expect(201);

      const response = await admin.get(`${ENTRIES}?${range}`).expect(200);

      const rows = response.body.data as AttendanceEntryDto[];
      expect(rows.map((r) => r.workDate)).toEqual([PAST, '2026-03-01']);
      expect(rows.map((r) => r.source)).toEqual([AttendanceSource.MANUAL, AttendanceSource.PUNCH]);
      expect(rows[0]?.enteredBy?.fullName).toBe(admin.user.fullName);
      expect(rows[1]?.enteredBy).toBeNull();
      expect(rows[1]?.note).toBeNull();
    });

    it('narrows to what was typed in', async () => {
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employeeId,
        siteId: null,
        workDate: '2026-03-01',
      });
      await create().expect(201);

      const response = await admin.get(`${ENTRIES}?${range}&source=MANUAL`).expect(200);

      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].workDate).toBe(PAST);
    });

    it('narrows to one employee', async () => {
      const other = await createUser(ctx, { organizationId: admin.organization.id });
      await create().expect(201);
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: other.user.id,
        siteId: null,
        workDate: PAST,
      });

      const response = await admin.get(`${ENTRIES}?${range}&userId=${employeeId}`).expect(200);

      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].userId).toBe(employeeId);
    });

    it('excludes days outside the range', async () => {
      await create().expect(201);
      const response = await admin.get(`${ENTRIES}?from=2026-03-04&to=2026-03-09`).expect(200);
      expect(response.body.meta.total).toBe(0);
    });

    it('shows nothing of another tenant', async () => {
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const outsider = await createUser(ctx, { organizationId: other.organization.id });
      await seedAttendanceRecord(ctx, {
        organizationId: other.organization.id,
        userId: outsider.user.id,
        siteId: null,
        workDate: PAST,
      });

      const response = await admin.get(`${ENTRIES}?${range}`).expect(200);
      expect(response.body.meta.total).toBe(0);
    });

    it('rejects an unbounded window', async () => {
      const response = await admin.get(ENTRIES).expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  // -------------------------------------------------------------------------
  // Authorisation
  // -------------------------------------------------------------------------

  describe('authorisation', () => {
    const SOME_ID = '00000000-0000-4000-8000-000000000000';
    const ROUTES: ReadonlyArray<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string }> = [
      { method: 'get', path: `${ENTRIES}?from=2026-03-01&to=2026-03-31` },
      { method: 'post', path: ENTRIES },
      { method: 'patch', path: `${ENTRIES}/${SOME_ID}` },
      { method: 'delete', path: `${ENTRIES}/${SOME_ID}` },
    ];

    it.each(ROUTES)('refuses a MEMBER on $method $path', async ({ method, path }) => {
      const member = await createUserAndLogin(ctx, {
        role: Role.MEMBER,
        organizationId: admin.organization.id,
      });

      const response = await member[method](path).send({});
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it.each(ROUTES)('refuses an anonymous caller on $method $path', async ({ method, path }) => {
      const response = await ctx.http[method](`/api/v1${path}`).send({});
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    });

    it('lets a MEMBER change nothing, even about their own attendance', async () => {
      const created = await create().expect(201);
      const employee = await createUserAndLogin(ctx, {
        organizationId: admin.organization.id,
      });

      await employee.delete(`${ENTRIES}/${created.body.id}`).expect(403);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
    });
  });
});
