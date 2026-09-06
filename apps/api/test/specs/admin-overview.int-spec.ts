import { AttendanceStatus, PunchOutcome, Role, UserStatus } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { seedAttendanceEvent, seedAttendanceRecord, seedSite } from '../fixtures/admin-fixtures.js';
import {
  FixedClockService,
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

/** 21:30 UTC on the 14th is 00:30 on the 15th in Riyadh. */
const AFTER_LOCAL_MIDNIGHT = new Date('2026-03-14T21:30:00.000Z');

describe('admin overview', () => {
  let ctx: TestApp;
  let clock: FixedClockService;
  let admin: AuthenticatedActor;

  beforeAll(async () => {
    clock = new FixedClockService(AFTER_LOCAL_MIDNIGHT);
    ctx = await createTestApp({
      imports: [AuthModule, AdminModule],
      env: { RATE_LIMIT_MAX: '100000' },
      configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    clock.set(AFTER_LOCAL_MIDNIGHT);
    await ctx.truncate();
    admin = await createUserAndLogin(ctx, {
      role: Role.ADMIN,
      organization: { timezone: 'Asia/Riyadh' },
    });
  });

  it("reports today in the organization's timezone, not the server's", async () => {
    const response = await admin.get('/admin/overview').expect(200);
    // `toISOString().slice(0, 10)` would say 2026-03-14 here, and the dashboard
    // would empty itself three hours before local midnight every night.
    expect(response.body).toMatchObject({ workDate: '2026-03-15', timezone: 'Asia/Riyadh' });
  });

  it('counts an empty day without dividing by zero', async () => {
    const response = await admin.get('/admin/overview').expect(200);
    expect(response.body).toMatchObject({
      totalActiveUsers: 1,
      checkedInCount: 0,
      checkedOutCount: 0,
      lateCount: 0,
      absentCount: 1,
      rejectedAttemptsToday: 0,
    });
  });

  it('adds up: absent is everyone active who has not checked in', async () => {
    const organizationId = admin.organization.id;
    const site = await seedSite(ctx, organizationId);
    const [present, late, open, absent] = await Promise.all([
      createUser(ctx, { organizationId }),
      createUser(ctx, { organizationId }),
      createUser(ctx, { organizationId }),
      createUser(ctx, { organizationId }),
    ]);
    // Suspended and soft-deleted employees are not expected at work at all.
    await createUser(ctx, { organizationId, status: UserStatus.SUSPENDED });
    await createUser(ctx, { organizationId, deletedAt: new Date('2026-01-01T00:00:00.000Z') });

    await seedAttendanceRecord(ctx, {
      organizationId,
      userId: present.user.id,
      siteId: site.id,
      workDate: '2026-03-15',
    });
    await seedAttendanceRecord(ctx, {
      organizationId,
      userId: late.user.id,
      siteId: site.id,
      workDate: '2026-03-15',
      status: AttendanceStatus.LATE,
      lateMinutes: 25,
    });
    await seedAttendanceRecord(ctx, {
      organizationId,
      userId: open.user.id,
      siteId: site.id,
      workDate: '2026-03-15',
      checkOutAt: null,
    });

    const response = await admin.get('/admin/overview').expect(200);
    expect(response.body).toMatchObject({
      // admin + 4 seeded members
      totalActiveUsers: 5,
      checkedInCount: 3,
      // Two of the three have closed their day; the third is still on site.
      checkedOutCount: 2,
      lateCount: 1,
      absentCount: 2,
    });
    expect(absent.user.id).toBeDefined();
  });

  it('counts rejected punches, and only rejected ones', async () => {
    const organizationId = admin.organization.id;
    const employee = await createUser(ctx, { organizationId });

    await seedAttendanceEvent(ctx, {
      organizationId,
      userId: employee.user.id,
      workDate: '2026-03-15',
      outcome: PunchOutcome.REJECTED_OUT_OF_RANGE,
    });
    await seedAttendanceEvent(ctx, {
      organizationId,
      userId: employee.user.id,
      workDate: '2026-03-15',
      outcome: PunchOutcome.REJECTED_LOW_ACCURACY,
    });
    await seedAttendanceEvent(ctx, {
      organizationId,
      userId: employee.user.id,
      workDate: '2026-03-15',
      outcome: PunchOutcome.ACCEPTED,
    });
    // Yesterday's rejection belongs to yesterday's tile.
    await seedAttendanceEvent(ctx, {
      organizationId,
      userId: employee.user.id,
      workDate: '2026-03-14',
      outcome: PunchOutcome.REJECTED_OUT_OF_RANGE,
    });

    const response = await admin.get('/admin/overview').expect(200);
    expect(response.body.rejectedAttemptsToday).toBe(2);
  });

  it('rolls over with the local day', async () => {
    const organizationId = admin.organization.id;
    const site = await seedSite(ctx, organizationId);
    const employee = await createUser(ctx, { organizationId });
    await seedAttendanceRecord(ctx, {
      organizationId,
      userId: employee.user.id,
      siteId: site.id,
      workDate: '2026-03-15',
    });

    const today = await admin.get('/admin/overview').expect(200);
    expect(today.body.checkedInCount).toBe(1);

    // 20:59 UTC is still the 14th in Riyadh — one minute before the rollover.
    clock.set(new Date('2026-03-14T20:59:00.000Z'));
    const yesterday = await admin.get('/admin/overview').expect(200);
    expect(yesterday.body.workDate).toBe('2026-03-14');
    expect(yesterday.body.checkedInCount).toBe(0);
  });

  it('counts nothing from another tenant', async () => {
    const other = await createUserAndLogin(ctx, {
      role: Role.ADMIN,
      organization: { timezone: 'Asia/Riyadh' },
    });
    const site = await seedSite(ctx, other.organization.id);
    const employee = await createUser(ctx, { organizationId: other.organization.id });
    await seedAttendanceRecord(ctx, {
      organizationId: other.organization.id,
      userId: employee.user.id,
      siteId: site.id,
      workDate: '2026-03-15',
    });
    await seedAttendanceEvent(ctx, {
      organizationId: other.organization.id,
      userId: employee.user.id,
      workDate: '2026-03-15',
      outcome: PunchOutcome.REJECTED_OUT_OF_RANGE,
    });

    const response = await admin.get('/admin/overview').expect(200);
    expect(response.body).toMatchObject({
      totalActiveUsers: 1,
      checkedInCount: 0,
      rejectedAttemptsToday: 0,
    });
  });

  it('uses each tenant\'s own zone for its own "today"', async () => {
    const other = await createUserAndLogin(ctx, {
      role: Role.ADMIN,
      organization: { timezone: 'America/New_York' },
    });

    const riyadh = await admin.get('/admin/overview').expect(200);
    const newYork = await other.get('/admin/overview').expect(200);

    expect(riyadh.body.workDate).toBe('2026-03-15');
    expect(newYork.body.workDate).toBe('2026-03-14');
  });
});
