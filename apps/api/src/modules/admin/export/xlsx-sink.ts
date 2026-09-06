import type { ReportSummary } from '@wasel/contracts';
import { Errors } from '../../../common/errors/app.exception.js';
import { EXPORT_MAX_XLSX_ROWS } from '../admin.constants.js';
import type { ReportRecord } from '../admin.mapper.js';
import { formatDuration, formatWallClock } from '../admin.time.js';
import { WorkbookWriter, type StreamingWorkbook } from './exceljs.js';
import { EXPORT_COLUMNS, exportHeaders, xlsxCells } from './export-columns.js';
import {
  assertClientPresent,
  awaitBackpressure,
  untilClosed,
  type ExportSink,
  type ExportSinkOptions,
} from './export-sink.js';

const DATA_SHEET = 'Attendance';
const SUMMARY_SHEET = 'Summary';

const HEADER_BACKGROUND = 'FF1F3B57';
const HEADER_TEXT = 'FFFFFFFF';
const HEADER_HEIGHT = 22;

/** Amber, for the one block in the workbook that is a warning rather than a fact. */
const NOTICE_BACKGROUND = 'FFFFE08A';
const NOTICE_TEXT = 'FF4A3200';
/** Tall enough for the wrapped explanation at the summary sheet's column width. */
const NOTICE_HEIGHT = 76;

/**
 * The most rows an XLSX export may carry, as a guard.
 *
 * Exported so the pre-flight check and this writer share one rule: the service
 * refuses an over-large range before the first byte, and the sink refuses to
 * emit a sheet Excel would reject even if the count raced with an insert.
 */
export function assertXlsxRowLimit(rowCount: number): void {
  if (rowCount <= EXPORT_MAX_XLSX_ROWS) return;
  throw Errors.validation([
    {
      path: 'to',
      message:
        `This range contains ${rowCount} records; an XLSX worksheet holds at most ` +
        `${EXPORT_MAX_XLSX_ROWS}. Narrow the range or request format=csv.`,
    },
  ]);
}

/**
 * The XLSX attendance sheet.
 *
 * Built with ExcelJS's **streaming** writer, not `Workbook.xlsx.write`: the
 * buffered API holds every cell as an object and then the whole zip as a
 * `Buffer` before the first byte is sent, so peak memory is a multiple of the
 * export size. `WorkbookWriter` commits each row into the zip stream as it is
 * added rather than keeping the sheet in memory.
 *
 * That is only half of streaming, and the missing half used to be this class's
 * worst bug. ExcelJS writes into its own `StreamBuf`, whose `write()` returns
 * `true` unconditionally and appends to an unbounded array, so nothing about the
 * client's socket ever reached the producer: a throttled download of 36,500
 * records pulled **the entire range** — all 74 keyset batches — within eight
 * seconds while the client had received 330 kB, and six concurrent ones took the
 * process from 137 MB to 447 MB resident. Since XLSX is the default format, that
 * was every browser download. `writeBatch` therefore waits on the *socket* after
 * each batch (see {@link awaitBackpressure}) rather than on anything ExcelJS
 * reports, which is what actually keeps the resident set flat whether the range
 * is one day or the full `EXPORT_MAX_RANGE_DAYS`.
 *
 * The layout is chosen for the person who opens it:
 *
 *  * row 1 is the *only* header, frozen and auto-filtered, so the sheet is a
 *    clean rectangle that Excel, Numbers, Sheets and pandas all read as a table.
 *    A title block above the header would break every one of them;
 *  * dates and times are real date cells with number formats, so sorting is
 *    chronological rather than lexical and a difference between two cells is a
 *    duration;
 *  * the times are the employee's **local wall clock**, and every time column
 *    says so in its header, because the file will be read on a machine in
 *    another timezone sooner or later;
 *  * the totals live on their own sheet, where they cannot be swept up by the
 *    autofilter or mistaken for a record.
 */
class XlsxSink implements ExportSink {
  private readonly workbook: StreamingWorkbook;
  private readonly sheet: ReturnType<StreamingWorkbook['addWorksheet']>;
  private rows = 0;

