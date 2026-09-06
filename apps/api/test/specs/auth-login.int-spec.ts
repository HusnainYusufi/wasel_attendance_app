import { ErrorCode, UserStatus, loginResponseSchema } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { createTestApp, createUser, createUserAndLogin, type TestApp } from '../support/index.js';
import { FixedClockService } from '../support/fixed-clock.js';

const LOGIN = '/api/v1/auth/login';
const PASSWORD = 'CorrectHorse7';

/** The envelope minus the two fields that are different on every response. */
function comparableBody(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, timestamp: _timestamp, ...rest } = body;
  return rest;
}

describe('POST /auth/login', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    // The ambient `.env` allows 100 requests a minute, and the login endpoint a
    // tenth of that. This file spends far more than ten logins proving properties
    // that have nothing to do with rate limiting, so the budget is raised here and
    // the limit itself is exercised in its own application below.
    ctx = await createTestApp({ imports: [AuthModule], env: { RATE_LIMIT_MAX: '100000' } });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    ctx.logs.clear();
  });

  it('returns the contract-shaped user and tokens', async () => {
    const { user } = await createUser(ctx, { password: PASSWORD });

    const response = await ctx.http
      .post(LOGIN)
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    expect(loginResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.user).toMatchObject({
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
    });
    expect(response.body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
  });

  it('never returns or logs the password or its hash', async () => {
    const { user } = await createUser(ctx, { password: PASSWORD });
    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    const response = await ctx.http.post(LOGIN).send({ email: user.email, password: PASSWORD });

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(stored.passwordHash);
    expect(ctx.logs.raw()).not.toContain(PASSWORD);
    expect(ctx.logs.raw()).not.toContain(stored.passwordHash);
    expect(ctx.logs.raw()).not.toContain(response.body.tokens.accessToken);
    expect(ctx.logs.raw()).not.toContain(response.body.tokens.refreshToken);
  });

  it('accepts the address in any case, because the contract normalises it', async () => {
    const { user } = await createUser(ctx, { email: 'mixed.case@wasel.test', password: PASSWORD });

    await ctx.http
      .post(LOGIN)
      .send({ email: 'Mixed.Case@WASEL.test', password: PASSWORD })
      .expect(200);

    expect(user.email).toBe('mixed.case@wasel.test');
  });

  it('records the session with the caller address and agent', async () => {
    const { user } = await createUser(ctx, { password: PASSWORD });

    await ctx.http
      .post(LOGIN)
      .set('User-Agent', 'WaselMobile/1.2 (Android 14)')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.userAgent).toBe('WaselMobile/1.2 (Android 14)');
    expect(session.ipAddress).toBeTruthy();
    // Only the digest is stored; a database dump must not be a set of live tokens.
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('survives an absurdly long user agent instead of failing the login', async () => {
    const { user } = await createUser(ctx, { password: PASSWORD });

    await ctx.http
      .post(LOGIN)
      .set('User-Agent', 'A'.repeat(4_000))
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.userAgent).toHaveLength(512);
  });

  it.each([
    ['no body', {}],
    ['missing password', { email: 'someone@wasel.test' }],
    ['malformed address', { email: 'not-an-email', password: PASSWORD }],
    ['empty password', { email: 'someone@wasel.test', password: '' }],
  ])('rejects %s with VALIDATION_FAILED', async (_name, body) => {
    const response = await ctx.http.post(LOGIN).send(body).expect(400);
    expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  describe('account enumeration', () => {
    it('answers a wrong password and an unknown address identically', async () => {
      const { user } = await createUser(ctx, { password: PASSWORD });

      const wrongPassword = await ctx.http
        .post(LOGIN)
        .send({ email: user.email, password: 'WrongPassword1' })
        .expect(401);
      const unknownAddress = await ctx.http
        .post(LOGIN)
        .send({ email: 'nobody@wasel.test', password: PASSWORD })
        .expect(401);

      expect(wrongPassword.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(comparableBody(unknownAddress.body)).toEqual(comparableBody(wrongPassword.body));
    });

    it('answers for a soft-deleted account exactly as for one that never existed', async () => {
      const { user } = await createUser(ctx, { password: PASSWORD, deletedAt: new Date() });

      const deleted = await ctx.http
        .post(LOGIN)
        .send({ email: user.email, password: PASSWORD })
        .expect(401);
      const missing = await ctx.http
        .post(LOGIN)
        .send({ email: 'nobody@wasel.test', password: PASSWORD })
        .expect(401);

      expect(comparableBody(deleted.body)).toEqual(comparableBody(missing.body));
    });

    it('takes comparable time whether or not the address exists', async () => {
      const { user } = await createUser(ctx, { password: PASSWORD });

      const measure = async (email: string): Promise<number> => {
        const samples: number[] = [];
        for (let i = 0; i < 7; i += 1) {
          const started = performance.now();
          await ctx.http.post(LOGIN).send({ email, password: 'WrongPassword1' });
          samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        return samples[3] ?? 0;
      };

      const known = await measure(user.email);
      const unknown = await measure('nobody@wasel.test');

      // Medians over the round trip. The bound is loose because HTTP and the
      // scheduler contribute noise; what it rules out is the failure that matters
      // — the unknown-address branch returning without hashing anything, which
      // lands an order of magnitude below the known-address branch.
      const ratio = unknown / known;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(2.5);
    });
  });

  describe('brute-force lockout', () => {
    it('locks the account after the configured number of failures', async () => {
      const maxAttempts = ctx.app.get(AppConfigService).security.loginMaxAttempts;
      const { user } = await createUser(ctx, { password: PASSWORD });

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const response = await ctx.http
          .post(LOGIN)
          .send({ email: user.email, password: 'WrongPassword1' });
        expect(response.status).toBe(401);
      }

      // Even the correct password is refused now, and with a distinct code so the
      // user learns why rather than doubting their password.
      const locked = await ctx.http
        .post(LOGIN)
        .send({ email: user.email, password: PASSWORD })
        .expect(403);
      expect(locked.body.code).toBe(ErrorCode.ACCOUNT_LOCKED);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.lockedUntil).not.toBeNull();
    });

    it('counts concurrent failures without losing any of them', async () => {
      const maxAttempts = ctx.app.get(AppConfigService).security.loginMaxAttempts;
      const { user } = await createUser(ctx, { password: PASSWORD });

      // Read-then-write would have every one of these read the same counter and
      // write the same value, and the account would never lock.
      await Promise.all(
        Array.from({ length: maxAttempts }, () =>
          ctx.http.post(LOGIN).send({ email: user.email, password: 'WrongPassword1' }),
        ),
      );

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.lockedUntil).not.toBeNull();
    });

    it('resets the counter on a successful login', async () => {
      const maxAttempts = ctx.app.get(AppConfigService).security.loginMaxAttempts;
      const { user } = await createUser(ctx, { password: PASSWORD });

      for (let attempt = 0; attempt < maxAttempts - 1; attempt += 1) {
        await ctx.http.post(LOGIN).send({ email: user.email, password: 'WrongPassword1' });
      }
      await ctx.http.post(LOGIN).send({ email: user.email, password: PASSWORD }).expect(200);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.failedLoginAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
      expect(row.lastLoginAt).not.toBeNull();

      // And the budget is genuinely full again.
      for (let attempt = 0; attempt < maxAttempts - 1; attempt += 1) {
        const response = await ctx.http
          .post(LOGIN)
          .send({ email: user.email, password: 'WrongPassword1' });
        expect(response.status).toBe(401);
      }
    });
  });

  describe('inactive accounts', () => {
    it('refuses a suspended user who supplies the right password', async () => {
      const { user } = await createUser(ctx, {
        password: PASSWORD,
        status: UserStatus.SUSPENDED,
      });

      const response = await ctx.http
        .post(LOGIN)
        .send({ email: user.email, password: PASSWORD })
        .expect(403);

      expect(response.body.code).toBe(ErrorCode.ACCOUNT_SUSPENDED);
      expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it('refuses a soft-deleted user who supplies the right password', async () => {
      const { user } = await createUser(ctx, { password: PASSWORD, deletedAt: new Date() });

      const response = await ctx.http
        .post(LOGIN)
        .send({ email: user.email, password: PASSWORD })
        .expect(401);

      expect(response.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    });
  });

  describe('audit trail', () => {
    it('records a successful login with the caller address and agent', async () => {
      const actor = await createUserAndLogin(ctx);

      const row = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.user.id, action: 'auth.login.succeeded' },
      });
      expect(row).toMatchObject({
        organizationId: actor.organization.id,
        entityType: 'User',
        entityId: actor.user.id,
      });
      expect(row.ipAddress).toBeTruthy();
    });

    it('records a failed login without recording the password', async () => {
      const { user } = await createUser(ctx, { password: PASSWORD });

      await ctx.http.post(LOGIN).send({ email: user.email, password: 'WrongPassword1' });

      const row = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: user.id, action: 'auth.login.failed' },
      });
      expect(JSON.stringify(row.metadata)).not.toContain('WrongPassword1');
    });

    it('cannot record an unknown address, and does not invent a tenant for it', async () => {
      await ctx.http.post(LOGIN).send({ email: 'nobody@wasel.test', password: PASSWORD });

      // `audit_logs.organizationId` is NOT NULL and an unknown address has no
      // tenant, so the rejection is logged rather than persisted.
      expect(await ctx.prisma.auditLog.count()).toBe(0);
      expect(ctx.logs.raw()).toContain('unknown_account');
      expect(ctx.logs.raw()).not.toContain(PASSWORD);
    });
  });
});

