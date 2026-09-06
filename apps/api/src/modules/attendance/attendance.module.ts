import { Module } from '@nestjs/common';
import { LoggingModule } from '../../common/logging/logging.module.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceEventService } from './attendance-event.service.js';
import { AttendanceService } from './attendance.service.js';
import { PunchRefusalFilter } from './punch-refusal.filter.js';
import { PunchRefusalAuditService } from './punch-refusal.service.js';

/**
 * Geofenced attendance: the product's core.
 *
 * Almost everything it consumes is already global — `PrismaModule`,
 * `ClockModule` and `AuthModule` (which registers the application-wide guards,
 * so these routes are authenticated without any annotation of their own).
 * `LoggingModule` is the exception: `PinoLogger` is not global, and
 * `PunchRefusalFilter` needs it to render through the shared error filter rather
 * than growing a second opinion about the error envelope.
 *
 * `AttendanceService` is exported for the admin module's reporting, which reads
 * the same records and must not grow a second opinion about what a work date is.
 */
@Module({
  imports: [LoggingModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceService,
    AttendanceEventService,
    PunchRefusalAuditService,
    PunchRefusalFilter,
  ],
  exports: [AttendanceService],
})
export class AttendanceModule {}
