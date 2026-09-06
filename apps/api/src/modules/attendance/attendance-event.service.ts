import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { GeofenceMatch, PunchOutcome, PunchType } from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { storedMeters } from './attendance.constants.js';
import { workDateToColumn } from './work-date.js';

/**
 * One punch attempt, as an auditor needs to see it.
 *
 * `nearest` is carried even for a rejection that never got as far as the
 * geofence — a low-accuracy fix taken 40 m from the office is a very different
 * story from one taken 40 km away, and the outcome code alone cannot tell them
 * apart.
 */
export interface PunchAttempt {
  auth: AuthContext;
  type: PunchType;
  outcome: PunchOutcome;
  /** The work date the *attempt* happened on, in the organization's timezone. */
  workDate: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  nearest: GeofenceMatch | null;
  /** Client-reported instant, recorded for tamper analysis. Never trusted. */
  deviceTime: Date | null;
  client: ClientInfo;
}

/**
 * Log marker for an audit row that could not be persisted at all.
 *
 * A constant rather than a phrase in the message, because this is the one line
 * in the module that an on-call alert should fire on: it means the attendance
 * event log is missing a row it is supposed to be complete for.
 */
export const ATTENDANCE_AUDIT_DROPPED = 'attendance.audit.dropped';

/** One retry. See {@link AttendanceEventService.record} for why exactly one. */
const AUDIT_WRITE_ATTEMPTS = 2;

/**
 * The append-only log of every punch attempt (CONVENTIONS §2.5).
 *
 * The rejections are the point. A table that records only successful punches
 * cannot answer "did anyone try to check in from home?", which is the first
 * question an auditor asks and the only one the geofence exists to answer.
 */
@Injectable()
export class AttendanceEventService {
  private readonly logger = new Logger(AttendanceEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The row for an attempt, for a caller that will write it inside its own
   * transaction.
   *
   * An **accepted** punch commits its record and its event together, so the
   * database can never hold a check-in with no audit trail — the two either both
   * land or neither does.
   */
  buildData(attempt: PunchAttempt): Prisma.AttendanceEventUncheckedCreateInput {
    return {
      organizationId: attempt.auth.organizationId,
      userId: attempt.auth.userId,
      type: attempt.type,
      outcome: attempt.outcome,
      workDate: workDateToColumn(attempt.workDate),
      latitude: attempt.latitude,
      longitude: attempt.longitude,
      accuracyM: attempt.accuracyM,
      distanceM: attempt.nearest ? storedMeters(attempt.nearest.distanceM) : null,
      siteId: attempt.nearest?.site.id ?? null,
      deviceTime: attempt.deviceTime,
      ipAddress: attempt.client.ipAddress,
      userAgent: attempt.client.userAgent,
    };
  }

  /**
   * Writes the row for a **rejected** attempt, which has no transaction to join.
   *
   * Deliberately never throws, for the same reason `AuditService` does not: the
   * caller is already on its way to a 4xx that the client must see, and turning a
   * failed audit write into a 500 would both hide the real outcome and hand an
   * attacker a way to make punches fail by making the audit table unwritable.
   *
   * That "best effort" is the weak half of CONVENTIONS §2.5. An accepted punch
   * commits its event inside the record's transaction, so it is genuinely
   * atomic; a rejection has no transaction to fail with, and a lost insert used
   * to vanish into a log line indistinguishable from any other. So it is retried
   * once — a transient pool error, a lock timeout, a connection reset mid-write
   * are the realistic failures here, and all three clear on a second attempt from
   * the pool — and only a second failure gives up. That last line carries a
   * stable {@link ATTENDANCE_AUDIT_DROPPED} marker with the whole row, so
   * alerting keys on the event rather than on prose, and so the row an auditor
   * lost can be reconstructed from the log.
   */
  async record(attempt: PunchAttempt): Promise<void> {
    const data = this.buildData(attempt);

    for (let attemptsMade = 1; attemptsMade <= AUDIT_WRITE_ATTEMPTS; attemptsMade += 1) {
      try {
        await this.prisma.attendanceEvent.create({ data });
        return;
      } catch (error) {
        if (attemptsMade < AUDIT_WRITE_ATTEMPTS) {
          this.logger.warn(
            { err: error, userId: attempt.auth.userId, outcome: attempt.outcome },
            'Attendance event write failed; retrying',
          );
          continue;
        }
        this.logger.error(
          { err: error, event: ATTENDANCE_AUDIT_DROPPED, outcome: attempt.outcome, row: data },
          'Failed to write attendance event',
        );
      }
    }
  }
}
