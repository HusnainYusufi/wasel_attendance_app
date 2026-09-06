import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Errors } from '../errors/app.exception.js';
import { getAuthContext, type AuthContext, type RequestWithAuth } from './auth-context.js';

/**
 * Resolves the principal from an execution context, or fails closed.
 *
 * Exported separately from the decorator so it can be unit-tested directly, and
 * so a guard needing the same lookup does not reimplement it.
 */
export function extractAuthContext(context: ExecutionContext): AuthContext {
  const request = context.switchToHttp().getRequest<RequestWithAuth>();
  const auth = getAuthContext(request);
  // Throwing beats returning `undefined`, which only happens when the route is
  // `@Public()` or a guard was bypassed. Failing closed turns a would-be
  // `Cannot read properties of undefined` — or, far worse, a query with
  // `organizationId: undefined` that silently spans every tenant — into a 401.
  if (!auth) throw Errors.unauthenticated();
  return auth;
}

/** Injects the authenticated principal. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => extractAuthContext(context),
);
