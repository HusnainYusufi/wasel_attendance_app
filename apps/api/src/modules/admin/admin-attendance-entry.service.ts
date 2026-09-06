import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AttendanceSource,
  ErrorCode,
  MIN_SHIFT_MINUTES,
  buildPageMeta,
  type AttendanceEntryDto,
  type AttendanceStatus,
  type CreateAttendanceEntryRequest,
  type ListAttendanceEntriesQuery,
  type Paginated,
  type UpdateAttendanceEntryRequest,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { Errors, type AppException, type ErrorDetail } from '../../common/errors/app.exception.js';
import { isUniqueViolation } from '../../prisma/prisma-errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MAX_CARRY_OVER_SHIFT_HOURS,
  MAX_CARRY_OVER_SHIFT_MS,
  MIN_SHIFT_MS,
} from '../attendance/attendance.constants.js';
import { statusFor } from '../attendance/attendance.mapper.js';
import {
  businessDateIn,
  lateMinutesFor,
  minutesBetween,
  shiftWorkDate,
  wallClockInstant,
  workDateFromColumn,
  workDateIn,
  workDateToColumn,
  workdayStartInstant,
} from '../attendance/work-date.js';
import type { ClientInfo } from '../auth/client-context.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminAuditAction, AdminAuditEntity } from './admin.constants.js';
import { fromIsoDate } from './admin.time.js';

/**
 * Manual attendance entry: an administrator recording or correcting a day.
 *
 * This is the most abusable endpoint in the product — the ability to type in a
 * day somebody did not work is precisely what an attendance record exists to
 * prevent — so three properties are non-negotiable and every branch below
 * upholds them.
 *
 *  1. **Nothing here decides what a work date is.** Every instant, every work
 *     date, every late minute and every worked minute comes from the attendance
 *     module's own helpers (`businessDateIn`, `workdayStartInstant`,
 *     `lateMinutesFor`, `minutesBetween`). A second opinion about the tenant's
 *     midnight would eventually disagree with the first, and the disagreement
 *     would show up in somebody's pay with no way to explain it.
 *
 *  2. **Nothing here invents a shift rule.** `MIN_SHIFT_MS` and
 *     `MAX_CARRY_OVER_SHIFT_MS` are the attendance module's constants, applied
 *     under the same conditions the punch path applies them.
 *
 *  3. **Every write is attributable.** `source`, `enteredById`, `enteredAt` and
 *     `note` are set on every create and every correction, and an `AuditLog` row
 *     is written for all three verbs.
 */

/** The workday policy a manual entry is judged against — the same fields a punch reads. */
const ORGANIZATION_POLICY_SELECT = {
  timezone: true,
  workdayStart: true,
  dayStartsAt: true,
  lateGraceMinutes: true,
} as const satisfies Prisma.OrganizationSelect;

type OrganizationPolicy = Prisma.OrganizationGetPayload<{
  select: typeof ORGANIZATION_POLICY_SELECT;
}>;

/**
 * The columns an {@link AttendanceEntryDto} is built from.
 *
 * `enteredBy` is joined rather than returned as a bare id: an audit surface that
 * shows a UUID where a name belongs is one nobody reads. It is a nullable
 * relation (`onDelete: SetNull`), so an administrator who has since been removed
 * leaves the row saying `MANUAL` with no name — which is still the truth, and
 * more useful than pretending the record was punched.
 */
const ATTENDANCE_ENTRY_SELECT = {
  id: true,
  userId: true,
  workDate: true,
  checkInAt: true,
  checkOutAt: true,
  status: true,
  workedMinutes: true,
  lateMinutes: true,
  source: true,
  enteredAt: true,
  note: true,
  user: { select: { fullName: true, email: true, employeeCode: true } },
  enteredBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.AttendanceRecordSelect;

type AttendanceEntryRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof ATTENDANCE_ENTRY_SELECT;
}>;

