import { ACCURACY_CEILING_M, Role } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { seedAttendanceRecord, seedSite } from '../fixtures/admin-fixtures.js';
import {
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

describe('admin organization', () => {
  let ctx: TestApp;
  let admin: AuthenticatedActor;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AdminModule],
      env: { RATE_LIMIT_MAX: '100000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    admin = await createUserAndLogin(ctx, {
      role: Role.ADMIN,
      organization: { name: 'Wasel', timezone: 'Asia/Riyadh' },
    });
  });

  describe('GET /admin/organization', () => {
    it('returns the tenant policy', async () => {
      const response = await admin.get('/admin/organization').expect(200);
      expect(response.body).toMatchObject({
        id: admin.organization.id,
        name: 'Wasel',
        timezone: 'Asia/Riyadh',
        workdayStart: '09:00',
        // 09:00-18:00 is the shipped default: a nine-to-six office day.
        workdayEnd: '18:00',
        // Local midnight: a new tenant's business day is its calendar day, which
        // is what every organization created before the setting existed did.
        dayStartsAt: '00:00',
        lateGraceMinutes: 15,
        maxAccuracyMeters: 100,
        // The default preserves what every tenant did before the column existed.
        enforceGeofence: true,
      });
    });

    it("is scoped to the caller's own tenant", async () => {
      const other = await createUserAndLogin(ctx, {
        role: Role.ADMIN,
        organization: { name: 'Other Co', timezone: 'UTC' },
      });
      const response = await other.get('/admin/organization').expect(200);
      expect(response.body.id).toBe(other.organization.id);
      expect(response.body.id).not.toBe(admin.organization.id);
    });
  });

  describe('PATCH /admin/organization', () => {
    it('updates the workday policy', async () => {
      const response = await admin
        .patch('/admin/organization')
        .send({ workdayStart: '08:00', workdayEnd: '16:30', lateGraceMinutes: 5 })
        .expect(200);
      expect(response.body).toMatchObject({
        workdayStart: '08:00',
        workdayEnd: '16:30',
        lateGraceMinutes: 5,
      });
    });

    it('moves the business-day boundary a night-shift tenant needs', async () => {
      const response = await admin
        .patch('/admin/organization')
        .send({ dayStartsAt: '20:00' })
        .expect(200);

      expect(response.body.dayStartsAt).toBe('20:00');
      // Deliberately unconstrained against the workday window: a boundary inside
      // the off-hours is exactly the configuration the field exists to allow.
      expect(response.body.workdayStart).toBe('09:00');
    });

    it('records a boundary change in the audit log, with the value it replaced', async () => {
      await admin.patch('/admin/organization').send({ dayStartsAt: '20:00' }).expect(200);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { organizationId: admin.organization.id },
        orderBy: { createdAt: 'desc' },
      });
      // Like `timezone`: it changes what rows written after it *mean*, so a
      // report that straddles the change has to be explicable from the log.
      expect(entry.metadata).toMatchObject({ previousDayStartsAt: '00:00', dayStartsAt: '20:00' });
    });

    it('turns the geofence from a gate into a record, and back', async () => {
      const off = await admin
        .patch('/admin/organization')
        .send({ enforceGeofence: false })
        .expect(200);
      expect(off.body.enforceGeofence).toBe(false);

      const on = await admin
        .patch('/admin/organization')
        .send({ enforceGeofence: true })
        .expect(200);
      expect(on.body.enforceGeofence).toBe(true);
    });

    it('records the geofence switch in the audit log, with the value it replaced', async () => {
      await admin.patch('/admin/organization').send({ enforceGeofence: false }).expect(200);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { organizationId: admin.organization.id },
        orderBy: { createdAt: 'desc' },
      });
      // A month of out-of-range check-ins in a report is explained entirely by
      // *when* this was switched, so the log has to answer it without a reader
      // diffing every settings edit the tenant ever made.
      expect(entry.metadata).toMatchObject({
        previousEnforceGeofence: 'true',
        enforceGeofence: 'false',
      });
    });

    it('rejects a window that ends before it begins', async () => {
      const response = await admin
        .patch('/admin/organization')
        .send({ workdayStart: '18:00', workdayEnd: '09:00' })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a one-sided change that would invert the stored window', async () => {
      // The contract can only compare the two when both are sent; this is the
      // half only the server can see.
      const response = await admin
        .patch('/admin/organization')
        .send({ workdayStart: '23:00' })
        .expect(400);
      expect(response.body.details).toContainEqual({
        path: 'workdayEnd',
        message: expect.stringContaining('before'),
      });
    });

    it.each([
      [{ timezone: 'Mars/Olympus' }, 'timezone'],
      [{ workdayStart: '9am' }, 'workdayStart'],
      [{ dayStartsAt: '25:00' }, 'dayStartsAt'],
      [{ lateGraceMinutes: -1 }, 'lateGraceMinutes'],
      [{ maxAccuracyMeters: ACCURACY_CEILING_M + 1 }, 'maxAccuracyMeters'],
      [{ maxAccuracyMeters: 5 }, 'maxAccuracyMeters'],
      [{ enforceGeofence: 'off' }, 'enforceGeofence'],
      [{}, ''],
    ])('rejects an invalid patch (%#)', async (payload, field) => {
      const response = await admin.patch('/admin/organization').send(payload).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      // The tuple's second element is the field the rejection must be attributed
      // to. Asserting it stops a patch from being rejected for the right reason
      // but blamed on the wrong input, which is what the client renders.
      if (field !== '') {
        expect(response.body.details).toContainEqual(expect.objectContaining({ path: field }));
      }
    });

    it('cannot be used to move another tenant', async () => {
      const other = await createUserAndLogin(ctx, {
        role: Role.ADMIN,
        organization: { name: 'Other Co', timezone: 'UTC' },
      });

      await admin.patch('/admin/organization').send({ timezone: 'Europe/Berlin' }).expect(200);

      const untouched = await ctx.prisma.organization.findUniqueOrThrow({
        where: { id: other.organization.id },
      });
      expect(untouched.timezone).toBe('UTC');
    });
  });

  /**
   * The question this module has to get right.
   *
   * `workDate` is not a view over `checkInAt`; it is the record of which local
   * working day an employee was counted against, decided by the policy in force
   * when they punched. Rewriting it on a settings change would restate
   * attendance sheets that have already been paid against — so the change is
   * prospective, and the previous zone goes into the audit log.
   */
  describe('changing the timezone', () => {
    it('does not rewrite the work dates already recorded', async () => {
      const site = await seedSite(ctx, admin.organization.id);
      const employee = await createUser(ctx, { organizationId: admin.organization.id });
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId: site.id,
        workDate: '2026-03-01',
        // 22:30 UTC on the 1st is already the 2nd in Riyadh; the stored work date
        // is the one the policy produced at punch time and must stay put.
        checkInAt: new Date('2026-03-01T22:30:00.000Z'),
        checkOutAt: null,
      });

      await admin.patch('/admin/organization').send({ timezone: 'America/New_York' }).expect(200);

      const record = await ctx.prisma.attendanceRecord.findFirstOrThrow({
        where: { userId: employee.user.id },
      });
      expect(record.workDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');

      const report = await admin
        .get('/admin/reports/attendance?from=2026-03-01&to=2026-03-31')
        .expect(200);
      expect(report.body.data[0].workDate).toBe('2026-03-01');
      // The instant is untouched too — only its *rendering* now follows the new
      // zone, which is why every export states the zone it used.
      expect(report.body.data[0].checkInAt).toBe('2026-03-01T22:30:00.000Z');
    });

    it('records the previous zone so a report spanning the change is explicable', async () => {
      await admin.patch('/admin/organization').send({ timezone: 'Europe/Berlin' }).expect(200);

      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.organization.updated' },
      });
      expect(audit.metadata).toMatchObject({
        previousTimezone: 'Asia/Riyadh',
        timezone: 'Europe/Berlin',
      });
    });

    it('does not claim a timezone change when the zone did not move', async () => {
      await admin.patch('/admin/organization').send({ name: 'Wasel Group' }).expect(200);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.organization.updated' },
      });
      expect(audit.metadata).not.toHaveProperty('previousTimezone');
    });

    /**
     * The timeline row, which is what makes the discontinuity *queryable*.
     *
     * Freezing `workDate` only fixes half the problem: every instant in an export
     * is still rendered in the tenant's current zone, so a range that predates a
     * move produces rows whose check-in date contradicts their own work date. The
     * export reads these rows on every download to decide whether to say so — and
     * finding them inside `admin.organization.updated`'s JSON would mean a path
     * predicate over every settings edit the tenant has ever made.
     */
    it('records the move as its own filterable action', async () => {
      await admin.patch('/admin/organization').send({ timezone: 'Europe/Berlin' }).expect(200);

      const timeline = await ctx.prisma.auditLog.findMany({
        where: { action: 'admin.organization.timezone_changed' },
      });
      expect(timeline).toHaveLength(1);
      expect(timeline[0]?.metadata).toMatchObject({
        previousTimezone: 'Asia/Riyadh',
        timezone: 'Europe/Berlin',
      });
      expect(timeline[0]?.entityId).toBe(admin.organization.id);
      expect(timeline[0]?.actorId).toBe(admin.user.id);
    });

    it('adds nothing to the timeline when another setting changed', async () => {
      await admin.patch('/admin/organization').send({ lateGraceMinutes: 30 }).expect(200);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'admin.organization.timezone_changed' },
        }),
      ).toBe(0);
    });

    it('adds nothing to the timeline when the zone is re-sent unchanged', async () => {
      await admin.patch('/admin/organization').send({ timezone: 'Asia/Riyadh' }).expect(200);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'admin.organization.timezone_changed' },
        }),
      ).toBe(0);
    });
  });
});
