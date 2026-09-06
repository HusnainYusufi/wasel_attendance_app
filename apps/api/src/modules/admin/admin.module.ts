import { Module } from '@nestjs/common';
import { AuditService } from '../auth/audit.service.js';
import { AdminAttendanceEntryController } from './admin-attendance-entry.controller.js';
import { AdminAttendanceEntryService } from './admin-attendance-entry.service.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminOrganizationController } from './admin-organization.controller.js';
import { AdminOrganizationService } from './admin-organization.service.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminReportsController } from './admin-reports.controller.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminSitesController } from './admin-sites.controller.js';
import { AdminSitesService } from './admin-sites.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { AttendanceExportService } from './attendance-export.service.js';

/**
 * The admin panel: employees, sites, tenant settings, the dashboard, the
 * attendance report and its export, and manual attendance entry.
 *
 * `AdminAttendanceEntryService` is the one provider here that *writes*
 * `attendance_records`, which the attendance module otherwise owns outright. It
 * reuses that module's helpers rather than importing the module: everything it
 * needs is a pure function over a work date, and depending on `AttendanceModule`
 * would drag `PunchRefusalFilter` and the punch controller into a module that
 * has no use for either.
 *
 * It imports nothing: `PrismaModule`, `ClockModule` and `AuthModule` are all
 * `@Global()`, so `PasswordService` — which this module reuses rather than
 * re-deriving the argon2 parameters — resolves without a local import.
 *
 * `AuditService` is listed as a provider only because the auth module does not
 * export it. That gives this module its own instance of the *same class*, which
 * is safe precisely because the service is stateless: one implementation, one
 * failure policy, one table. Exporting it from `AuthModule` would be tidier and
 * is noted in the hand-off; re-implementing it here would not be.
 */
@Module({
  controllers: [
    AdminOverviewController,
    AdminUsersController,
    AdminSitesController,
    AdminOrganizationController,
    AdminReportsController,
    AdminAttendanceEntryController,
  ],
  providers: [
    AuditService,
    AdminAuditService,
    AdminOverviewService,
    AdminUsersService,
    AdminSitesService,
    AdminOrganizationService,
    AdminReportsService,
    AttendanceExportService,
    AdminAttendanceEntryService,
  ],
})
export class AdminModule {}
