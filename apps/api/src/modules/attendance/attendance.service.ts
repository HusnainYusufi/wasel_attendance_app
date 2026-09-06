import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  MIN_SHIFT_MINUTES,
  PunchOutcome,
  PunchType,
  buildPageMeta,
  findNearestSite,
  formatDistance,
  type AttendanceHistoryQuery,
  type AttendanceRecordDto,
  type AttendanceStatusDto,
  type GeofenceMatch,
  type Paginated,
  type PunchRequest,
  type PunchResponse,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import { Errors, type AppException } from '../../common/errors/app.exception.js';
import { isUniqueViolation } from '../../prisma/prisma-errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { AttendanceEventService, type PunchAttempt } from './attendance-event.service.js';
import { MAX_CARRY_OVER_SHIFT_MS, MIN_SHIFT_MS, storedMeters } from './attendance.constants.js';
import {
  ATTENDANCE_RECORD_INCLUDE,
  GEOFENCE_SITE_SELECT,
  statusFor,
  toAttendanceRecordDto,
  toGeofenceSite,
  toSiteSummary,
  type AttendanceRecordRow,
  type GeofenceSiteRow,
} from './attendance.mapper.js';
import {
  businessDateIn,
  lateMinutesFor,
  minutesBetween,
  parseInstant,
  shiftWorkDate,
  workDateFromColumn,
  workDateToColumn,
} from './work-date.js';

/** The workday policy a punch is judged against. Nothing else about the tenant is read. */
const ORGANIZATION_POLICY_SELECT = {
  timezone: true,
  workdayStart: true,
  dayStartsAt: true,
  lateGraceMinutes: true,
  maxAccuracyMeters: true,
  enforceGeofence: true,
} as const satisfies Prisma.OrganizationSelect;

type OrganizationPolicy = Prisma.OrganizationGetPayload<{
  select: typeof ORGANIZATION_POLICY_SELECT;
}>;

/** An attempt before its outcome is known; the outcome is decided by the gates below. */
type PunchAttemptDraft = Omit<PunchAttempt, 'outcome'>;

/**
 * The two records a punch can possibly concern: today's, and the one a check-out
 * is allowed to close.
 */
interface ResolvedDay {
  /** The record for the current work date, complete or not. */
  today: AttendanceRecordRow | null;
  /** The record a check-out would close now, or null if there is nothing to close. */
  open: AttendanceRecordRow | null;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AttendanceEventService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Everything the home screen needs in one round trip.
   *
   * `canCheckIn` and `canCheckOut` are decided here, by the same resolver the
   * punch endpoints use, so a button can never offer an action the server is
   * about to refuse. A client that computed them from the record itself would
   * get the overnight case wrong in exactly the way the server does not.
   */
  async status(auth: AuthContext): Promise<AttendanceStatusDto> {
    const now = this.clock.now();
    const organization = await this.loadPolicy(auth.organizationId);
    const workDate = businessDateIn(now, organization.timezone, organization.dayStartsAt);

    const [sites, day] = await Promise.all([
      this.loadActiveSites(auth.organizationId),
      this.resolveDay(auth, workDate, now),
    ]);

    // During an overnight shift there is no record for the current work date yet,
    // but there is one the user is still inside. Returning it keeps the response
    // self-consistent — `canCheckOut` is true exactly when `today` is a record
    // with no check-out — and lets the screen say "checked in 23:50 yesterday"
    // instead of showing an enabled button with nothing behind it. The DTO
    // carries its own `workDate`, so nothing is misdated.
    const visible = day.today ?? day.open;

    return {
      serverTime: now.toISOString(),
      timezone: organization.timezone,
      workDate,
      // An open shift closes the check-in button even when it belongs to an
      // earlier business day. Offering both used to be the worst bug on this
      // screen: acting on the check-in the server itself enabled opened a second
      // record, which then made the first one permanently ineligible for the
      // carry-over branch — a night's work stranded as INCOMPLETE beside a
      // fabricated zero-minute day, with no path back.
      canCheckIn: day.today === null && day.open === null,
      // A check-out has to pass the same geofence gate as any other punch, and
      // with no active site there is nothing to measure against: the endpoint
      // would answer 422 NO_ACTIVE_SITE. Promising the action anyway is how a
      // shift ends up unclosable by a button that says it can close it.
      //
      // That reasoning is entirely conditional on the fence being enforced. A
      // tenant that does not enforce one has no gate to fail, so a missing site
      // must not withdraw the action — otherwise switching enforcement off would
      // strand every open shift in an organization with no sites, which is
      // exactly the organization the setting exists for.
      canCheckOut: day.open !== null && (sites.length > 0 || !organization.enforceGeofence),
      today: visible === null ? null : toAttendanceRecordDto(visible),
      sites: sites.map((site) => ({
        id: site.id,
        name: site.name,
        latitude: site.latitude,
        longitude: site.longitude,
        radiusMeters: site.radiusMeters,
      })),
      maxAccuracyMeters: organization.maxAccuracyMeters,
      // So the client knows which mode it is in rather than inferring it from a
      // rejection it has not made yet: with enforcement off the distance panel
      // is a record of where the user is, not a gate they must pass.
      enforceGeofence: organization.enforceGeofence,
    };
  }

