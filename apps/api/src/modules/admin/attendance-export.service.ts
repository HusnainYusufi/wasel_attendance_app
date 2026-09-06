import { Injectable, Logger } from '@nestjs/common';
import { ExportFormat, type ExportQuery } from '@wasel/contracts';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { ClockService } from '../../common/clock/clock.service.js';
import type { ClientInfo } from '../auth/client-context.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminAuditAction, AdminAuditEntity } from './admin.constants.js';
import { AdminReportsService, type ReportRange } from './admin-reports.service.js';
import type { ReportRecord } from './admin.mapper.js';
import {
  contentDisposition,
  EXPORT_CONTENT_TYPE,
  exportFilename,
} from './export/content-disposition.js';
import { createCsvSink } from './export/csv-sink.js';
import { ExportTotals } from './export/export-totals.js';
import {
  ClientDisconnectedError,
  type ExportSink,
  type ExportSinkOptions,
} from './export/export-sink.js';
import { installResponseDeadline } from './export/response-deadline.js';
import { assertXlsxRowLimit, createXlsxSink } from './export/xlsx-sink.js';

/** Re-attaches a batch that was pulled early to probe for failure. */
async function* withFirst(
  first: IteratorResult<ReportRecord[], void>,
  rest: AsyncGenerator<ReportRecord[], void>,
): AsyncGenerator<ReportRecord[], void> {
  if (first.done === true) return;
  yield first.value;
  yield* rest;
}

/** Why a download stopped, as it is recorded in the audit trail. */
const ABORT_REASON = {
  DISCONNECTED: 'client_disconnected',
  /** The client held the connection open without reading — see `response-deadline.ts`. */
  STALLED: 'client_stalled',
  FAILED: 'render_failed',
} as const;

/**
 * `GET /admin/reports/export` — the attendance sheet.
 *
 * The response is streamed rather than assembled: rows arrive from the database
 * in keyset batches, are rendered into the chosen format, and are handed to the
 * socket immediately. Nothing accumulates but the running totals and the set of
 * employee ids they need, so the memory cost of exporting a year is the same as
 * exporting a day. That is not a micro-optimisation — `EXPORT_MAX_RANGE_DAYS`
 * caps the range at 366 *days*, which for a large tenant is six figures of rows,
 * and one buffered download of that size takes the whole API with it.
 *
 * "Handed to the socket immediately" is only true because each sink waits for the
 * socket between batches; a sink that does not is a producer racing a consumer
 * with an unbounded queue in between, which is the same failure wearing a
 * streaming costume. See `export/export-sink.ts`.
 *
 * Memory being bounded says nothing about the *connection*: Node puts no timeout
 * on a response, so a client that opens an export and never reads holds a socket
 * — and an in-flight request a rolling deploy waits on — indefinitely. See
 * `export/response-deadline.ts` for the stall budget and why it is a stall budget
 * rather than a time limit.
 *
 * Three audit rows are possible and exactly one pair is written: the intent,
 * before the first byte, and then either a completion or an abort. A payroll
 * extract that was half-delivered is a fact somebody will need later — who asked
 * for it, over what range, and how much of it they got — and recording it only on
 * success is how that fact goes missing precisely when it matters.
 */
@Injectable()
export class AttendanceExportService {
  private readonly logger = new Logger(AttendanceExportService.name);

  constructor(
    private readonly reports: AdminReportsService,
    private readonly audit: AdminAuditService,
    private readonly clock: ClockService,
  ) {}

