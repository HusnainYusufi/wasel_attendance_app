import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Role } from '@wasel/contracts';
import { ROLES_KEY } from './auth.constants.js';

/**
 * Restricts a route to the listed roles. Implies authentication: the roles guard
 * runs after the authentication guard and has a principal to inspect.
 *
 * Applying it with no roles would be a no-op that reads like protection, so the
 * signature requires at least one.
 */
export const Roles = (...roles: [Role, ...Role[]]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);
