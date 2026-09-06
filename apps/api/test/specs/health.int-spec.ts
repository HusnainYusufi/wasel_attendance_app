import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '@wasel/contracts';
import { DatabaseProbe } from '../../src/health/database-probe.js';
import { createTestApp, type TestApp } from '../support/index.js';

describe('health endpoints', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('reports liveness without touching the database', async () => {
    const response = await ctx.http.get('/api/v1/health/live').expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports readiness after a real SELECT 1', async () => {
    const response = await ctx.http.get('/api/v1/health/ready').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('is reachable without authentication', async () => {
    await ctx.http.get('/api/v1/health/live').expect(200);
  });

  it('probes on a connection of its own, named apart from application traffic', async () => {
    await ctx.http.get('/api/v1/health/ready').expect(200);

    const rows = await ctx.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM pg_stat_activity
      WHERE application_name = 'wasel-api-probe' AND datname = current_database()
    `;
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});

describe('readiness under a saturated application pool', () => {
  const POOL_MAX = 2;
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ env: { DATABASE_POOL_MAX: String(POOL_MAX) } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('stays ready while every application-pool connection is checked out', async () => {
    // The cascade this design exists to prevent: under load the probe could not
    // acquire a pooled connection, hit its two-second deadline and answered 503,
    // so the orchestrator pulled the replica and moved its traffic onto the ones
    // already saturating.
    const started: Array<Promise<void>> = [];
    const release: Array<() => void> = [];

    const held = Array.from({ length: POOL_MAX }, () => {
      let signalStarted!: () => void;
      started.push(
        new Promise<void>((resolve) => {
          signalStarted = resolve;
        }),
      );
      return ctx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          const gate = new Promise<void>((resolve) => release.push(resolve));
          signalStarted();
          await gate;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
    });

    try {
      await Promise.all(started);
      const response = await ctx.http.get('/api/v1/health/ready').expect(200);
      expect(response.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
    } finally {
      for (const resolve of release) resolve();
      await Promise.allSettled(held);
    }
  });
});

describe('readiness with an unreachable database', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(DatabaseProbe).useValue({
          ping: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5434')),
          onModuleDestroy: () => Promise.resolve(),
        }),
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('answers 503 with the error envelope', async () => {
    const response = await ctx.http.get('/api/v1/health/ready').expect(503);

    expect(response.body).toMatchObject({
      statusCode: 503,
      code: ErrorCode.INTERNAL_ERROR,
      details: [{ path: 'database', message: 'unreachable' }],
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it('does not leak the connection error to the client', async () => {
    const response = await ctx.http.get('/api/v1/health/ready').expect(503);
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(response.body)).not.toContain('5434');
  });

  it('still answers liveness', async () => {
    await ctx.http.get('/api/v1/health/live').expect(200);
  });
});
