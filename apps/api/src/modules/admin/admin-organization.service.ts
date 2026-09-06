import { Injectable } from '@nestjs/common';
import type { OrganizationDto, UpdateOrganizationRequest } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Errors } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminAuditAction, AdminAuditEntity } from './admin.constants.js';
import {
  ADMIN_ORGANIZATION_SELECT,
  toOrganizationDto,
  type AdminOrganizationRow,
} from './admin.mapper.js';

@Injectable()
export class AdminOrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async get(auth: AuthContext): Promise<OrganizationDto> {
    return toOrganizationDto(await this.load(auth.organizationId));
  }

  /**
   * Updates the tenant's policy.
   *
   * **Changing `timezone` is deliberately prospective only: no stored
   * `workDate` is rewritten.** Three reasons, in increasing order of severity.
   *
   *  1. *It would falsify history.* `workDate` is not a derived view of
   *     `checkInAt`; it is the record of which local working day an employee was
   *     counted against, decided by the policy in force at the moment they
   *     punched. A shift from `Asia/Riyadh` to `UTC` would move every 00:00–03:00
   *     punch back a day, silently restating attendance sheets that payroll has
   *     already paid against.
   *  2. *It is not even well defined.* `status` and `lateMinutes` were computed
   *     against the old local workday window. Rewriting the dates without
   *     recomputing those leaves internally inconsistent rows; recomputing them
   *     rewrites an audit trail — and neither is something a settings screen
   *     should do behind a toggle.
   *  3. *It can fail destructively.* `@@unique([userId, workDate])` means a
   *     recomputation that maps two adjacent days onto one collides. A bulk
   *     rewrite would abort part-way, or, if written defensively, would have to
   *     silently discard one of the two records.
   *
   * So the change applies from the next punch onwards, and it is written to the
   * audit log with both the old and the new zone — twice: once inside the
   * `admin.organization.updated` row that describes this request, and once as a
   * dedicated `admin.organization.timezone_changed` row that forms the tenant's
   * timezone timeline.
   *
   * The second row is not bookkeeping. Freezing `workDate` fixes only half the
   * problem: the export still renders each stored *instant* in the tenant's
   * **current** zone, so re-exporting an already-paid month after a move produces
   * rows whose check-in date contradicts their own work date. The export reads
   * this timeline on every download and says so in the file when the range it is
   * rendering predates the zone it is rendering in — see
   * `AdminReportsService.timezoneChangesSince` and `export/export-columns.ts`.
   * A report that looks perfectly consistent and is wrong is the outcome worth
   * paying to avoid.
   */
  async update(
    auth: AuthContext,
    body: UpdateOrganizationRequest,
    client: ClientInfo,
  ): Promise<OrganizationDto> {
    const current = await this.load(auth.organizationId);

    // The contract can only compare `workdayStart` against `workdayEnd` when the
    // request carries both. A patch that moves only one of them has to be checked
    // against the stored value, or an organization can end up with a window that
    // ends before it begins and a LATE threshold that never fires.
    const nextStart = body.workdayStart ?? current.workdayStart;
    const nextEnd = body.workdayEnd ?? current.workdayEnd;
    if (nextStart >= nextEnd) {
      throw Errors.validation([
        { path: 'workdayEnd', message: 'Workday start must be before workday end' },
      ]);
    }

    const updated = await this.prisma.organization.update({
      where: { id: auth.organizationId },
      data: {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.workdayStart === undefined ? {} : { workdayStart: body.workdayStart }),
        ...(body.workdayEnd === undefined ? {} : { workdayEnd: body.workdayEnd }),
        ...(body.dayStartsAt === undefined ? {} : { dayStartsAt: body.dayStartsAt }),
        ...(body.lateGraceMinutes === undefined ? {} : { lateGraceMinutes: body.lateGraceMinutes }),
        ...(body.maxAccuracyMeters === undefined
          ? {}
          : { maxAccuracyMeters: body.maxAccuracyMeters }),
        ...(body.enforceGeofence === undefined ? {} : { enforceGeofence: body.enforceGeofence }),
      },
      select: ADMIN_ORGANIZATION_SELECT,
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.ORGANIZATION_UPDATED,
      entityType: AdminAuditEntity.ORGANIZATION,
      entityId: auth.organizationId,
      metadata: {
        fields: Object.keys(body).sort().join(','),
        // Recorded explicitly, and only when they moved: these are the settings
        // whose change alters the meaning of rows written after them, so they
        // must be reconstructable from the log rather than inferred from a diff.
        // `dayStartsAt` is here for the same reason as `timezone` — it decides
        // where one work date ends and the next begins, so a report straddling
        // the change is discontinuous, and this row is what explains it.
        ...(updated.timezone === current.timezone
          ? {}
          : { previousTimezone: current.timezone, timezone: updated.timezone }),
        ...(updated.dayStartsAt === current.dayStartsAt
          ? {}
          : { previousDayStartsAt: current.dayStartsAt, dayStartsAt: updated.dayStartsAt }),
        // The third setting in this family, and the loudest of them: it decides
        // whether a punch taken 791 km from the nearest office is a record or a
        // refusal. A report that shows a month of out-of-range check-ins is
        // explained entirely by *when* this was switched, so the log has to be
        // able to answer it without diffing settings edits.
        ...(updated.enforceGeofence === current.enforceGeofence
          ? {}
          : {
              previousEnforceGeofence: String(current.enforceGeofence),
              enforceGeofence: String(updated.enforceGeofence),
            }),
      },
      client,
    });

    // The timezone timeline, as its own filterable row. Every export queries it
    // to decide whether the range it is about to render was recorded under a
    // different zone than the one it renders in — see
    // `AdminReportsService.timezoneChangesSince`.
    if (updated.timezone !== current.timezone) {
      await this.audit.record({
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: AdminAuditAction.ORGANIZATION_TIMEZONE_CHANGED,
        entityType: AdminAuditEntity.ORGANIZATION,
        entityId: auth.organizationId,
        metadata: { previousTimezone: current.timezone, timezone: updated.timezone },
        client,
      });
    }

    return toOrganizationDto(updated);
  }

  private async load(organizationId: string): Promise<AdminOrganizationRow> {
    const row = await this.prisma.organization.findUnique({
      // `organizations` is the tenant table itself, so the id *is* the tenancy
      // predicate — and it comes from the access token, never from the request.
      where: { id: organizationId },
      select: ADMIN_ORGANIZATION_SELECT,
    });
    if (!row) throw Errors.notFound('Organization');
    return row;
  }
}
