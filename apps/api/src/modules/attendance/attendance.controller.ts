import { Controller, Get, HttpCode, Post, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  attendanceHistoryQuerySchema,
  attendanceRecordSchema,
  attendanceStatusSchema,
  punchRequestSchema,
  punchResponseSchema,
  type AttendanceHistoryQuery,
  type AttendanceRecordDto,
  type AttendanceStatusDto,
  type Paginated,
  type PunchRequest,
  type PunchResponse,
} from '@wasel/contracts';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import {
  ApiErrorResponses,
  ApiZodBody,
  ApiZodResponse,
} from '../../common/openapi/zod-api.decorators.js';
import { ZodBody, ZodQuery } from '../../common/pipes/zod-param.decorators.js';
import { ClientContext, type ClientInfo } from '../auth/client-context.js';
import { AttendanceService } from './attendance.service.js';
import { PunchRefusalFilter } from './punch-refusal.filter.js';

/**
 * Documentation only — it validates nothing.
 *
 * `Paginated<T>` and `PageMeta` are TypeScript interfaces in `@wasel/contracts`,
 * not Zod schemas, so there is no component to `$ref` for a paged response.
 * Declaring the envelope here keeps the published document complete rather than
 * silently missing the shape of `GET /attendance/history`; the record inside it
 * is the contract's own schema, so the part that can drift does not.
 */
const paginatedAttendanceSchema = z.object({
  data: z.array(attendanceRecordSchema),
  meta: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
    hasNext: z.boolean(),
    hasPrevious: z.boolean(),
  }),
});

/**
 * Thin by design: validate, delegate, return. Every rule worth getting wrong —
 * the order of the geofence gates, the work-date boundary, the overnight
 * check-out — lives in the service, where it is unit-testable without an HTTP
 * server.
 *
 * No `@Roles()` anywhere: members and administrators punch through the same
 * routes, and every one of them is scoped to `@CurrentUser()`, so a user can
 * only ever reach their own attendance. Authentication itself is the globally
 * registered `JwtAuthGuard`.
 */
@ApiTags('attendance')
@ApiBearerAuth('access-token')
// A refusal raised by a guard never reaches the service, and so never wrote the
// audit row CONVENTIONS §2.5 requires. Bound at the controller because a filter
// here still sees exceptions thrown by the globally registered guards, which is
// the only place the attendance module can observe them.
@UseFilters(PunchRefusalFilter)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Everything the home screen needs for today',
    description:
      'Server time, the organization timezone, the current work date, whether the ' +
      'user may check in or out (decided server-side, so a button cannot offer an ' +
      "action the server will refuse), the day's record, and the active sites the " +
      'client previews distances against. `canCheckIn` is false while any shift ' +
      'is open, including one carried over from an earlier work date — in which ' +
      'case `today` is that earlier record and carries its own `workDate`.',
  })
  @ApiZodResponse(200, attendanceStatusSchema, "Today's attendance state")
  @ApiErrorResponses(401, 403)
  status(@CurrentUser() auth: AuthContext): Promise<AttendanceStatusDto> {
    return this.attendance.status(auth);
  }

  @Post('check-in')
  @ApiOperation({
    summary: 'Open the work day',
    description:
      'Rejected when the GPS fix is too imprecise to prove anything ' +
      '(`LOW_GPS_ACCURACY`), when the organization has no active site ' +
      '(`NO_ACTIVE_SITE`), when the device is outside every geofence ' +
      '(`OUT_OF_RANGE`), when the day is already open (`ALREADY_CHECKED_IN`) or ' +
      'when a shift from an earlier work date is still open (`SHIFT_STILL_OPEN`, ' +
      'resolved by checking out of it). Every one of those attempts is written ' +
      'to the attendance event log.',
  })
  @ApiZodBody(punchRequestSchema)
  @ApiZodResponse(201, punchResponseSchema, 'Checked in')
  @ApiErrorResponses(400, 401, 403, 409, 422)
  checkIn(
    @CurrentUser() auth: AuthContext,
    @ZodBody(punchRequestSchema) body: PunchRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<PunchResponse> {
    return this.attendance.checkIn(auth, body, client);
  }

  // 200 rather than the 201 a POST defaults to: this closes an existing record,
  // it does not create one.
  @Post('check-out')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Close the work day',
    description:
      'Closes the open shift — including one opened on the previous work date, ' +
      'so a 23:50 → 00:10 shift is not lost to the calendar rolling over. The ' +
      'accuracy and geofence gates apply exactly as they do to a check-in. A ' +
      'check-out inside the first minute of the shift is refused with ' +
      '`SHIFT_TOO_SHORT` and leaves the shift open, because storing a ' +
      'zero-minute day would both fabricate a full day of attendance and lock ' +
      'the employee out of the one they were about to work.',
  })
  @ApiZodBody(punchRequestSchema)
  @ApiZodResponse(200, punchResponseSchema, 'Checked out')
  @ApiErrorResponses(400, 401, 403, 409, 422)
  checkOut(
    @CurrentUser() auth: AuthContext,
    @ZodBody(punchRequestSchema) body: PunchRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<PunchResponse> {
    return this.attendance.checkOut(auth, body, client);
  }

  @Get('history')
  @ApiOperation({
    summary: "The caller's own attendance, newest first",
    description: 'Always scoped to the authenticated user; there is no way to ask for another.',
  })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'from', required: false, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: false, schema: { type: 'string', format: 'date' } })
  @ApiZodResponse(200, paginatedAttendanceSchema, 'A page of attendance records')
  @ApiErrorResponses(400, 401, 403)
  history(
    @CurrentUser() auth: AuthContext,
    @ZodQuery(attendanceHistoryQuerySchema) query: AttendanceHistoryQuery,
  ): Promise<Paginated<AttendanceRecordDto>> {
    return this.attendance.history(auth, query);
  }
}