describe('login lockout release', () => {
  let ctx: TestApp;
  const clock = new FixedClockService(new Date('2026-03-01T09:00:00.000Z'));

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule],
      env: { LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCKOUT_MINUTES: '15', RATE_LIMIT_MAX: '100000' },
      configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    clock.set(new Date('2026-03-01T09:00:00.000Z'));
  });

  it('releases the lock once the window has passed, with a full budget', async () => {
    const { user } = await createUser(ctx, { password: PASSWORD });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ctx.http.post(LOGIN).send({ email: user.email, password: 'WrongPassword1' });
    }
    const locked = await ctx.http
      .post(LOGIN)
      .send({ email: user.email, password: PASSWORD })
      .expect(403);
    expect(locked.body.code).toBe(ErrorCode.ACCOUNT_LOCKED);

    clock.advanceMs(15 * 60_000 + 1_000);
    await ctx.http.post(LOGIN).send({ email: user.email, password: PASSWORD }).expect(200);

    // Two failures must not immediately re-lock: the counter was cleared with the
    // lock, so a released account is not one mistake away from being locked again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await ctx.http
        .post(LOGIN)
        .send({ email: user.email, password: 'WrongPassword1' });
      expect(response.status).toBe(401);
    }
  });
});

describe('login rate limiting', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    // A global budget of 4 leaves the login endpoint one attempt per window.
    ctx = await createTestApp({
      imports: [AuthModule],
      env: { RATE_LIMIT_MAX: '4', RATE_LIMIT_WINDOW_MS: '60000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
  });

  it('throttles the credential endpoint harder than the global default', async () => {
    const { user } = await createUser(ctx, { password: PASSWORD });

    await ctx.http.post(LOGIN).send({ email: user.email, password: PASSWORD }).expect(200);

    const throttled = await ctx.http
      .post(LOGIN)
      .send({ email: user.email, password: PASSWORD })
      .expect(429);
    expect(throttled.body.code).toBe(ErrorCode.RATE_LIMITED);

    // The global budget of 4 is untouched by the login bucket, so ordinary routes
    // still answer.
    await ctx.http.get('/api/v1/health/live').expect(200);
  });
});
