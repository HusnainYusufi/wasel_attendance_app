import type { ReportSummary } from '@wasel/contracts';
import type { ReportRecord } from '../admin.mapper.js';
import { UTF8_BOM, csvRow } from './csv.js';
import { exportSheet, type ExportSheet } from './export-sheet.js';
import { endStream, writeChunk, type ExportSink, type ExportSinkOptions } from './export-sink.js';

/**
 * The CSV attendance sheet.
 *
 * Data only — no title block, no totals row. A CSV's entire value is that
 * anything can parse it, and a preamble or a trailing summary line breaks every
 * one of those parsers, including the Excel import that this file exists to
 * feed. The totals belong to the XLSX summary sheet and to
 * `GET /admin/reports/attendance`, both of which have somewhere to put them.
 *
 * The preamble is held back until the first flush so that an empty range still
 * produces a valid one-line file — a header with no rows — rather than a 404 or
 * a zero-byte download that Excel refuses to open.
 *
 * That rectangle is also why a timezone-change warning goes in the *header* here
 * rather than in a note beside the totals as it does in the workbook: a column
 * title is the only place in this file a sentence can go without breaking every
 * parser that reads it. See {@link exportHeaders}.
 */
class CsvSink implements ExportSink {
  private readonly sheet: ExportSheet;
  private pending: string;

  constructor(private readonly options: ExportSinkOptions) {
    this.sheet = exportSheet(options.variant);
    // The BOM is the first thing in the file whichever variant this is: without
    // it Excel decodes the bytes as the machine's legacy code page and an Arabic
    // name arrives as `Ø§Ù„…`.
    this.pending =
      UTF8_BOM +
      csvRow(this.sheet.headers(options.context.timezone, options.timezoneChanges.length > 0));
  }

  async writeBatch(records: readonly ReportRecord[]): Promise<void> {
    const timezone = this.options.context.timezone;
    let chunk = this.pending;
    this.pending = '';

    for (const record of records) {
      chunk += csvRow(this.sheet.csvCells(record, timezone));
    }

    // One write per batch, not per row: a `write` syscall per record turns a
    // 100k-row export into 100k of them.
    await writeChunk(this.options.stream, chunk);
  }

  async finish(_summary: ReportSummary): Promise<void> {
    if (this.pending !== '') {
      await writeChunk(this.options.stream, this.pending);
      this.pending = '';
    }
    await endStream(this.options.stream);
  }
}

export function createCsvSink(options: ExportSinkOptions): ExportSink {
  return new CsvSink(options);
}
