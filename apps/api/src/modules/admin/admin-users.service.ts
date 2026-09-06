import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  Role,
  UserStatus,
  buildPageMeta,
  type CreateUserRequest,
  type ListUsersQuery,
  type Paginated,
  type ResetUserPasswordRequest,
  type UpdateUserRequest,
  type UserDto,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { AppException, Errors } from '../../common/errors/app.exception.js';
import { isNotFound, isTransactionFailure, isUniqueViolation } from '../../prisma/prisma-errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { PasswordService } from '../auth/password.service.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminAuditAction, AdminAuditEntity } from './admin.constants.js';
import { ADMIN_USER_SELECT, toUserDto, type AdminUserRow } from './admin.mapper.js';

/**
 * Both spellings of each `users` unique constraint.
 *
 * `isUniqueViolation` matches on the exact constraint name *or* the complete
 * field set, and which of the two the driver reports depends on whether Prisma
 * is running through an adapter. Checking both is what keeps a duplicate email
 * reported as `EMAIL_TAKEN` and a duplicate code as `EMPLOYEE_CODE_TAKEN` —
 * the mobile client attaches the error to a specific input, so getting this
 * wrong points the user at the wrong field.
 */
const EMAIL_CONSTRAINT = 'users_organizationId_email_key';
const EMAIL_FIELDS = ['organizationId', 'email'] as const;
const EMPLOYEE_CODE_CONSTRAINT = 'users_organizationId_employeeCode_key';
const EMPLOYEE_CODE_FIELDS = ['organizationId', 'employeeCode'] as const;

function lastAdmin(): AppException {
  return Errors.unprocessable(
    ErrorCode.LAST_ADMIN,
    'This organization must keep at least one active administrator',
  );
}

/**
 * The admin lock was held by somebody else for longer than the transaction had.
 *
 * A `409` rather than the `500 INTERNAL_ERROR` a raw `P2028` becomes: nothing is
 * broken and nothing was written, the request simply lost a race for a row lock,
 * and "retry" is both the correct advice and something a client can act on
 * automatically. Reporting it as a server fault also buries a genuine outage in
 * noise the first time two administrators edit the same tenant at once.
 */
function contended(): AppException {
  return Errors.conflict(
    ErrorCode.CONFLICT,
    'Another administrator change is in progress for this organization; please retry',
  );
}

/**
 * Would this change leave the organization with no active administrator?
 *
 * Pure, and separated from the query that feeds it so the decision itself can be
 * unit-tested without a database. `activeAdminIds` must be a *locked* snapshot —
 * see {@link AdminUsersService.lockActiveAdmins} for why reading it unlocked is
 * a race rather than a check.
 */
export function wouldLeaveNoAdmin(
  activeAdminIds: readonly string[],
  targetId: string,
  targetStaysActiveAdmin: boolean,
): boolean {
  if (targetStaysActiveAdmin) return false;
  return activeAdminIds.includes(targetId) && activeAdminIds.every((id) => id === targetId);
}

