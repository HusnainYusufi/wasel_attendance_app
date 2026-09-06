import { Controller, Get, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  attendanceReportQuerySchema,
  EXPORT_MAX_RANGE_DAYS,
  ExportFormat,
  exportQuerySchema,
  Role,
  type AttendanceReportQuery,
  type ExportQuery,
} from '@wasel/contracts';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ApiErrorResponses, ApiZodResponse } from '../../common/openapi/zod-api.decorators.js';
import { ZodQuery } from '../../common/pipes/zod-param.decorators.js';
import { ClientContext, type ClientInfo } from '../auth/client-context.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AttendanceExportService } from './attendance-export.service.js';
import { attendanceReportSchema, type AttendanceReport } from './admin.schemas.js';

const RANGE_QUERY = { required: true, schema: { type: 'string', format: 'date' } } as const;

/** Reporting and export. Admin-only at the class level — see `AdminUsersController`. */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(
    private readonly reports: AdminReportsService,
    private readonly exporter: AttendanceExportService,
  ) {}

  @Get('attendance')
  @ApiOperation({
    summary: 'Attendance report',
    description: `Paginated, joined to the employee and both sites. The summary covers the whole filtered range, not the page. Ranges are capped at ${EXPORT_MAX_RANGE_DAYS} days.`,
  })
  @ApiQuery({ name: 'from', ...RANGE_QUERY })
  @ApiQuery({ name: 'to', ...RANGE_QUERY })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'pageSize', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiZodResponse(200, attendanceReportSchema, 'A page of attendance records plus totals')
  @ApiErrorResponses(400, 401, 403)
  report(
    @CurrentUser() auth: AuthContext,
    @ZodQuery(attendanceReportQuerySchema) query: AttendanceReportQuery,
  ): Promise<AttendanceReport> {
    return this.reports.page(auth, query);
  }

  /**
   * `@Res()` without `passthrough` on purpose: the handler owns the response
   * because the body is streamed, not serialised. Returning a value here would
   * make Nest buffer a workbook it cannot describe.
   */
  @Get('export')
  @ApiOperation({
    summary: 'Download the attendance sheet',
    description:
      'Streams an XLSX workbook or an RFC 4180 CSV. Times are the wall clock in ' +
      "the organization's timezone, which the file states. An empty range " +
      'produces a valid file containing only the header row.',
  })
  @ApiQuery({ name: 'from', ...RANGE_QUERY })
  @ApiQuery({ name: 'to', ...RANGE_QUERY })
  @ApiQuery({ name: 'userId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'format', required: false, enum: [ExportFormat.XLSX, ExportFormat.CSV] })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiResponse({
    status: 200,
    description: 'The attendance sheet',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiErrorResponses(400, 401, 403, 404)
  export(
    @CurrentUser() auth: AuthContext,
    @ZodQuery(exportQuerySchema) query: ExportQuery,
    @ClientContext() client: ClientInfo,
    @Res() response: Response,
  ): Promise<void> {
    return this.exporter.stream(auth, query, client, response);
  }
}
