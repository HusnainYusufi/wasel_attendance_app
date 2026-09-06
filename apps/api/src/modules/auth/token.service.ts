import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode, Role, uuidSchema } from '@wasel/contracts';
import type { AccessTokenClaims, RefreshTokenClaims } from '@wasel/contracts';
import { z } from 'zod';
import { ClockService } from '../../common/clock/clock.service.js';
import { Errors } from '../../common/errors/app.exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER, TokenType } from './auth.constants.js';

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * Parses the `15m` / `30d` form that `JWT_ACCESS_TTL` and `JWT_REFRESH_TTL` use.
 *
 * Done here rather than handed to `jsonwebtoken` as a string because the session
 * row needs the same `expiresAt` the token carries. Deriving both from one number
 * makes them agree by construction; parsing the string twice, in two libraries,
 * is how a session outlives its token by a rounding difference.
 */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)?$/.exec(value.trim());
  const amount = match?.[1];
  if (amount === undefined) {
    throw new TypeError(`Unsupported duration "${value}"; expected a form such as 15m or 30d`);
  }
  // A bare number is milliseconds, matching the `ms` package that the JWT
  // library itself uses, so the two never disagree about `900`.
  const unit = match?.[2] ?? 'ms';
  const unitMs = DURATION_UNIT_MS[unit];
  if (unitMs === undefined) throw new TypeError(`Unsupported duration unit "${unit}"`);
  return Number(amount) * unitMs;
}

/** Claims as signed. `typ` is ours; everything else is the contract's shape. */
export interface AccessClaims extends AccessTokenClaims {
  typ: typeof TokenType.ACCESS;
}
export interface RefreshClaims extends RefreshTokenClaims {
  typ: typeof TokenType.REFRESH;
  /**
   * The `User.tokenVersion` this token was minted against. The contract does not
   * declare it, because it is not something a client reads — but carrying it here
   * makes `tokenVersion` the single revocation switch for *both* token types.
   * Without it, a bump that is not accompanied by revoking the session rows would
   * kill the access tokens and leave the refresh tokens minting fresh ones.
   */
  tv: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
  /** Lifetime in seconds, for the `expiresIn` field of the tokens response. */
  expiresInSeconds: number;
}

export interface AccessTokenSubject {
  id: string;
  organizationId: string;
  role: Role;
  tokenVersion: number;
}

export interface RefreshTokenSubject {
  userId: string;
  familyId: string;
  sessionId: string;
  tokenVersion: number;
}

/**
 * A verified JWT is still attacker-shaped data: it proves only that *we* signed
 * something, not that the payload has the fields the code is about to index. The
 * schemas below turn a malformed or hand-edited-then-resigned payload into a 401
 * rather than an `undefined` flowing into a tenant-scoped query.
 */
const baseClaims = {
  iat: z.number().int(),
  exp: z.number().int(),
};

const accessClaimsSchema = z.object({
  ...baseClaims,
  sub: uuidSchema,
  org: uuidSchema,
  role: z.enum([Role.ADMIN, Role.MEMBER]),
  tv: z.number().int().min(0),
  typ: z.literal(TokenType.ACCESS),
});

const refreshClaimsSchema = z.object({
  ...baseClaims,
  sub: uuidSchema,
  fam: uuidSchema,
  sid: uuidSchema,
  tv: z.number().int().min(0),
  typ: z.literal(TokenType.REFRESH),
});

/** True for `jsonwebtoken`'s expiry error, matched structurally: under pnpm the
 * library can be reached through more than one path, and two copies of the same
 * class fail `instanceof` while being the same error. */
function isExpiredError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TokenExpiredError';
}

@Injectable()
export class TokenService {
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
  ) {
    // Parsed once at construction so a malformed TTL fails the boot rather than
    // the first login.
    this.accessTtlMs = parseDurationMs(config.jwt.accessTtl);
    this.refreshTtlMs = parseDurationMs(config.jwt.refreshTtl);
  }

  signAccessToken(user: AccessTokenSubject): Promise<IssuedToken> {
    return this.sign(
      {
        sub: user.id,
        org: user.organizationId,
        role: user.role,
        tv: user.tokenVersion,
        typ: TokenType.ACCESS,
      },
      this.config.jwt.accessSecret,
      this.accessTtlMs,
    );
  }

  signRefreshToken(subject: RefreshTokenSubject): Promise<IssuedToken> {
    return this.sign(
      {
        sub: subject.userId,
        fam: subject.familyId,
        sid: subject.sessionId,
        tv: subject.tokenVersion,
        typ: TokenType.REFRESH,
      },
      this.config.jwt.refreshSecret,
      this.refreshTtlMs,
    );
  }

  verifyAccessToken(raw: string): Promise<AccessClaims> {
    return this.verify(raw, this.config.jwt.accessSecret, accessClaimsSchema);
  }

  verifyRefreshToken(raw: string): Promise<RefreshClaims> {
    return this.verify(raw, this.config.jwt.refreshSecret, refreshClaimsSchema);
  }

  /**
   * What goes in `sessions.tokenHash`.
   *
   * SHA-256 and not a password hash: the token is 200+ bits of signed, random
   * material, so there is nothing to brute-force and the lookup has to be a
   * single indexed equality — an argon2 digest would need a table scan. Storing
   * the raw token instead would make a database dump a set of live credentials.
   */
  hashToken(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  private async sign(
    claims: Record<string, unknown>,
    secret: string,
    ttlMs: number,
  ): Promise<IssuedToken> {
    const issuedAt = Math.floor(this.clock.nowMs() / 1000);
    const expiresInSeconds = Math.floor(ttlMs / 1000);

    const token = await this.jwt.signAsync(
      // `iat` is supplied rather than left to the library so the injected clock
      // decides expiry; `jsonwebtoken` computes `exp` from whichever `iat` it
      // finds, which is what makes token lifetimes testable without sleeping.
      { ...claims, iat: issuedAt },
      {
        secret,
        algorithm: JWT_ALGORITHM,
        expiresIn: expiresInSeconds,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        // Two tokens minted for the same subject in the same second would
        // otherwise be byte-identical, and `sessions.tokenHash` is UNIQUE.
        jwtid: randomUUID(),
      },
    );

    return {
      token,
      expiresInSeconds,
      expiresAt: new Date((issuedAt + expiresInSeconds) * 1000),
    };
  }

  private async verify<T extends z.ZodType>(
    raw: string,
    secret: string,
    schema: T,
  ): Promise<z.output<T>> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(raw, {
        secret,
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        clockTimestamp: Math.floor(this.clock.nowMs() / 1000),
      });
    } catch (error) {
      // Expiry is the one failure a client can act on (refresh and retry);
      // everything else — bad signature, wrong secret, wrong audience, garbage —
      // collapses to one code so that probing cannot distinguish them.
      throw isExpiredError(error)
        ? Errors.unauthenticated(ErrorCode.TOKEN_EXPIRED, 'Token has expired')
        : Errors.unauthenticated(ErrorCode.TOKEN_INVALID, 'Token is not valid');
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw Errors.unauthenticated(ErrorCode.TOKEN_INVALID, 'Token is not valid');
    }
    return parsed.data;
  }
}
