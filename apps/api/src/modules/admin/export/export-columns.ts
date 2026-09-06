import { AttendanceSource, PunchType, formatDistance } from '@wasel/contracts';
import { outOfRangePunches, type ReportRecord } from '../admin.mapper.js';
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

/**
 * Metres, displayed the way a person reads a distance.
 *
 * Three sections — Excel's maximum — chosen to match {@link formatDistance}
 * exactly, because the CSV renders these same cells with that function and a CSV
 * and an XLSX of one range that disagree about a cell is a payroll dispute with
 * two answers. Under a kilometre: whole metres. Under ten: one decimal of
 * kilometres. Beyond that: whole kilometres, because `791.0 km` claims a
 * precision a GPS fix does not have.
 *
 * The cell underneath stays a real number, which is the whole reason not to
 * simply write the string here: a distance column of text sorts `791 km` before
 * `80 m`, and the one thing an administrator does with this column is sort it.
 */
const DISTANCE_FORMAT = '[<1000]#,##0" m";[<10000]0.0," km";#,##0," km"';

/**
 * The label for a row where a punch landed outside its own site's radius.
 *
 * A dedicated column rather than a colour or a note, because this file is read
 * by filtering and sorting far more often than by eye: a text column can be
 * filtered to "not blank" in one click, survives a CSV round trip, and means the
 * same thing in Excel, Numbers, Sheets and pandas. Cell shading does none of
 * that and vanishes the moment anyone saves as CSV.
 *
 * It names *which* punch rather than saying `Yes`, because "checked in 40 km
 * away and out at the office" and the reverse are different stories, and the two
 * distance columns are far enough apart on the row that reading them back is
 * work. In-range rows stay blank so the exceptions are the only thing with ink
 * on them.
 */
const OUT_OF_RANGE_LABEL: Record<PunchType, string> = {
  [PunchType.CHECK_IN]: 'Check-in',
  [PunchType.CHECK_OUT]: 'Check-out',
};

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: 'Work date', width: 12, numFmt: 'yyyy-mm-dd' },
  { header: 'Employee code', width: 16 },
  { header: 'Full name', width: 28 },
  { header: 'Email', width: 30 },
  { header: 'Check-in', width: 19, zoned: true, numFmt: 'yyyy-mm-dd hh:mm' },
  { header: 'Check-in site', width: 22 },
  // The distance and the accuracy sit beside the punch they belong to rather
  // than in a block of their own: reading a row is then one left-to-right pass —
  // when, where, how far, how sure — instead of a hunt across the sheet.
  { header: 'Check-in distance from site', width: 24, numFmt: DISTANCE_FORMAT },
  { header: 'Check-in GPS accuracy (radius)', width: 26, numFmt: DISTANCE_FORMAT },
  { header: 'Check-out', width: 19, zoned: true, numFmt: 'yyyy-mm-dd hh:mm' },
  { header: 'Check-out site', width: 22 },
  { header: 'Check-out distance from site', width: 26, numFmt: DISTANCE_FORMAT },
  { header: 'Check-out GPS accuracy (radius)', width: 28, numFmt: DISTANCE_FORMAT },
  { header: 'Outside geofence', width: 20 },
  // Beside the geofence flag rather than at the end: both columns answer the
  // same question — how far should I trust this row — and a reader scanning for
  // "which of these days did somebody type in" should not have to hunt for it.
  { header: 'Entered by hand', width: 24 },
  { header: 'Reason for manual entry', width: 34 },
  { header: 'Status', width: 12 },
  { header: 'Worked minutes', width: 16, numFmt: '0' },
  { header: 'Late minutes', width: 14, numFmt: '0' },
];

