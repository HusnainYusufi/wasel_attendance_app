import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, Role } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { AppException } from '../../errors/app.exception.js';
import {
  AUTH_CONTEXT_PROPERTY,
  getAuthContext,
  setAuthContext,
  type AuthContext,
  type RequestWithAuth,
} from '../auth-context.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../auth.constants.js';
import { extractAuthContext } from '../current-user.decorator.js';
import { Public } from '../public.decorator.js';
import { Roles } from '../roles.decorator.js';

const PRINCIPAL: AuthContext = {
  userId: 'u-1',
  organizationId: 'o-1',
  role: Role.MEMBER,
  tokenVersion: 3,
};

@Controller('demo')
class DemoController {
  @Public()
  @Get('open')
  open(): string {
    return 'open';
  }

  @Roles(Role.ADMIN)
  @Get('admin')
  admin(): string {
    return 'admin';
  }

  @Get('member')
  member(): string {
    return 'member';
  }
}

@Public()
@Controller('all-open')
class OpenController {
  @Get()
  index(): string {
    return 'index';
  }
}

function executionContext(request: RequestWithAuth): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('metadata seam', () => {
  const reflector = new Reflector();

  it('marks a route public in a way a guard can read', () => {
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, DemoController.prototype.open)).toBe(true);
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, DemoController.prototype.member)).toBeUndefined();
  });

  it('marks a whole controller public', () => {
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, OpenController)).toBe(true);
  });

  it('records required roles', () => {
    expect(reflector.get<Role[]>(ROLES_KEY, DemoController.prototype.admin)).toEqual([Role.ADMIN]);
    expect(reflector.get<Role[]>(ROLES_KEY, DemoController.prototype.member)).toBeUndefined();
  });

  it('resolves handler-then-class the way a guard will', () => {
    const merged = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      DemoController.prototype.open,
      DemoController,
    ]);
    expect(merged).toBe(true);
  });

  it('uses namespaced keys so a third-party decorator cannot collide', () => {
    expect(IS_PUBLIC_KEY).toBe('wasel:auth:public');
    expect(ROLES_KEY).toBe('wasel:auth:roles');
  });
});

describe('auth context transport', () => {
  it('round-trips a principal through the request object', () => {
    const request: RequestWithAuth = {};
    expect(getAuthContext(request)).toBeUndefined();

    setAuthContext(request, PRINCIPAL);

    expect(getAuthContext(request)).toEqual(PRINCIPAL);
    expect(request[AUTH_CONTEXT_PROPERTY]).toEqual(PRINCIPAL);
  });

  it('stores the principal under a namespaced property', () => {
    expect(AUTH_CONTEXT_PROPERTY).toBe('waselAuth');
  });
});

describe('extractAuthContext', () => {
  it('returns the principal a guard attached', () => {
    const request: RequestWithAuth = {};
    setAuthContext(request, PRINCIPAL);

    expect(extractAuthContext(executionContext(request))).toEqual(PRINCIPAL);
  });

  it('fails closed with 401 rather than yielding undefined', () => {
    try {
      extractAuthContext(executionContext({}));
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(401);
      expect((error as AppException).code).toBe(ErrorCode.UNAUTHENTICATED);
      return;
    }
    throw new Error('expected extractAuthContext to reject an unauthenticated request');
  });
});
