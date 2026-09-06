import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AttendanceStatus,
  buildPageMeta,
  type AttendanceReportQuery,
  type ReportSummary,
} from '@wasel/contracts';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Errors } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminAuditAction, EXPORT_BATCH_SIZE } from './admin.constants.js';
import { REPORT_RECORD_SELECT, toReportRow, type ReportRecord } from './admin.mapper.js';
import type { AttendanceReport } from './admin.schemas.js';
import { fromIsoDate } from './admin.time.js';

/** An inclusive range of local calendar dates, optionally narrowed to one employee. */
export interface ReportRange {
  from: string;
  to: string;
  userId?: string | undefined;
}

/** What an export needs to know about the tenant it is rendering. */
export interface ReportContext {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  timezone: string;
}

/** One recorded move of the tenant's IANA timezone. */
export interface TimezoneChange {
  /** When the administrator saved it. */
  at: Date;
  /** The zone that was in force until this instant. */
  from: string;
  /** The zone that took over. */
  to: string;
}

/** Keyset position: `(workDate, userId)` is unique, so it fully orders the table. */
interface Cursor {
  workDate: Date;
  userId: string;
}

/**
 * How far before the range's first day a timezone change still counts as
 * happening "during or after" these records.
 *
 * `from` is a local calendar date, and `fromIsoDate` materialises it as midnight
 * **UTC**; the first punch that could carry that `workDate` happened at local
 * midnight, which is up to 14 hours earlier in UTC+14 (and `dayStartsAt` can pull
 * it earlier still). A full day of slack covers every zone with room to spare.
 *
 * The slack deliberately errs toward annotating. A note that over-warns because
 * the zone moved a few hours before the range began costs the reader one
 * sentence; a missed change is the self-contradictory sheet this exists to
 * prevent.
 */
const TIMEZONE_WINDOW_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * The most changes an export will enumerate in its summary.
 *
 * A ceiling on the query, not on the warning: the annotation fires on the
 * existence of any change, so a tenant that somehow moved zones more times than
 * this is still warned — it simply gets the earliest ones listed, which are the
 * ones that bear on the oldest rows in the file.
 */
const MAX_LISTED_TIMEZONE_CHANGES = 25;

