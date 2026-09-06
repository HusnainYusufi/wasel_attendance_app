import { Injectable, Logger } from '@nestjs/common';
import type {
  AuthTokens,
  AuthUser,
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  RefreshRequest,
  RefreshResponse,
} from '@wasel/contracts';
import { ErrorCode, UserStatus } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { AppException, Errors } from '../../common/errors/app.exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';
import { AuditAction, TOKEN_TYPE_BEARER } from './auth.constants.js';
import { AUTH_USER_SELECT, toAuthUser, type AuthUserRow } from './auth.mapper.js';
import type { ClientInfo } from './client-context.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionRow } from './session.service.js';
import { TokenService } from './token.service.js';

/** Everything login needs: the public projection plus the secret, gated columns. */
const LOGIN_CANDIDATE_SELECT = {
  ...AUTH_USER_SELECT,
  passwordHash: true,
  tokenVersion: true,
  failedLoginAttempts: true,
  lockedUntil: true,
} as const;

type LoginCandidate = AuthUserRow & {
  passwordHash: string;
  tokenVersion: number;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
};

type ActiveUser = AuthUserRow & { tokenVersion: number };

function accountLocked(): AppException {
  return new AppException(
    403,
    ErrorCode.ACCOUNT_LOCKED,
    'Too many failed attempts; this account is temporarily locked',
  );
}

