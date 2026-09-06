import { Injectable } from '@nestjs/common';
import { AttendanceStatus, PunchOutcome, UserStatus, type AdminOverview } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { Errors } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { businessDateIn } from '../attendance/work-date.js';
import { fromIsoDate } from './admin.time.js';

/**
 * The dashboard tiles.
 *
 * Every count is for **today in the organization's timezone**, not the server's:
 * for `Asia/Riyadh` the two disagree for three hours out of every twenty-four,
 * and a dashboard that empties itself at 03:00 local is the most visible possible
 * form of that bug.
 *
 * The tiles are defined so that they add up, which matters more than any single
 * one being clever:
 *
 *  * `checkedInCount` — employees who have checked in today *at all*, not those
 *    currently on site. This is what makes `absentCount` meaningful.
 *  * `checkedOutCount` — of those, the ones who have also checked out. The
 *    difference between the two tiles is therefore "still on site".
 *  * `absentCount` — active employees with no record today. It is clamped at
 *    zero rather than allowed to go negative, which it can do for a few seconds
 *    after an employee is suspended between the two counts.
 *  * `rejectedAttemptsToday` — refused punches, keyed on the event's `workDate`
 *    so it agrees with the other tiles across the local midnight rather than the
 *    server's. The single most interesting tile for an auditor.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async get(auth: AuthContext): Promise<AdminOverview> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { timezone: true, dayStartsAt: true },
    });
    if (!organization) throw Errors.notFound('Organization');

    // Deliberately the attendance module's rule, not a local one: the dashboard
    // must count the same day the punches were filed under. A tenant whose
    // `dayStartsAt` is not midnight would otherwise see a dashboard that
    // disagreed with its own attendance records for part of every day.
    const workDateIso = businessDateIn(
      this.clock.now(),
      organization.timezone,
      organization.dayStartsAt,
    );
    const workDate = fromIsoDate(workDateIso);
    const organizationId = auth.organizationId;

    // One batched round trip. Each count is an index probe:
    // `users(organizationId, status)` for the first, and
    // `attendance_records(organizationId, workDate)` /
    // `attendance_events(organizationId, outcome)` for the rest.
    const [totalActiveUsers, checkedInCount, checkedOutCount, lateCount, rejectedAttemptsToday] =
      await this.prisma.$transaction([
        this.prisma.user.count({
          where: { organizationId, deletedAt: null, status: UserStatus.ACTIVE },
        }),
        this.prisma.attendanceRecord.count({ where: { organizationId, workDate } }),
        this.prisma.attendanceRecord.count({
          where: { organizationId, workDate, checkOutAt: { not: null } },
        }),
        this.prisma.attendanceRecord.count({
          where: { organizationId, workDate, status: AttendanceStatus.LATE },
        }),
        this.prisma.attendanceEvent.count({
          where: { organizationId, workDate, outcome: { not: PunchOutcome.ACCEPTED } },
        }),
      ]);

    return {
      workDate: workDateIso,
      timezone: organization.timezone,
      totalActiveUsers,
      checkedInCount,
      checkedOutCount,
      lateCount,
      absentCount: Math.max(0, totalActiveUsers - checkedInCount),
      rejectedAttemptsToday,
    };
  }
}
