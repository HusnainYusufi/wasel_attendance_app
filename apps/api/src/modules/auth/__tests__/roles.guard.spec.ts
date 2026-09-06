import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, Role } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { setAuthContext, type RequestWithAuth } from '../../../common/auth/auth-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { RolesGuard } from '../guards/roles.guard.js';

@Controller('demo')
class DemoController {
  @Roles(Role.ADMIN)
  @Get('admin')
  admin(): string {
    return 'admin';
  }

  @Roles(Role.ADMIN, Role.MEMBER)
  @Get('any')
  any(): string {
    return 'any';
  }

  @Get('unannotated')
  unannotated(): string {
    return 'unannotated';
  }
}

@Roles(Role.ADMIN)
@Controller('admin-area')
class AdminAreaController {
  @Get()
  index(): string {
    return 'index';
  }
}

function contextFor(
  handler: () => string,
  request: RequestWithAuth,
  classRef: unknown = DemoController,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestAs(role: Role): RequestWithAuth {
  const request: RequestWithAuth = {};
  setAuthContext(request, {
    userId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    role,
    tokenVersion: 0,
  });
  return request;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('steps aside on an unannotated route', () => {
    expect(guard.canActivate(contextFor(DemoController.prototype.unannotated, {}))).toBe(true);
  });

  it('admits a matching role', () => {
    expect(
      guard.canActivate(contextFor(DemoController.prototype.admin, requestAs(Role.ADMIN))),
    ).toBe(true);
  });

  it('refuses a MEMBER on an ADMIN route', () => {
    expect(() =>
      guard.canActivate(contextFor(DemoController.prototype.admin, requestAs(Role.MEMBER))),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.FORBIDDEN }));
  });

  it('admits either role when both are listed', () => {
    for (const role of [Role.ADMIN, Role.MEMBER]) {
      expect(guard.canActivate(contextFor(DemoController.prototype.any, requestAs(role)))).toBe(
        true,
      );
    }
  });

  it('honours a controller-level annotation', () => {
    expect(() =>
      guard.canActivate(
        contextFor(
          AdminAreaController.prototype.index,
          requestAs(Role.MEMBER),
          AdminAreaController,
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.FORBIDDEN }));
  });

  it('fails closed with 401 when no principal was attached', () => {
    // Only reachable if the authentication guard is missing or ran after this
    // one. Answering "allowed" there would ship an unguarded admin route.
    expect(() => guard.canActivate(contextFor(DemoController.prototype.admin, {}))).toThrowError(
      expect.objectContaining({ code: ErrorCode.UNAUTHENTICATED }),
    );
  });
});
