import { Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  organizationSchema,
  Role,
  updateOrganizationRequestSchema,
  type OrganizationDto,
  type UpdateOrganizationRequest,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
} from '../../common/openapi/zod-api.decorators.js';
import { ZodBody } from '../../common/pipes/zod-param.decorators.js';
import { ClientContext, type ClientInfo } from '../auth/client-context.js';
import { AdminOrganizationService } from './admin-organization.service.js';

/** Tenant settings. Admin-only at the class level — see `AdminUsersController`. */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin/organization')
export class AdminOrganizationController {
  constructor(private readonly organization: AdminOrganizationService) {}

  @Get()
  @ApiOperation({ summary: 'Organization settings' })
  @ApiZodResponse(200, organizationSchema, 'The organization')
  @ApiErrorResponses(401, 403, 404)
  get(@CurrentUser() auth: AuthContext): Promise<OrganizationDto> {
    return this.organization.get(auth);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update organization settings',
    description:
      'Changing `timezone` or `dayStartsAt` applies to attendance recorded from ' +
      'now on. Existing `workDate` values are historical facts and are never ' +
      'rewritten; the change is written to the audit log with the previous value. ' +
      '`dayStartsAt` is the local time the business day rolls over — leave it at ' +
      '`00:00` for a daytime organization, and set it inside the off-hours (for ' +
      'example `20:00`) for one whose shifts cross midnight, so that a whole ' +
      'night lands on one work date and is measured against one `workdayStart`.',
  })
  @ApiZodBody(updateOrganizationRequestSchema)
  @ApiZodResponse(200, organizationSchema, 'Updated')
  @ApiErrorResponses(400, 401, 403, 404)
  update(
    @CurrentUser() auth: AuthContext,
    @ZodBody(updateOrganizationRequestSchema) body: UpdateOrganizationRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<OrganizationDto> {
    return this.organization.update(auth, body, client);
  }
}