  /**
   * Opens the day.
   *
   * The gates run in the order the domain rules define them: accuracy, then a
   * site to measure against, then the fence, then the day's state. Location
   * before state is deliberate — a punch is a claim to be at work, and when that
   * claim is false the audit row should say `REJECTED_OUT_OF_RANGE`, which is the
   * row an auditor is actually looking for, rather than filing the attempt away
   * as a duplicate tap.
   *
   * A tenant with `enforceGeofence: false` runs none of the three location gates
   * and every one of the state gates. See {@link AttendanceService.resolveLocation}.
   */
  async checkIn(
    auth: AuthContext,
    request: PunchRequest,
    client: ClientInfo,
  ): Promise<PunchResponse> {
    const now = this.clock.now();
    const organization = await this.loadPolicy(auth.organizationId);
    const workDate = businessDateIn(now, organization.timezone, organization.dayStartsAt);
    const attempt = await this.draft(auth, request, client, PunchType.CHECK_IN, workDate);

    const match = await this.resolveLocation(attempt, organization);

    // A pre-check purely for the error message: the unique index below is what
    // actually decides, because a check-then-insert loses the double-tap race.
    const day = await this.resolveDay(auth, workDate, now);
    if (day.today !== null) throw await this.rejectDuplicateCheckIn(attempt);
    // A shift opened on an earlier business day and never closed. Opening a
    // second one on top of it would strand the first forever: the carry-over
    // branch is only eligible while the current business day has no record, so
    // creating one here makes yesterday's row permanently unclosable. The
    // employee has to close what is open before starting something new.
    if (day.open !== null) throw await this.rejectShiftStillOpen(attempt);

    const lateMinutes = lateMinutesFor({
      checkInAt: now,
      workDate,
      timezone: organization.timezone,
      workdayStart: organization.workdayStart,
      dayStartsAt: organization.dayStartsAt,
      graceMinutes: organization.lateGraceMinutes,
    });
    const distanceM = match === null ? null : storedMeters(match.distanceM);
    const event = this.events.buildData({ ...attempt, outcome: PunchOutcome.ACCEPTED });

    try {
      // Record and audit row in one transaction: an accepted punch that left no
      // trace, or a trace with no punch, are both worse than a failed request.
      const record = await this.prisma.$transaction(async (tx) => {
        const created = await tx.attendanceRecord.create({
          data: {
            organizationId: auth.organizationId,
            userId: auth.userId,
            workDate: workDateToColumn(workDate),
            checkInAt: now,
            checkInSiteId: match?.site.id ?? null,
            checkInLatitude: request.latitude,
            checkInLongitude: request.longitude,
            checkInAccuracyM: request.accuracy,
            checkInDistanceM: distanceM,
            status: statusFor(null, lateMinutes),
            lateMinutes,
          },
          include: ATTENDANCE_RECORD_INCLUDE,
        });
        await tx.attendanceEvent.create({ data: event });
        return created;
      });

      return {
        outcome: PunchOutcome.ACCEPTED,
        type: PunchType.CHECK_IN,
        record: toAttendanceRecordDto(record),
        site: match === null ? null : toSiteSummary(match.site),
        distanceM,
      };
    } catch (error) {
      // `@@unique([userId, workDate])` is the arbiter for two simultaneous
      // check-ins (CONVENTIONS §2.4). The complete field set is required: a
      // partial match would also catch an unrelated constraint on this table.
      if (!isUniqueViolation(error, ['userId', 'workDate'])) throw error;
      throw await this.rejectDuplicateCheckIn(attempt);
    }
  }