/**
 * A manual record has no location, and says so.
 *
 * `checkInLatitude` / `checkInLongitude` / `checkInAccuracyM` are `NOT NULL` —
 * they were designed for a punch, which always has a fix. A hand-entered day has
 * none, and the honest encoding is the one the contract already treats as
 * synthetic: `accuracySchema` refuses an accuracy of zero on a punch precisely
 * because "a real GNSS fix always carries a non-zero error estimate, so `0`
 * signals a spoofed or synthesised location payload". That is exactly what this
 * row is. Fabricating the office's coordinates instead would put a location an
 * auditor could mistake for evidence onto a record nobody was measured for.
 *
 * `checkInSiteId` and `checkInDistanceM` stay null, so the report's
 * `outOfRange` flag — which needs both a site and a distance — never fires on a
 * manual row.
 */
const NO_LOCATION = {
  latitude: 0,
  longitude: 0,
  accuracyM: 0,
} as const;

/**
 * The wall clocks a create or a correction may carry.
 *
 * Every field is optional because a correction may move one end of the shift and
 * leave the other exactly where the record already had it — down to the second,
 * which re-sending an `HH:mm` could not preserve.
 */
interface ShiftInput {
  checkInTime?: string | undefined;
  /** `null` clears the check-out and reopens the day. */
  checkOutTime?: string | null | undefined;
  checkOutNextDay?: boolean | undefined;
}

/** The shift a request describes, once its wall clocks have been resolved to instants. */
interface ResolvedShift {
  checkInAt: Date;
  checkOutAt: Date | null;
}

/** The three stored columns that are computed rather than typed in. */
interface DerivedTotals {
  status: AttendanceStatus;
  lateMinutes: number;
  workedMinutes: number | null;
}

