import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PinoLogger } from 'nestjs-pino';
import { REDACTION_PLACEHOLDER } from '../../src/common/logging/redaction.js';
import { ProbeModule } from '../support/probe.module.js';
import { createTestApp, type TestApp } from '../support/index.js';

const PASSWORD = 'correct-horse-battery-staple';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-access-token';

describe('request logging', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [ProbeModule], env: { LOG_LEVEL: 'debug' } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.logs.clear();
  });

  it('never writes a password a handler logged from the request body', async () => {
    // The handler logs `{ body }` deliberately. Asserting only that the request
    // line omits the password would pass with redaction removed entirely, because
    // the request serialiser never includes a body in the first place.
    await ctx.http
      .post('/api/v1/__probe/credentials')
      .send({ email: 'user@wasel.test', password: PASSWORD, newPassword: `${PASSWORD}-2` })
      .expect(201);

    const raw = ctx.logs.raw();
    expect(raw).toContain('probe received credentials');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).toContain(REDACTION_PLACEHOLDER);
    // The rest of the body must survive, or the assertion above would be
    // satisfied by logging nothing at all.
    expect(raw).toContain('user@wasel.test');
  });

  it('never writes a password nested inside a context object or a list of rows', async () => {
    await ctx.http
      .post('/api/v1/__probe/credentials-nested')
      .send({ email: 'user@wasel.test', password: PASSWORD })
      .expect(201);

    const raw = ctx.logs.raw();
    expect(raw).toContain('probe received nested credentials');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).toContain('user@wasel.test');
  });

  it('never writes an Authorization header a handler logged by hand', async () => {
    // The header allowlist drops `authorization` before redaction ever runs, so
    // the transport-level assertion below proves nothing about redaction on its
    // own. This one puts the header where a handler would put it.
    await ctx.http
      .post('/api/v1/__probe/echo-headers')
      .send({ headers: { Authorization: BEARER, 'X-Api-Key': 'ak-secret-value' } })
      .expect(201);

    const raw = ctx.logs.raw();
    expect(raw).toContain('probe received headers');
    expect(raw).not.toContain('super-secret-access-token');
    expect(raw).not.toContain('ak-secret-value');
  });

  it('never writes the Authorization header from the transport', async () => {
    await ctx.http.get('/api/v1/__probe/ok').set('Authorization', BEARER).expect(200);

    await ctx.logs.waitFor((record) => record['req'] !== undefined);
    expect(ctx.logs.raw()).not.toContain('super-secret-access-token');
    expect(ctx.logs.raw()).not.toContain(BEARER);
  });

  it('never writes a cookie header', async () => {
    await ctx.http
      .get('/api/v1/__probe/ok')
      .set('Cookie', 'session=abc123-secret-cookie-value')
      .expect(200);

    await ctx.logs.waitFor((record) => record['req'] !== undefined);
    expect(ctx.logs.raw()).not.toContain('abc123-secret-cookie-value');
  });

  it('never writes a secret carried in the query string', async () => {
    await ctx.http
      .get('/api/v1/__probe/ok?token=QUERY_TOKEN_SECRET&access_token=QUERY_AT_SECRET&page=2')
      .expect(200);

    await ctx.logs.waitFor((record) => record['req'] !== undefined);
    const raw = ctx.logs.raw();
    expect(raw).not.toContain('QUERY_TOKEN_SECRET');
    expect(raw).not.toContain('QUERY_AT_SECRET');
    // The rest of the URL is still there, so the line remains useful.
    expect(raw).toContain('page=2');
  });

  it('never writes a secret carried in the Referer header', async () => {
    await ctx.http
      .get('/api/v1/__probe/ok')
      .set('Referer', 'https://evil.test/reset?token=REFERER_TOKEN_SECRET')
      .expect(200);

    await ctx.logs.waitFor((record) => record['req'] !== undefined);
    expect(ctx.logs.raw()).not.toContain('REFERER_TOKEN_SECRET');
    expect(ctx.logs.raw()).toContain('evil.test');
  });

  it('records the peer address on the request line', async () => {
    await ctx.http.get('/api/v1/__probe/ok').expect(200);

    const records = await ctx.logs.waitFor((record) => record['req'] !== undefined);
    const request = records
      .map((record) => record['req'] as { remoteAddress?: string } | undefined)
      .find((req) => req !== undefined);

    expect(request?.remoteAddress).toEqual(expect.any(String));
    expect(request?.remoteAddress).not.toBe('');
  });

  it('redacts secret-bearing fields inside a logged context object', async () => {
    // `resolve`, not `get`: nestjs-pino registers PinoLogger as transient-scoped.
    const logger = await ctx.app.resolve(PinoLogger);
    logger.info(
      {
        context: { userId: 'u-1' },
        password: PASSWORD,
        refreshToken: 'rt-value',
        nested: { passwordHash: 'argon2id$secret' },
        rows: [{ session: { accessToken: 'at-inside-a-list' } }],
      },
      'logging a context object',
    );

    const raw = ctx.logs.raw();
    expect(raw).toContain('logging a context object');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('rt-value');
    expect(raw).not.toContain('argon2id$secret');
    expect(raw).not.toContain('at-inside-a-list');
    expect(raw).toContain(REDACTION_PLACEHOLDER);
  });

  it('logs one line per request carrying the request id', async () => {
    const response = await ctx.http
      .get('/api/v1/__probe/ok')
      .set('x-request-id', 'trace-log-1')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('trace-log-1');
    const matching = ctx.logs
      .records()
      .filter((record) => JSON.stringify(record).includes('trace-log-1'));
    expect(matching.length).toBeGreaterThan(0);
  });

  it('does not log the health probes', async () => {
    await ctx.http.get('/api/v1/health/live').expect(200);
    expect(ctx.logs.raw()).not.toContain('/api/v1/health/live');
  });
});

describe('boot-time configuration warnings', () => {
  it('warns, on the log, when the documentation is published in production', async () => {
    // Legal but almost always a mistake: the published document is a complete map
    // of the attack surface, including which routes are unauthenticated. Refusing
    // to boot would be wrong — a locked-down staging box is a real use — so it has
    // to be impossible to do silently instead.
    const ctx = await createTestApp({
      env: {
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
        // Production refuses the `.env.example` placeholders and a wildcard
        // origin, so the environment has to clear those bars to reach the
        // warning at all.
        JWT_ACCESS_SECRET: 'prod-shaped-access-secret-9f31c7ae204b',
        JWT_REFRESH_SECRET: 'prod-shaped-refresh-secret-5c02de81b3f7',
        CORS_ORIGINS: 'https://app.wasel.test',
      },
    });

    try {
      const raw = ctx.logs.raw();
      expect(raw).toContain('Questionable configuration');
      expect(raw).toContain('SWAGGER_ENABLED');
    } finally {
      await ctx.close();
    }
  });
});
