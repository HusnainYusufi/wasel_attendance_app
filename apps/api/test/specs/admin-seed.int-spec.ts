import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Role } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_PASSWORDS,
  SeedError,
  assertSafeForTarget,
  isPlaceholderPassword,
  publishedAdminPassword,
  readEnv,
  seed,
} from '../../prisma/seed.js';
import { createTestApp, type TestApp } from '../support/index.js';

/**
 * `pnpm db:seed`, exercised as code rather than as a subprocess.
 *
 * The seed writes the one account that has every permission in a tenant, so its
 * refusals matter more than its happy path. They are also the parts a subprocess
 * test cannot pin down: the process would load `.env`, and the whole point of the
 * environment check is what happens when there is no `.env` to load.
 */

const ENV_EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '.env.example',
);

const BASE_ENV = {
  DATABASE_URL: 'postgresql://wasel:secret@localhost:5432/wasel?schema=public',
  SEED_ADMIN_EMAIL: 'admin@wasel.app',
  SEED_ADMIN_PASSWORD: 'Sunflower42Bridge',
};

describe('database seed', () => {
  describe('the environment it will accept', () => {
    /**
     * The finding this test exists for: `NODE_ENV` used to default to
     * `development`, and the production refusal was written as
     * `if (NODE_ENV !== 'production') return`. An unset `NODE_ENV` — the normal
     * state of a container image and of most CI runners — therefore skipped the
     * check entirely and seeded a tenant-wide administrator with the password
     * published in `.env.example`.
     */
    it('refuses to run at all when NODE_ENV is unset', () => {
      expect(() => readEnv({ ...BASE_ENV })).toThrow(SeedError);
      expect(() => readEnv({ ...BASE_ENV })).toThrow(/NODE_ENV/);
    });

    it('refuses an environment it does not recognise', () => {
      expect(() => readEnv({ ...BASE_ENV, NODE_ENV: 'staging' })).toThrow(SeedError);
      expect(() => readEnv({ ...BASE_ENV, NODE_ENV: '' })).toThrow(SeedError);
    });

    it('accepts the three environments it knows', () => {
      for (const NODE_ENV of ['development', 'test', 'production']) {
        expect(readEnv({ ...BASE_ENV, NODE_ENV }).NODE_ENV).toBe(NODE_ENV);
      }
    });
  });

  describe('the placeholder-password refusal', () => {
    const withPlaceholder = (NODE_ENV: string) =>
      readEnv({ ...BASE_ENV, NODE_ENV, SEED_ADMIN_PASSWORD: 'Admin123!Change' });

    it('refuses a published password anywhere but development and test', () => {
      expect(() => assertSafeForTarget(withPlaceholder('production'))).toThrow(SeedError);
    });

    it('allows it in development and in test, where it is the point', () => {
      expect(() => assertSafeForTarget(withPlaceholder('development'))).not.toThrow();
      expect(() => assertSafeForTarget(withPlaceholder('test'))).not.toThrow();
    });

    it('allows a real password in production', () => {
      expect(() =>
        assertSafeForTarget(readEnv({ ...BASE_ENV, NODE_ENV: 'production' })),
      ).not.toThrow();
    });

    /**
     * The list of placeholders is hand-written, and a hand-written copy of
     * somebody else's constant drifts. Changing `.env.example` without touching
     * `seed.ts` used to disarm the guard silently; now the file is consulted at
     * runtime *and* the drift fails here, where it is visible.
     */
    it('covers the password actually published in .env.example', () => {
      const published = publishedAdminPassword(ENV_EXAMPLE);
      expect(published).not.toBeNull();
      expect(readFileSync(ENV_EXAMPLE, 'utf8')).toContain('SEED_ADMIN_PASSWORD');
      expect(PLACEHOLDER_PASSWORDS).toContain(published);
      expect(isPlaceholderPassword(published ?? '')).toBe(true);
    });

    it('treats a password published only in the file as a placeholder too', () => {
      expect(isPlaceholderPassword('Sunflower42Bridge')).toBe(false);
    });
  });

  describe('against a real database', () => {
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

    const env = (overrides: Record<string, string> = {}) =>
      readEnv({
        ...BASE_ENV,
        NODE_ENV: 'test',
        SEED_ORG_NAME: 'Seeded Tenant',
        SEED_ORG_SLUG: 'seeded-tenant',
        SEED_ORG_TIMEZONE: 'Asia/Riyadh',
        ...overrides,
      });

    it('creates the tenant, the administrator and the first site, then does nothing', async () => {
      const first = await seed(env(), ctx.prisma);
      expect(first.steps.map((step) => step.outcome)).toEqual(['created', 'created', 'created']);
      expect(first.warnings).toEqual([]);

      const second = await seed(env(), ctx.prisma);
      expect(second.steps.map((step) => step.outcome)).toEqual([
        'existing',
        'existing',
        'existing',
      ]);

      const admins = await ctx.prisma.user.count({ where: { role: Role.ADMIN, deletedAt: null } });
      expect(admins).toBe(1);
    });

    /**
     * The lookup used to ignore `deletedAt`, so a soft-deleted administrator was
     * mistaken for a live one: `db:seed` printed "existing … password left
     * unchanged / Nothing to do" and exited 0 while the tenant had **zero**
     * active administrators and nobody could sign in.
     */
    it('refuses when a soft-deleted user holds the administrator address', async () => {
      await seed(env(), ctx.prisma);
      await ctx.prisma.user.updateMany({
        where: { email: BASE_ENV.SEED_ADMIN_EMAIL },
        data: { deletedAt: new Date() },
      });
      expect(await ctx.prisma.user.count({ where: { role: Role.ADMIN, deletedAt: null } })).toBe(0);

      await expect(seed(env(), ctx.prisma)).rejects.toThrow(SeedError);
      await expect(seed(env(), ctx.prisma)).rejects.toThrow(/soft-deleted/);
    });

    /**
     * The organization's timezone decides what `workDate` *means*. Declining to
     * overwrite it is right; declining silently is how an operator concludes
     * their `SEED_ORG_TIMEZONE` took effect when every record is still filed
     * against the old zone.
     */
    it('says so when it ignores SEED_ORG_TIMEZONE on an existing organization', async () => {
      await seed(env(), ctx.prisma);

      const again = await seed(env({ SEED_ORG_TIMEZONE: 'Europe/London' }), ctx.prisma);
      expect(again.warnings).toHaveLength(1);
      expect(again.warnings[0]).toContain('Europe/London');
      expect(again.warnings[0]).toContain('Asia/Riyadh');

      const organization = await ctx.prisma.organization.findUniqueOrThrow({
        where: { slug: 'seeded-tenant' },
      });
      expect(organization.timezone).toBe('Asia/Riyadh');
    });

    it('stays quiet when the timezone matches', async () => {
      await seed(env(), ctx.prisma);
      expect((await seed(env(), ctx.prisma)).warnings).toEqual([]);
    });
  });
});