@Injectable()
export class AdminAttendanceEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly clock: ClockService,
  ) {}

  /**
   * A window of the tenant's attendance, newest first.
   *
   * Ordered by work date descending, which is how an administrator scans for the
   * day they came to fix. `userId` breaks the tie so paging is stable — the
   * unique index makes `(workDate, userId)` a total order.
   */
  async list(
    auth: AuthContext,
    query: ListAttendanceEntriesQuery,
  ): Promise<Paginated<AttendanceEntryDto>> {
    const where: Prisma.AttendanceRecordWhereInput = {
      organizationId: auth.organizationId,
      workDate: { gte: fromIsoDate(query.from), lte: fromIsoDate(query.to) },
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.source === undefined ? {} : { source: query.source }),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.count({ where }),
      this.prisma.attendanceRecord.findMany({
        where,
        select: ATTENDANCE_ENTRY_SELECT,
        orderBy: [{ workDate: 'desc' }, { userId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map(toAttendanceEntryDto),
      meta: buildPageMeta(query.page, query.pageSize, total),
    };
  }

  /**
   * Records a day by hand.
   *
   * The unique index on `(userId, workDate)` is the arbiter for a date that
   * already has a record — checked at the database rather than read first, both
   * because a read-then-write loses the race against the employee's own check-in
   * and because the constraint is the only thing that cannot be wrong.
   */
  async create(
    auth: AuthContext,
    body: CreateAttendanceEntryRequest,
    client: ClientInfo,
  ): Promise<AttendanceEntryDto> {
    const now = this.clock.now();
    const organization = await this.loadPolicy(auth.organizationId);
    const target = await this.requireEmployee(auth, body.userId);

    const shift = this.resolveShift(organization, body.workDate, body, now);
    const derived = this.derive(organization, body.workDate, shift);

    let created: AttendanceEntryRow;
    try {
      created = await this.prisma.attendanceRecord.create({
        data: {
          organizationId: auth.organizationId,
          userId: target.id,
          workDate: workDateToColumn(body.workDate),
          checkInAt: shift.checkInAt,
          checkInSiteId: null,
          checkInLatitude: NO_LOCATION.latitude,
          checkInLongitude: NO_LOCATION.longitude,
          checkInAccuracyM: NO_LOCATION.accuracyM,
          checkInDistanceM: null,
          ...(shift.checkOutAt === null
            ? {}
            : {
                checkOutAt: shift.checkOutAt,
                checkOutSiteId: null,
                checkOutLatitude: NO_LOCATION.latitude,
                checkOutLongitude: NO_LOCATION.longitude,
                checkOutAccuracyM: NO_LOCATION.accuracyM,
                checkOutDistanceM: null,
              }),
          source: AttendanceSource.MANUAL,
          enteredById: auth.userId,
          enteredAt: now,
          note: body.note,
          ...derived,
        },
        select: ATTENDANCE_ENTRY_SELECT,
      });
    } catch (error) {
      // The complete field set, never a partial one: `isUniqueViolation` matches
      // by the whole constraint, and a partial target would also catch an
      // unrelated index on this table and report the wrong thing.
      if (!isUniqueViolation(error, ['userId', 'workDate'])) throw error;
      throw duplicateWorkDate(body.workDate);
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.ATTENDANCE_ENTRY_CREATED,
      entityType: AdminAuditEntity.ATTENDANCE_RECORD,
      entityId: created.id,
      metadata: {
        userId: target.id,
        workDate: body.workDate,
        checkInAt: auditInstant(shift.checkInAt),
        checkOutAt: auditInstant(shift.checkOutAt),
        lateMinutes: derived.lateMinutes,
        note: body.note,
      },
      client,
    });

    return toAttendanceEntryDto(created);
  }

  /**
   * Corrects a day.
   *
   * Works on a punched record as readily as on a hand-entered one — that is the
   * entire point, since "Ahmed forgot to check out on Tuesday" is a punch — and
   * flips `source` to `MANUAL` when it does. The row is no longer purely the
   * employee's own account of their day, and a sheet that still called it a
   * punch would be lying by omission. The flip is unconditional: reaching this
   * endpoint *is* an administrative edit, so there is no "it was only the note"
   * exception to get wrong, and none to argue about afterwards.
   *
   * The employee's original coordinates and accuracy are deliberately left
   * alone. They record where a punch was taken and are evidence; erasing them
   * because the times were corrected would destroy the only trace of what
   * actually happened. `source: MANUAL` is what tells a reader those fields no
   * longer all describe one event.
   */
  async update(
    auth: AuthContext,
    id: string,
    body: UpdateAttendanceEntryRequest,
    client: ClientInfo,
  ): Promise<AttendanceEntryDto> {
    const now = this.clock.now();
    const organization = await this.loadPolicy(auth.organizationId);
    const existing = await this.requireRecord(auth, id);
    const workDate = workDateFromColumn(existing.workDate);

    const shift = this.resolveShift(organization, workDate, body, now, existing);
    const derived = this.derive(organization, workDate, shift);

    const updated = await this.prisma.attendanceRecord.update({
      where: { id: existing.id, organizationId: auth.organizationId },
      data: {
        checkInAt: shift.checkInAt,
        checkOutAt: shift.checkOutAt,
        // A cleared check-out must take its whole half of the record with it,
        // or the row keeps last week's coordinates against a day that is now
        // open — and the report would render a check-out site for a shift that
        // has no check-out.
        ...(shift.checkOutAt === null
          ? {
              checkOutSiteId: null,
              checkOutLatitude: null,
              checkOutLongitude: null,
              checkOutAccuracyM: null,
              checkOutDistanceM: null,
            }
          : {}),
        source: AttendanceSource.MANUAL,
        enteredById: auth.userId,
        enteredAt: now,
        note: body.note,
        ...derived,
      },
      select: ATTENDANCE_ENTRY_SELECT,
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.ATTENDANCE_ENTRY_UPDATED,
      entityType: AdminAuditEntity.ATTENDANCE_RECORD,
      entityId: existing.id,
      metadata: {
        userId: existing.userId,
        workDate,
        // What the row said before this edit. Without it the trail records that
        // a correction happened but not what it corrected, which is the only
        // thing anyone reviewing it wants to know.
        previousSource: existing.source,
        previousCheckInAt: auditInstant(existing.checkInAt),
        previousCheckOutAt: auditInstant(existing.checkOutAt),
        checkInAt: auditInstant(shift.checkInAt),
        checkOutAt: auditInstant(shift.checkOutAt),
        lateMinutes: derived.lateMinutes,
        note: body.note,
      },
      client,
    });

    return toAttendanceEntryDto(updated);
  }

  /**
   * Removes a day.
   *
   * A hard delete, and the only destructive verb in the module: unlike a site or
   * a user, an attendance record has nothing referring to it, so there is no
   * history to preserve by keeping the row — and a soft-deleted record would
   * still occupy `(userId, workDate)`, permanently blocking the employee from
   * ever punching that day again.
   *
   * The audit row carries the whole record, so what was deleted is recoverable
   * from the trail. Punched records are removable too: a duplicate or plainly
   * wrong day has to be fixable, and the safeguard that matters is that the
   * removal itself cannot be hidden.
   */
  async remove(auth: AuthContext, id: string, client: ClientInfo): Promise<void> {
    const existing = await this.requireRecord(auth, id);

    await this.prisma.attendanceRecord.delete({
      where: { id: existing.id, organizationId: auth.organizationId },
      select: { id: true },
    });

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.ATTENDANCE_ENTRY_DELETED,
      entityType: AdminAuditEntity.ATTENDANCE_RECORD,
      entityId: existing.id,
      metadata: {
        userId: existing.userId,
        workDate: workDateFromColumn(existing.workDate),
        source: existing.source,
        checkInAt: auditInstant(existing.checkInAt),
        checkOutAt: auditInstant(existing.checkOutAt),
        lateMinutes: existing.lateMinutes,
        note: existing.note ?? '',
      },
      client,
    });
  }

  /**
   * Wall clocks → instants, then every rule that needs a timezone or a clock.
   *
   * `existing` is supplied on a correction: an omitted field keeps whatever the
   * record already held, so a patch that only moves the check-in cannot
   * accidentally restate the check-out a minute off its stored value.
   */
  private resolveShift(
    organization: OrganizationPolicy,
    workDate: string,
    body: ShiftInput,
    now: Date,
    existing?: AttendanceEntryRow,
  ): ResolvedShift {
    this.assertNotFuture(organization, workDate, now);

    const checkInAt =
      body.checkInTime === undefined
        ? requireExisting(existing).checkInAt
        : // The occurrence of that wall clock which falls inside the business
          // day `workDate`. This is `workdayStartInstant` doing exactly the job
          // it was written for — resolving a wall-clock time into a business day
          // whose boundary the tenant chose — with the check-in time in place of
          // the workday start. Reimplementing the two-candidate search here
          // would be the second opinion this module exists to avoid.
          workdayStartInstant({
            workDate,
            timezone: organization.timezone,
            workdayStart: body.checkInTime,
            dayStartsAt: organization.dayStartsAt,
          });

    const checkOutAt =
      body.checkOutTime === undefined
        ? (existing?.checkOutAt ?? null)
        : body.checkOutTime === null
          ? null
          : // Anchored on the check-in's *calendar* date, because that is what
            // "the next day" means to the person filling in the timesheet. A
            // business date would be the wrong anchor here: for a night-shift
            // tenant the check-in and the check-out share one business date
            // while sitting on two calendar dates, which is the exact case the
            // flag exists to express.
            wallClockInstant(
              shiftWorkDate(
                workDateIn(checkInAt, organization.timezone),
                body.checkOutNextDay === true ? 1 : 0,
              ),
              body.checkOutTime,
              organization.timezone,
            );

    const shift: ResolvedShift = { checkInAt, checkOutAt };
    this.assertShiftIsPossible(organization, workDate, shift, now);
    return shift;
  }

  /**
   * A record may not describe a day that has not happened.
   *
   * This is the rule the whole feature turns on. Every other guard here stops an
   * administrator getting a *past* day wrong; this one stops them recording a
   * *future* day at all, and a future day cannot be a correction of anything —
   * there is nothing yet to correct. It would also collide with the employee's
   * own check-in when the day arrives, because `(userId, workDate)` is unique:
   * a pre-filled tomorrow locks somebody out of punching their own shift.
   *
   * Today is allowed, because a same-day repair is ordinary — a dead phone at
   * 08:00, fixed at 10:00 — but the instants are still held to the server clock,
   * so a 17:00 check-out cannot be typed at 10:00.
   */
  private assertNotFuture(organization: OrganizationPolicy, workDate: string, now: Date): void {
    const today = businessDateIn(now, organization.timezone, organization.dayStartsAt);
    if (workDate > today) {
      throw Errors.validation([
        {
          path: 'workDate',
          message: `Attendance cannot be recorded for a future date. Today is ${today} in ${organization.timezone}.`,
        },
      ]);
    }
  }

  /** Every bound on a shift's shape, using the attendance module's own constants. */
  private assertShiftIsPossible(
    organization: OrganizationPolicy,
    workDate: string,
    shift: ResolvedShift,
    now: Date,
  ): void {
    const details: ErrorDetail[] = [];
    if (shift.checkInAt.getTime() > now.getTime()) {
      details.push({ path: 'checkInTime', message: 'Check-in cannot be in the future.' });
    }
    if (shift.checkOutAt !== null && shift.checkOutAt.getTime() > now.getTime()) {
      details.push({ path: 'checkOutTime', message: 'Check-out cannot be in the future.' });
    }
    if (details.length > 0) throw Errors.validation(details);

    if (shift.checkOutAt === null) return;
    const span = shift.checkOutAt.getTime() - shift.checkInAt.getTime();

    // One check for the whole lower bound, against the attendance module's own
    // constant. Measured in milliseconds rather than through `minutesBetween`,
    // which rounds — a forty-second shift would round *up* to one minute and
    // slip past a check on the rounded value. It catches a negative span too,
    // which is not merely defensive: on a spring-forward morning the requested
    // wall clock may not exist and Luxon resolves the gap forward, so a 02:30 →
    // 03:00 pair can come back inverted. Both are the same refusal — this is not
    // a shift — and both get the code the punch path already uses for a
    // zero-minute day.
    if (span < MIN_SHIFT_MS) {
      throw Errors.conflict(
        ErrorCode.SHIFT_TOO_SHORT,
        `A shift must be at least ${MIN_SHIFT_MINUTES} minute long.`,
      );
    }

    // The carry-over window, applied under exactly the condition the punch path
    // applies it: only when the check-out lands outside the business day the
    // record is filed under. A shift that begins and ends inside one business
    // day is already bounded by the day itself, and imposing 18 hours on it here
    // would make a manual correction stricter than the punch it corrects.
    const closesOnAnotherDay =
      businessDateIn(shift.checkOutAt, organization.timezone, organization.dayStartsAt) !==
      workDate;
    if (closesOnAnotherDay && span > MAX_CARRY_OVER_SHIFT_MS) {
      throw Errors.validation([
        {
          path: 'checkOutTime',
          message:
            `A shift closing on a later day may run at most ` +
            `${MAX_CARRY_OVER_SHIFT_HOURS} hours, the same window a real check-out is given.`,
        },
      ]);
    }
  }

  /**
   * Work date, lateness, worked minutes and status — every one of them from the
   * helper a punch uses, so a hand-entered 08:47 scores exactly what a punch at
   * 08:47 would have scored.
   */
  private derive(
    organization: OrganizationPolicy,
    workDate: string,
    shift: ResolvedShift,
  ): DerivedTotals {
    const lateMinutes = lateMinutesFor({
      checkInAt: shift.checkInAt,
      workDate,
      timezone: organization.timezone,
      workdayStart: organization.workdayStart,
      dayStartsAt: organization.dayStartsAt,
      graceMinutes: organization.lateGraceMinutes,
    });

    return {
      lateMinutes,
      workedMinutes:
        shift.checkOutAt === null ? null : minutesBetween(shift.checkInAt, shift.checkOutAt),
      status: statusFor(shift.checkOutAt, lateMinutes),
    };
  }

  /**
   * The employee the record is for, constrained to the caller's tenant.
   *
   * `organizationId` comes from the access token, never from the body, so a
   * `userId` belonging to another tenant is simply not found — a 404 rather than
   * a 403, which is also what keeps the endpoint from confirming that an id
   * exists somewhere else.
   */
  private async requireEmployee(auth: AuthContext, userId: string): Promise<{ id: string }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw Errors.notFound('User');
    return user;
  }

  /** The record, constrained to the caller's tenant. Same reasoning as above. */
  private async requireRecord(auth: AuthContext, id: string): Promise<AttendanceEntryRow> {
    const record = await this.prisma.attendanceRecord.findFirst({
      where: { id, organizationId: auth.organizationId },
      select: ATTENDANCE_ENTRY_SELECT,
    });
    if (!record) throw Errors.notFound('Attendance record');
    return record;
  }

  private async loadPolicy(organizationId: string): Promise<OrganizationPolicy> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: ORGANIZATION_POLICY_SELECT,
    });
    // Unreachable while the principal exists — deleting an organization cascades
    // to its users, so the guard would have refused the request first.
    if (!organization) {
      throw Errors.unauthenticated(ErrorCode.SESSION_REVOKED, 'This session is no longer valid');
    }
    return organization;
  }
}