/** The columns a quorum decision is made from, plus the sign-in identifier. */
type QuorumSubject = { id: string; email: string; role: Role; status: UserStatus };

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AdminAuditService,
    private readonly clock: ClockService,
  ) {}

  async list(auth: AuthContext, query: ListUsersQuery): Promise<Paginated<UserDto>> {
    const where = this.listFilter(auth, query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: ADMIN_USER_SELECT,
        // `id` breaks ties: two users created in the same millisecond would
        // otherwise be free to swap places between pages, which silently drops
        // one row from the listing and shows another twice.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map((row) => toUserDto(row)),
      meta: buildPageMeta(query.page, query.pageSize, total),
    };
  }

  async get(auth: AuthContext, id: string): Promise<UserDto> {
    const row = await this.prisma.user.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      select: ADMIN_USER_SELECT,
    });
    if (!row) throw Errors.notFound('User');
    return toUserDto(row);
  }

  async create(auth: AuthContext, body: CreateUserRequest, client: ClientInfo): Promise<UserDto> {
    // Hashed with the auth module's own service, never with a second argon2 call
    // site: two hashers with different parameters is two security policies, and
    // the weaker one wins silently for every account it creates.
    const passwordHash = await this.passwords.hash(body.password);

    let created: AdminUserRow;
    try {
      created = await this.prisma.user.create({
        data: {
          organizationId: auth.organizationId,
          email: body.email,
          passwordHash,
          fullName: body.fullName,
          employeeCode: body.employeeCode ?? null,
          role: body.role,
        },
        select: ADMIN_USER_SELECT,
      });
    } catch (error) {
      rethrowUserConflict(error);
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.USER_CREATED,
      entityType: AdminAuditEntity.USER,
      entityId: created.id,
      metadata: { role: created.role, status: created.status },
      client,
    });

    return toUserDto(created);
  }

  /**
   * Edits an employee, including their sign-in address.
   *
   * **A changed email revokes every session the account holds.** The argument
   * runs both ways and this is the side it lands on.
   *
   * *Against:* an email edit is usually a typo fix — `ali@x.co` → `ali@x.com` —
   * for a person who is sitting at their desk with the app open. Signing them out
   * costs them a login for a change they did not ask for and never see.
   *
   * *For, and decisive:* the email **is** half of the credential pair, so an
   * account whose address changed is not the same principal the live tokens were
   * minted for. The reason this route exists is that an address was typed wrong,
   * and the failure mode that motivates it is that the wrong address belonged to
   * a **real, different person** — who received the temporary password and signed
   * in. Correcting the address without revoking leaves that stranger holding a
   * live session on the account, and a refresh chain that keeps minting new ones
   * long after the mistake was "fixed". Revocation is also the only way the
   * administrator learns the correction actually took: the employee is asked to
   * sign in with the new address, which either works or surfaces the next typo
   * immediately.
   *
   * The cost of being wrong is asymmetric — one extra login against an
   * indefinitely live session on somebody else's attendance record — so the
   * sessions go. It is scoped to a change that really moves the address
   * (`body.email` is already normalised by the contract, so this compares
   * canonical forms, not spellings): re-submitting the same address, which is
   * what an edit form that always sends every field does, revokes nothing.
   */
  async update(
    auth: AuthContext,
    id: string,
    body: UpdateUserRequest,
    client: ClientInfo,
  ): Promise<UserDto> {
    // The admin quorum can only move if this patch touches `role` or `status`.
    // Taking the tenant-wide admin lock to rename an ordinary member serialises
    // every user edit in the organization behind one set of row locks, and inside
    // an interactive transaction with Prisma's 5 s default that surfaces as
    // `500 INTERNAL_ERROR` — a rename failing because somebody else was being
    // promoted. The lock is the right tool for the quorum decision and nothing
    // else.
    const affectsQuorum = body.role !== undefined || body.status !== undefined;
    const now = this.clock.now();

    const { updated, previousEmail } = await this.inTransaction(async (tx) => {
      const current = await this.lockAndLoad(tx, auth.organizationId, id, affectsQuorum);

      if (current.activeAdminIds !== null) {
        const nextRole = body.role ?? current.role;
        const nextStatus = body.status ?? current.status;
        this.assertQuorum(
          current.activeAdminIds,
          current.id,
          nextRole === Role.ADMIN && nextStatus === UserStatus.ACTIVE,
        );
      }

      const renamed = body.email !== undefined && body.email !== current.email;

      let row: AdminUserRow;
      try {
        row = await tx.user.update({
          // The tenancy predicate rides along on the unique `id`, so this cannot
          // become a cross-tenant write even if the guarded read above is ever
          // refactored away.
          where: { id: current.id, organizationId: auth.organizationId, deletedAt: null },
          data: {
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
            ...(body.employeeCode === undefined ? {} : { employeeCode: body.employeeCode }),
            ...(body.role === undefined ? {} : { role: body.role }),
            ...(body.status === undefined ? {} : { status: body.status }),
            // Bumped in the same statement as the address, so no window exists in
            // which the row carries the new email and the old tokens are still
            // accepted.
            ...(renamed ? { tokenVersion: { increment: 1 } } : {}),
          },
          select: ADMIN_USER_SELECT,
        });
      } catch (error) {
        // Soft-deleted between the read above and this write; the `where` clause
        // then matches nothing and Prisma reports `P2025`.
        if (isNotFound(error)) throw Errors.notFound('User');
        rethrowUserConflict(error);
      }

      // `tokenVersion` kills the access tokens; this kills the refresh chain that
      // would otherwise mint replacements for the rest of its lifetime.
      if (renamed) {
        await tx.session.updateMany({
          where: { userId: current.id, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      return { updated: row, previousEmail: renamed ? current.email : null };
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.USER_UPDATED,
      entityType: AdminAuditEntity.USER,
      entityId: updated.id,
      metadata: {
        fields: Object.keys(body).sort().join(','),
        role: updated.role,
        status: updated.status,
        // Both addresses, and only when one replaced the other. The account's
        // identity is the one thing about it that cannot be reconstructed from
        // the current row: without the old address, an audit row saying "email
        // was updated" cannot answer "updated from what?", which is the only
        // question anybody asks it. `sessionsRevoked` records the security
        // consequence at the moment it happened rather than leaving it to be
        // inferred from this method's source.
        ...(previousEmail === null
          ? {}
          : { previousEmail, email: updated.email, sessionsRevoked: true }),
      },
      client,
    });

    return toUserDto(updated);
  }

  /**
   * Soft delete.
   *
   * The row survives because `attendance_records` and `attendance_events` point
   * at it: hard-deleting an employee who left would cascade away the very history
   * an attendance system exists to keep, and a report for last month would
   * quietly lose rows. `tokenVersion` is bumped and the sessions revoked in the
   * same transaction so the departing employee's phone stops working at once.
   */
  async remove(auth: AuthContext, id: string, client: ClientInfo): Promise<void> {
    const now = this.clock.now();

    await this.inTransaction(async (tx) => {
      // Always locked: a deletion always removes an active administrator when the
      // target is one, so the quorum is always in play.
      const current = await this.lockAndLoad(tx, auth.organizationId, id, true);
      this.assertQuorum(current.activeAdminIds ?? [], current.id, false);

      await tx.user.update({
        where: { id: current.id, organizationId: auth.organizationId, deletedAt: null },
        data: { deletedAt: now, tokenVersion: { increment: 1 } },
        select: { id: true },
      });
      await tx.session.updateMany({
        where: { userId: current.id, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.USER_DELETED,
      entityType: AdminAuditEntity.USER,
      entityId: id,
      client,
    });
  }

  /**
   * Administrative password reset.
   *
   * Bumping `tokenVersion` is the point: an administrator resets a password
   * because the old one is compromised or the device is gone, so every access
   * token already in flight has to die with it. Revoking the sessions kills the
   * refresh chain that would otherwise mint replacements.
   */
  async resetPassword(
    auth: AuthContext,
    id: string,
    body: ResetUserPasswordRequest,
    client: ClientInfo,
  ): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, role: true },
    });
    if (!target) throw Errors.notFound('User');

    const passwordHash = await this.passwords.hash(body.newPassword);
    const now = this.clock.now();

    await this.inTransaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: target.id, organizationId: auth.organizationId, deletedAt: null },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
          // A reset is also the intended way out of a brute-force lockout.
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      // Soft-deleted between the read and this write. `updateMany` reports that
      // by changing nothing rather than by throwing, so a caller that ignores the
      // count answers 204 and writes an audit row for a password it did not set —
      // and the administrator believes the account is now reachable with it.
      if (count === 0) throw Errors.notFound('User');

      await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: peerAdminReset(auth, target)
        ? AdminAuditAction.ADMIN_PASSWORD_RESET
        : AdminAuditAction.USER_PASSWORD_RESET,
      entityType: AdminAuditEntity.USER,
      entityId: target.id,
      metadata: { selfService: target.id === auth.userId, targetRole: target.role },
      client,
    });
  }

  /**
   * Runs a mutation in an interactive transaction, translating lock contention.
   *
   * `$transaction` gives up after 5 s by default and reports `P2028`, which
   * reaches the global filter as `INTERNAL_ERROR`. Nothing was written and the
   * request is worth retrying, so it is worth saying so.
   */
  private async inTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error) {
      if (isTransactionFailure(error)) throw contended();
      throw error;
    }
  }

  private listFilter(auth: AuthContext, query: ListUsersQuery): Prisma.UserWhereInput {
    const search = query.search?.trim();
    return {
      organizationId: auth.organizationId,
      // Soft-deleted employees leave the directory but stay in the reports.
      deletedAt: null,
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { employeeCode: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  /**
   * Takes the organization's admin lock, then reads the target under it.
   *
   * Order matters and is the whole design. Locking first means the subsequent
   * read — and every concurrent transaction's read — is serialised behind the
   * same set of row locks, so the quorum decision is made against a snapshot no
   * other request can invalidate before this one commits.
   *
   * `lockAdmins` is false for a change that cannot move the quorum. The lock is
   * tenant-wide, so taking it unconditionally makes every edit to any employee
   * wait behind every other one, and the wait is bounded by a 5 s transaction
   * timeout rather than by anything the administrator did.
   */
  private async lockAndLoad(
    tx: Prisma.TransactionClient,
    organizationId: string,
    id: string,
    lockAdmins: boolean,
  ): Promise<QuorumSubject & { activeAdminIds: string[] | null }> {
    // `null`, not `[]`: "no quorum decision is being made here" and "this
    // organization has no active administrators" must not look the same to the
    // caller, or a change that skipped the lock would appear to prove the tenant
    // is already locked out.
    const activeAdminIds = lockAdmins ? await this.lockActiveAdmins(tx, organizationId) : null;

    const current = await tx.user.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true, email: true, role: true, status: true },
    });
    if (!current) throw Errors.notFound('User');

    return { ...current, activeAdminIds };
  }

  /**
   * Locks every active administrator row in the organization and returns their
   * ids.
   *
   * This is the last-admin race guard, and it is deliberately not a
   * read-then-write check. Consider two requests, each demoting one of the last
   * two admins. Under READ COMMITTED an `EXISTS (SELECT … another admin …)`
   * predicate is *true for both* — each sees the other's still-uncommitted admin
   * — and both commit, leaving the tenant locked out of its own admin panel.
   * That is textbook write skew, and no amount of application-level checking
   * fixes it.
   *
   * `SELECT … FOR UPDATE` does, because it changes what the second transaction
   * *reads*. The loser blocks on the winner's row lock; when the winner commits,
   * Postgres re-evaluates the predicate against the newly committed row version
   * and drops the row that is no longer an active admin. The second request
   * therefore observes the demotion it would otherwise have raced, and correctly
   * rejects its own.
   *
   * `ORDER BY id` is not cosmetic: it fixes one global lock-acquisition order per
   * organization, which is what stops two concurrent requests deadlocking by
   * grabbing the same two rows in opposite orders.
   *
   * Raw SQL because Prisma has no `FOR UPDATE`. Both interpolations are bound
   * parameters, and the enum literals are constants from this file.
   */
  private async lockActiveAdmins(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "users"
      WHERE "organizationId" = ${organizationId}::uuid
        AND "role" = 'ADMIN'::"Role"
        AND "status" = 'ACTIVE'::"UserStatus"
        AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR UPDATE
    `;
    return rows.map((row) => row.id);
  }

  private assertQuorum(
    activeAdminIds: readonly string[],
    targetId: string,
    targetStaysActiveAdmin: boolean,
  ): void {
    if (wouldLeaveNoAdmin(activeAdminIds, targetId, targetStaysActiveAdmin)) throw lastAdmin();
  }
}

/**
 * Is this an administrator resetting *another administrator's* password?
 *
 * Worth its own audit action. In a two-role product every ADMIN already has total
 * authority over the tenant, so this is not a privilege escalation — but it is
 * the one operation that hands the caller somebody else's identity, and the
 * target's sessions die with it. An alert on it is cheap; reconstructing it later
 * out of undifferentiated `admin.user.password_reset` rows is not.
 */
function peerAdminReset(auth: AuthContext, target: { id: string; role: Role }): boolean {
  return target.role === Role.ADMIN && target.id !== auth.userId;
}

/** Re-throws a `users` unique violation as the field-specific contract error. */
function rethrowUserConflict(error: unknown): never {
  if (isUniqueViolation(error, EMAIL_CONSTRAINT) || isUniqueViolation(error, EMAIL_FIELDS)) {
    throw Errors.conflict(ErrorCode.EMAIL_TAKEN, 'That email address is already in use');
  }
  if (
    isUniqueViolation(error, EMPLOYEE_CODE_CONSTRAINT) ||
    isUniqueViolation(error, EMPLOYEE_CODE_FIELDS)
  ) {
    throw Errors.conflict(ErrorCode.EMPLOYEE_CODE_TAKEN, 'That employee code is already in use');
  }
  throw error;
}
