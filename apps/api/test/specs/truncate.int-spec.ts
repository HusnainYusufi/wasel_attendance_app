import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { createTestApp, truncateAll, type TestApp } from '../support/index.js';

/**
 * Lives in its own file on purpose: `truncateAll` memoises its table list in
 * module scope, and the point of these assertions is what that cache does on a
 * failed discovery. Vitest gives each file its own worker, so the cache starts
 * empty here.
 */
describe('truncateAll table discovery', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('fails loudly when the schema holds no tables instead of quietly doing nothing', async () => {
    const executeRawUnsafe = vi.fn(() => Promise.resolve(0));
    const empty = {
      $queryRaw: () => Promise.resolve([]),
      $executeRawUnsafe: executeRawUnsafe,
    } as unknown as PrismaService;

    // An unmigrated database used to yield an empty array, which is truthy, so it
    // was memoised for the worker's life: every later truncate became a no-op and
    // each test ran against the previous test's rows.
    await expect(truncateAll(empty)).rejects.toThrow(/no tables/i);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('does not memoise that failure, so the next call rediscovers the real tables', async () => {
    await ctx.prisma.organization.create({
      data: { name: 'Cache Probe', slug: 'cache-probe', timezone: 'Asia/Riyadh' },
    });

    await truncateAll(ctx.prisma);

    expect(await ctx.prisma.organization.count()).toBe(0);
  });
});
