import { Controller, Get, Module } from '@nestjs/common';
import { Role } from '@wasel/contracts';
import type { AuthContext } from '../../src/common/auth/auth-context.js';
import { CurrentUser } from '../../src/common/auth/current-user.decorator.js';
import { Public } from '../../src/common/auth/public.decorator.js';
import { Roles } from '../../src/common/auth/roles.decorator.js';

/**
 * Routes that exist only to exercise the guards on the seam every other module
 * uses: the `@Public()` opt-out, the authenticated default, `@Roles(...)`, and
 * the principal that `@CurrentUser()` receives.
 *
 * They live under `test/` and are never compiled into `dist`.
 */
@Controller('__auth-probe')
export class AuthProbeController {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  /** No annotation: authenticated because the global guard defaults that way. */
  @Get('principal')
  principal(@CurrentUser() auth: AuthContext): AuthContext {
    return auth;
  }

  @Roles(Role.ADMIN)
  @Get('admin-only')
  adminOnly(@CurrentUser() auth: AuthContext): { role: Role } {
    return { role: auth.role };
  }

  @Roles(Role.ADMIN, Role.MEMBER)
  @Get('any-role')
  anyRole(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [AuthProbeController] })
export class AuthProbeModule {}
