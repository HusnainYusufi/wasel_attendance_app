import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ErrorCode, type ProfileDto, type UpdateProfileRequest } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { AppException, Errors } from '../../common/errors/app.exception.js';
import { isNotFound, isTransactionFailure, isUniqueViolation } from '../../prisma/prisma-errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { PasswordService } from '../auth/password.service.js';
import { ProfileAuditService } from './profile-audit.service.js';
import { ProfileAuditAction } from './profile.constants.js';
import { PROFILE_USER_SELECT, toProfileDto, type ProfileRow } from './profile.mapper.js';

/**
 * Both spellings of the `users` email constraint.
 *
 * `isUniqueViolation` matches on the exact constraint name *or* the **complete**
 * field set, and which one the driver reports depends on whether Prisma is
 * running through an adapter. Checking both is what keeps a duplicate address
 * reported as `EMAIL_TAKEN` on the `email` field rather than as a generic 409 —
 * the mobile client attaches the error to a specific input, so a partial match
 * would point the user at the wrong one. Partial field sets deliberately do not
 * match: `['organizationId']` alone is also true of the employee-code
 * constraint.
 */
const EMAIL_CONSTRAINT = 'users_organizationId_email_key';
const EMAIL_FIELDS = ['organizationId', 'email'] as const;

function emailTaken(): AppException {
  return new AppException(409, ErrorCode.EMAIL_TAKEN, 'That email address is already in use', [
    { path: 'email', message: 'That email address is already in use' },
  ]);
}

/** Lost a race for a row lock. Nothing was written and retrying is the right advice. */
function contended(): AppException {
  return Errors.conflict(
    ErrorCode.CONFLICT,
    'Another change to this account is in progress; please retry',
  );
}