  /**
   * Closes the day.
   *
   * State before location here, and deliberately the other way round from
   * check-in: when there is no open shift at all, answering `OUT_OF_RANGE` would
   * send the user chasing a geofence problem instead of telling them the thing
   * they need to know, which is that they never checked in.
   */
  async checkOut(
    auth: AuthContext,
    request: PunchRequest,
    client: ClientInfo,
  ): Promise<PunchResponse> {
    const now = this.clock.now();
    const organization = await this.loadPolicy(auth.organizationId);
    const workDate = businessDateIn(now, organization.timezone, organization.dayStartsAt);
    const attempt = await this.draft(auth, request, client, PunchType.CHECK_OUT, workDate);

    const day = await this.resolveDay(auth, workDate, now);
    if (day.open === null) {
      // `open === null` with a record present for today can only mean it is
      // already closed; anything else means there is nothing open to close.
      throw day.today === null
        ? await this.rejected(
            attempt,
            PunchOutcome.REJECTED_NOT_CHECKED_IN,
            Errors.conflict(ErrorCode.NOT_CHECKED_IN, 'You are not checked in'),
          )
        : await this.rejectDuplicateCheckOut(attempt);
    }
    const open = day.open;

    // Before the location gates, because this is a statement about the shift
    // rather than about where the device is: a check-out in the same breath as
    // the check-in is a mis-tap, and closing on it stored a zero-minute day as
    // PRESENT — counted by the report exactly like a full one — while locking
    // the employee out of the day they were about to work. Refusing leaves the
    // shift open, which is the only recoverable outcome.
    if (now.getTime() - open.checkInAt.getTime() < MIN_SHIFT_MS) {
      throw await this.rejectShiftTooShort(attempt);
    }

    const match = await this.resolveLocation(attempt, organization);
    const distanceM = match === null ? null : storedMeters(match.distanceM);
    const workedMinutes = minutesBetween(open.checkInAt, now);
    const event = this.events.buildData({ ...attempt, outcome: PunchOutcome.ACCEPTED });

    const record = await this.prisma.$transaction(async (tx) => {
      // `checkOutAt: null` in the filter is the arbiter for two simultaneous
      // check-outs: Postgres serialises the row, so exactly one update matches.
      const claimed = await tx.attendanceRecord.updateMany({
        where: {
          id: open.id,
          userId: auth.userId,
          organizationId: auth.organizationId,
          checkOutAt: null,
        },
        data: {
          checkOutAt: now,
          checkOutSiteId: match?.site.id ?? null,
          checkOutLatitude: request.latitude,
          checkOutLongitude: request.longitude,
          checkOutAccuracyM: request.accuracy,
          checkOutDistanceM: distanceM,
          workedMinutes,
          status: statusFor(now, open.lateMinutes),
        },
      });
      if (claimed.count === 0) return null;

      await tx.attendanceEvent.create({ data: event });
      return tx.attendanceRecord.findUniqueOrThrow({
        where: { id: open.id },
        include: ATTENDANCE_RECORD_INCLUDE,
      });
    });

    if (record === null) throw await this.rejectDuplicateCheckOut(attempt);

    return {
      outcome: PunchOutcome.ACCEPTED,
      type: PunchType.CHECK_OUT,
      record: toAttendanceRecordDto(record),
      site: match === null ? null : toSiteSummary(match.site),
      distanceM,
    };
  }

