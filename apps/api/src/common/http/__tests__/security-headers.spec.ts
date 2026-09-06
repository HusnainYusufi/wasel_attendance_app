import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createSecurityHeaders } from '../security-headers.js';

function run(handler: ReturnType<typeof createSecurityHeaders>, url: string): Map<string, string> {
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    removeHeader: vi.fn(),
    getHeader: () => undefined,
  } as unknown as Response;
  const request = { originalUrl: url, method: 'GET', headers: {} } as unknown as Request;

  handler(request, response, vi.fn());
  return headers;
}

describe('createSecurityHeaders', () => {
  it('applies a deny-by-default policy to API routes', () => {
    const headers = run(createSecurityHeaders('/api/docs'), '/api/v1/health/live');
    const policy = headers.get('content-security-policy') ?? '';

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // helmet's default policy allows inline styles; the API must not inherit it.
    expect(policy).not.toContain("'unsafe-inline'");
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('relaxes the policy only for the documentation route', () => {
    const handler = createSecurityHeaders('/api/docs');

    expect(run(handler, '/api/docs').get('content-security-policy')).toContain("'unsafe-inline'");
    expect(run(handler, '/api/docs/swagger-ui.css').get('content-security-policy')).toContain(
      "'unsafe-inline'",
    );
    expect(run(handler, '/api/v1/attendance').get('content-security-policy')).not.toContain(
      "'unsafe-inline'",
    );
  });

  it('does not relax a route that merely starts with the docs path', () => {
    const handler = createSecurityHeaders('/api/docs');
    expect(run(handler, '/api/docsomething').get('content-security-policy')).toContain(
      "default-src 'none'",
    );
  });

  it('ignores the query string when matching the docs path', () => {
    const handler = createSecurityHeaders('/api/docs');
    expect(run(handler, '/api/docs?x=1').get('content-security-policy')).toContain(
      "'unsafe-inline'",
    );
  });

  it('is strict everywhere when the documentation is disabled', () => {
    const handler = createSecurityHeaders(null);
    expect(run(handler, '/api/docs').get('content-security-policy')).toContain(
      "default-src 'none'",
    );
  });

  it('relaxes the whole API when the docs path is a prefix of it', () => {
    // Documenting the hazard rather than defending against it here: prefix
    // matching is what makes `/api/docs/swagger-ui.css` work, so this middleware
    // cannot distinguish `/api` from a legitimate docs root. `envSchema` refuses
    // to boot such a value — see the SWAGGER_PATH cases in app-config.spec.ts —
    // which is why this stays a unit-level demonstration and never reaches a
    // running application.
    const handler = createSecurityHeaders('/api');

    expect(run(handler, '/api/v1/health/live').get('content-security-policy')).toContain(
      "'unsafe-inline'",
    );
    expect(
      run(handler, '/api/v1/attendance/check-in').get('content-security-policy'),
    ).not.toContain("default-src 'none'");
  });

  it('marks API responses uncacheable but leaves the docs alone', () => {
    const handler = createSecurityHeaders('/api/docs');

    expect(run(handler, '/api/v1/attendance').get('cache-control')).toBe('no-store');
    expect(run(handler, '/api/docs').get('cache-control')).toBeUndefined();
  });

  it('marks responses uncacheable when the documentation is disabled too', () => {
    expect(run(createSecurityHeaders(null), '/api/v1/attendance').get('cache-control')).toBe(
      'no-store',
    );
  });
});
