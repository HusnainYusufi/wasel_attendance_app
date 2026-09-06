import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@wasel/contracts';
import { ROLES_KEY } from '../../../common/auth/auth.constants.js';
import { extractAuthContext } from '../../../common/auth/current-user.decorator.js';
import { Errors } from '../../../common/errors/app.exception.js';

/**
 * Enforces `@Roles(...)`.
 *
 * Registered globally *after* {@link JwtAuthGuard}, so a principal is already on
 * the request. It does not authenticate: on an unannotated route it steps aside,
 * and on an annotated one with no principal it fails closed with a 401 via
 * `extractAuthContext` rather than reading `undefined.role`.
 *
 * The role compared is the one the authentication guard read from the database,
 * not the one in the token, so a demotion applies to tokens issued before it.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const auth = extractAuthContext(context);
    if (!required.includes(auth.role)) throw Errors.forbidden();

    return true;
  }
}
