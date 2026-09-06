import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  buildPageMeta,
  type CreateSiteRequest,
  type PaginationQuery,
  type Paginated,
  type SiteDto,
  type UpdateSiteRequest,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { Errors } from '../../common/errors/app.exception.js';
import { isUniqueViolation } from '../../prisma/prisma-errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminAuditAction, AdminAuditEntity } from './admin.constants.js';
import { ADMIN_SITE_SELECT, toSiteDto, type AdminSiteRow } from './admin.mapper.js';

const NAME_CONSTRAINT = 'sites_organizationId_name_key';
const NAME_FIELDS = ['organizationId', 'name'] as const;

/**
 * Geofenced sites.
 *
 * Every mutation is soft: a `Site` row is the *meaning* of a historical
 * attendance record — `attendance_records.checkInSiteId` is a hard foreign key,
 * and last quarter's report renders `checkInSite.name`. Hard-deleting a closed
 * branch would either fail on the constraint or, worse, take the records with
 * it. Deactivating stops it accepting new punches; deleting hides it from the
 * admin panel. Neither touches a row that has already been reported on.
 */
@Injectable()
export class AdminSitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly clock: ClockService,
  ) {}

  async list(auth: AuthContext, query: PaginationQuery): Promise<Paginated<SiteDto>> {
    const where: Prisma.SiteWhereInput = { organizationId: auth.organizationId, deletedAt: null };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.site.count({ where }),
      this.prisma.site.findMany({
        where,
        select: ADMIN_SITE_SELECT,
        // Alphabetical: an administrator looks a site up by name, not by age.
        // `id` breaks ties so paging is stable.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map((row) => toSiteDto(row)),
      meta: buildPageMeta(query.page, query.pageSize, total),
    };
  }

  async get(auth: AuthContext, id: string): Promise<SiteDto> {
    const row = await this.prisma.site.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      select: ADMIN_SITE_SELECT,
    });
    if (!row) throw Errors.notFound('Site');
    return toSiteDto(row);
  }

  async create(auth: AuthContext, body: CreateSiteRequest, client: ClientInfo): Promise<SiteDto> {
    let created: AdminSiteRow;
    try {
      created = await this.prisma.site.create({
        data: {
          organizationId: auth.organizationId,
          name: body.name,
          address: body.address ?? null,
          latitude: body.latitude,
          longitude: body.longitude,
          radiusMeters: body.radiusMeters,
          isActive: body.isActive,
        },
        select: ADMIN_SITE_SELECT,
      });
    } catch (error) {
      rethrowSiteConflict(error);
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.SITE_CREATED,
      entityType: AdminAuditEntity.SITE,
      entityId: created.id,
      metadata: {
        name: created.name,
        latitude: created.latitude,
        longitude: created.longitude,
        radiusMeters: created.radiusMeters,
      },
      client,
    });

    return toSiteDto(created);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: UpdateSiteRequest,
    client: ClientInfo,
  ): Promise<SiteDto> {
    const existing = await this.prisma.site.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw Errors.notFound('Site');

    let updated: AdminSiteRow;
    try {
      updated = await this.prisma.site.update({
        where: { id: existing.id, organizationId: auth.organizationId, deletedAt: null },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
          ...(body.longitude === undefined ? {} : { longitude: body.longitude }),
          ...(body.radiusMeters === undefined ? {} : { radiusMeters: body.radiusMeters }),
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        },
        select: ADMIN_SITE_SELECT,
      });
    } catch (error) {
      rethrowSiteConflict(error);
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.SITE_UPDATED,
      entityType: AdminAuditEntity.SITE,
      entityId: updated.id,
      metadata: { fields: Object.keys(body).sort().join(','), isActive: updated.isActive },
      client,
    });

    return toSiteDto(updated);
  }

  /**
   * Retires a site.
   *
   * `isActive` is cleared alongside `deletedAt` so that any query which filters
   * only on `isActive` — the geofence lookup on the attendance side — stops
   * offering it immediately, without having to know about soft deletion.
   */
  async remove(auth: AuthContext, id: string, client: ClientInfo): Promise<void> {
    const existing = await this.prisma.site.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw Errors.notFound('Site');

    await this.prisma.site.update({
      where: { id: existing.id, organizationId: auth.organizationId, deletedAt: null },
      data: { deletedAt: this.clock.now(), isActive: false },
      select: { id: true },
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.SITE_DELETED,
      entityType: AdminAuditEntity.SITE,
      entityId: existing.id,
      client,
    });
  }
}

/**
 * A retired site keeps its name.
 *
 * `@@unique([organizationId, name])` covers soft-deleted rows too, so "HQ" stays
 * reserved after "HQ" is retired. That is the conservative half of a trade-off:
 * releasing the name would mean renaming the archived row, and the archived row
 * is what every historical report prints — last year's export would silently
 * start saying something else. The proper fix is a partial unique index
 * (`WHERE "deletedAt" IS NULL`), which lives in `schema.prisma`; see the hand-off
 * notes.
 */
function rethrowSiteConflict(error: unknown): never {
  if (isUniqueViolation(error, NAME_CONSTRAINT) || isUniqueViolation(error, NAME_FIELDS)) {
    throw Errors.conflict(
      ErrorCode.SITE_NAME_TAKEN,
      'A site with that name already exists in this organization',
    );
  }
  throw error;
}
