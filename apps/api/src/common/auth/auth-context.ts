import type { Role } from '@wasel/contracts';

/**
 * The authenticated principal, as resolved from the access token.
 *
 * `organizationId` is the tenancy boundary: every query on a tenant table must
 * be constrained by it, and it must come from the token — never from a request
 * body, which the caller controls.
 */
export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  /** Must equal `User.tokenVersion`; a lower value means the token was revoked. */
  tokenVersion: number;
}

/**
 * Property on the Express request that carries the principal.
 *
 * Exported as a constant, and only ever read/written through the two helpers
 * below, so the guard that sets it and the decorator that reads it cannot drift
 * apart on a renamed string.
 */
export const AUTH_CONTEXT_PROPERTY = 'waselAuth' as const;

export interface RequestWithAuth {
  [AUTH_CONTEXT_PROPERTY]?: AuthContext;
}

/** Called by the authentication guard once a token has been verified. */
export function setAuthContext(request: RequestWithAuth, auth: AuthContext): void {
  request[AUTH_CONTEXT_PROPERTY] = auth;
}

/** Returns the principal, or `undefined` on an unauthenticated (public) route. */
export function getAuthContext(request: RequestWithAuth): AuthContext | undefined {
  return request[AUTH_CONTEXT_PROPERTY];
}
