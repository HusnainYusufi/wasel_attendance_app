import type { ReportRecord } from '../admin.mapper.js';
import { formatWallClock, toIsoDate, toSpreadsheetDate } from '../admin.time.js';
import { neutralizeFormula } from './csv.js';

/**
 * The attendance sheet's columns — one definition, both formats.
 *
 * A CSV and an XLSX of the same range that disagree on columns or ordering is a
 * support ticket waiting to happen, so the shape is declared once and each
 * writer only decides how to *render* a cell, never which cells there are.
 */
export interface ExportColumn {
  readonly header: string;
  readonly width: number;
  /**
   * True for a column whose value is an instant rendered in the organization's
   * timezone. Those headers carry the zone, because a bare "08:47" in a
   * spreadsheet is ambiguous the moment the file leaves the machine that made it
   * — and payroll disputes are exactly the context this file gets read in.
   */
  readonly zoned?: boolean;
  /** Excel number format. Absent for text columns. */
  readonly numFmt?: string;
}

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: 'Work date', width: 12, numFmt: 'yyyy-mm-dd' },
  { header: 'Employee code', width: 16 },
  { header: 'Full name', width: 28 },
  { header: 'Email', width: 30 },
  { header: 'Check-in', width: 19, zoned: true, numFmt: 'yyyy-mm-dd hh:mm' },
  { header: 'Check-in site', width: 22 },
  { header: 'Check-out', width: 19, zoned: true, numFmt: 'yyyy-mm-dd hh:mm' },
  { header: 'Check-out site', width: 22 },
  { header: 'Status', width: 12 },
  { header: 'Worked minutes', width: 16, numFmt: '0' },
  { header: 'Late minutes', width: 14, numFmt: '0' },
];

/**
 * What a zoned header says when the range predates the zone it is rendered in.
 *
 * Deliberately in the **header**, and deliberately identical in both formats.
 * The CSV is a bare rectangle by design — no preamble, no trailer, see
 * `csv-sink.ts` — so the column title is the only place in that file a sentence
 * can go without breaking every parser that reads it. Putting it there rather
 * than only on the XLSX summary sheet also keeps the promise the column
 * definitions exist to keep: a CSV and an XLSX of the same range say the same
 * thing about the same cell.
 *
 * The wording names the actual hazard rather than gesturing at it. A reader
 * comparing this file against the copy payroll was paid from needs to know why
 * two exports of one month disagree, and that a row's check-in date can sit on
 * the other side of midnight from its own work date.
 */
export const TIMEZONE_CHANGED_NOTE =
  'timezone changed since these records were made — work dates were not restated';

/**
 * @param zoneChanged True when the tenant's timezone moved on or after the first
 * day of the exported range, so the instants below are rendered in a zone that
 * was not in force when they were recorded.
 */
export function exportHeaders(timezone: string, zoneChanged: boolean): string[] {
  const zone = zoneChanged ? `${timezone}; ${TIMEZONE_CHANGED_NOTE}` : timezone;
  return EXPORT_COLUMNS.map((column) =>
    column.zoned ? `${column.header} (${zone})` : column.header,
  );
}

/** A CSV line: everything already rendered as text or a number. */
export function csvCells(record: ReportRecord, timezone: string): Array<string | number | null> {
  return [
    toIsoDate(record.workDate),
    record.user.employeeCode,
    record.user.fullName,
    record.user.email,
    formatWallClock(record.checkInAt, timezone),
    record.checkInSite.name,
    record.checkOutAt === null ? null : formatWallClock(record.checkOutAt, timezone),
    record.checkOutSite?.name ?? null,
    record.status,
    record.workedMinutes,
    record.lateMinutes,
  ];
}

/** `neutralizeFormula`, but transparent about a cell that has no value. */
function text(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : neutralizeFormula(value);
}

/**
 * An XLSX row: real `Date` and `number` cells, never pre-formatted strings.
 *
 * This is what makes the workbook usable rather than merely correct — Excel can
 * sort chronologically, filter a date range and subtract two times only if the
 * cells are genuinely dates. A sheet of strings looks identical and does none of
 * it.
 *
 * The text cells go through the same {@link neutralizeFormula} the CSV writer
 * uses, even though an xlsx cell carries no `<f>` element and Excel therefore
 * renders `=WEBSERVICE(…)` in an employee's name as inert text. Two reasons, and
 * neither is Excel's own behaviour: the recipient who re-exports the sheet to
 * CSV re-arms the payload in a file nothing will neutralise a second time, and a
 * CSV and an XLSX of the same range that disagree about a cell's contents is a
 * payroll dispute with two answers. The cost is a leading apostrophe on the rare
 * legitimate value that starts with `-` or `+`, which is visible, recoverable and
 * far cheaper than either alternative.
 */
export function xlsxCells(
  record: ReportRecord,
  timezone: string,
): Array<Date | string | number | null> {
  return [
    // `workDate` is a calendar date the driver already hands back as midnight
    // UTC, which is exactly the serial Excel wants. Only the instants need the
    // wall-clock relabelling.
    record.workDate,
    text(record.user.employeeCode),
    text(record.user.fullName),
    text(record.user.email),
    toSpreadsheetDate(record.checkInAt, timezone),
    text(record.checkInSite.name),
    record.checkOutAt === null ? null : toSpreadsheetDate(record.checkOutAt, timezone),
    text(record.checkOutSite?.name),
    record.status,
    record.workedMinutes,
    record.lateMinutes,
  ];
}
