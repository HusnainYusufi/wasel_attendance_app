import { argon2id } from 'argon2';
import type { RateLimitConfig } from '../../config/app-config.js';

/**
 * Argon2id parameters.
 *
 * These are the first of OWASP's recommended Argon2id configurations (Password
 * Storage Cheat Sheet): **m = 19 MiB, t = 2, p = 1**. The set is chosen as a
 * whole — memory and iterations trade off against each other, so raising one
 * while lowering the other silently changes the security level.
 *
 *  * `argon2id` rather than `argon2i`/`argon2d`: the hybrid is the only variant
 *    resistant to both side-channel and GPU/ASIC time-memory trade-off attacks,
 *    and is what RFC 9106 recommends when there is no reason to prefer another.
 *  * `memoryCost` is the expensive dimension for an attacker — 19 MiB per guess
 *    is what makes a GPU farm impractical, because each core needs its own copy.
 *  * `parallelism: 1` because Node hashes on the libuv thread pool; asking for
 *    lanes the pool cannot give does not speed verification up, it only reduces
 *    the effective cost per lane.
 *  * `hashLength: 32` — a 256-bit digest, matching the security target.
 *
 * Verification reads its parameters from the stored digest, so an existing hash
 * keeps working if these are raised later; `argon2.needsRehash` identifies the
 * rows to upgrade on the user's next successful login.
 */
export const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

/** Payload discriminator, so a refresh token can never be spent as an access token. */
export const TokenType = {
  ACCESS: 'access',
  REFRESH: 'refresh',
} as const;
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export const JWT_ISSUER = 'wasel-attendance-api';
export const JWT_AUDIENCE = 'wasel-attendance-clients';

/**
 * Pinned rather than left to the library's default. An unpinned verifier honours
 * the `alg` header the *token* carries, which is the classic algorithm-confusion
 * vector: `alg: none`, or an HMAC forged with a public key as the secret.
 */
export const JWT_ALGORITHM = 'HS256';

export const TOKEN_TYPE_BEARER = 'Bearer';

/**
 * How much stricter `POST /auth/login` is than the global rate limit.
 *
 * Derived from `RATE_LIMIT_MAX` rather than configured separately so there is one
 * knob to turn, and so a deployment that tightens the global limit cannot leave
 * the credential endpoint at a stale, looser value.
 */
export const LOGIN_RATE_LIMIT_DIVISOR = 10;

export function loginRateLimit(global: RateLimitConfig): { limit: number; ttl: number } {
  return {
    // At least one attempt per window: a global limit below the divisor must
    // still leave the endpoint usable rather than bricking every login.
    limit: Math.max(1, Math.floor(global.max / LOGIN_RATE_LIMIT_DIVISOR)),
    ttl: global.windowMs,
  };
}

/**
 * `AuditLog.action` values written by this module. Dotted and stable: they are
 * queried by auditors and must not change when a method is renamed.
 */
export const AuditAction = {
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGIN_SUSPENDED: 'auth.login.suspended',
  LOGOUT: 'auth.logout',
  LOGOUT_ALL: 'auth.logout_all',
  PASSWORD_CHANGED: 'auth.password_changed',
  PASSWORD_CHANGE_REJECTED: 'auth.password_change_rejected',
  REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AUDIT_ENTITY_USER = 'User';
