import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, UserStatus } from '@wasel/contracts';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/auth/auth.constants.js';
import { setAuthContext, type RequestWithAuth } from '../../../common/auth/auth-context.js';
import { AppException, Errors } from '../../../common/errors/app.exception.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { TokenService } from '../token.service.js';

/**
 * Extracts the credential from an `Authorization` header.
 *
 * The scheme is matched case-insensitively (RFC 7235 says it is case-insensitive,
 * and real clients send `bearer`), and an empty credential is `null` rather than
 * `''` so that `Authorization: Bearer` cannot reach the verifier as a token.
 */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^bearer\s+(\S+)\s*$/i.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Authenticates every request that has not opted out with `@Public()`.
 *
 * Registered globally, so the default for a new route is "authenticated" and
 * shipping an unguarded endpoint takes a deliberate annotation.
 *
 * The principal is rebuilt from the database on each request rather than trusted
 * from the token body. That is one indexed read per request, and it buys the
 * three properties a stateless token cannot have on its own: a `tokenVersion`
 * bump takes effect immediately, a suspension or soft delete takes effect
 * immediately, and a role demotion cannot be ridden out on a token minted before
 * it.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const raw = bearerToken(request.headers?.authorization);
    if (raw === null) {
      throw Errors.unauthenticated(ErrorCode.UNAUTHENTICATED, 'A bearer access token is required');
    }

    const claims = await this.tokens.verifyAccessToken(raw);

    // Constrained by the token's own tenant claim as well as its subject: a user
    // whose row moved organizations must not keep operating under the old one.
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, organizationId: claims.org, deletedAt: null },
      select: { id: true, organizationId: true, role: true, status: true, tokenVersion: true },
    });

    if (!user || user.tokenVersion !== claims.tv) {
      throw Errors.unauthenticated(ErrorCode.SESSION_REVOKED, 'This session is no longer valid');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new AppException(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
    }

    setAuthContext(request, {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    return true;
  }
}
