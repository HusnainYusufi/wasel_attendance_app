import { ExportFormat, ExportVariant } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_CONTENT_TYPE,
  contentDisposition,
  exportFilename,
} from '../export/content-disposition.js';

describe('exportFilename', () => {
  it('names the file after the tenant and the range', () => {
    expect(
      exportFilename(
        'acme-logistics',
        '2026-01-01',
        '2026-01-31',
        ExportFormat.XLSX,
        ExportVariant.DETAILED,
      ),
    ).toBe('acme-logistics-attendance-2026-01-01_to_2026-01-31.xlsx');
  });

  /**
   * The name the detailed sheet has always had, unchanged by the arrival of a
   * second variant. Administrators have folders full of it and scripts that glob
   * for it; renaming every file anyone has ever downloaded to announce that
   * something *else* now exists would break the thing that did not change.
   */
  it('leaves the detailed name exactly as it has always been', () => {
    for (const format of [ExportFormat.CSV, ExportFormat.XLSX]) {
      expect(
        exportFilename('acme', '2026-01-01', '2026-01-31', format, ExportVariant.DETAILED),
      ).toBe(`acme-attendance-2026-01-01_to_2026-01-31.${format}`);
    }
  });

  /**
   * Two exports of one range now differ only in their columns, so a folder
   * holding both under one name is a payroll record whose contents are a
   * surprise.
   */
  it('says which variant a minified sheet is, in both formats', () => {
    for (const format of [ExportFormat.CSV, ExportFormat.XLSX]) {
      expect(
        exportFilename('acme', '2026-01-01', '2026-01-31', format, ExportVariant.MINIFIED),
      ).toBe(`acme-attendance-minified-2026-01-01_to_2026-01-31.${format}`);
    }
  });

  it('reduces a hostile slug to characters that need no escaping', () => {
    for (const variant of [ExportVariant.DETAILED, ExportVariant.MINIFIED]) {
      const filename = exportFilename(
        'evil"; rm -rf /\r\nX-Injected: 1',
        '2026-01-01',
        '2026-01-02',
        ExportFormat.CSV,
        variant,
      );
      expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(filename.endsWith('.csv')).toBe(true);
    }
  });

  it('falls back rather than emitting an empty name for a non-Latin slug', () => {
    expect(
      exportFilename('شركة', '2026-01-01', '2026-01-02', ExportFormat.CSV, ExportVariant.DETAILED),
    ).toBe('wasel-attendance-2026-01-01_to_2026-01-02.csv');
    expect(
      exportFilename('شركة', '2026-01-01', '2026-01-02', ExportFormat.CSV, ExportVariant.MINIFIED),
    ).toBe('wasel-attendance-minified-2026-01-01_to_2026-01-02.csv');
  });
});

describe('contentDisposition', () => {
  it('emits both the plain and the RFC 5987 filename', () => {
    expect(contentDisposition('wasel-attendance-2026-01-01_to_2026-01-31.csv')).toBe(
      'attachment; filename="wasel-attendance-2026-01-01_to_2026-01-31.csv"; ' +
        "filename*=UTF-8''wasel-attendance-2026-01-01_to_2026-01-31.csv",
    );
  });

  it('cannot be used to inject a response header', () => {
    const header = contentDisposition('a\r\nX-Evil: 1"b');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    // The quote that would have closed the `filename="…"` token is gone.
    expect(header).toBe(`attachment; filename="aX-Evil: 1_b"; filename*=UTF-8''aX-Evil%3A%201_b`);
  });

  /**
   * The variant token is a literal chosen here, not the request's string
   * interpolated, so a hostile slug is still the only untrusted input reaching
   * the header — and it is still reduced before it gets there.
   */
  it('stays injection-safe end to end for the minified name', () => {
    const header = contentDisposition(
      exportFilename(
        'evil"; drop\r\nX-Evil: 1',
        '2026-01-01',
        '2026-01-31',
        ExportFormat.XLSX,
        ExportVariant.MINIFIED,
      ),
    );
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('-attendance-minified-2026-01-01_to_2026-01-31.xlsx');
    expect(header.match(/filename="([^"]*)"/)?.[1]).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('content types', () => {
  it('uses the OOXML media type for xlsx and a charset for csv', () => {
    expect(EXPORT_CONTENT_TYPE[ExportFormat.XLSX]).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(EXPORT_CONTENT_TYPE[ExportFormat.CSV]).toBe('text/csv; charset=utf-8');
  });
});
