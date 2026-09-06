import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, Role, UserStatus } from '@wasel/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Public } from '../../../common/auth/public.decorator.js';
import { getAuthContext, type RequestWithAuth } from '../../../common/auth/auth-context.js';
import { AppException } from '../../../common/errors/app.exception.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { bearerToken, JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import type { TokenService } from '../token.service.js';
import { FIXED_NOW, MovableClock, testTokenService } from './fixtures.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

interface UserRow {
  id: string;
  organizationId: string;
  role: Role;
  status: UserStatus;
  tokenVersion: number;
}

const ACTIVE_MEMBER: UserRow = {
  id: USER_ID,
  organizationId: ORG_ID,
  role: Role.MEMBER,
  status: UserStatus.ACTIVE,
  tokenVersion: 3,
};

@Controller('demo')
class DemoController {
  @Public()
  @Get('open')
  open(): string {
    return 'open';
  }

  @Get('closed')
  closed(): string {
    return 'closed';
  }
}

function contextFor(handler: () => string, request: RequestWithAuth): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => DemoController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Records the `where` a guard queried with, so tenancy can be asserted. */
function prismaReturning(row: UserRow | null): {
  prisma: PrismaService;
  findFirst: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(row);
  return { prisma: { user: { findFirst } } as unknown as PrismaService, findFirst };
}

describe('bearerToken', () => {
  it.each([
    ['standard', 'Bearer abc.def.ghi', 'abc.def.ghi'],
    ['lowercase scheme', 'bearer abc.def.ghi', 'abc.def.ghi'],
    ['extra whitespace', '  Bearer   abc.def.ghi  ', 'abc.def.ghi'],
    ['array header', undefined, null],
  ])('%s', (_name, header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['scheme only', 'Bearer'],
    ['scheme with no credential', 'Bearer   '],
    ['wrong scheme', 'Basic abc'],
    ['token without scheme', 'abc.def.ghi'],
  ])('rejects a %s header', (_name, header) => {
    expect(bearerToken(header)).toBeNull();
  });

  it('takes the first value of a repeated header', () => {
    expect(bearerToken(['Bearer first', 'Bearer second'])).toBe('first');
  });
});

describe('JwtAuthGuard', () => {
  const reflector = new Reflector();
  let clock: MovableClock;
  let tokens: TokenService;

  beforeEach(() => {
    clock = new MovableClock(FIXED_NOW);
    tokens = testTokenService(clock);
  });

  const guardFor = (
    row: UserRow | null,
  ): ReturnType<typeof prismaReturning> & {
    guard: JwtAuthGuard;
  } => {
    const built = prismaReturning(row);
    return { ...built, guard: new JwtAuthGuard(reflector, tokens, built.prisma) };
  };

  async function authorizedRequest(row: UserRow, tokenVersion = row.tokenVersion) {
    const issued = await tokens.signAccessToken({
      id: row.id,
      organizationId: row.organizationId,
      role: row.role,
      tokenVersion,
    });
    return { headers: { authorization: `Bearer ${issued.token}` } } as unknown as RequestWithAuth;
  }

  it('lets a @Public() route through without reading the header', async () => {
    const { guard, findFirst } = guardFor(null);
    const request = {} as RequestWithAuth;

    await expect(
      guard.canActivate(contextFor(DemoController.prototype.open, request)),
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
    expect(getAuthContext(request)).toBeUndefined();
  });

  it('attaches the principal from the database, not from the token body', async () => {
    // The token says MEMBER; the row says ADMIN. The row wins, so a demotion or
    // promotion applies to tokens minted before it.
    const { guard } = guardFor({ ...ACTIVE_MEMBER, role: Role.ADMIN });
    const request = await authorizedRequest(ACTIVE_MEMBER);

    await expect(
      guard.canActivate(contextFor(DemoController.prototype.closed, request)),
    ).resolves.toBe(true);

    expect(getAuthContext(request)).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      role: Role.ADMIN,
      tokenVersion: 3,
    });
  });

  it('scopes the lookup by the token tenant and excludes soft-deleted rows', async () => {
    const { guard, findFirst } = guardFor(ACTIVE_MEMBER);
    await guard.canActivate(
      contextFor(DemoController.prototype.closed, await authorizedRequest(ACTIVE_MEMBER)),
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID, organizationId: ORG_ID, deletedAt: null },
      }),
    );
  });

  it.each([
    ['missing header', {}],
    ['empty header', { headers: {} }],
    ['wrong scheme', { headers: { authorization: 'Basic abc' } }],
    ['scheme only', { headers: { authorization: 'Bearer' } }],
  ])('answers 401 UNAUTHENTICATED for a %s', async (_name, request) => {
    const { guard } = guardFor(ACTIVE_MEMBER);

    await expect(
      guard.canActivate(contextFor(DemoController.prototype.closed, request as RequestWithAuth)),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
  });

  it('answers 401 SESSION_REVOKED when the user is gone', async () => {
    const { guard } = guardFor(null);

    await expect(
      guard.canActivate(
        contextFor(DemoController.prototype.closed, await authorizedRequest(ACTIVE_MEMBER)),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_REVOKED });
  });

  it('answers 401 SESSION_REVOKED when tokenVersion has moved on', async () => {
    const { guard } = guardFor({ ...ACTIVE_MEMBER, tokenVersion: 4 });

    await expect(
      guard.canActivate(
        contextFor(DemoController.prototype.closed, await authorizedRequest(ACTIVE_MEMBER, 3)),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_REVOKED });
  });

  it('answers 403 ACCOUNT_SUSPENDED for a suspended user holding a valid token', async () => {
    const { guard } = guardFor({ ...ACTIVE_MEMBER, status: UserStatus.SUSPENDED });

    const error = await guard
      .canActivate(
        contextFor(DemoController.prototype.closed, await authorizedRequest(ACTIVE_MEMBER)),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(403);
    expect((error as AppException).code).toBe(ErrorCode.ACCOUNT_SUSPENDED);
  });

  it('answers 401 TOKEN_EXPIRED once the access token has aged out', async () => {
    const { guard } = guardFor(ACTIVE_MEMBER);
    const request = await authorizedRequest(ACTIVE_MEMBER);
    clock.advanceMs(901_000);

    await expect(
      guard.canActivate(contextFor(DemoController.prototype.closed, request)),
    ).rejects.toMatchObject({ code: ErrorCode.TOKEN_EXPIRED });
  });

  it('does not query the database for an unverifiable token', async () => {
    const { guard, findFirst } = guardFor(ACTIVE_MEMBER);
    const request = { headers: { authorization: 'Bearer nonsense' } } as unknown as RequestWithAuth;

    await expect(
      guard.canActivate(contextFor(DemoController.prototype.closed, request)),
    ).rejects.toMatchObject({ code: ErrorCode.TOKEN_INVALID });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
