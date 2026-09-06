import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '@wasel/contracts';
import { ProbeModule } from '../support/probe.module.js';
import { createTestApp, type TestApp } from '../support/index.js';

const ALLOWED = 'http://localhost:5173';
const DENIED = 'https://attacker.example';

describe('CORS', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [ProbeModule],
      env: { CORS_ORIGINS: `${ALLOWED},capacitor://localhost` },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('reflects an allowlisted origin with credentials', async () => {
    const response = await ctx.http.get('/api/v1/__probe/ok').set('Origin', ALLOWED).expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['vary']).toContain('Origin');
  });

  it('emits no allow-origin header for a foreign origin', async () => {
    const response = await ctx.http.get('/api/v1/__probe/ok').set('Origin', DENIED).expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never echoes an arbitrary origin on preflight', async () => {
    const denied = await ctx.http
      .options('/api/v1/__probe/ok')
      .set('Origin', DENIED)
      .set('Access-Control-Request-Method', 'GET');

    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const allowed = await ctx.http
      .options('/api/v1/__probe/ok')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('does not treat a prefix of an allowlisted origin as allowed', async () => {
    const response = await ctx.http
      .get('/api/v1/__probe/ok')
      .set('Origin', `${ALLOWED}.attacker.example`)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a non-browser request that sends no Origin', async () => {
    const response = await ctx.http.get('/api/v1/__probe/ok').expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('security headers', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [ProbeModule] });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('sets a restrictive content security policy and hides the stack', async () => {
    const response = await ctx.http.get('/api/v1/__probe/ok').expect(200);

    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('compresses a sufficiently large response', async () => {
    const response = await ctx.http
      .post('/api/v1/__probe/validate')
      .set('Accept-Encoding', 'gzip')
      .send({
        user: { email: 'a@b.co', age: 30 },
        items: Array.from({ length: 400 }, () => ({
          id: '3f1a1b2c-1111-4222-8333-444455556666',
        })),
      })
      .expect(201);

    expect(response.headers['content-encoding']).toBe('gzip');
  });
});

describe('rate limiting', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [ProbeModule],
      env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('answers 429 in the error envelope once the limit is exceeded', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ctx.http.get('/api/v1/__probe/ok').expect(200);
    }

    const blocked = await ctx.http.get('/api/v1/__probe/ok').expect(429);

    expect(blocked.body).toMatchObject({
      statusCode: 429,
      code: ErrorCode.RATE_LIMITED,
    });
    expect(blocked.body.requestId).toEqual(expect.any(String));
    // The framework's own "ThrottlerException: Too many requests" must not be the
    // client-facing message; clients switch on `code`, not on prose.
    expect(blocked.body.message).not.toContain('ThrottlerException');
  });

  it('exempts the health probes from throttling', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await ctx.http.get('/api/v1/health/live').expect(200);
    }
  });
});

/**
 * `TRUST_PROXY_HOPS` is the whole reason the CORS, rate-limit and audit-log
 * designs can talk about "the client's IP" at all, and until now nothing
 * exercised it. Express's `trust proxy` decides two things at once: what `req.ip`
 * is, and therefore what the throttler counts against and what the log records.
 * With the hop count at 0 both must ignore `X-Forwarded-For` completely.
 */
describe('trust proxy hop count', () => {
  const SPOOFED = ['1.2.3.4', '5.6.7.8', '9.10.11.12', '13.14.15.16'];

  describe('at 0 hops, the default', () => {
    let ctx: TestApp;

    beforeAll(async () => {
      ctx = await createTestApp({
        imports: [ProbeModule],
        env: { TRUST_PROXY_HOPS: '0', RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' },
      });
    });

    afterAll(async () => {
      await ctx.close();
    });

    it('does not let a spoofed X-Forwarded-For buy a fresh rate-limit bucket', async () => {
      // Every request carries a different forged client IP. If the throttler
      // keyed on it, each would start a new bucket and the limit would never
      // bind — a one-header bypass of every per-IP control in the service.
      for (const forged of SPOOFED.slice(0, 2)) {
        await ctx.http.get('/api/v1/__probe/ok').set('X-Forwarded-For', forged).expect(200);
      }

      await ctx.http
        .get('/api/v1/__probe/ok')
        .set('X-Forwarded-For', SPOOFED[2] as string)
        .expect(429);
    });

    it('logs the socket peer, not the address the caller claimed', async () => {
      ctx.logs.clear();
      await ctx.http
        .get('/api/v1/__probe/ok')
        .set('X-Forwarded-For', '203.0.113.77')
        .set('X-Real-IP', '198.51.100.23')
        .expect(429);

      // pino-http writes the request line from the response `finish` event, after
      // supertest resolves; asserting before it lands would pass against an empty
      // log and prove nothing.
      const records = await ctx.logs.waitFor((record) => record['req'] !== undefined);

      const raw = ctx.logs.raw();
      expect(raw).not.toContain('203.0.113.77');
      expect(raw).not.toContain('198.51.100.23');

      const request = records
        .map((record) => record['req'] as { remoteAddress?: string } | undefined)
        .find((req) => req?.remoteAddress !== undefined);
      expect(request?.remoteAddress).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    });
  });

  describe('at 1 hop, behind a known ingress', () => {
    let ctx: TestApp;

    beforeAll(async () => {
      ctx = await createTestApp({
        imports: [ProbeModule],
        env: { TRUST_PROXY_HOPS: '1', RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' },
      });
    });

    afterAll(async () => {
      await ctx.close();
    });

    it('does key the limiter per forwarded client, which is why the hop count must be exact', () => {
      // The mirror image of the test above, kept so the difference is a decision
      // rather than an accident: one trusted hop makes the last `X-Forwarded-For`
      // entry authoritative, so a deployment that sets the count higher than the
      // real number of proxies hands the key space back to the client.
      return SPOOFED.reduce(
        (chain, forged) =>
          chain.then(() =>
            ctx.http.get('/api/v1/__probe/ok').set('X-Forwarded-For', forged).expect(200),
          ),
        Promise.resolve() as Promise<unknown>,
      );
    });
  });
});