  async stream(
    auth: AuthContext,
    query: ExportQuery,
    client: ClientInfo,
    response: Response,
  ): Promise<void> {
    const context = await this.reports.context(auth);
    const range: ReportRange = { from: query.from, to: query.to, userId: query.userId };

    // XLSX only, and before anything else: a worksheet has a hard row ceiling, so
    // a range past it would produce a large download that Excel then refuses to
    // open. Refusing here costs one aggregate over the same predicate and returns
    // an ordinary `ApiErrorBody` that names the remedy.
    if (query.format === ExportFormat.XLSX) {
      assertXlsxRowLimit(await this.reports.countRecords(auth, range));
    }

    // Read before the first byte, because it decides what the header row says.
    // One indexed lookup that returns nothing at all for the overwhelming
    // majority of tenants, which have never changed their timezone.
    const timezoneChanges = await this.reports.timezoneChangesSince(auth, query.from);

    const batches = this.reports.streamRecords(auth, range);

    // The first batch is fetched *before* a single response byte is written. Once
    // the status line is out there is no envelope left to send, so a database
    // failure could only be reported by truncating a download the browser has
    // already begun saving. Failing here instead produces an ordinary
    // `ApiErrorBody`.
    const first = await batches.next();

    const generatedAt = this.clock.now();
    const filename = exportFilename(context.organizationSlug, query.from, query.to, query.format);

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.REPORT_EXPORT_STARTED,
      entityType: AdminAuditEntity.REPORT,
      entityId: null,
      metadata: this.describe(query),
      client,
    });

    response.status(200);
    response.setHeader('Content-Type', EXPORT_CONTENT_TYPE[query.format]);
    response.setHeader('Content-Disposition', contentDisposition(filename));
    // Payroll data. No shared cache, no browser back-forward cache, no disk copy
    // beyond the one the user deliberately saved.
    response.setHeader('Cache-Control', 'no-store');

    const options: ExportSinkOptions = {
      stream: response,
      context,
      range,
      generatedAt,
      timezoneChanges,
    };
    const sink: ExportSink =
      query.format === ExportFormat.CSV ? createCsvSink(options) : createXlsxSink(options);
    const totals = new ExportTotals();

    // Armed only once the response is committed, and disarmed in `finally`. Every
    // failure before this point still has an error envelope to fail into, and a
    // response that is already over needs no deadline.
    const deadline = installResponseDeadline(response, {
      onExpire: () => {
        this.logger.warn(
          { organizationId: auth.organizationId, format: query.format, rows: totals.rowCount },
          'Attendance export closed: the client stopped reading',
        );
      },
    });

    try {
      for await (const batch of withFirst(first, batches)) {
        for (const record of batch) totals.add(record);
        await sink.writeBatch(batch);
        deadline.touch();
      }
      // An empty range still gets here: the sink writes its header row and ends,
      // so the download is a valid, openable file with no data rows rather than a
      // 404 or a zero-byte file Excel reports as corrupt.
      await sink.finish(totals.toSummary());
    } catch (error) {
      await this.recordAbort(auth, query, client, totals, error, deadline.expired);
      // Destroying the socket is the only honest signal left: the client sees a
      // truncated transfer and discards it, rather than saving a short file that
      // looks complete and quietly under-reports somebody's hours. A client that
      // already hung up needs no signal and no cause — its socket is gone, and
      // handing `destroy` an error it will never deliver only invents one.
      response.destroy(
        error instanceof Error && !(error instanceof ClientDisconnectedError) ? error : undefined,
      );
      return;
    } finally {
      deadline.clear();
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.REPORT_EXPORTED,
      entityType: AdminAuditEntity.REPORT,
      entityId: null,
      metadata: { ...this.describe(query), rows: totals.rowCount },
      client,
    });
  }

  /**
   * Logs and audits a download that stopped early.
   *
   * A cancelled download is a warning, not an error: the client changed its mind,
   * nothing is broken, and paging an on-call engineer for it would train them to
   * ignore the channel. A rendering or database failure is the other thing
   * entirely and keeps `error`.
   */
  private async recordAbort(
    auth: AuthContext,
    query: ExportQuery,
    client: ClientInfo,
    totals: ExportTotals,
    error: unknown,
    stalled: boolean,
  ): Promise<void> {
    const disconnected = error instanceof ClientDisconnectedError;
    const details = {
      err: error,
      organizationId: auth.organizationId,
      format: query.format,
      rows: totals.rowCount,
    };

    if (disconnected) {
      this.logger.warn(details, 'Attendance export abandoned by the client');
    } else {
      this.logger.error(details, 'Attendance export failed after the response had started');
    }

    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: AdminAuditAction.REPORT_EXPORT_FAILED,
      entityType: AdminAuditEntity.REPORT,
      entityId: null,
      metadata: {
        ...this.describe(query),
        rows: totals.rowCount,
        // A stalled client reaches the same `catch` as one that hung up — the
        // deadline destroys the socket, which is exactly what an abort looks
        // like from inside the loop — so the two are told apart here rather
        // than guessed at later. They mean different things: the first walked
        // away, the second never read a byte and had to be evicted.
        reason: stalled
          ? ABORT_REASON.STALLED
          : disconnected
            ? ABORT_REASON.DISCONNECTED
            : ABORT_REASON.FAILED,
      },
      client,
    });
  }

  /** The request, as every one of this route's audit rows describes it. */
  private describe(query: ExportQuery): Record<string, string | number | boolean> {
    return {
      format: query.format,
      from: query.from,
      to: query.to,
      singleEmployee: query.userId !== undefined,
    };
  }
}