  constructor(private readonly options: ExportSinkOptions) {
    this.workbook = new WorkbookWriter({
      stream: options.stream,
      useStyles: true,
      // Shared strings would need the whole string table in memory until the
      // workbook closes, which is exactly the buffering this writer avoids.
      useSharedStrings: false,
    });
    this.workbook.creator = 'Wasel Attendance';
    this.workbook.created = options.generatedAt;
    this.workbook.modified = options.generatedAt;

    this.sheet = this.workbook.addWorksheet(DATA_SHEET, {
      // Row 1 stays on screen however far the reader scrolls.
      views: [{ state: 'frozen', ySplit: 1 }],
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        // Repeat the header on every printed page.
        printTitlesRow: '1:1',
      },
    });
    // Assigned rather than passed to `addWorksheet`: ExcelJS accepts it either
    // way at runtime, but only this spelling is in its type definitions.
    this.sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: EXPORT_COLUMNS.length },
    };

    this.sheet.columns = EXPORT_COLUMNS.map((column) => ({
      width: column.width,
      ...(column.numFmt === undefined ? {} : { style: { numFmt: column.numFmt } }),
    }));

    const header = this.sheet.addRow(
      exportHeaders(options.context.timezone, options.timezoneChanges.length > 0),
    );
    header.height = HEADER_HEIGHT;
    header.font = { bold: true, color: { argb: HEADER_TEXT } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BACKGROUND } };
    header.alignment = { vertical: 'middle', horizontal: 'left' };
    header.commit();
  }

  async writeBatch(records: readonly ReportRecord[]): Promise<void> {
    const timezone = this.options.context.timezone;
    this.rows += records.length;
    assertXlsxRowLimit(this.rows);

    for (const record of records) {
      // Committing per row is what flushes it into the zip and releases it.
      this.sheet.addRow(xlsxCells(record, timezone)).commit();
    }

    // Rendering the batch was synchronous and told us nothing about whether the
    // client can keep up. This is where the export finds out, and where an
    // abandoned download stops costing anything.
    await awaitBackpressure(this.options.stream);
  }

  async finish(summary: ReportSummary): Promise<void> {
    assertClientPresent(this.options.stream);
    this.sheet.commit();
    this.writeSummarySheet(summary);
    // Finalises the zip and ends the response stream. `commit` resolves on the
    // response's `finish`, which a socket the client already dropped will never
    // emit — hence the race.
    await untilClosed(this.options.stream, this.workbook.commit());
  }

  /**
   * Created only after the data sheet has been committed.
   *
   * The streaming writer appends one zip entry at a time, so two open worksheets
   * would make the second buffer in memory until the first closed — which is
   * both the bug this class exists to avoid and, in the worst case, a corrupt
   * archive.
   */
  private writeSummarySheet(summary: ReportSummary): void {
    const { context, range, generatedAt } = this.options;
    const sheet = this.workbook.addWorksheet(SUMMARY_SHEET);
    sheet.columns = [{ width: 30 }, { width: 96 }];

    const title = sheet.addRow(['Attendance export']);
    title.font = { bold: true, size: 14 };
    title.commit();
    sheet.addRow([]).commit();

    const rows: Array<[string, string | number]> = [
      ['Organization', context.organizationName],
      // Stated in full, because every time in the workbook is a wall clock in
      // this zone and nothing in the xlsx format records that.
      ['Timezone', context.timezone],
      ['From (inclusive)', range.from],
      ['To (inclusive)', range.to],
      ['Employees', range.userId === undefined ? 'All employees' : `Filtered: ${range.userId}`],
      ['Generated at', `${formatWallClock(generatedAt, context.timezone)} (${context.timezone})`],
      ['', ''],
      ['Records', summary.totalRecords],
      ['Distinct employees', summary.distinctUsers],
      ['Present', summary.presentCount],
      ['Late', summary.lateCount],
      ['Incomplete (no check-out)', summary.incompleteCount],
      ['Total worked minutes', summary.totalWorkedMinutes],
      ['Total worked (h:mm)', formatDuration(summary.totalWorkedMinutes)],
    ];

    for (const [label, value] of rows) {
      const row = sheet.addRow([label, value]);
      row.getCell(1).font = { bold: true };
      row.commit();
    }

    this.writeTimezoneNotice(sheet);
    sheet.commit();
  }

  /**
   * The timezone-change notice, when there is one.
   *
   * Placed last and made loud on purpose. Every zoned column header already
   * carries the short warning — that is the half the CSV can also carry — but a
   * header has room for a sentence, not for the dates and the zones. A reader
   * holding two exports of one month that disagree needs to know *when* the zone
   * moved and *which way*, and this is the only surface in either file with space
   * to say it.
   *
   * The alternative design was to store the zone in force on each
   * `AttendanceRecord` and render every row in its own zone. It was rejected: it
   * would put two zones in one time column, which makes the sheet's own
   * arithmetic lie — the date cells carry the wall clock relabelled as UTC (see
   * `admin.time.ts`), so under mixed zones sorting by check-in is no longer
   * chronological and subtracting two cells is no longer a duration. It would
   * also require inventing a zone for every row written before the column
   * existed. One zone per file, loudly declared, is both what a payroll reader
   * can actually use and the only version that states nothing it does not know.
   */
  private writeTimezoneNotice(sheet: ReturnType<StreamingWorkbook['addWorksheet']>): void {
    const { context, timezoneChanges } = this.options;
    if (timezoneChanges.length === 0) return;

    sheet.addRow([]).commit();

    const heading = sheet.addRow([
      'Timezone changed',
      `${timezoneChanges.length} change${timezoneChanges.length === 1 ? '' : 's'} recorded on or after ${this.options.range.from}`,
    ]);
    for (const column of [1, 2]) {
      heading.getCell(column).font = { bold: true, color: { argb: NOTICE_TEXT } };
      heading.getCell(column).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: NOTICE_BACKGROUND },
      };
    }
    heading.commit();

    for (const change of timezoneChanges) {
      // Rendered in the current zone like every other instant in the workbook, and
      // labelled as such, so the notice does not itself introduce a second clock.
      const at = `${formatWallClock(change.at, context.timezone)} (${context.timezone})`;
      sheet.addRow([at, `${change.from} → ${change.to}`]).commit();
    }

    const explanation = sheet.addRow([
      'What this means',
      `Every time in this file is the wall clock in ${context.timezone}, the timezone in force now. ` +
        'Work dates were assigned in the timezone in force when each punch happened and are ' +
        'deliberately never restated, so for records made before the change a row’s check-in ' +
        'date can fall on the day before or after its own work date. Times in an export of this ' +
        'range taken before the change will not match the times here.',
    ]);
    explanation.getCell(1).font = { bold: true };
    explanation.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    explanation.height = NOTICE_HEIGHT;
    explanation.commit();
  }
}

export function createXlsxSink(options: ExportSinkOptions): ExportSink {
  return new XlsxSink(options);
}
