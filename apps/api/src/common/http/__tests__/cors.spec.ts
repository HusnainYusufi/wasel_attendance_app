import { describe, expect, it, vi } from 'vitest';
import { createCorsOptions } from '../cors.js';

type OriginCallback = (error: Error | null, allow?: boolean) => void;
type OriginFn = (origin: string | undefined, callback: OriginCallback) => void;

function decide(allowlist: string[], origin: string | undefined): boolean | undefined {
  const options = createCorsOptions(allowlist);
  const originFn = options.origin as OriginFn;
  const callback = vi.fn<OriginCallback>();

  originFn(origin, callback);

  expect(callback).toHaveBeenCalledOnce();
  const [error, allow] = callback.mock.calls[0] ?? [];
  expect(error).toBeNull();
  return allow;
}

const ALLOWLIST = ['http://localhost:5173', 'capacitor://localhost'];

describe('createCorsOptions', () => {
  it.each(ALLOWLIST)('allows %s', (origin) => {
    expect(decide(ALLOWLIST, origin)).toBe(true);
  });

  it.each([
    'https://attacker.example',
    'http://localhost:5174',
    'http://localhost:5173.attacker.example',
    'http://localhost',
    'null',
    '*',
  ])('refuses %s', (origin) => {
    expect(decide(ALLOWLIST, origin)).toBe(false);
  });

  it('is case sensitive, because Origin comparison is', () => {
    expect(decide(ALLOWLIST, 'HTTP://LOCALHOST:5173')).toBe(false);
  });

  it('emits no CORS headers for a request without an Origin', () => {
    // Not a CORS request at all: curl, a native mobile client, a server-to-server
    // call. There is no same-origin policy to relax.
    expect(decide(ALLOWLIST, undefined)).toBe(false);
  });

  it('enables credentials and exposes the request id header', () => {
    const options = createCorsOptions(ALLOWLIST);

    expect(options.credentials).toBe(true);
    expect(options.exposedHeaders).toContain('x-request-id');
    expect(options.allowedHeaders).toContain('Authorization');
  });

  it('allows nothing when the allowlist is empty', () => {
    expect(decide([], 'http://localhost:5173')).toBe(false);
  });
});
