import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  Role,
  attendanceEntrySchema,
  createAttendanceEntryRequestSchema,
  listAttendanceEntriesQuerySchema,
  updateAttendanceEntryRequestSchema,
  uuidSchema,
  type AttendanceEntryDto,
  type CreateAttendanceEntryRequest,
  type ListAttendanceEntriesQuery,
  type Paginated,
  type UpdateAttendanceEntryRequest,
} from '@wasel/contracts';
import { z } from 'zod';
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
import { AdminAttendanceEntryService } from './admin-attendance-entry.service.js';
import { pageMetaSchema } from './admin.schemas.js';

/**
 * Documentation only. `Paginated<T>` is a TypeScript generic in
 * `@wasel/contracts`, so there is no single runtime schema to `$ref`; composing
 * the envelope here keeps the published document complete without inventing a
 * parallel DTO. The element inside it is the contract's own schema, so the half
 * that can drift does not.
 */
const paginatedAttendanceEntriesSchema = z.object({
  data: z.array(attendanceEntrySchema),
  meta: pageMetaSchema,
});

/**
 * Manual attendance entry.
 *
 * Admin-only at the class level, like every other controller in this module: a
 * per-method `@Roles` is one forgotten annotation away from an unguarded route,
 * and on *this* controller an unguarded route would let any employee write their
 * own attendance.
 *
 * Thin by design. Every rule worth getting wrong — which wall clock belongs to
 * which business day, what makes a shift possible, whether a future date may be
 * recorded — lives in the service, where it is testable without an HTTP server.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin/attendance')
export class AdminAttendanceEntryController {
  constructor(private readonly entries: AdminAttendanceEntryService) {}

  @Get()
  @ApiOperation({
    summary: 'Attendance in a date range, with its provenance',
    description:
      'Every row carries `source`, `enteredBy`, `enteredAt` and `note`, so a ' +
      'hand-entered day is never indistinguishable from a punched one. Filter ' +
      'with `source=MANUAL` to see only what was typed in.',
  })
  @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'source',
    required: false,
    schema: { type: 'string', enum: ['PUNCH', 'MANUAL'] },
  })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiZodResponse(200, paginatedAttendanceEntriesSchema, 'A page of attendance records')
  @ApiErrorResponses(400, 401, 403)
  list(
    @CurrentUser() auth: AuthContext,
    @ZodQuery(listAttendanceEntriesQuerySchema) query: ListAttendanceEntriesQuery,
  ): Promise<Paginated<AttendanceEntryDto>> {
    return this.entries.list(auth, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Record a day by hand',
    description:
      'Times are local wall clocks in the organization timezone; the server ' +
      'resolves them with the same helpers a punch uses, so the work date and ' +
      'the late minutes are exactly what a real punch at that moment would have ' +
      'produced. The record is stored as `MANUAL` and names the administrator. ' +
      'Refused for a future date, for a check-out that is not after its ' +
      'check-in, for a shift under the minimum length (`SHIFT_TOO_SHORT`), and ' +
      'with `409 CONFLICT` when that employee already has a record for the day.',
  })
  @ApiZodBody(createAttendanceEntryRequestSchema)
  @ApiZodResponse(201, attendanceEntrySchema, 'Created')
  @ApiErrorResponses(400, 401, 403, 404, 409)
  create(
    @CurrentUser() auth: AuthContext,
    @ZodBody(createAttendanceEntryRequestSchema) body: CreateAttendanceEntryRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<AttendanceEntryDto> {
    return this.entries.create(auth, body, client);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Correct a day',
    description:
      'Works on a punched record as well as a hand-entered one, and flips it to ' +
      '`MANUAL` either way — a corrected row is no longer purely the account the ' +
      'employee gave of their day. `checkOutTime: null` reopens the day. The ' +
      'employee, the work date and the recorded coordinates are not editable: ' +
      'moving a record to another person or another date is a delete and a ' +
      'create, which leaves an audit trail that says so.',
  })
  @ApiZodBody(updateAttendanceEntryRequestSchema)
  @ApiZodResponse(200, attendanceEntrySchema, 'Corrected')
  @ApiErrorResponses(400, 401, 403, 404, 409)
  update(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ZodBody(updateAttendanceEntryRequestSchema) body: UpdateAttendanceEntryRequest,
    @ClientContext() client: ClientInfo,
  ): Promise<AttendanceEntryDto> {
    return this.entries.update(auth, id, body, client);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a day',
    description:
      'A hard delete: nothing references an attendance record, and a soft-deleted ' +
      'one would keep occupying `(userId, workDate)` and lock the employee out of ' +
      'ever punching that day. The audit row carries the whole record, so what ' +
      'was removed stays recoverable from the trail.',
  })
  @ApiErrorResponses(400, 401, 403, 404)
  remove(
    @CurrentUser() auth: AuthContext,
    @ZodParam('id', uuidSchema) id: string,
    @ClientContext() client: ClientInfo,
  ): Promise<void> {
    return this.entries.remove(auth, id, client);
  }
}
