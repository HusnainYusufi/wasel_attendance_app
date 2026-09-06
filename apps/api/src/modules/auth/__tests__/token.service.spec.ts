import { JwtService } from '@nestjs/jwt';
import { ErrorCode, Role } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { AppException } from '../../../common/errors/app.exception.js';
import { parseDurationMs, TokenService } from '../token.service.js';
import { FIXED_NOW, MovableClock, testConfig, testTokenService } from './fixtures.js';

const SUBJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  role: Role.MEMBER,
  tokenVersion: 3,
};

const REFRESH_SUBJECT = {
  userId: SUBJECT.id,
  familyId: '33333333-3333-4333-8333-333333333333',
  sessionId: '44444444-4444-4444-8444-444444444444',
  tokenVersion: 3,
};

function codeOf(error: unknown): ErrorCode {
  expect(error).toBeInstanceOf(AppException);
  return (error as AppException).code;
}

describe('parseDurationMs', () => {
  it.each([
    ['900', 900],
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['24h', 86_400_000],
    ['30d', 2_592_000_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(['', 'soon', '15x', '-5m', '1.5h'])('rejects %s', (input) => {
    expect(() => parseDurationMs(input)).toThrow(TypeError);
  });
});

describe('TokenService', () => {
  it('round-trips an access token', async () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const issued = await tokens.signAccessToken(SUBJECT);
    const claims = await tokens.verifyAccessToken(issued.token);

    expect(claims).toMatchObject({
      sub: SUBJECT.id,
      org: SUBJECT.organizationId,
      role: Role.MEMBER,
      tv: 3,
      typ: 'access',
    });
    expect(issued.expiresInSeconds).toBe(900);
    expect(issued.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 900_000);
  });

  it('round-trips a refresh token', async () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const issued = await tokens.signRefreshToken(REFRESH_SUBJECT);
    const claims = await tokens.verifyRefreshToken(issued.token);

    expect(claims).toMatchObject({
      sub: REFRESH_SUBJECT.userId,
      fam: REFRESH_SUBJECT.familyId,
      sid: REFRESH_SUBJECT.sessionId,
      tv: 3,
      typ: 'refresh',
    });
  });

  it('derives expiry from the injected clock, not the wall clock', async () => {
    const clock = new MovableClock(FIXED_NOW);
    const tokens = testTokenService(clock);
    const issued = await tokens.signAccessToken(SUBJECT);

    clock.advanceMs(899_000);
    await expect(tokens.verifyAccessToken(issued.token)).resolves.toBeDefined();

    clock.advanceMs(2_000);
    await expect(tokens.verifyAccessToken(issued.token)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_EXPIRED,
    );
  });

  it('refuses a refresh token presented as an access token', async () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const refresh = await tokens.signRefreshToken(REFRESH_SUBJECT);

    await expect(tokens.verifyAccessToken(refresh.token)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_INVALID,
    );
  });

  it('refuses an access token presented as a refresh token', async () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const access = await tokens.signAccessToken(SUBJECT);

    await expect(tokens.verifyRefreshToken(access.token)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_INVALID,
    );
  });

  it('refuses a token whose payload was tampered with', async () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const issued = await tokens.signAccessToken(SUBJECT);
    const [header, payload, signature] = issued.token.split('.');

    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as {
      role: string;
    };
    decoded.role = Role.ADMIN;
    const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    await expect(tokens.verifyAccessToken(`${header}.${forged}.${signature}`)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_INVALID,
    );
  });

  it.each([
    ['garbage', 'not-a-token'],
    ['two segments', 'aaa.bbb'],
    ['empty', ''],
    ['alg none', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.'],
  ])('refuses a malformed token (%s)', async (_name, raw) => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    await expect(tokens.verifyAccessToken(raw)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_INVALID,
    );
  });

  it('refuses a token signed with a different secret', async () => {
    const clock = new MovableClock(FIXED_NOW);
    const attacker = testTokenService(clock, {
      JWT_ACCESS_SECRET: 'attacker-access-secret-0123456789-abcde',
      JWT_REFRESH_SECRET: 'attacker-refresh-secret-0123456789-abcd',
    });
    const forged = await attacker.signAccessToken(SUBJECT);

    await expect(testTokenService(clock).verifyAccessToken(forged.token)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_INVALID,
    );
  });

  it('refuses a well-signed token with claims the application never mints', async () => {
    const clock = new MovableClock(FIXED_NOW);
    const config = testConfig();
    const jwt = new JwtService({});
    // Correct secret, correct issuer and audience, but `sub` is not a uuid and
    // `tv` is missing: a payload the schema must reject rather than index into.
    const raw = await jwt.signAsync(
      { sub: 'not-a-uuid', org: SUBJECT.organizationId, role: Role.ADMIN, typ: 'access' },
      {
        secret: config.jwt.accessSecret,
        algorithm: 'HS256',
        issuer: 'wasel-attendance-api',
        audience: 'wasel-attendance-clients',
        expiresIn: 900,
      },
    );

    await expect(new TokenService(jwt, config, clock).verifyAccessToken(raw)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.TOKEN_INVALID,
    );
  });

  it('hashes a token deterministically and irreversibly', () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const hash = tokens.hashToken('some.refresh.token');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.hashToken('some.refresh.token')).toBe(hash);
    expect(tokens.hashToken('some.refresh.tokes')).not.toBe(hash);
    expect(hash).not.toContain('refresh');
  });

  it('mints a distinct token for the same subject within the same second', async () => {
    const tokens = testTokenService(new MovableClock(FIXED_NOW));
    const first = await tokens.signRefreshToken(REFRESH_SUBJECT);
    const second = await tokens.signRefreshToken(REFRESH_SUBJECT);

    // `sessions.tokenHash` is UNIQUE; identical tokens would collide there.
    expect(first.token).not.toBe(second.token);
  });
});