/** What the "Outside geofence" cell says, or `null` when nothing was. */
export function outOfRangeCell(record: ReportRecord): string | null {
  const punches = outOfRangePunches(record);
  if (punches.length === 0) return null;
  return punches.map((punch) => OUT_OF_RANGE_LABEL[punch]).join(' + ');
}

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
 * Column titles, with the zone spelled out on the ones that render an instant.
 *
 * Shared by both variants rather than written twice: a second copy of this rule
 * would eventually annotate one sheet and not the other, and "which of these two
 * files is telling me the truth about the timezone" is the exact question the
 * annotation exists to answer.
 *
 * @param zoneChanged True when the tenant's timezone moved on or after the first
 * day of the exported range, so the instants below are rendered in a zone that
 * was not in force when they were recorded.
 */
export function zonedHeaders(
  columns: readonly ExportColumn[],
  timezone: string,
  zoneChanged: boolean,
): string[] {
  const zone = zoneChanged ? `${timezone}; ${TIMEZONE_CHANGED_NOTE}` : timezone;
  return columns.map((column) => (column.zoned ? `${column.header} (${zone})` : column.header));
}

/** The detailed sheet's headers. */
export function exportHeaders(timezone: string, zoneChanged: boolean): string[] {
  return zonedHeaders(EXPORT_COLUMNS, timezone, zoneChanged);
}

/** A CSV line: everything already rendered as text or a number. */
export function csvCells(record: ReportRecord, timezone: string): Array<string | number | null> {
  return [
    toIsoDate(record.workDate),
    record.user.employeeCode,
    record.user.fullName,
    record.user.email,
    formatWallClock(record.checkInAt, timezone),
    record.checkInSite?.name ?? null,
    // Rendered here, kept numeric in the workbook: a CSV has no number formats,
    // so this is the only place the unit can live, and `791 km` is what the
    // reader needs where `791043.2` is a puzzle. The XLSX column format below
    // prints the identical string from the number.
    distanceText(record.checkInDistanceM),
    distanceText(record.checkInAccuracyM),
    record.checkOutAt === null ? null : formatWallClock(record.checkOutAt, timezone),
    record.checkOutSite?.name ?? null,
    distanceText(record.checkOutDistanceM),
    distanceText(record.checkOutAccuracyM),
    outOfRangeCell(record),
    enteredByHandCell(record),
    record.note,
    record.status,
    record.workedMinutes,
    record.lateMinutes,
  ];
}

/**
 * Who typed this row in, or nothing at all when the employee punched it.
 *
 * Blank rather than "No" for a real punch, so the column filters to exactly the
 * hand-entered days in one click — and so a row whose provenance is a real punch
 * makes no claim at all, which is the honest thing for it to say.
 */
export function enteredByHandCell(record: ReportRecord): string | null {
  if (record.source !== AttendanceSource.MANUAL) return null;
  return record.enteredBy?.fullName ?? 'an administrator (since removed)';
}

/** A distance as a person reads it, or nothing at all when there is no distance. */
function distanceText(value: number | null): string | null {
  return value === null ? null : formatDistance(value);
}

/** `neutralizeFormula`, but transparent about a cell that has no value. */
export function safeText(value: string | null | undefined): string | null {
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
    safeText(record.user.employeeCode),
    safeText(record.user.fullName),
    safeText(record.user.email),
    toSpreadsheetDate(record.checkInAt, timezone),
    safeText(record.checkInSite?.name),
    // Numbers, not the rendered strings the CSV carries: the column's number
    // format displays exactly the same text, and keeping the value numeric is
    // what lets an administrator sort by "how far away was this" — the single
    // most useful thing to do with these columns. Passed through untouched, so a
    // genuine `0` (standing on the site centre) stays a zero rather than being
    // swept into the blank that "no site to measure from" produces.
    record.checkInDistanceM,
    record.checkInAccuracyM,
    record.checkOutAt === null ? null : toSpreadsheetDate(record.checkOutAt, timezone),
    safeText(record.checkOutSite?.name),
    record.checkOutDistanceM,
    record.checkOutAccuracyM,
    safeText(outOfRangeCell(record)),
    safeText(enteredByHandCell(record)),
    safeText(record.note),
    record.status,
    record.workedMinutes,
    record.lateMinutes,
  ];
}
