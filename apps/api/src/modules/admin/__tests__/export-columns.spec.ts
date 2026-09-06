import { describe, expect, it } from 'vitest';
import {
  EXPORT_COLUMNS,
  TIMEZONE_CHANGED_NOTE,
  csvCells,
  exportHeaders,
  xlsxCells,
} from '../export/export-columns.js';
import { reportRecord } from './fixtures.js';

const RIYADH = 'Asia/Riyadh';

/** The column a header names, so an assertion cannot drift onto its neighbour. */
const columnAt = (header: string): number => {
  const index = EXPORT_COLUMNS.findIndex((column) => column.header === header);
  if (index < 0) throw new Error(`No export column named "${header}"`);
  return index;
};

describe('exportHeaders', () => {
  it('names the zone on exactly the columns that render an instant', () => {
    const headers = exportHeaders(RIYADH, false);

    expect(headers).toHaveLength(EXPORT_COLUMNS.length);
    for (const [index, column] of EXPORT_COLUMNS.entries()) {
      expect(headers[index]).toBe(column.zoned ? `${column.header} (${RIYADH})` : column.header);
    }
    // A bare "08:47" is ambiguous the moment the file leaves the machine that
    // made it, and a payroll dispute is exactly where it gets read.
    expect(headers.filter((header) => header.includes(RIYADH))).toHaveLength(2);
  });

  it('warns in the header when the zone moved after these records were made', () => {
    const headers = exportHeaders(RIYADH, true);

    // Located by name rather than by index, so adding a column between them
    // cannot quietly turn this into an assertion about a different cell.
    const zoned = EXPORT_COLUMNS.flatMap((column, index) => (column.zoned ? [index] : []));
    expect(zoned).toHaveLength(2);
    for (const index of zoned) {
      expect(headers[index]).toBe(
        `${EXPORT_COLUMNS[index]?.header} (${RIYADH}; ${TIMEZONE_CHANGED_NOTE})`,
      );
    }
    // The unzoned columns are untouched: `Work date` is stored, not rendered, and
    // is the very value the note says the times may now contradict.
    expect(headers[0]).toBe('Work date');
    expect(headers.filter((header) => header.includes(TIMEZONE_CHANGED_NOTE))).toHaveLength(2);
  });

  it('puts the warning where a CSV can carry it', () => {
    // The CSV is a bare rectangle by design — no preamble, no trailer — so the
    // column title is the only place in that file a sentence can go without
    // breaking every parser that reads it. It must therefore be self-contained:
    // "see the summary sheet" would be a dead reference in half the exports.
    expect(TIMEZONE_CHANGED_NOTE).toContain('timezone changed');
    expect(TIMEZONE_CHANGED_NOTE).toContain('work dates were not restated');
    expect(TIMEZONE_CHANGED_NOTE).not.toMatch(/sheet|below|above/i);
    // And it must survive CSV quoting without needing an escape that would make
    // the header unreadable in a text editor.
    expect(TIMEZONE_CHANGED_NOTE).not.toMatch(/[",\r\n]/);
  });
});

describe('location columns', () => {
  const CHECK_IN_DISTANCE = columnAt('Check-in distance from site');
  const CHECK_IN_ACCURACY = columnAt('Check-in GPS accuracy (radius)');
  const CHECK_OUT_DISTANCE = columnAt('Check-out distance from site');
  const OUTSIDE = columnAt('Outside geofence');

  it('renders a distance the way a person reads one in the CSV', () => {
    const cells = csvCells(
      reportRecord({ checkInDistanceM: 791_043.2, checkInAccuracyM: 2400, checkOutDistanceM: 45 }),
      RIYADH,
    );

    expect(cells[CHECK_IN_DISTANCE]).toBe('791 km');
    expect(cells[CHECK_IN_ACCURACY]).toBe('2.4 km');
    expect(cells[CHECK_OUT_DISTANCE]).toBe('45 m');
  });

  it('keeps the workbook cells numeric so the column can be sorted', () => {
    const cells = xlsxCells(reportRecord({ checkInDistanceM: 791_043.2 }), RIYADH);

    // A column of "791 km" strings sorts before "80 m", and sorting by distance
    // is the one thing an administrator does with it. The number format on the
    // column is what makes it *read* as the CSV's text.
    expect(cells[CHECK_IN_DISTANCE]).toBe(791_043.2);
    expect(EXPORT_COLUMNS[CHECK_IN_DISTANCE]?.numFmt).toContain('km');
  });

  it('distinguishes standing on the site centre from having no site', () => {
    expect(csvCells(reportRecord({ checkInDistanceM: 0 }), RIYADH)[CHECK_IN_DISTANCE]).toBe('0 m');
    expect(xlsxCells(reportRecord({ checkInDistanceM: 0 }), RIYADH)[CHECK_IN_DISTANCE]).toBe(0);

    const noSite = reportRecord({ checkInSite: null, checkInDistanceM: null });
    expect(csvCells(noSite, RIYADH)[CHECK_IN_DISTANCE]).toBeNull();
    expect(xlsxCells(noSite, RIYADH)[CHECK_IN_DISTANCE]).toBeNull();
    expect(csvCells(noSite, RIYADH)[columnAt('Check-in site')]).toBeNull();
  });

  it('leaves the flag blank unless a punch was actually outside', () => {
    expect(csvCells(reportRecord(), RIYADH)[OUTSIDE]).toBeNull();
    expect(csvCells(reportRecord({ checkInDistanceM: 791_043.2 }), RIYADH)[OUTSIDE]).toBe(
      'Check-in',
    );
    expect(
      csvCells(reportRecord({ checkInDistanceM: 400, checkOutDistanceM: 900 }), RIYADH)[OUTSIDE],
    ).toBe('Check-in + Check-out');
  });

  it('says the same thing about the same cell in both formats', () => {
    // A CSV and an XLSX of one range that disagree is a payroll dispute with two
    // answers, so the two writers must at least agree on shape and on emptiness.
    const record = reportRecord({ checkInDistanceM: 791_043.2 });
    const csv = csvCells(record, RIYADH);
    const xlsx = xlsxCells(record, RIYADH);

    expect(csv).toHaveLength(EXPORT_COLUMNS.length);
    expect(xlsx).toHaveLength(EXPORT_COLUMNS.length);
    for (const [index] of EXPORT_COLUMNS.entries()) {
      expect(csv[index] === null).toBe(xlsx[index] === null);
    }
  });
});