@Injectable()
export class AdminReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of the report, plus totals for the **whole** filtered range.
   *
   * The summary deliberately ignores pagination: "37 late this month" is the
   * number an administrator came for, and computing it from the visible page
   * would make it change as they clicked through.
   *
   * Three statements, batched into one transaction so the page and its totals
   * describe the same snapshot. The count is *constant in the page size* — the
   * employee and both site names arrive through the relation selection rather
   * than through a query per row, which is the N+1 this endpoint would otherwise
   * be a textbook example of.
   */
  async page(auth: AuthContext, query: AttendanceReportQuery): Promise<AttendanceReport> {
    const where = this.filter(auth, query);

    const { rows, byStatus, distinctUsers } = await this.prisma.$transaction(async (tx) => {
      const page = await tx.attendanceRecord.findMany({
        where,
        select: REPORT_RECORD_SELECT,
        // Newest first for a screen. The export orders the other way — see
        // `streamRecords` — because a sheet is read forwards.
        orderBy: [{ workDate: 'desc' }, { userId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });

      const groups = await tx.attendanceRecord.groupBy({
        by: ['status'],
        where,
        orderBy: { status: 'asc' },
        _count: { _all: true },
        _sum: { workedMinutes: true },
      });

      // Bounded by the number of employees, not by the number of records: at
      // most one row per distinct `userId`. A `COUNT(DISTINCT …)` would return
      // one value instead of a few hundred, but it would mean restating this
      // filter in raw SQL — and a tenancy predicate that exists in two places is
      // a tenancy predicate that will eventually exist in one.
      const users = await tx.attendanceRecord.groupBy({
        by: ['userId'],
        where,
        orderBy: { userId: 'asc' },
      });

      return { rows: page, byStatus: groups, distinctUsers: users.length };
    });

    const summary = summarize(byStatus, distinctUsers);

    return {
      data: rows.map((row) => toReportRow(row)),
      meta: buildPageMeta(query.page, query.pageSize, summary.totalRecords),
      summary,
    };
  }

  /**
   * Every record in the range, in batches, oldest first.
   *
   * Keyset pagination rather than `skip`/`take`: `OFFSET n` makes Postgres walk
   * and discard the first *n* rows on every batch, so exporting a year turns into
   * a quadratic scan. `(workDate, userId)` is a unique index, so it is a total
   * order and the cursor cannot skip or repeat a row even while the table is
   * being written to underneath the export.
   *
   * The generator is what keeps the endpoint's memory flat: the caller writes
   * each batch to the socket and lets it go, so a 100k-row export costs the same
   * resident set as a 10-row one.
   */
  async *streamRecords(
    auth: AuthContext,
    range: ReportRange,
    batchSize = EXPORT_BATCH_SIZE,
  ): AsyncGenerator<ReportRecord[], void> {
    const base = this.filter(auth, range);
    let cursor: Cursor | null = null;

    for (;;) {
      const batch: ReportRecord[] = await this.prisma.attendanceRecord.findMany({
        where: cursor === null ? base : { ...base, ...keysetAfter(cursor) },
        select: REPORT_RECORD_SELECT,
        orderBy: [{ workDate: 'asc' }, { userId: 'asc' }],
        take: batchSize,
      });

      if (batch.length === 0) return;
      yield batch;
      if (batch.length < batchSize) return;

      const last = batch[batch.length - 1];
      if (last === undefined) return;
      cursor = { workDate: last.workDate, userId: last.userId };
    }
  }

  /**
   * How many records the range holds, without reading any of them.
   *
   * One aggregate over the same predicate {@link streamRecords} uses, so the
   * answer is the count of exactly the rows the export would emit. The XLSX path
   * asks before it starts, because a worksheet's row ceiling is a property of the
   * file format and exceeding it produces a download nothing can open.
   */
  countRecords(auth: AuthContext, range: ReportRange): Promise<number> {
    return this.prisma.attendanceRecord.count({ where: this.filter(auth, range) });
  }

  /**
   * Timezone moves recorded on or after the first day of `from`, oldest first.
   *
   * This is what lets an export tell its reader something the file otherwise
   * cannot say. `workDate` is frozen at punch time and never restated, but every
   * *instant* in the sheet — check-in, check-out, "generated at" — is rendered in
   * the tenant's **current** zone. After a move those two disagree, so a March
   * sheet re-exported in June can show `Work date 2026-03-02` beside
   * `Check-in 2026-03-01 17:30`. Nothing is corrupt and nothing was rewritten;
   * the file is simply describing March in June's zone, and a payroll reader
   * comparing it against the copy they were paid from deserves to be told rather
   * than left to discover it.
   *
   * A change recorded *before* the range began is irrelevant — every row in the
   * range was written under the current zone — which is why this is anchored on
   * `from` rather than fetching the whole history.
   */
  async timezoneChangesSince(auth: AuthContext, from: string): Promise<TimezoneChange[]> {
    const since = new Date(fromIsoDate(from).getTime() - TIMEZONE_WINDOW_SLACK_MS);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: auth.organizationId,
        action: AdminAuditAction.ORGANIZATION_TIMEZONE_CHANGED,
        createdAt: { gte: since },
      },
      select: { createdAt: true, metadata: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_LISTED_TIMEZONE_CHANGES,
    });

    return rows.map(toTimezoneChange).filter((change): change is TimezoneChange => change !== null);
  }

  async context(auth: AuthContext): Promise<ReportContext> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { name: true, slug: true, timezone: true },
    });
    if (!organization) throw Errors.notFound('Organization');

    return {
      organizationId: auth.organizationId,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      timezone: organization.timezone,
    };
  }

  /**
   * The one place the report's tenancy and range predicate is written.
   *
   * `organizationId` comes from the access token, never from the query string.
   * `userId` narrows *within* that tenant, so passing another tenant's user id
   * yields an empty report rather than their attendance.
   */
  private filter(auth: AuthContext, range: ReportRange): Prisma.AttendanceRecordWhereInput {
    return {
      organizationId: auth.organizationId,
      workDate: { gte: fromIsoDate(range.from), lte: fromIsoDate(range.to) },
      ...(range.userId === undefined ? {} : { userId: range.userId }),
    };
  }
}

/**
 * An audit row → a {@link TimezoneChange}, or `null` if it does not carry one.
 *
 * `metadata` is `Json`, so it is `unknown` until proven otherwise. A row whose
 * shape does not match is skipped rather than throwing: an export must not fail
 * because a historical audit row was written by an older version of the writer.
 */
function toTimezoneChange(row: { createdAt: Date; metadata: unknown }): TimezoneChange | null {
  const metadata = row.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;

  const fields = metadata as Record<string, unknown>;
  const from = fields['previousTimezone'];
  const to = fields['timezone'];
  if (typeof from !== 'string' || typeof to !== 'string') return null;

  return { at: row.createdAt, from, to };
}

/** `(workDate, userId) > (cursor.workDate, cursor.userId)`, as Prisma spells it. */
function keysetAfter(cursor: Cursor): Prisma.AttendanceRecordWhereInput {
  return {
    OR: [
      { workDate: { gt: cursor.workDate } },
      { workDate: cursor.workDate, userId: { gt: cursor.userId } },
    ],
  };
}

type StatusGroup = {
  status: AttendanceStatus;
  _count: { _all: number };
  _sum: { workedMinutes: number | null };
};

/**
 * Folds the per-status aggregate into the contract's summary.
 *
 * Pure, so the arithmetic — including "a record with no check-out contributes
 * zero worked minutes, not `null`" — is unit-testable without a database.
 */
export function summarize(groups: readonly StatusGroup[], distinctUsers: number): ReportSummary {
  const countOf = (status: AttendanceStatus): number =>
    groups.find((group) => group.status === status)?._count._all ?? 0;

  return {
    totalRecords: groups.reduce((total, group) => total + group._count._all, 0),
    presentCount: countOf(AttendanceStatus.PRESENT),
    lateCount: countOf(AttendanceStatus.LATE),
    incompleteCount: countOf(AttendanceStatus.INCOMPLETE),
    distinctUsers,
    totalWorkedMinutes: groups.reduce((total, group) => total + (group._sum.workedMinutes ?? 0), 0),
  };
}