  /**
   * The caller's own attendance, newest first.
   *
   * Scoped to `userId` **and** `organizationId`, both taken from the token. The
   * user filter alone would already be enough today, but the tenant filter is
   * what keeps it correct if a row is ever reachable by another path — and
   * CONVENTIONS §2.1 asks for it on every query against a tenant table.
   */
  async history(
    auth: AuthContext,
    query: AttendanceHistoryQuery,
  ): Promise<Paginated<AttendanceRecordDto>> {
    const workDateFilter = {
      ...(query.from === undefined ? {} : { gte: workDateToColumn(query.from) }),
      ...(query.to === undefined ? {} : { lte: workDateToColumn(query.to) }),
    };

    const where: Prisma.AttendanceRecordWhereInput = {
      userId: auth.userId,
      organizationId: auth.organizationId,
      ...(Object.keys(workDateFilter).length === 0 ? {} : { workDate: workDateFilter }),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.count({ where }),
      this.prisma.attendanceRecord.findMany({
        where,
        include: ATTENDANCE_RECORD_INCLUDE,
        // `checkInAt` breaks a tie only in theory — one row per day is enforced —
        // but it keeps the order total, so a page boundary cannot shuffle.
        orderBy: [{ workDate: 'desc' }, { checkInAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map(toAttendanceRecordDto),
      meta: buildPageMeta(query.page, query.pageSize, total),
    };
  }

  /** Assembles the audit shape once, so every branch below files the same evidence. */
  private async draft(
    auth: AuthContext,
    request: PunchRequest,
    client: ClientInfo,
    type: PunchType,
    workDate: string,
  ): Promise<PunchAttemptDraft> {
    const sites = await this.loadActiveSites(auth.organizationId);
    return {
      auth,
      type,
      workDate,
      latitude: request.latitude,
      longitude: request.longitude,
      accuracyM: request.accuracy,
      // The shared implementation from `@wasel/contracts`, so the distance the
      // client previews and the distance the server enforces cannot disagree.
      nearest: findNearestSite(request, sites.map(toGeofenceSite)),
      deviceTime: parseInstant(request.deviceTime),
      client,
    };
  }

  /**
   * Where the punch happened, and — only for a tenant that enforces a geofence —
   * whether that is somewhere it is allowed to happen.
   *
   * The three gates run in policy order. Accuracy comes first because a fix
   * reading "at the office ± 3 km" proves nothing: without it the geofence is
   * decorative, since any wide-enough error radius can be reported from anywhere
   * in the city.
   *
   * **With `enforceGeofence: false` none of them run**, and the return value
   * becomes what it always described but never had to be — the nearest site and
   * the distance to it, as a *record*. The accuracy gate stands down with the
   * other two rather than surviving on its own: its entire purpose was to stop a
   * wide error radius faking its way inside a fence, and with no fence it only
   * refuses honest punches from someone whose phone reports ±300 m indoors. The
   * accuracy is still written to the record and to the audit event, so nothing
   * an investigator had is lost — it simply stops being a veto.
   *
   * Null comes back only in that mode, and only for a tenant with no active
   * sites at all: there is genuinely nothing to measure from, and inventing a
   * site to point at would be worse than saying so.
   */
  private async resolveLocation(
    attempt: PunchAttemptDraft,
    organization: Pick<OrganizationPolicy, 'enforceGeofence' | 'maxAccuracyMeters'>,
  ): Promise<GeofenceMatch | null> {
    if (!organization.enforceGeofence) return attempt.nearest;

    const maxAccuracyMeters = organization.maxAccuracyMeters;
    if (attempt.accuracyM > maxAccuracyMeters) {
      throw await this.rejected(
        attempt,
        PunchOutcome.REJECTED_LOW_ACCURACY,
        Errors.unprocessable(
          ErrorCode.LOW_GPS_ACCURACY,
          `Your location is only accurate to ${formatDistance(attempt.accuracyM)}, and this ` +
            `organization requires ${formatDistance(maxAccuracyMeters)} or better. Move into ` +
            'the open and try again.',
        ),
      );
    }

    if (attempt.nearest === null) {
      throw await this.rejected(
        attempt,
        PunchOutcome.REJECTED_NO_ACTIVE_SITE,
        Errors.unprocessable(
          ErrorCode.NO_ACTIVE_SITE,
          'Your organization has no active site to punch at. Ask an administrator to add one.',
        ),
      );
    }

    if (!attempt.nearest.withinFence) {
      const { site, distanceM } = attempt.nearest;
      throw await this.rejected(
        attempt,
        PunchOutcome.REJECTED_OUT_OF_RANGE,
        Errors.unprocessable(
          ErrorCode.OUT_OF_RANGE,
          // Naming the site and the distance is the difference between an error a
          // user can act on and one that becomes a support ticket.
          `You are ${formatDistance(distanceM)} from ${site.name}, which accepts punches ` +
            `within ${formatDistance(site.radiusMeters)}.`,
        ),
      );
    }

    return attempt.nearest;
  }

  /**
   * Records the rejection, then hands back the exception for the caller to throw.
   *
   * Returning it rather than throwing keeps `throw await this.rejected(...)` at
   * every call site, which is what makes the audit write impossible to forget:
   * there is no path to one of these errors that does not go through here.
   */
  private async rejected(
    attempt: PunchAttemptDraft,
    outcome: PunchOutcome,
    error: AppException,
  ): Promise<AppException> {
    await this.events.record({ ...attempt, outcome });
    return error;
  }

  private rejectDuplicateCheckIn(attempt: PunchAttemptDraft): Promise<AppException> {
    return this.rejected(
      attempt,
      PunchOutcome.REJECTED_ALREADY_CHECKED_IN,
      Errors.conflict(ErrorCode.ALREADY_CHECKED_IN, 'You are already checked in today'),
    );
  }

  private rejectDuplicateCheckOut(attempt: PunchAttemptDraft): Promise<AppException> {
    return this.rejected(
      attempt,
      PunchOutcome.REJECTED_ALREADY_CHECKED_OUT,
      Errors.conflict(ErrorCode.ALREADY_CHECKED_OUT, 'You have already checked out'),
    );
  }

  private rejectShiftStillOpen(attempt: PunchAttemptDraft): Promise<AppException> {
    return this.rejected(
      attempt,
      PunchOutcome.REJECTED_SHIFT_STILL_OPEN,
      Errors.conflict(
        ErrorCode.SHIFT_STILL_OPEN,
        'Your previous shift is still open. Check out of it before starting a new one.',
      ),
    );
  }

  private rejectShiftTooShort(attempt: PunchAttemptDraft): Promise<AppException> {
    return this.rejected(
      attempt,
      PunchOutcome.REJECTED_SHIFT_TOO_SHORT,
      Errors.conflict(
        ErrorCode.SHIFT_TOO_SHORT,
        `A shift must be at least ${MIN_SHIFT_MINUTES} minute long. You are still checked in.`,
      ),
    );
  }

  /**
   * Which record a punch concerns.
   *
   * **The overnight rule.** A check-out at 00:10 belongs to the shift that began
   * at 23:50, not to a work date the user has not started; dropping it because
   * the calendar rolled over would silently lose a night's work. So when the
   * current work date has no record at all, the previous day's unclosed record is
   * still closable — bounded by {@link MAX_CARRY_OVER_SHIFT_MS} so a punch can
   * never be attached to a shift nobody was working.
   *
   * The "no record today" condition is the other half of the rule: once the user
   * has checked in again, that check-in is itself evidence the previous shift
   * ended, and yesterday's record stays `INCOMPLETE` for an administrator to
   * settle rather than absorbing today's check-out. `checkIn` now refuses to
   * create that second record while a shift is open, so this branch is reached
   * by administrative repair rather than by the employee's own next punch.
   *
   * A tenant that has set `dayStartsAt` outside its shift rarely needs the
   * carry-over at all — 23:50 and 00:10 are the *same* business date there, and
   * the record is found as `today`. The window stays because it is what covers
   * the shift that runs past its own boundary.
   */
  private async resolveDay(auth: AuthContext, workDate: string, now: Date): Promise<ResolvedDay> {
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        userId: auth.userId,
        organizationId: auth.organizationId,
        workDate: {
          in: [workDateToColumn(shiftWorkDate(workDate, -1)), workDateToColumn(workDate)],
        },
      },
      include: ATTENDANCE_RECORD_INCLUDE,
    });

    const today = rows.find((row) => workDateFromColumn(row.workDate) === workDate) ?? null;
    if (today !== null) {
      return { today, open: today.checkOutAt === null ? today : null };
    }

    const carryOver =
      rows.find(
        (row) =>
          row.checkOutAt === null &&
          now.getTime() - row.checkInAt.getTime() <= MAX_CARRY_OVER_SHIFT_MS,
      ) ?? null;

    return { today: null, open: carryOver };
  }

  /**
   * The tenant's workday policy.
   *
   * Keyed by the id from the access token, which the guard has already matched
   * against a live, non-deleted user row — so this is a tenant lookup, not an
   * unscoped `findUnique` on somebody else's identifier.
   */
  private async loadPolicy(organizationId: string): Promise<OrganizationPolicy> {
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

  /** Active, non-deleted sites only: a decommissioned office must stop accepting punches. */
  private loadActiveSites(organizationId: string): Promise<GeofenceSiteRow[]> {
    return this.prisma.site.findMany({
      where: { organizationId, isActive: true, deletedAt: null },
      select: GEOFENCE_SITE_SELECT,
      orderBy: { name: 'asc' },
    });
  }
}
