import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ErrorCode, type ReminderScheduleDto } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { Errors } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MAX_CARRY_OVER_SHIFT_MS } from '../attendance/attendance.constants.js';
import {
  businessDateIn,
  shiftWorkDate,
  workDateFromColumn,
  workDateToColumn,
} from '../attendance/work-date.js';
import { planShiftReminders } from './reminder-plan.js';

/** Only the workday policy the plan is derived from. Nothing else about the tenant is read. */
const ORGANIZATION_POLICY_SELECT = {
  timezone: true,
  workdayStart: true,
  workdayEnd: true,
  dayStartsAt: true,
} as const satisfies Prisma.OrganizationSelect;

/** The four columns a plan needs, and no more — this row never leaves the service. */
const OPEN_SHIFT_SELECT = {
  id: true,
  workDate: true,
  checkInAt: true,
  checkOutAt: true,
} as const satisfies Prisma.AttendanceRecordSelect;

type OpenShiftRow = Prisma.AttendanceRecordGetPayload<{ select: typeof OPEN_SHIFT_SELECT }>;

type WorkdayPolicy = Prisma.OrganizationGetPayload<{ select: typeof ORGANIZATION_POLICY_SELECT }>;

@Injectable()
export class RemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /**
   * The nudges the caller's device should have standing right now.
   *
   * The response is a *complete* statement, not a delta: whatever comes back is
   * exactly what should be scheduled, and an empty list means cancel everything.
   * That is what makes check-out safe — the record closes, this returns nothing,
   * and the client's next sync tears the alarms down. It is also why no state is
   * stored: the plan is a pure function of the open record and the tenant's
   * policy, so there is no schedule table to fall out of step with reality when
   * an administrator edits a record by hand.
   */
  async schedule(auth: AuthContext): Promise<ReminderScheduleDto> {
    const now = this.clock.now();
    const organization = await this.loadPolicy(auth.organizationId);
    const workDate = businessDateIn(now, organization.timezone, organization.dayStartsAt);
    const open = await this.findOpenShift(auth, workDate, now);

    return {
      serverTime: now.toISOString(),
      reminders:
        open === null
          ? []
          : planShiftReminders({
              attendanceRecordId: open.id,
              checkInAt: open.checkInAt,
              now,
              // The record's own business date, not today's: a shift that began
              // last night is measured against the day it belongs to, otherwise
              // its expected check-out would be pushed 24 hours into the future
              // and the plan would nag somebody who is a day overdue.
              workDate: workDateFromColumn(open.workDate),
              timezone: organization.timezone,
              workdayStart: organization.workdayStart,
              workdayEnd: organization.workdayEnd,
              dayStartsAt: organization.dayStartsAt,
            }),
    };
  }

  /**
   * The one record a reminder could possibly concern: the caller's open shift.
   *
   * Deliberately the same shape as the attendance module's own resolver — the
   * record for the current business date if it is still open, otherwise an
   * unclosed record from the previous business date while it is still inside the
   * carry-over window. Reminders must agree with the punch endpoints about what
   * "checked in" means, or the app would keep nudging somebody the server
   * considers checked out, or fall silent on a night shift the server considers
   * open. The constant is imported rather than re-chosen for the same reason.
   *
   * Scoped to `userId` *and* `organizationId` per CONVENTIONS §2.1: the ids come
   * from the access token, so this can only ever read the caller's own days.
   */
  private async findOpenShift(
    auth: AuthContext,
    workDate: string,
    now: Date,
  ): Promise<OpenShiftRow | null> {
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        userId: auth.userId,
        organizationId: auth.organizationId,
        workDate: {
          in: [workDateToColumn(shiftWorkDate(workDate, -1)), workDateToColumn(workDate)],
        },
      },
      select: OPEN_SHIFT_SELECT,
    });

    // Both halves of the attendance module's rule, and the second half is the
    // one worth stating: an *unclosed* record from yesterday only counts while
    // there is no record for today at all. Once the user has a record for the
    // current business date, yesterday's stays open for an administrator to
    // settle and must not attract reminders of its own. Filtering the query on
    // `checkOutAt: null` instead would quietly lose that condition and nudge
    // somebody the punch endpoints consider checked out.
    const today = rows.find((row) => workDateFromColumn(row.workDate) === workDate) ?? null;
    if (today !== null) return today.checkOutAt === null ? today : null;

    return (
      rows.find(
        (row) =>
          row.checkOutAt === null &&
          now.getTime() - row.checkInAt.getTime() <= MAX_CARRY_OVER_SHIFT_MS,
      ) ?? null
    );
  }

  private async loadPolicy(organizationId: string): Promise<WorkdayPolicy> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: ORGANIZATION_POLICY_SELECT,
    });
    // Unreachable while the principal exists: deleting an organization cascades
    // to its users, so the guard would have rejected the request first.
    if (!organization) {
      throw Errors.unauthenticated(ErrorCode.SESSION_REVOKED, 'This session is no longer valid');
    }
    return organization;
  }
}