function accountSuspended(): AppException {
  return new AppException(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
}

function sessionRevoked(): AppException {
  return Errors.unauthenticated(ErrorCode.SESSION_REVOKED, 'This session is no longer valid');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Exchanges credentials for a token pair.
   *
   * The ordering of the checks below is the security-relevant part:
   *
   *  1. **Lock before verify.** A locked account is rejected without spending a
   *     hash, so the lockout actually sheds the load a brute-force generates.
   *  2. **Verify before status.** "Suspended" is only disclosed to somebody who
   *     already proved they hold the password, so it is not an enumeration
   *     oracle; a soft-deleted account is never disclosed at all and behaves
   *     exactly like an address that was never registered.
   *  3. **A dummy verification when nothing matched**, so the no-such-account
   *     path costs the same wall-clock time as the wrong-password path.
   *
   * The one deliberate exception is `ACCOUNT_LOCKED`: it tells an attacker who
   * has just made `LOGIN_MAX_ATTEMPTS` guesses that the address exists. The
   * alternative — answering `INVALID_CREDENTIALS` to a locked account — leaves a
   * legitimate user with no way to learn why their correct password is refused,
   * and the disclosure is bounded (it costs a lockout to obtain, and reveals
   * nothing an attacker who can already trigger a password-reset email lacks).
   */
  async login(request: LoginRequest, client: ClientInfo): Promise<LoginResponse> {
    const now = this.clock.now();

    // Not organization-scoped, and cannot be: `email` is unique *per* tenant and
    // the login contract carries no tenant selector, so the tenant is derived
    // from whichever candidate the password matches. Soft-deleted rows are
    // excluded here rather than checked later, which is what makes a deleted
    // account indistinguishable from one that never existed.
    const candidates: LoginCandidate[] = await this.prisma.user.findMany({
      where: { email: request.email, deletedAt: null },
      select: LOGIN_CANDIDATE_SELECT,
      orderBy: { createdAt: 'asc' },
    });

    const unlocked = candidates.filter((candidate) => !this.isLocked(candidate, now));

    if (candidates.length > 0 && unlocked.length === 0) {
      await this.auditAll(candidates, AuditAction.LOGIN_LOCKED, client, { reason: 'locked' });
      throw accountLocked();
    }

    let matched: LoginCandidate | null = null;
    for (const candidate of unlocked) {
      if (await this.passwords.verify(candidate.passwordHash, request.password)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      // Reached with no candidates at all (unknown or deleted address) or with
      // every candidate's password wrong. The dummy hash equalises the first case
      // with the second.
      if (unlocked.length === 0) {
        await this.passwords.verifyDummy(request.password);
        // No row, so no tenant, so no audit row is possible (see `auditAll`).
        // The address is deliberately not logged: it is unverified user input and
        // logging it turns a typo'd login into retained personal data.
        this.logger.warn({ ip: client.ipAddress, reason: 'unknown_account' }, 'Login rejected');
      }
      await this.registerFailedAttempts(unlocked, now);
      await this.auditAll(unlocked, AuditAction.LOGIN_FAILED, client, {
        reason: 'invalid_password',
      });
      throw Errors.invalidCredentials();
    }

    if (matched.status !== UserStatus.ACTIVE) {
      await this.audit.record({
        organizationId: matched.organizationId,
        actorId: matched.id,
        action: AuditAction.LOGIN_SUSPENDED,
        client,
        metadata: { reason: 'suspended' },
      });
      throw accountSuspended();
    }

    // Re-read `tokenVersion` from the write rather than from the candidate row:
    // a `logout-all` that landed while the password was being verified must not
    // be undone by minting a token from a stale version.
    const refreshed = await this.prisma.user.update({
      where: { id: matched.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
      select: { tokenVersion: true },
    });

    const tokens = await this.issueTokenPair(
      { ...matched, tokenVersion: refreshed.tokenVersion },
      client,
    );

    await this.audit.record({
      organizationId: matched.organizationId,
      actorId: matched.id,
      action: AuditAction.LOGIN_SUCCEEDED,
      client,
    });

    return { user: toAuthUser(matched), tokens };
  }

  /**
   * Rotates a refresh token.
   *
   * A token is exchangeable exactly once. A second presentation means either the
   * token leaked and is being replayed, or two clients raced — and the database
   * cannot tell those apart, so both are treated as theft and the whole rotation
   * family is revoked. Treating a replay as benign is the failure that leaves a
   * stolen token working forever.
   */
  async refresh(request: RefreshRequest, client: ClientInfo): Promise<RefreshResponse> {
    const claims = await this.tokens.verifyRefreshToken(request.refreshToken);
    const session = await this.sessions.findByToken(request.refreshToken);

    // The signature proves we minted it; the row proves it was not already
    // withdrawn. The claim/row cross-check catches a token whose payload was
    // re-pointed at another session — impossible without the secret, and cheap
    // enough to assert anyway.
    if (
      !session ||
      session.userId !== claims.sub ||
      session.familyId !== claims.fam ||
      session.id !== claims.sid
    ) {
      throw Errors.unauthenticated(ErrorCode.TOKEN_INVALID, 'Refresh token is not valid');
    }

    if (session.usedAt !== null) {
      await this.handleReuse(session, client, 'replayed');
      throw sessionRevoked();
    }
    if (session.revokedAt !== null) throw sessionRevoked();
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw Errors.unauthenticated(ErrorCode.TOKEN_EXPIRED, 'Refresh token has expired');
    }

    const user = await this.loadActiveUser(claims.sub);
    if (user.tokenVersion !== claims.tv) {
      // Belt and braces with the session rows: `logout-all` and a password change
      // revoke both, but anything that bumps `tokenVersion` alone — an
      // administrative forced sign-out, say — must not leave the refresh chain
      // able to mint fresh access tokens against the new version.
      throw sessionRevoked();
    }

    const rotated = await this.sessions.rotate(session, user, client);
    if (!rotated) {
      // Lost the race for this row: another request exchanged it between the read
      // above and the conditional update. Same evidence as a replay, same verdict.
      await this.handleReuse(session, client, 'concurrent');
      throw sessionRevoked();
    }

    const access = await this.tokens.signAccessToken({
      id: user.id,
      organizationId: user.organizationId,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    return {
      tokens: {
        accessToken: access.token,
        refreshToken: rotated.token,
        expiresIn: access.expiresInSeconds,
        tokenType: TOKEN_TYPE_BEARER,
      },
    };
  }

  /**
   * Signs one device out by revoking the presented token's whole rotation family.
   *
   * The family, not just the row: the point of logging out is that the device
   * cannot come back, and its unspent successor would otherwise still work.
   */
  async logout(auth: AuthContext, request: LogoutRequest, client: ClientInfo): Promise<void> {
    if (request.refreshToken) {
      const session = await this.sessions.findByToken(request.refreshToken);
      if (session && session.userId === auth.userId) {
        await this.sessions.revokeFamily(session.familyId);
      } else if (session) {
        // An authenticated caller presenting somebody else's refresh token. Not
        // honoured — otherwise any user could sign any other user out by
        // replaying a captured token — but worth a line for whoever investigates.
        this.logger.warn(
          { userId: auth.userId, sessionId: session.id },
          'Logout presented a refresh token belonging to another user',
        );
      }
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AuditAction.LOGOUT,
      client,
      metadata: { scoped: request.refreshToken !== undefined },
    });
  }

  /**
   * Signs every device out.
   *
   * Revoking the sessions kills refresh; bumping `tokenVersion` kills the access
   * tokens already in flight, which no session table can do because they are
   * never written down anywhere.
   */
  async logoutAll(auth: AuthContext, client: ClientInfo): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: auth.userId, organizationId: auth.organizationId },
        data: { tokenVersion: { increment: 1 } },
      }),
      this.prisma.session.updateMany({
        where: { userId: auth.userId, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      }),
    ]);

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AuditAction.LOGOUT_ALL,
      client,
    });
  }

  /** Changing a password invalidates every token that was minted before it. */
  async changePassword(
    auth: AuthContext,
    request: ChangePasswordRequest,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: auth.userId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, organizationId: true, passwordHash: true },
    });
    if (!user) throw sessionRevoked();

    if (!(await this.passwords.verify(user.passwordHash, request.currentPassword))) {
      await this.audit.record({
        organizationId: user.organizationId,
        actorId: user.id,
        action: AuditAction.PASSWORD_CHANGE_REJECTED,
        client,
        metadata: { reason: 'invalid_current_password' },
      });
      throw Errors.invalidCredentials();
    }

    const passwordHash = await this.passwords.hash(request.newPassword);

    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: user.id, organizationId: user.organizationId },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
          // A password change is also the intended way out of a lockout.
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      }),
    ]);

    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.id,
      action: AuditAction.PASSWORD_CHANGED,
      client,
    });
  }

  async currentUser(auth: AuthContext): Promise<AuthUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: auth.userId, organizationId: auth.organizationId, deletedAt: null },
      select: AUTH_USER_SELECT,
    });
    if (!user) throw sessionRevoked();
    return toAuthUser(user);
  }

  private async issueTokenPair(user: ActiveUser, client: ClientInfo): Promise<AuthTokens> {
    const access = await this.tokens.signAccessToken({
      id: user.id,
      organizationId: user.organizationId,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
    const refresh = await this.sessions.start(user, client);

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresInSeconds,
      tokenType: TOKEN_TYPE_BEARER,
    };
  }

  /**
   * The refresh path's user lookup.
   *
   * Not organization-scoped, and correctly so: the identifier comes from a token
   * this service signed and a session row it wrote, never from the request body,
   * so there is no id for a caller to substitute. The tenant is read *out* of the
   * row and put into the access token, which is what everything downstream scopes
   * on.
   */
  private async loadActiveUser(userId: string): Promise<ActiveUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { ...AUTH_USER_SELECT, tokenVersion: true },
    });
    if (!user) throw sessionRevoked();
    if (user.status !== UserStatus.ACTIVE) throw accountSuspended();
    return user;
  }

  private async handleReuse(
    session: SessionRow,
    client: ClientInfo,
    reason: 'replayed' | 'concurrent',
  ): Promise<void> {
    const revoked = await this.sessions.revokeFamily(session.familyId);

    // Reads the tenant out of the row rather than scoping by one: the id comes
    // from a session this service wrote, and the only use of the result is
    // filing the audit entry under the correct organization.
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { organizationId: true },
    });

    this.logger.warn(
      { userId: session.userId, familyId: session.familyId, reason, revoked },
      'Refresh token reuse detected; rotation family revoked',
    );

    if (!user) return;
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: session.userId,
      action: AuditAction.REFRESH_REUSE_DETECTED,
      client,
      metadata: { reason, revokedSessions: revoked, familyId: session.familyId },
    });
  }

  private isLocked(user: { lockedUntil: Date | null }, now: Date): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
  }

  /**
   * Counts a failed attempt and locks the account the moment the threshold is
   * crossed, in one statement.
   *
   * Read-then-write cannot do this: five simultaneous guesses all read `4`, all
   * write `5`, and the account is never locked. Here the increment, the
   * comparison and the lock all happen inside a single `UPDATE`, which Postgres
   * serialises on the row — so of any number of concurrent failures, exactly one
   * observes the crossing.
   *
   * The counter resets to zero as the lock is set, so a released account starts
   * with a full budget rather than re-locking on its next single mistake.
   */
  private async registerFailedAttempts(
    users: ReadonlyArray<{ id: string }>,
    now: Date,
  ): Promise<void> {
    const { loginMaxAttempts, loginLockoutMinutes } = this.config.security;
    const lockedUntil = new Date(now.getTime() + loginLockoutMinutes * 60_000);

    for (const user of users) {
      await this.prisma.$executeRaw`
        UPDATE "users"
        SET "failedLoginAttempts" =
              CASE WHEN "failedLoginAttempts" + 1 >= ${loginMaxAttempts} THEN 0
                   ELSE "failedLoginAttempts" + 1 END,
            "lockedUntil" =
              CASE WHEN "failedLoginAttempts" + 1 >= ${loginMaxAttempts} THEN ${lockedUntil}::timestamptz
                   ELSE "lockedUntil" END,
            "updatedAt" = ${now}::timestamptz
        WHERE "id" = ${user.id}::uuid
      `;
    }
  }

  private async auditAll(
    users: ReadonlyArray<{ id: string; organizationId: string }>,
    action: AuditAction,
    client: ClientInfo,
    metadata: Record<string, string | number | boolean>,
  ): Promise<void> {
    // An address with no matching row has no tenant, and `audit_logs.organizationId`
    // is NOT NULL — so a failure against an unknown address cannot be recorded as
    // a row. It is logged instead; see the module README note in the report.
    for (const user of users) {
      await this.audit.record({
        organizationId: user.organizationId,
        actorId: user.id,
        action,
        client,
        metadata,
      });
    }
  }
}
