import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { clientInfoFromRequest } from '../client-context.js';

function request(ip: unknown, userAgent: unknown): Request {
  return { ip, headers: { 'user-agent': userAgent } } as unknown as Request;
}

describe('clientInfoFromRequest', () => {
  it('reads the address Express resolved and the user agent', () => {
    expect(clientInfoFromRequest(request('203.0.113.7', 'Wasel/1.0'))).toEqual({
      ipAddress: '203.0.113.7',
      userAgent: 'Wasel/1.0',
    });
  });

  it('truncates to the column widths rather than letting Postgres reject the row', () => {
    const info = clientInfoFromRequest(request('a'.repeat(80), 'b'.repeat(2000)));

    // `sessions.ipAddress` is varchar(45) and `userAgent` varchar(512); an
    // oversized header would otherwise turn a login into a 500.
    expect(info.ipAddress).toHaveLength(45);
    expect(info.userAgent).toHaveLength(512);
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['not a string', 42],
  ])('yields null for a %s value', (_name, value) => {
    expect(clientInfoFromRequest(request(value, value))).toEqual({
      ipAddress: null,
      userAgent: null,
    });
  });
});
