import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNotFound,
  isUniqueViolation,
  uniqueViolationConstraint,
  uniqueViolationFields,
} from '../../src/prisma/prisma-errors.js';
import { createTestApp, type TestApp } from '../support/index.js';

const ORG = {
  name: 'Truncation Test Org',
  slug: 'truncation-test-org',
  timezone: 'Asia/Riyadh',
};

describe('PrismaService against a real database', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.truncate();
  });

  it('connects through the driver adapter and answers a query', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
    expect(rows).toEqual([{ one: 1 }]);
  });

  it('writes and reads a row', async () => {
    const created = await ctx.prisma.organization.create({ data: ORG });
    expect(created.timezone).toBe('Asia/Riyadh');

    const found = await ctx.prisma.organization.findUnique({ where: { slug: ORG.slug } });
    expect(found?.id).toBe(created.id);
  });

  it('truncates every table, discovered from the catalogue', async () => {
    const org = await ctx.prisma.organization.create({ data: ORG });
    await ctx.prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'someone@wasel.test',
        passwordHash: 'not-a-real-hash',
        fullName: 'Someone',
      },
    });

    await ctx.truncate();

    expect(await ctx.prisma.organization.count()).toBe(0);
    expect(await ctx.prisma.user.count()).toBe(0);
    expect(await ctx.prisma.site.count()).toBe(0);
    expect(await ctx.prisma.attendanceEvent.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count()).toBe(0);
    // `sessions` holds refresh-token hashes: a row surviving between tests is
    // both cross-contamination and a credential outliving the test that made it.
    expect(await ctx.prisma.session.count()).toBe(0);
  });

  it('leaves the migration ledger intact so the next test run is not re-migrated', async () => {
    await ctx.truncate();
    const rows = await ctx.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"
    `;
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('recognises a real unique violation through the typed helper', async () => {
    await ctx.prisma.organization.create({ data: ORG });

    let caught: unknown;
    try {
      await ctx.prisma.organization.create({ data: ORG });
    } catch (error) {
      caught = error;
    }

    expect(isUniqueViolation(caught)).toBe(true);
    expect(uniqueViolationConstraint(caught)).toBe('organizations_slug_key');
    expect(uniqueViolationFields(caught)).toEqual(['slug']);
    expect(isUniqueViolation(caught, 'slug')).toBe(true);
    expect(isUniqueViolation(caught, 'organizations_slug_key')).toBe(true);
    expect(isUniqueViolation(caught, 'name')).toBe(false);
    expect(isNotFound(caught)).toBe(false);
  });

  it('recognises a real missing-record error through the typed helper', async () => {
    let caught: unknown;
    try {
      await ctx.prisma.organization.update({
        where: { slug: 'no-such-organization' },
        data: { name: 'x' },
      });
    } catch (error) {
      caught = error;
    }

    expect(isNotFound(caught)).toBe(true);
    expect(isUniqueViolation(caught)).toBe(false);
  });

  it('enforces the per-user, per-day attendance uniqueness the check-in flow relies on', async () => {
    const org = await ctx.prisma.organization.create({ data: ORG });
    const user = await ctx.prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'racer@wasel.test',
        passwordHash: 'not-a-real-hash',
        fullName: 'Racer',
      },
    });
    const site = await ctx.prisma.site.create({
      data: {
        organizationId: org.id,
        name: 'HQ',
        latitude: 24.7136,
        longitude: 46.6753,
      },
    });

    const record = {
      organizationId: org.id,
      userId: user.id,
      workDate: new Date('2026-01-15T00:00:00.000Z'),
      checkInAt: new Date('2026-01-15T06:00:00.000Z'),
      checkInSiteId: site.id,
      checkInLatitude: 24.7136,
      checkInLongitude: 46.6753,
      checkInAccuracyM: 12,
      checkInDistanceM: 5,
    };

    // Both inserts are issued before either is awaited: this is the double-tap
    // race the unique index exists to lose safely.
    const results = await Promise.allSettled([
      ctx.prisma.attendanceRecord.create({ data: record }),
      ctx.prisma.attendanceRecord.create({ data: record }),
    ]);

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(isUniqueViolation((rejected[0] as PromiseRejectedResult).reason)).toBe(true);
    expect(await ctx.prisma.attendanceRecord.count()).toBe(1);
  });
});
