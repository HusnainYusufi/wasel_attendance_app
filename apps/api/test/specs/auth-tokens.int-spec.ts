import {
  ErrorCode,
  Role,
  UserStatus,
  authUserSchema,
  refreshResponseSchema,
} from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClockService } from '../../src/common/clock/clock.service.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import {
  AuthProbeModule,
  createTestApp,
  createUser,
  createUserAndLogin,
  type TestApp,
} from '../support/index.js';
import { ProbeModule } from '../support/probe.module.js';
import { FixedClockService } from '../support/fixed-clock.js';

const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';
const LOGOUT_ALL = '/api/v1/auth/logout-all';
const CHANGE_PASSWORD = '/api/v1/auth/change-password';
const PROBE = '/api/v1/__auth-probe';

describe('authentication and authorization', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AuthProbeModule],
      env: { RATE_LIMIT_MAX: '100000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    ctx.logs.clear();
  });

  describe('the global guard', () => {
    it('lets a @Public() route through with no credential', async () => {
      await ctx.http.get(`${PROBE}/open`).expect(200, { ok: true });
    });

    it('refuses an unannotated route with no credential', async () => {
      const response = await ctx.http.get(`${PROBE}/principal`).expect(401);
      expect(response.body.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it.each([
      ['no scheme', 'abcdef'],
      ['wrong scheme', 'Basic YWRtaW46YWRtaW4='],
      ['scheme only', 'Bearer'],
      ['empty', ''],
      ['two tokens', 'Bearer a b'],
    ])('refuses a %s Authorization header', async (_name, header) => {
      const response = await ctx.http
        .get(`${PROBE}/principal`)
        .set('Authorization', header)
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('accepts a lowercase bearer scheme', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.http
        .get(`${PROBE}/principal`)
        .set('Authorization', `bearer ${actor.accessToken}`)
        .expect(200);
    });

    it('attaches a principal carrying the tenant', async () => {
      const actor = await createUserAndLogin(ctx, { role: Role.ADMIN });

      const response = await actor.get('/__auth-probe/principal').expect(200);
      expect(response.body).toEqual({
        userId: actor.user.id,
        organizationId: actor.organization.id,
        role: Role.ADMIN,
        tokenVersion: 0,
      });
    });

    it('refuses a token whose signature was tampered with', async () => {
      const actor = await createUserAndLogin(ctx);
      const [header, payload] = actor.accessToken.split('.');

      const response = await ctx.http
        .get(`${PROBE}/principal`)
        .set(
          'Authorization',
          `Bearer ${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        )
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('refuses a refresh token presented as an access token', async () => {
      const actor = await createUserAndLogin(ctx);

      // The two token types are signed with different secrets *and* carry a type
      // claim, so a refresh token is not a bearer credential anywhere.
      const response = await ctx.http
        .get(`${PROBE}/principal`)
        .set('Authorization', `Bearer ${actor.refreshToken}`)
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('refuses the token of a user who was suspended after signing in', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { status: UserStatus.SUSPENDED },
      });

      const response = await actor.get('/__auth-probe/principal').expect(403);
      expect(response.body.code).toBe(ErrorCode.ACCOUNT_SUSPENDED);
    });

    it('refuses the token of a user who was soft-deleted after signing in', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { deletedAt: new Date() },
      });

      const response = await actor.get('/__auth-probe/principal').expect(401);
      expect(response.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });

    it('refuses a token whose tokenVersion has been bumped', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { tokenVersion: { increment: 1 } },
      });

      const response = await actor.get('/__auth-probe/principal').expect(401);
      expect(response.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });
  });

  describe('@Roles', () => {
    it('admits an ADMIN and refuses a MEMBER', async () => {
      const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const member = await createUserAndLogin(ctx, { role: Role.MEMBER });

      await admin.get('/__auth-probe/admin-only').expect(200, { role: Role.ADMIN });

      const refused = await member.get('/__auth-probe/admin-only').expect(403);
      expect(refused.body.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('admits either role where both are listed', async () => {
      const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const member = await createUserAndLogin(ctx, { role: Role.MEMBER });

      await admin.get('/__auth-probe/any-role').expect(200);
      await member.get('/__auth-probe/any-role').expect(200);
    });

    it('applies the role from the database, not the one in the token', async () => {
      const actor = await createUserAndLogin(ctx, { role: Role.ADMIN });
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { role: Role.MEMBER },
      });

      // A demotion takes effect immediately, without waiting for the token to age
      // out, because the guard rebuilds the principal from the row.
      await actor.get('/__auth-probe/admin-only').expect(403);
    });

    it('refuses an annotated route with no credential at all', async () => {
      const response = await ctx.http.get(`${PROBE}/admin-only`).expect(401);
      expect(response.body.code).toBe(ErrorCode.UNAUTHENTICATED);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the authenticated principal in contract shape', async () => {
      const actor = await createUserAndLogin(ctx, {
        organization: { name: 'Wasel HQ', timezone: 'Asia/Riyadh' },
      });

      const response = await actor.get('/auth/me').expect(200);

      expect(authUserSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        id: actor.user.id,
        organizationId: actor.organization.id,
        organizationName: 'Wasel HQ',
        timezone: 'Asia/Riyadh',
      });
      expect(response.body).not.toHaveProperty('passwordHash');
    });

    it('keeps two tenants apart', async () => {
      const first = await createUserAndLogin(ctx);
      const second = await createUserAndLogin(ctx);

      const a = await first.get('/auth/me').expect(200);
      const b = await second.get('/auth/me').expect(200);

      expect(a.body.organizationId).not.toBe(b.body.organizationId);
      expect(a.body.organizationId).toBe(first.organization.id);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the token pair', async () => {
      const actor = await createUserAndLogin(ctx);

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(200);

      expect(refreshResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.tokens.refreshToken).not.toBe(actor.refreshToken);
      expect(response.body.tokens.accessToken).not.toBe(actor.accessToken);

      // The new access token works…
      await ctx.http
        .get(`${PROBE}/principal`)
        .set('Authorization', `Bearer ${response.body.tokens.accessToken}`)
        .expect(200);

      // …and the spent refresh token is marked, not deleted.
      const spent = await ctx.prisma.session.findFirstOrThrow({
        where: { userId: actor.user.id, usedAt: { not: null } },
      });
      expect(spent.revokedAt).toBeNull();
      expect(await ctx.prisma.session.count({ where: { userId: actor.user.id } })).toBe(2);
    });

    it('keeps the successor inside the same rotation family', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.http.post(REFRESH).send({ refreshToken: actor.refreshToken }).expect(200);

      const families = await ctx.prisma.session.findMany({
        where: { userId: actor.user.id },
        select: { familyId: true },
      });
      expect(new Set(families.map((row) => row.familyId)).size).toBe(1);
    });

    it('revokes the whole family when a spent token is presented again', async () => {
      const actor = await createUserAndLogin(ctx);
      const rotated = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(200);

      // The theft signal: the original token turning up a second time.
      const replay = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(replay.body.code).toBe(ErrorCode.SESSION_REVOKED);

      // Everything descended from it dies too — including the token the thief's
      // victim (or the thief) obtained a moment ago.
      const live = await ctx.prisma.session.count({
        where: { userId: actor.user.id, revokedAt: null },
      });
      expect(live).toBe(0);

      const afterRevocation = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: rotated.body.tokens.refreshToken })
        .expect(401);
      expect(afterRevocation.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });

    it('records the reuse in the audit log', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.http.post(REFRESH).send({ refreshToken: actor.refreshToken }).expect(200);
      await ctx.http.post(REFRESH).send({ refreshToken: actor.refreshToken }).expect(401);

      const row = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.user.id, action: 'auth.refresh.reuse_detected' },
      });
      expect(row.organizationId).toBe(actor.organization.id);
    });

    it('lets exactly one of several concurrent exchanges win', async () => {
      const actor = await createUserAndLogin(ctx);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.http.post(REFRESH).send({ refreshToken: actor.refreshToken }),
        ),
      );

      // The conditional UPDATE is the arbiter: five requests, one matching row.
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 401)).toHaveLength(4);

      // The losers are indistinguishable from a replay, so the family is revoked.
      // A client that races itself is signed out — the safe direction, since the
      // database cannot tell a race from a stolen token being replayed.
      const live = await ctx.prisma.session.count({
        where: { userId: actor.user.id, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('refuses a refresh token after the device has logged out', async () => {
      const actor = await createUserAndLogin(ctx);
      await actor.post('/auth/logout').send({ refreshToken: actor.refreshToken }).expect(204);

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });

    it.each([
      ['garbage', 'not-a-token'],
      ['empty segments', 'a.b.c'],
    ])('refuses a %s refresh token', async (_name, token) => {
      const response = await ctx.http.post(REFRESH).send({ refreshToken: token }).expect(401);
      expect(response.body.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('refuses an access token presented for refresh', async () => {
      const actor = await createUserAndLogin(ctx);
      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.accessToken })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('refuses a well-signed token whose session row is gone', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.session.deleteMany({ where: { userId: actor.user.id } });

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.TOKEN_INVALID);
    });

    it('refuses a session that has outlived its expiry, even with a valid token', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.session.updateMany({
        where: { userId: actor.user.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.TOKEN_EXPIRED);
    });

    it('refuses a refresh token whose tokenVersion has been bumped', async () => {
      const actor = await createUserAndLogin(ctx);
      // A bump with the session rows left alone — what an administrative forced
      // sign-out would do if it forgot half the job. The refresh chain must not
      // survive it and start minting access tokens against the new version.
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { tokenVersion: { increment: 1 } },
      });

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });

    it('carries the current tokenVersion into each rotated token', async () => {
      const actor = await createUserAndLogin(ctx);
      const rotated = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(200);

      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { tokenVersion: { increment: 1 } },
      });

      const afterBump = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: rotated.body.tokens.refreshToken })
        .expect(401);
      expect(afterBump.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });

    it('refuses to refresh a suspended user', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { status: UserStatus.SUSPENDED },
      });

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(403);
      expect(response.body.code).toBe(ErrorCode.ACCOUNT_SUSPENDED);
    });

    it('refuses to refresh a soft-deleted user', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { deletedAt: new Date() },
      });

      const response = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.SESSION_REVOKED);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the presented rotation family and audits it', async () => {
      const actor = await createUserAndLogin(ctx);

      await actor.post('/auth/logout').send({ refreshToken: actor.refreshToken }).expect(204);

      const live = await ctx.prisma.session.count({
        where: { userId: actor.user.id, revokedAt: null },
      });
      expect(live).toBe(0);
      await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.user.id, action: 'auth.logout' },
      });
    });

    it('leaves other devices signed in', async () => {
      const first = await createUserAndLogin(ctx);
      const second = await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: first.user.email, password: first.password })
        .expect(200);

      await first.post('/auth/logout').send({ refreshToken: first.refreshToken }).expect(204);

      await ctx.http
        .post(REFRESH)
        .send({ refreshToken: second.body.tokens.refreshToken })
        .expect(200);
    });

    it('ignores a refresh token belonging to somebody else', async () => {
      const attacker = await createUserAndLogin(ctx);
      const victim = await createUserAndLogin(ctx);

      await attacker.post('/auth/logout').send({ refreshToken: victim.refreshToken }).expect(204);

      // The victim's session survives: otherwise a captured token would be a
      // one-request denial of service against any user.
      await ctx.http.post(REFRESH).send({ refreshToken: victim.refreshToken }).expect(200);
    });

    it('accepts a request with no body', async () => {
      const actor = await createUserAndLogin(ctx);
      await actor.post('/auth/logout').expect(204);
    });

    it('requires authentication', async () => {
      await ctx.http.post(LOGOUT).send({}).expect(401);
    });
  });

  describe('POST /auth/logout-all', () => {
    it('kills every session and every access token already in flight', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: actor.user.email, password: actor.password })
        .expect(200);

      await actor.post('/auth/logout-all').expect(204);

      // The access token is the interesting half: nothing is written down about
      // it anywhere, so only the tokenVersion bump can retire it.
      const response = await actor.get('/__auth-probe/principal').expect(401);
      expect(response.body.code).toBe(ErrorCode.SESSION_REVOKED);

      expect(
        await ctx.prisma.session.count({ where: { userId: actor.user.id, revokedAt: null } }),
      ).toBe(0);
      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: actor.user.id } });
      expect(row.tokenVersion).toBe(1);

      await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.user.id, action: 'auth.logout_all' },
      });
    });

    it('does not touch another user in the same tenant', async () => {
      const first = await createUserAndLogin(ctx);
      const second = await createUserAndLogin(ctx, { organizationId: first.organization.id });

      await first.post('/auth/logout-all').expect(204);

      await second.get('/auth/me').expect(200);
    });

    it('requires authentication', async () => {
      await ctx.http.post(LOGOUT_ALL).expect(401);
    });
  });

  describe('POST /auth/change-password', () => {
    it('invalidates every token issued before the change', async () => {
      const actor = await createUserAndLogin(ctx);

      await actor
        .post('/auth/change-password')
        .send({ currentPassword: actor.password, newPassword: 'BrandNewPass9' })
        .expect(204);

      const withOldAccess = await actor.get('/__auth-probe/principal').expect(401);
      expect(withOldAccess.body.code).toBe(ErrorCode.SESSION_REVOKED);

      const withOldRefresh = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(401);
      expect(withOldRefresh.body.code).toBe(ErrorCode.SESSION_REVOKED);

      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: actor.user.email, password: 'BrandNewPass9' })
        .expect(200);
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: actor.user.email, password: actor.password })
        .expect(401);

      await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.user.id, action: 'auth.password_changed' },
      });
    });

    it('refuses a wrong current password without changing anything', async () => {
      const actor = await createUserAndLogin(ctx);

      const response = await actor
        .post('/auth/change-password')
        .send({ currentPassword: 'NotMyPassword1', newPassword: 'BrandNewPass9' })
        .expect(401);
      expect(response.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);

      await actor.get('/auth/me').expect(200);
      await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.user.id, action: 'auth.password_change_rejected' },
      });
    });

    it.each([
      ['too short', 'Short1'],
      ['no digit', 'NoDigitsHere'],
      ['no letter', '1234567890'],
    ])('rejects a %s new password', async (_name, newPassword) => {
      const actor = await createUserAndLogin(ctx);

      const response = await actor
        .post('/auth/change-password')
        .send({ currentPassword: actor.password, newPassword })
        .expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects reusing the current password', async () => {
      const actor = await createUserAndLogin(ctx);

      const response = await actor
        .post('/auth/change-password')
        .send({ currentPassword: actor.password, newPassword: actor.password })
        .expect(400);
      expect(response.body.details?.[0]?.path).toBe('newPassword');
    });

    it('clears a lockout, so a locked user can recover by changing their password', async () => {
      const actor = await createUserAndLogin(ctx);
      await ctx.prisma.user.update({
        where: { id: actor.user.id },
        data: { failedLoginAttempts: 4, lockedUntil: new Date(Date.now() + 600_000) },
      });

      await actor
        .post('/auth/change-password')
        .send({ currentPassword: actor.password, newPassword: 'BrandNewPass9' })
        .expect(204);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: actor.user.id } });
      expect(row.lockedUntil).toBeNull();
      expect(row.failedLoginAttempts).toBe(0);
    });

    it('requires authentication', async () => {
      await ctx.http
        .post(CHANGE_PASSWORD)
        .send({ currentPassword: 'whatever1', newPassword: 'BrandNewPass9' })
        .expect(401);
    });
  });

  describe('secrets never reach the log', () => {
    it('survives a full session lifecycle without leaking a credential', async () => {
      const actor = await createUserAndLogin(ctx, { password: 'CorrectHorse7' });
      const rotated = await ctx.http
        .post(REFRESH)
        .send({ refreshToken: actor.refreshToken })
        .expect(200);
      await actor.get('/auth/me').expect(200);
      await actor
        .post('/auth/change-password')
        .send({ currentPassword: actor.password, newPassword: 'BrandNewPass9' })
        .expect(204);

      const stored = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: actor.user.id },
        select: { passwordHash: true },
      });
      const written = ctx.logs.raw();

      for (const secret of [
        'CorrectHorse7',
        'BrandNewPass9',
        stored.passwordHash,
        actor.accessToken,
        actor.refreshToken,
        rotated.body.tokens.accessToken,
        rotated.body.tokens.refreshToken,
      ]) {
        expect(written).not.toContain(secret);
      }
    });
  });
});

describe('token lifetimes', () => {
  let ctx: TestApp;
  const start = new Date('2026-03-01T09:00:00.000Z');
  const clock = new FixedClockService(start);

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AuthProbeModule],
      env: { RATE_LIMIT_MAX: '100000', JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL: '30d' },
      configure: (builder) => builder.overrideProvider(ClockService).useValue(clock),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    clock.set(start);
  });

  it('refuses an access token once its lifetime has elapsed', async () => {
    const actor = await createUserAndLogin(ctx);

    clock.advanceMs(14 * 60_000);
    await actor.get('/__auth-probe/principal').expect(200);

    clock.advanceMs(2 * 60_000);
    const response = await actor.get('/__auth-probe/principal').expect(401);
    expect(response.body.code).toBe(ErrorCode.TOKEN_EXPIRED);
  });

  it('still accepts the refresh token after the access token has expired', async () => {
    const actor = await createUserAndLogin(ctx);
    clock.advanceMs(16 * 60_000);

    await ctx.http.post(REFRESH).send({ refreshToken: actor.refreshToken }).expect(200);
  });

  it('refuses a refresh token once its lifetime has elapsed', async () => {
    const actor = await createUserAndLogin(ctx);

    clock.advanceMs(31 * 24 * 60 * 60_000);
    const response = await ctx.http
      .post(REFRESH)
      .send({ refreshToken: actor.refreshToken })
      .expect(401);
    expect(response.body.code).toBe(ErrorCode.TOKEN_EXPIRED);
  });

  it('writes a session expiry that matches the token it was issued with', async () => {
    const actor = await createUserAndLogin(ctx);

    const session = await ctx.prisma.session.findFirstOrThrow({
      where: { userId: actor.user.id },
    });
    expect(session.expiresAt.getTime()).toBe(start.getTime() + 30 * 24 * 60 * 60_000);
  });

  it('never lets a locked account slip through on a stale clock', async () => {
    const { user } = await createUser(ctx, { password: 'CorrectHorse7' });
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'WrongPassword1' });
    }

    clock.advanceMs(14 * 60_000);
    const stillLocked = await ctx.http
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'CorrectHorse7' })
      .expect(403);
    expect(stillLocked.body.code).toBe(ErrorCode.ACCOUNT_LOCKED);
  });
});

describe('the kernel once authentication is global', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    // The orchestrator will mount AuthModule inside AppModule, which turns the
    // authentication guard on for every route in the application. This asserts
    // that the routes which must stay open — the probes an orchestrator polls,
    // and the kernel's own fixtures — are still reachable afterwards.
    ctx = await createTestApp({ imports: [AuthModule, ProbeModule] });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it.each([
    ['liveness', '/api/v1/health/live'],
    ['readiness', '/api/v1/health/ready'],
    ['a @Public() controller', '/api/v1/__probe/ok'],
  ])('leaves %s reachable without a credential', async (_name, path) => {
    await ctx.http.get(path).expect(200);
  });

  it('still answers an unrouted path with the error envelope, not a 401', async () => {
    const response = await ctx.http.get('/api/v1/does-not-exist').expect(404);
    expect(response.body.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('still maps a server fault to INTERNAL_ERROR rather than an auth failure', async () => {
    const response = await ctx.http.get('/api/v1/__probe/unhandled').expect(500);
    expect(response.body.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});
