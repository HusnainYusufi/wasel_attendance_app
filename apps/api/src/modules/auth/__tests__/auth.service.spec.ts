import { Logger } from '@nestjs/common';
import { ErrorCode, Role, UserStatus } from '@wasel/contracts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppException } from '../../../common/errors/app.exception.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../audit.service.js';
import { AuthService } from '../auth.service.js';
import { PasswordService } from '../password.service.js';
import { SessionService } from '../session.service.js';
import { FIXED_NOW, MovableClock, testConfig, testTokenService } from './fixtures.js';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT = { ipAddress: '203.0.113.7', userAgent: 'vitest' };
const PASSWORD = 'CorrectHorse7';

interface CandidateOverrides {
  status?: UserStatus;
  lockedUntil?: Date | null;
  failedLoginAttempts?: number;
}

const passwords = new PasswordService();
let digest: string;

beforeAll(async () => {
  // The service logs a warning on every rejected login; forty of them buries the
  // test output. The behaviour itself is asserted in the integration suite, which
  // reads the bytes pino actually wrote.
  Logger.overrideLogger(false);
  await passwords.onModuleInit();
  digest = await passwords.hash(PASSWORD);
});

function candidate(overrides: CandidateOverrides = {}) {
  return {
    id: USER_ID,
    email: 'member@wasel.test',
    fullName: 'Member One',
    employeeCode: null,
    role: Role.MEMBER,
    status: overrides.status ?? UserStatus.ACTIVE,
    organizationId: ORG_ID,
    organization: { name: 'Wasel', timezone: 'Asia/Riyadh' },
    passwordHash: digest,
    tokenVersion: 2,
    failedLoginAttempts: overrides.failedLoginAttempts ?? 0,
    lockedUntil: overrides.lockedUntil ?? null,
  };
}

interface Harness {
  service: AuthService;
  executeRaw: ReturnType<typeof vi.fn>;
  auditCreate: ReturnType<typeof vi.fn>;
  sessionCreate: ReturnType<typeof vi.fn>;
  userUpdate: ReturnType<typeof vi.fn>;
}

/**
 * A Prisma stand-in with just the surface `login` touches. Hand-written rather
 * than generated: the point of these tests is the *ordering* of the credential
 * checks, and a mock that records calls is what makes the ordering assertable.
 */
function harness(candidates: ReturnType<typeof candidate>[]): Harness {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const auditCreate = vi.fn().mockResolvedValue({});
  const sessionCreate = vi.fn().mockResolvedValue({});
  const userUpdate = vi.fn().mockResolvedValue({ tokenVersion: 2 });

  const prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue(candidates),
      findFirst: vi.fn().mockResolvedValue(candidates[0] ?? null),
      update: userUpdate,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    session: {
      create: sessionCreate,
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: auditCreate },
    $executeRaw: executeRaw,
    $transaction: vi.fn(),
  } as unknown as PrismaService;

  const clock = new MovableClock(FIXED_NOW);
  const tokens = testTokenService(clock);
  const service = new AuthService(
    prisma,
    passwords,
    tokens,
    new SessionService(prisma, tokens, clock),
    new AuditService(prisma),
    testConfig(),
    clock,
  );

  return { service, executeRaw, auditCreate, sessionCreate, userUpdate };
}

function codeOf(error: unknown): ErrorCode {
  expect(error).toBeInstanceOf(AppException);
  return (error as AppException).code;
}

function statusOf(error: unknown): number {
  expect(error).toBeInstanceOf(AppException);
  return (error as AppException).getStatus();
}

