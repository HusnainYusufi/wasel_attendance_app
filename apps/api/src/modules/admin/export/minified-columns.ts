import type { ReportRecord } from '../admin.mapper.js';
import { formatWallClock, toIsoDate, toSpreadsheetDate } from '../admin.time.js';
import { safeText, zonedHeaders, type ExportColumn } from './export-columns.js';

/**
 * The minified attendance sheet — who, which day, in, out, hours.
 *
 * A second sheet rather than a narrowing of the first, because the two are read
 * by different people for different reasons. The detailed sheet answers "is this
 * record trustworthy": sites, distances, GPS accuracy, geofence flags. This one
 * answers "what do I pay this person", and its reader is transcribing four
 * numbers into a payroll system. Every column that is not one of those four is a
 * column they can land on by mistake, and the sixteen-column sheet is wide enough
 * that "check-in distance from site" and "check-in GPS accuracy" sit side by side
 * with nothing but their headers to tell them apart.
 *
 * Two decisions in here are worth stating, because both were judgement calls.
 *
 * **The work date is present, and the customer did not ask for it.** They asked
 * for four fields: name, in, out, hours. A sheet of check-in times with no date
 * is usable for exactly one day and unusable for every range longer than that —
 * thirty rows all saying `08:15` with nothing to say which morning. It is also
 * not derivable from the check-in instant: a night shift that starts at 23:40
 * belongs to the business day that opened before it (see `dayStartsAt`), and
 * after a timezone move the check-in's calendar date can sit on the other side of
 * midnight from its own work date. The work date is the row's identity — it is
 * half of the `(workDate, userId)` key the export is ordered and paginated by —
 * so it goes in the file, first, where it also makes the sheet's own sort order
 * visible. That is one extra column against a sheet nobody can use twice.
 *
 * **The employee code and email stayed out.** Two people can share a name, and
 * that is a real risk this sheet does not mitigate. It is the price of the
 * customer's actual request, it is recoverable — the detailed sheet has both — and
 * a "minified" sheet that grows a disambiguation column is on its way back to
 * being the sheet it was meant to replace.
 */

/**
 * How many decimals of an hour the sheet states.
 *
 * Two, which is what payroll multiplies by an hourly rate, and which is the
 * conventional precision for it. It is deliberately *not* enough to represent
 * every whole minute exactly — 8:16 is 8.2666… hours — and the consequences of
 * that are handled below rather than hidden.
 */
const HOURS_DECIMALS = 2;

/**
 * The Excel number format, derived from {@link HOURS_DECIMALS} so the workbook
 * cannot display a different precision from the one the CSV renders.
 */
const HOURS_NUMBER_FORMAT = `0.${'0'.repeat(HOURS_DECIMALS)}`;

/**
 * Hours as a decimal, not as `h:mm`, and the reasoning is mostly about the CSV.
 *
 * `7:30` in a CSV is not a duration to Excel, it is a *time of day*: the import
 * parses it to 0.3125 — seven and a half twenty-fourths of a day — so a column of
 * them sums to something a fifth the size of the truth and formats as a
 * meaningless clock reading. The person doing that summing is running payroll.
 * A decimal is a plain number in every reader, in both formats, and needs no
 * import step to be right.
 *
 * It is also the number the reader actually wants: hours × rate is the
 * calculation this sheet exists to feed, and `7.5` does it where `7:30` has to be
 * converted first. The human-readable `h:mm` has not been lost — the workbook's
 * Summary sheet still carries the grand total in both spellings, which is where a
 * duration is read rather than computed with.
 */
function decimalHours(minutes: number | null): number | null {
  return minutes === null ? null : minutes / 60;
}

/**
 * The same value as the workbook *displays* it, for the CSV.
 *
 * The split follows the pattern the distance columns already set: the xlsx cell
 * holds the exact number and its column format renders the text, and the CSV —
 * which has no number formats — carries that text directly. The two files
 * therefore show a reader the identical string for the identical cell, which is
 * the invariant this export path holds above being tidy.
 *
 * The rounding is real and worth naming: 8:16 renders as `8.27`, so a column of
 * them adds up a few hundredths high. In the workbook that does not happen — the
 * cell underneath is exact, so the column sums to the true total and agrees with
 * the Summary sheet. In the CSV it does, by at most half of one hundredth of an
 * hour — 0.3 seconds — per row. Stating a per-row figure to the precision payroll
 * pays at, and keeping the authoritative total exact where the file has somewhere
 * to put it, is the trade this makes.
 */
function decimalHoursText(minutes: number | null): string | null {
  return minutes === null ? null : (minutes / 60).toFixed(HOURS_DECIMALS);
}

/**
 * Five columns, in the order the sheet is physically sorted in.
 *
 * `Work date` leads because the rows arrive ordered by `(workDate, userId)`, and
 * a sheet whose first column is not its sort key reads as unsorted — which
 * invites the reader to re-sort it and lose the tie-break. It is also the
 * skeleton the detailed sheet starts with, so switching between the two variants
 * does not mean relearning the file.
 */
export const MINIFIED_COLUMNS: readonly ExportColumn[] = [
  { header: 'Work date', width: 12, numFmt: 'yyyy-mm-dd' },
  { header: 'Employee', width: 30 },
  { header: 'Check-in', width: 19, zoned: true, numFmt: 'yyyy-mm-dd hh:mm' },
  { header: 'Check-out', width: 19, zoned: true, numFmt: 'yyyy-mm-dd hh:mm' },
  { header: 'Total hours', width: 13, numFmt: HOURS_NUMBER_FORMAT },
];

export function minifiedHeaders(timezone: string, zoneChanged: boolean): string[] {
  return zonedHeaders(MINIFIED_COLUMNS, timezone, zoneChanged);
}

/**
 * A CSV line. Strings are handed over raw — {@link csvField} neutralises them —
 * exactly as the detailed writer does, so one rule governs both sheets.
 */
export function minifiedCsvCells(
  record: ReportRecord,
  timezone: string,
): Array<string | number | null> {
  return [
    toIsoDate(record.workDate),
    record.user.fullName,
    formatWallClock(record.checkInAt, timezone),
    record.checkOutAt === null ? null : formatWallClock(record.checkOutAt, timezone),
    decimalHoursText(record.workedMinutes),
  ];
}

/**
 * An XLSX row: real dates and a real number for the hours.
 *
 * The hours cell is the point of the whole variant. Someone will select that
 * column and expect the status bar to show a total, and they will get one only
 * because the cell is a number rather than the string the column format makes it
 * look like. A record with no check-out leaves it **blank** rather than zero: a
 * zero is a claim that the person worked nothing, it is summed as one, and it is
 * indistinguishable from a genuine zero-minute day — where an empty cell says
 * "this shift is still open", which is what an incomplete record means.
 */
export function minifiedXlsxCells(
  record: ReportRecord,
  timezone: string,
): Array<Date | string | number | null> {
  return [
    record.workDate,
    safeText(record.user.fullName),
    toSpreadsheetDate(record.checkInAt, timezone),
    record.checkOutAt === null ? null : toSpreadsheetDate(record.checkOutAt, timezone),
    decimalHours(record.workedMinutes),
  ];
}
