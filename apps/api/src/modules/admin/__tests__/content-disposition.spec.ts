import { ExportFormat } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_CONTENT_TYPE,
  contentDisposition,
  exportFilename,
} from '../export/content-disposition.js';

describe('exportFilename', () => {
  it('names the file after the tenant and the range', () => {
    expect(exportFilename('acme-logistics', '2026-01-01', '2026-01-31', ExportFormat.XLSX)).toBe(
      'acme-logistics-attendance-2026-01-01_to_2026-01-31.xlsx',
    );
  });

  it('reduces a hostile slug to characters that need no escaping', () => {
    const filename = exportFilename(
      'evil"; rm -rf /\r\nX-Injected: 1',
      '2026-01-01',
      '2026-01-02',
      ExportFormat.CSV,
    );
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(filename.endsWith('.csv')).toBe(true);
  });

  it('falls back rather than emitting an empty name for a non-Latin slug', () => {
    expect(exportFilename('شركة', '2026-01-01', '2026-01-02', ExportFormat.CSV)).toBe(
      'wasel-attendance-2026-01-01_to_2026-01-02.csv',
    );
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
});

describe('content types', () => {
  it('uses the OOXML media type for xlsx and a charset for csv', () => {
    expect(EXPORT_CONTENT_TYPE[ExportFormat.XLSX]).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(EXPORT_CONTENT_TYPE[ExportFormat.CSV]).toBe('text/csv; charset=utf-8');
  });
});
