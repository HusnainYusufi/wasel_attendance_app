import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { adminOverviewSchema, Role, type AdminOverview } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ApiErrorResponses, ApiZodResponse } from '../../common/openapi/zod-api.decorators.js';
import { AdminOverviewService } from './admin-overview.service.js';

/** The dashboard. Admin-only at the class level — see `AdminUsersController`. */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get('overview')
  @ApiOperation({
    summary: "Today's dashboard tiles",
    description: '"Today" is the calendar date in the organization\'s own timezone.',
  })
  @ApiZodResponse(200, adminOverviewSchema, 'Tiles')
  @ApiErrorResponses(401, 403, 404)
  get(@CurrentUser() auth: AuthContext): Promise<AdminOverview> {
    return this.overview.get(auth);
  }
}
