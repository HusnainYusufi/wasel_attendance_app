import { ExportFormat } from '@wasel/contracts';

export const EXPORT_CONTENT_TYPE: Readonly<Record<ExportFormat, string>> = {
  [ExportFormat.CSV]: 'text/csv; charset=utf-8',
  [ExportFormat.XLSX]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Anything outside this set is replaced, so the name never needs escaping. */
const UNSAFE_IN_FILENAME = /[^A-Za-z0-9]+/g;
const SLUG_MAX = 40;

/**
 * `wasel-attendance-2026-01-01_to_2026-01-31.xlsx`.
 *
 * The range is in the name because these files are downloaded repeatedly and
 * accumulate in one folder; `export.xlsx (3)` is unusable as a payroll record.
 *
 * The tenant slug is reduced to `[A-Za-z0-9-]`, which also removes every
 * character that could break out of the header: a quote closing the
 * `filename="…"` token, a semicolon inventing a new parameter, or a CR/LF
 * splitting the response. Sanitising at construction rather than at emission
 * means a future caller cannot reintroduce the hole by building a name itself.
 */
export function exportFilename(
  organizationSlug: string,
  from: string,
  to: string,
  format: ExportFormat,
): string {
  const slug = organizationSlug
    .normalize('NFKD')
    .replace(UNSAFE_IN_FILENAME, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .toLowerCase();

  return `${slug === '' ? 'wasel' : slug}-attendance-${from}_to_${to}.${format}`;
}

/**
 * An RFC 6266 `Content-Disposition`.
 *
 * Both spellings are emitted: the `filename` token for every client, and
 * `filename*` with an explicit charset for the ones that honour RFC 5987. The
 * belt-and-braces sanitising is deliberate even though {@link exportFilename}
 * already guarantees an ASCII-safe name — this function is the last thing
 * between a string and a response header, and header injection is not a mistake
 * worth making twice.
 */
export function contentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n]/g, '').replace(/["\\]/g, '_');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