describe('AuthService.login', () => {
  it('issues a token pair and resets the failure counter', async () => {
    const { service, userUpdate, sessionCreate } = harness([candidate()]);

    const result = await service.login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT);

    expect(result.user).toMatchObject({ id: USER_ID, organizationId: ORG_ID });
    expect(result.tokens.tokenType).toBe('Bearer');
    expect(result.tokens.expiresIn).toBe(900);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: FIXED_NOW },
      }),
    );
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it('never returns the password hash', async () => {
    const { service } = harness([candidate()]);
    const result = await service.login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT);

    expect(JSON.stringify(result)).not.toContain(digest);
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('answers the same code for a wrong password and an unknown address', async () => {
    const unknown = await harness([])
      .service.login({ email: 'nobody@wasel.test', password: PASSWORD }, CLIENT)
      .catch((error: unknown) => error);
    const wrong = await harness([candidate()])
      .service.login({ email: 'member@wasel.test', password: 'WrongPassword1' }, CLIENT)
      .catch((error: unknown) => error);

    expect(codeOf(unknown)).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(codeOf(wrong)).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(statusOf(unknown)).toBe(401);
    expect(statusOf(wrong)).toBe(401);
    expect((unknown as AppException).message).toBe((wrong as AppException).message);
  });

  it('spends the same time on an unknown address as on a wrong password', async () => {
    const measure = async (run: () => Promise<unknown>): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const started = performance.now();
        await run().catch(() => undefined);
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return samples[3] ?? 0;
    };

    const unknownAddress = await measure(() =>
      harness([]).service.login({ email: 'nobody@wasel.test', password: PASSWORD }, CLIENT),
    );
    const wrongPassword = await measure(() =>
      harness([candidate()]).service.login(
        { email: 'member@wasel.test', password: 'WrongPassword1' },
        CLIENT,
      ),
    );

    // Medians, because a GC pause in one sample is not a timing leak. What would
    // be a leak is the unknown-address path returning in microseconds because it
    // never hashed anything — that shows up as a ratio near zero.
    const ratio = unknownAddress / wrongPassword;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('counts a failed attempt with a single conditional UPDATE', async () => {
    const { service, executeRaw } = harness([candidate()]);

    await expect(
      service.login({ email: 'member@wasel.test', password: 'WrongPassword1' }, CLIENT),
    ).rejects.toBeInstanceOf(AppException);

    // Read-then-write loses the race; the statement must do the increment, the
    // comparison and the lock together.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings] = executeRaw.mock.calls[0] as [string[]];
    expect(strings.join('?')).toMatch(/UPDATE "users"/);
    expect(strings.join('?')).toMatch(/"failedLoginAttempts" \+ 1/);
  });

  it('rejects a locked account before spending a hash', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() + 60_000);
    const { service, executeRaw } = harness([candidate({ lockedUntil })]);

    const error = await service
      .login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT)
      .catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(statusOf(error)).toBe(403);
    // No further attempt is counted: a locked account must be cheap to refuse.
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('treats an expired lock as unlocked', async () => {
    const lockedUntil = new Date(FIXED_NOW.getTime() - 1_000);
    const { service } = harness([candidate({ lockedUntil })]);

    await expect(
      service.login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT),
    ).resolves.toMatchObject({ user: { id: USER_ID } });
  });

  it('refuses a suspended account only after the password checks out', async () => {
    const { service } = harness([candidate({ status: UserStatus.SUSPENDED })]);

    const wrongPassword = await service
      .login({ email: 'member@wasel.test', password: 'WrongPassword1' }, CLIENT)
      .catch((error: unknown) => error);
    const rightPassword = await service
      .login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT)
      .catch((error: unknown) => error);

    // Suspension is disclosed only to somebody who already holds the password,
    // so it is not an enumeration oracle.
    expect(codeOf(wrongPassword)).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(codeOf(rightPassword)).toBe(ErrorCode.ACCOUNT_SUSPENDED);
    expect(statusOf(rightPassword)).toBe(403);
  });

  it('writes an audit row for a success and for a failure', async () => {
    const success = harness([candidate()]);
    await success.service.login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT);
    expect(success.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'auth.login.succeeded',
          actorId: USER_ID,
          organizationId: ORG_ID,
          ipAddress: CLIENT.ipAddress,
          userAgent: CLIENT.userAgent,
        }),
      }),
    );

    const failure = harness([candidate()]);
    await failure.service
      .login({ email: 'member@wasel.test', password: 'WrongPassword1' }, CLIENT)
      .catch(() => undefined);
    expect(failure.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'auth.login.failed' }) }),
    );
  });

  it('keeps the password out of every audit row it writes', async () => {
    const { service, auditCreate } = harness([candidate()]);
    await service.login({ email: 'member@wasel.test', password: PASSWORD }, CLIENT);

    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(digest);
  });
});
