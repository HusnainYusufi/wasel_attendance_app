import { describe, expect, it } from 'vitest';
import { generateRequestId, resolveRequestId, sanitizeRequestId } from '../request-id.js';

describe('sanitizeRequestId', () => {
  it.each(['abc', 'trace-1.2:3_4', 'a'.repeat(128)])('accepts a safe id', (value) => {
    expect(sanitizeRequestId(value)).toBe(value);
  });

  it.each([
    ['a newline, which would forge a second log line', 'good\nlevel=fatal msg=owned'],
    ['a carriage return', 'good\rmore'],
    ['a space', 'has space'],
    ['an id over the length limit', 'a'.repeat(129)],
    ['an empty string', ''],
    ['a quote that would break JSON framing', 'id","injected":"x'],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeRequestId(value)).toBeUndefined();
  });

  it.each([undefined, null, 42, {}, []])('rejects a non-string', (value) => {
    expect(sanitizeRequestId(value)).toBeUndefined();
  });
});

describe('resolveRequestId', () => {
  it('reuses a safe inbound id so a trace survives the proxy hop', () => {
    expect(resolveRequestId('edge-abc')).toBe('edge-abc');
  });

  it('takes the first value when a header is repeated', () => {
    expect(resolveRequestId(['first', 'second'])).toBe('first');
  });

  it('mints a UUID when the header is absent', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a UUID rather than trusting an unsafe id', () => {
    const resolved = resolveRequestId('bad\nvalue');
    expect(resolved).not.toContain('\n');
    expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('generateRequestId', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 100 }, generateRequestId));
    expect(ids.size).toBe(100);
  });
});
