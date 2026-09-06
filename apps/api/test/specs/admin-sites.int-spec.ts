import { Role, SITE_RADIUS_MAX_M, SITE_RADIUS_MIN_M, type SiteDto } from '@wasel/contracts';
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

const HQ = {
  name: 'Head Office',
  address: 'King Fahd Road, Riyadh',
  latitude: 24.7136,
  longitude: 46.6753,
  radiusMeters: 150,
};

describe('admin sites', () => {
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
    admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
  });

  describe('POST /admin/sites', () => {
    it('creates an active site with its geofence', async () => {
      const response = await admin.post('/admin/sites').send(HQ).expect(201);
      expect(response.body).toMatchObject({ ...HQ, isActive: true });
      expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('can create a site that starts deactivated', async () => {
      const response = await admin
        .post('/admin/sites')
        .send({ ...HQ, isActive: false })
        .expect(201);
      expect(response.body.isActive).toBe(false);
    });

    it('reports a duplicate name as SITE_NAME_TAKEN', async () => {
      await admin.post('/admin/sites').send(HQ).expect(201);
      const response = await admin.post('/admin/sites').send(HQ).expect(409);
      expect(response.body.code).toBe('SITE_NAME_TAKEN');
    });

    it('allows the same site name in another tenant', async () => {
      await admin.post('/admin/sites').send(HQ).expect(201);
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      await other.post('/admin/sites').send(HQ).expect(201);
    });

    it.each([
      [{ ...HQ, latitude: 91 }, 'latitude'],
      [{ ...HQ, longitude: -181 }, 'longitude'],
      [{ ...HQ, latitude: Number.NaN }, 'latitude'],
      [{ ...HQ, radiusMeters: SITE_RADIUS_MIN_M - 1 }, 'radiusMeters'],
      [{ ...HQ, radiusMeters: SITE_RADIUS_MAX_M + 1 }, 'radiusMeters'],
      [{ ...HQ, radiusMeters: 100.5 }, 'radiusMeters'],
      [{ ...HQ, name: 'A' }, 'name'],
    ])('rejects an invalid geofence (%#)', async (payload, path) => {
      const response = await admin.post('/admin/sites').send(payload).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details.some((d: { path: string }) => d.path === path)).toBe(true);
    });

    it('writes an audit row carrying the geofence', async () => {
      const response = await admin.post('/admin/sites').send(HQ).expect(201);
      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'admin.site.created', entityId: response.body.id },
      });
      expect(audit).toMatchObject({ entityType: 'Site', actorId: admin.user.id });
      expect(audit?.metadata).toMatchObject({ radiusMeters: 150 });
    });
  });

  describe('GET /admin/sites', () => {
    it('lists alphabetically and includes deactivated sites', async () => {
      await seedSite(ctx, admin.organization.id, { name: 'Warehouse', isActive: false });
      await seedSite(ctx, admin.organization.id, { name: 'Head Office' });

      const response = await admin.get('/admin/sites').expect(200);
      expect(response.body.data.map((s: SiteDto) => s.name)).toEqual(['Head Office', 'Warehouse']);
      expect(response.body.meta.total).toBe(2);
    });

    it('hides retired sites', async () => {
      await seedSite(ctx, admin.organization.id, {
        name: 'Closed Branch',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const response = await admin.get('/admin/sites').expect(200);
      expect(response.body.meta.total).toBe(0);
    });

    it('pages', async () => {
      await seedSite(ctx, admin.organization.id, { name: 'A site' });
      await seedSite(ctx, admin.organization.id, { name: 'B site' });

      const page = await admin.get('/admin/sites?page=2&pageSize=1').expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.data[0].name).toBe('B site');
      expect(page.body.meta).toMatchObject({ total: 2, totalPages: 2, hasPrevious: true });
    });

    it('shows nothing of another tenant', async () => {
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      await seedSite(ctx, other.organization.id, { name: 'Their HQ' });

      const response = await admin.get('/admin/sites').expect(200);
      expect(response.body.meta.total).toBe(0);
    });
  });

  describe('GET/PATCH/DELETE /admin/sites/:id', () => {
    it('reads back one site', async () => {
      const site = await seedSite(ctx, admin.organization.id, { name: 'Head Office' });
      const response = await admin.get(`/admin/sites/${site.id}`).expect(200);
      expect(response.body).toMatchObject({ id: site.id, name: 'Head Office' });
    });

    it('moves a geofence', async () => {
      const site = await seedSite(ctx, admin.organization.id);
      const response = await admin
        .patch(`/admin/sites/${site.id}`)
        .send({ latitude: 21.4225, longitude: 39.8262, radiusMeters: 300 })
        .expect(200);
      expect(response.body).toMatchObject({
        latitude: 21.4225,
        longitude: 39.8262,
        radiusMeters: 300,
      });
    });

    it('reports a rename onto an existing name', async () => {
      await seedSite(ctx, admin.organization.id, { name: 'Head Office' });
      const other = await seedSite(ctx, admin.organization.id, { name: 'Warehouse' });

      const response = await admin
        .patch(`/admin/sites/${other.id}`)
        .send({ name: 'Head Office' })
        .expect(409);
      expect(response.body.code).toBe('SITE_NAME_TAKEN');
    });

    it('rejects an empty patch', async () => {
      const response = await admin
        .patch(`/admin/sites/${(await seedSite(ctx, admin.organization.id)).id}`)
        .send({})
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    /**
     * The regression this suite used to claim it covered but did not.
     *
     * `createSiteRequestSchema.isActive` carries `.default(true)` and `.partial()`
     * does not strip a default, so a patch schema derived from it injected
     * `isActive: true` into every request — silently reactivating a geofence
     * whenever an administrator edited an unrelated field on a branch they had
     * deliberately closed, and letting the site accept punches again. Sending
     * `{}` never showed it, because an empty body is rejected for its own
     * unrelated reason: the payload has to carry a *different* field for the
     * injected default to ride along with it.
     */
    it('leaves a deactivated site deactivated when an unrelated field is patched', async () => {
      const site = await seedSite(ctx, admin.organization.id, { isActive: false });

      const response = await admin
        .patch(`/admin/sites/${site.id}`)
        .send({ radiusMeters: 275 })
        .expect(200);

      expect(response.body).toMatchObject({ radiusMeters: 275, isActive: false });
      const row = await ctx.prisma.site.findUniqueOrThrow({ where: { id: site.id } });
      expect(row.isActive).toBe(false);
    });

    it('still lets a patch reactivate a site when it asks to', async () => {
      const site = await seedSite(ctx, admin.organization.id, { isActive: false });
      await admin.patch(`/admin/sites/${site.id}`).send({ isActive: true }).expect(200);

      const row = await ctx.prisma.site.findUniqueOrThrow({ where: { id: site.id } });
      expect(row.isActive).toBe(true);
    });

    it('cannot read, patch or delete another tenant’s site', async () => {
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const theirs = await seedSite(ctx, other.organization.id, { name: 'Their HQ' });

      await admin.get(`/admin/sites/${theirs.id}`).expect(404);
      await admin.patch(`/admin/sites/${theirs.id}`).send({ radiusMeters: 9000 }).expect(404);
      await admin.delete(`/admin/sites/${theirs.id}`).expect(404);

      const untouched = await ctx.prisma.site.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(untouched.radiusMeters).not.toBe(9000);
      expect(untouched.deletedAt).toBeNull();
    });

    it('retires a site without touching the records that reference it', async () => {
      const site = await seedSite(ctx, admin.organization.id, { name: 'Closing Branch' });
      const employee = await createUser(ctx, { organizationId: admin.organization.id });
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId: site.id,
        workDate: '2026-03-02',
      });

      await admin.delete(`/admin/sites/${site.id}`).expect(204);

      const row = await ctx.prisma.site.findUniqueOrThrow({ where: { id: site.id } });
      // Soft: the foreign key from `attendance_records` still resolves, so the
      // historical report keeps printing "Closing Branch" rather than failing or
      // losing the row.
      expect(row.deletedAt).not.toBeNull();
      // Cleared too, so a query that only knows about `isActive` — the geofence
      // lookup — stops offering it without having to learn about soft deletes.
      expect(row.isActive).toBe(false);

      const report = await admin
        .get('/admin/reports/attendance?from=2026-03-01&to=2026-03-31')
        .expect(200);
      expect(report.body.data[0].checkInSiteName).toBe('Closing Branch');
    });

    it('answers 404 on a second delete', async () => {
      const site = await seedSite(ctx, admin.organization.id);
      await admin.delete(`/admin/sites/${site.id}`).expect(204);
      await admin.delete(`/admin/sites/${site.id}`).expect(404);
    });

    it('deactivating a site leaves its history intact', async () => {
      const site = await seedSite(ctx, admin.organization.id, { name: 'Night Depot' });
      const employee = await createUser(ctx, { organizationId: admin.organization.id });
      await seedAttendanceRecord(ctx, {
        organizationId: admin.organization.id,
        userId: employee.user.id,
        siteId: site.id,
        workDate: '2026-03-05',
      });

      await admin.patch(`/admin/sites/${site.id}`).send({ isActive: false }).expect(200);

      const records = await ctx.prisma.attendanceRecord.findMany({
        where: { checkInSiteId: site.id },
      });
      expect(records).toHaveLength(1);
    });
  });
});
