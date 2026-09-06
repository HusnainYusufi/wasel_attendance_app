import { describe, expect, it } from 'vitest';
import { EXPORT_COLUMNS, TIMEZONE_CHANGED_NOTE, exportHeaders } from '../export/export-columns.js';

const RIYADH = 'Asia/Riyadh';

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

    expect(headers[4]).toBe(`Check-in (${RIYADH}; ${TIMEZONE_CHANGED_NOTE})`);
    expect(headers[6]).toBe(`Check-out (${RIYADH}; ${TIMEZONE_CHANGED_NOTE})`);
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
