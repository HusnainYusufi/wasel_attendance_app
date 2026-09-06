import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { reminderScheduleSchema, type ReminderScheduleDto } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses, ApiZodResponse } from '../../common/openapi/zod-api.decorators.js';
import { RemindersService } from './reminders.service.js';

/**
 * Where the device asks what it should remind the user about.
 *
 * One route, no parameters, always scoped to `@CurrentUser()` — there is no way
 * to ask for somebody else's schedule, and no `@Roles()` because everybody who
 * punches gets reminders. Authentication is the globally registered
 * `JwtAuthGuard`.
 */
@ApiTags('reminders')
@ApiBearerAuth('access-token')
@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('schedule')
  @ApiOperation({
    summary: 'Check-out reminders for the caller’s open shift',
    description:
      'The complete set of local notifications the device should have standing, ' +
      'as absolute UTC instants. Schedule exactly these and nothing else. An ' +
      'empty list is a normal answer — no open shift, already checked out, or ' +
      'every planned instant already passed — and means cancel what is scheduled. ' +
      'The instants are stable: re-fetching after a reload, a resume or a token ' +
      'refresh returns the same times for the same shift, so a client may safely ' +
      're-sync as often as it likes.',
  })
  @ApiZodResponse(200, reminderScheduleSchema, 'The reminder plan for the open shift')
  @ApiErrorResponses(401, 403)
  schedule(@CurrentUser() auth: AuthContext): Promise<ReminderScheduleDto> {
    return this.reminders.schedule(auth);
  }
}