/** The columns an update decision is made from, plus the credential it verifies. */
type UpdateSubject = { id: string; email: string; passwordHash: string };

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: ProfileAuditService,
    private readonly clock: ClockService,
  ) {}

  async get(auth: AuthContext): Promise<ProfileDto> {
    const row = await this.load(auth);
    return toProfileDto(row);
  }

  /**
   * Edits the caller's own name and sign-in address.
   *
   * Two security decisions live here, and both differ deliberately from the
   * administrator's equivalent in `AdminUsersService.update`.
   *
   * **1. An email change requires the current password.**
   *
   * The contract already refuses a request without it, so this is the check that
   * makes the refusal mean something. The reason self-service needs a step-up
   * that the admin route does not is that there is no second principal: an
   * administrator editing an employee has proven a role, is acting under a
   * mandate, and leaves an audit row under *their own* name — somebody else is
   * in the loop. Here the actor and the subject are one person, so the only
   * evidence of legitimacy is the session the request arrived on, and on a phone
   * that session is a long-lived refresh token sitting behind a lock screen.
   *
   * That is the threat: a borrowed unlocked phone. Email is half of the
   * credential pair, so re-pointing the account at an attacker's address hands
   * them every recovery path the product has or will have — an administrator
   * resetting "the employee's" password to that address, any future
   * forgot-password flow — while the real owner cannot even sign in to notice.
   * Requiring the password converts *possession of the device* into *knowledge
   * of the password*, which is exactly the gap the attack walks through, and it
   * costs a legitimate user one extra field on a form they will use once. A name
   * change carries no such demand: a wrong display name is embarrassing, not a
   * credential.
   *
   * **2. A changed email revokes every session, including this one.**
   *
   * `tokenVersion` is bumped and the session rows are revoked, so the caller's
   * own device is signed out along with the others. The alternative — sparing
   * the acting session — is friendlier and was rejected:
   *
   *  * The access token carries no session identifier, only `tokenVersion`, so
   *    "revoke every session except this one" is not expressible without minting
   *    a replacement token pair inside this endpoint. Turning a profile edit into
   *    a token-issuing route widens the credential surface for a UX gain.
   *  * The failure mode that motivates revocation is that the *old* address was
   *    somebody else's — the same argument the admin path makes. If a second
   *    party is holding a live session on this account, it has to die, and this
   *    request cannot tell which session that is.
   *  * It matches `POST /auth/change-password` exactly, so the product has one
   *    rule to explain and the client has one flow to implement: change your
   *    sign-in details, sign in again.
   *
   * Scoped to a change that really moves the address. `body.email` is normalised
   * by the contract, so this compares canonical forms rather than spellings, and
   * re-submitting the address you already have revokes nothing.
   */
  async update(
    auth: AuthContext,
    body: UpdateProfileRequest,
    client: ClientInfo,
  ): Promise<ProfileDto> {
    const current = await this.loadSubject(auth);

    // Canonical forms on both sides: the contract lowercased and trimmed the
    // request, and the column stores the same normalisation.
    const renamed = body.email !== undefined && body.email !== current.email;

    if (body.email !== undefined) {
      await this.assertCurrentPassword(auth, current, body.currentPassword, client);
    }

    const now = this.clock.now();

    const updated = await this.inTransaction(async (tx) => {
      let row: ProfileRow;
      try {
        row = await tx.user.update({
          // The tenancy predicate rides along on the unique `id` so this cannot
          // become a cross-tenant write even if the guarded read above is ever
          // refactored away. `deletedAt: null` keeps a soft-deleted account from
          // editing itself back into visibility.
          where: { id: current.id, organizationId: auth.organizationId, deletedAt: null },
          data: {
            ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
            ...(body.email === undefined ? {} : { email: body.email }),
            // Bumped in the same statement as the address, so no window exists in
            // which the row carries the new email and the old access tokens are
            // still honoured.
            ...(renamed ? { tokenVersion: { increment: 1 } } : {}),
          },
          select: PROFILE_USER_SELECT,
        });
      } catch (error) {
        // Soft-deleted between the read and this write; the `where` matches
        // nothing and Prisma reports P2025.
        if (isNotFound(error)) throw Errors.notFound('User');
        if (isUniqueViolation(error, EMAIL_CONSTRAINT) || isUniqueViolation(error, EMAIL_FIELDS)) {
          throw emailTaken();
        }
        throw error;
      }

      // `tokenVersion` kills the access tokens; this kills the refresh chain that
      // would otherwise mint replacements for the rest of its lifetime.
      if (renamed) {
        await tx.session.updateMany({
          where: { userId: current.id, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      return row;
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: ProfileAuditAction.PROFILE_UPDATED,
      metadata: {
        fields: Object.keys(body)
          .filter((key) => key !== 'currentPassword')
          .sort()
          .join(','),
        emailChanged: renamed,
      },
      client,
    });

    if (renamed) {
      await this.audit.record({
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: ProfileAuditAction.EMAIL_CHANGED,
        // Both addresses, and only when one replaced the other. The account's
        // identity is the one thing about it that cannot be reconstructed from
        // the current row: without the old address, "the email was changed"
        // cannot answer "changed from what?", which is the only question anybody
        // asks it after a suspected takeover.
        metadata: {
          previousEmail: current.email,
          email: updated.email,
          sessionsRevoked: true,
        },
        client,
      });
    }

    return toProfileDto(updated);
  }

  /** The caller's own row. Never takes an id from the request. */
  private async load(auth: AuthContext): Promise<ProfileRow> {
    const row = await this.prisma.user.findFirst({
      where: { id: auth.userId, organizationId: auth.organizationId, deletedAt: null },
      select: PROFILE_USER_SELECT,
    });
    // Authenticated a moment ago, so this is a soft delete that landed between
    // the guard's read and this one. `SESSION_REVOKED` rather than 404: the
    // account is gone, and the client's correct response is to sign out, not to
    // report a missing page.
    if (!row) throw this.sessionRevoked();
    return row;
  }

  private async loadSubject(auth: AuthContext): Promise<UpdateSubject> {
    const row = await this.prisma.user.findFirst({
      where: { id: auth.userId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!row) throw this.sessionRevoked();
    return row;
  }

  /**
   * Verifies the step-up credential, and files the rejection.
   *
   * The audit row is the reason this is not an inline `if`. Repeated failures
   * against one account are the signature of somebody holding the device but not
   * the password — the precise attack this check exists to stop — and that
   * pattern is only visible if every refusal is written down.
   */
  private async assertCurrentPassword(
    auth: AuthContext,
    current: UpdateSubject,
    candidate: string | undefined,
    client: ClientInfo,
  ): Promise<void> {
    const verified =
      candidate !== undefined && (await this.passwords.verify(current.passwordHash, candidate));
    if (verified) return;

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: ProfileAuditAction.EMAIL_CHANGE_REJECTED,
      metadata: { reason: 'invalid_current_password' },
      client,
    });
    throw Errors.invalidCredentials();
  }

  private sessionRevoked(): AppException {
    return Errors.unauthenticated(ErrorCode.SESSION_REVOKED, 'This session is no longer valid');
  }

  /**
   * Runs a mutation in an interactive transaction, translating lock contention.
   *
   * `$transaction` gives up after 5 s and reports `P2028`, which the global
   * filter would render as `INTERNAL_ERROR`. It is reachable here: an
   * administrator promoting somebody holds `FOR UPDATE` locks on every active
   * admin row in the tenant, and an admin editing their own profile at that
   * moment queues behind them. Nothing was written and the request is worth
   * retrying, so it is worth saying so.
   */
  private async inTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error) {
      if (isTransactionFailure(error)) throw contended();
      throw error;
    }
  }
}