/**
 * A nullable instant, as audit metadata.
 *
 * The empty string marks "there was none" rather than the key being omitted.
 * `metadata` is a JSON column that auditors query with path expressions, and a
 * key that is sometimes absent makes a missing `checkOutAt` mean both "the day
 * was left open" and "the writer that made this row did not record it".
 *
 * Worked minutes are deliberately absent from every one of these rows: they are
 * the rounded difference of the two instants above, both of which are here, so
 * storing them would be a second copy of a derived number that could disagree
 * with the record it describes.
 */
function auditInstant(value: Date | null): string {
  return value?.toISOString() ?? '';
}

/**
 * A record already exists for that person on that day.
 *
 * Named rather than inlined so the create path has exactly one answer to the
 * unique violation, and so the message names the date — "there is already a
 * record" without saying which day is a support ticket.
 */
function duplicateWorkDate(workDate: string): AppException {
  return Errors.conflict(
    ErrorCode.CONFLICT,
    `This employee already has a record for ${workDate}. Edit that record instead of adding a second one.`,
  );
}

/**
 * Guards the one call shape that cannot happen: a create request always carries
 * `checkInTime`, and a correction always supplies the record it is correcting.
 * Throwing rather than defaulting keeps a future caller from silently storing a
 * check-in of "now".
 */
function requireExisting(existing: AttendanceEntryRow | undefined): AttendanceEntryRow {
  if (existing === undefined) {
    throw new TypeError('A check-in time is required when there is no record to correct');
  }
  return existing;
}

/** Row → contract DTO. The only shape that leaves this service. */
function toAttendanceEntryDto(row: AttendanceEntryRow): AttendanceEntryDto {
  return {
    id: row.id,
    userId: row.userId,
    userFullName: row.user.fullName,
    userEmail: row.user.email,
    employeeCode: row.user.employeeCode,
    workDate: workDateFromColumn(row.workDate),
    checkInAt: row.checkInAt.toISOString(),
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    status: row.status,
    workedMinutes: row.workedMinutes,
    lateMinutes: row.lateMinutes,
    source: row.source,
    enteredBy:
      row.enteredBy === null ? null : { id: row.enteredBy.id, fullName: row.enteredBy.fullName },
    enteredAt: row.enteredAt?.toISOString() ?? null,
    note: row.note,
  };
}
