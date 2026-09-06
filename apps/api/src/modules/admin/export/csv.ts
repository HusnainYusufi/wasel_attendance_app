/**
 * RFC 4180 CSV, hardened against the one vulnerability this feature is famous
 * for.
 *
 * A CSV is not a data format to Excel; it is a *program*. A cell whose text
 * begins `=`, `+`, `-` or `@` is parsed as a formula and evaluated the moment the
 * file is opened, and `=HYPERLINK`, `=WEBSERVICE` and DDE payloads make that a
 * remote-code-execution and data-exfiltration primitive. In an attendance export
 * the payload arrives through an employee's own full name, which an administrator
 * with no reason for suspicion then opens on their laptop. Neutralising it is not
 * defence in depth — it is the control.
 */

/** Excel renders UTF-8 as mojibake without it; Arabic names arrive as `Ø§Ù„…`. */
export const UTF8_BOM = '\uFEFF';

/** RFC 4180 §2.1: the line break is CRLF. */
export const CSV_EOL = '\r\n';

/**
 * Leading characters that turn a cell into a formula.
 *
 * Tab and carriage return are here because Excel strips them during import and
 * then re-examines the first surviving character, so `\t=cmd|…` slips past a
 * naive check of `value[0]`.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Fields containing any of these must be quoted (RFC 4180 §2.6, §2.7). */
const NEEDS_QUOTING = /["\r\n,]/;

/**
 * Renders a value Excel cannot execute.
 *
 * The apostrophe is the mitigation OWASP recommends: it is not part of the data,
 * every spreadsheet application treats what follows as literal text, and — unlike
 * stripping the character — the original value stays legible and recoverable. A
 * name is evidence in a payroll dispute; silently deleting a character from it
 * would be its own kind of wrong.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** One field, escaped and quoted only where RFC 4180 requires it. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';

  const safe = neutralizeFormula(value);
  // §2.7: a quote inside a quoted field is escaped by doubling it.
  return NEEDS_QUOTING.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map((value) => csvField(value)).join(',') + CSV_EOL;
}
