import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  createSiteRequestSchema,
  paginationQuerySchema,
  Role,
  siteSchema,
  updateSiteRequestSchema,
  uuidSchema,
  type CreateSiteRequest,
  type Paginated,
  type PaginationQuery,
  type SiteDto,
  type UpdateSiteRequest,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
} from '../../common/openapi/zod-api.decorators.js';
import { ZodBody, ZodParam, ZodQuery } from '../../common/pipes/zod-param.decorators.js';
import { ClientContext, type ClientInfo } from '../auth/client-context.js';
import { AdminSitesService } from './admin-sites.service.js';
import { paginatedSitesSchema } from './admin.schemas.js';

/** Geofenced sites. Admin-only at the class level — see `AdminUsersController`. */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin/sites')
export class AdminSitesController {
  constructor(private readonly sites: AdminSitesService) {}

  @Get()
  @ApiOperation({ summary: 'List sites', description: 'Includes deactivated sites.' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiZodResponse(200, paginatedSitesSchema, 'A page of sites')
  @ApiErrorResponses(400, 401, 403)
  list(
    @CurrentUser() auth: AuthContext,
    @ZodQuery(paginationQuerySchema) query: PaginationQuery,
  ): Promise<Paginated<SiteDto>> {
    return this.sites.list(auth, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a site' })
  @ApiZodBody(createSiteRequestSchema)
  @ApiZodResponse(201, siteSchema, 'Created')
  @ApiErrorResponses(400, 401, 403, 409)
  create(
    @CurrentUser() auth: AuthContext,
    @ZodBody(createSiteRequestSchema) body: CreateSiteRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<SiteDto> {
    return this.sites.create(auth, body, client);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One site' })
  @ApiZodResponse(200, siteSchema, 'The site')
  @ApiErrorResponses(400, 401, 403, 404)
  get(@CurrentUser() auth: AuthContext, @ZodParam('id', uuidSchema) id: string): Promise<SiteDto> {
    return this.sites.get(auth, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a site' })
  @ApiZodBody(updateSiteRequestSchema)
  @ApiZodResponse(200, siteSchema, 'Updated')
  @ApiErrorResponses(400, 401, 403, 404, 409)
  update(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ZodBody(updateSiteRequestSchema) body: UpdateSiteRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<SiteDto> {
    return this.sites.update(auth, id, body, client);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Retire a site',
    description:
      'A soft delete. Attendance records referencing the site keep resolving its ' +
      'name, so historical reports are unchanged.',
  })
  @ApiErrorResponses(400, 401, 403, 404)
  remove(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ClientContext() client: ClientInfo,
  ): Promise<void> {
    return this.sites.remove(auth, id, client);
  }
}
