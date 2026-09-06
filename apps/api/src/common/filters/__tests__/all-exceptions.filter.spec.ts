import type { ArgumentsHost } from '@nestjs/common';
import { ErrorCode } from '@wasel/contracts';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { Errors } from '../../errors/app.exception.js';
import { AllExceptionsFilter } from '../all-exceptions.filter.js';
import { GENERIC_ERROR_MESSAGE } from '../error-mapping.js';

function fakeLogger() {
  return {
    setContext: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as PinoLogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function fakeHost(options: { headersSent?: boolean; requestId?: unknown } = {}) {
  const headers = new Map<string, string>();
  let status: number | undefined;
  let body: Record<string, unknown> | undefined;
  const end = vi.fn();

  const response = {
    headersSent: options.headersSent ?? false,
    setHeader: (name: string, value: string) => headers.set(name, value),
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
    end,
  };

  const request = {
    id: options.requestId,
    method: 'GET',
    url: '/api/v1/sites/abc',
    route: { path: '/api/v1/sites/:id' },
    headers: {},
  };

  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  return { host, headers, end, status: () => status, body: () => body };
}

describe('AllExceptionsFilter', () => {
  it('renders the envelope for an expected failure and logs it as a warning', () => {
    const logger = fakeLogger();
    const target = fakeHost({ requestId: 'req-1' });

    new AllExceptionsFilter(logger).catch(Errors.notFound('Site'), target.host);

    expect(target.status()).toBe(404);
    expect(target.body()).toEqual({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'Site not found',
      requestId: 'req-1',
      timestamp: expect.any(String),
    });
    expect(target.headers.get('x-request-id')).toBe('req-1');
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs the parameterised route rather than the concrete URL', () => {
    const logger = fakeLogger();
    new AllExceptionsFilter(logger).catch(Errors.forbidden(), fakeHost({ requestId: 'r' }).host);

    const [context] = logger.warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({ path: '/api/v1/sites/:id' });
  });

  it('logs an unexpected failure at error level with the cause attached', () => {
    const logger = fakeLogger();
    const cause = new Error('secret: db://user:pw@host/db');
    const target = fakeHost({ requestId: 'req-2' });

    new AllExceptionsFilter(logger).catch(cause, target.host);

    expect(target.status()).toBe(500);
    expect(target.body()).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_ERROR_MESSAGE,
    });
    expect(JSON.stringify(target.body())).not.toContain('db://');

    expect(logger.error).toHaveBeenCalledOnce();
    const [context] = logger.error.mock.calls[0] ?? [];
    expect(context).toMatchObject({ requestId: 'req-2', err: cause });
  });

  it('mints a request id when the request carries none', () => {
    const target = fakeHost();
    new AllExceptionsFilter(fakeLogger()).catch(Errors.forbidden(), target.host);

    expect(target.body()?.['requestId']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores an unsafe request id rather than reflecting it', () => {
    const target = fakeHost({ requestId: 'bad\nvalue' });
    new AllExceptionsFilter(fakeLogger()).catch(Errors.forbidden(), target.host);

    expect(target.body()?.['requestId']).not.toContain('\n');
  });

  it('ends the response instead of throwing when headers are already sent', () => {
    const logger = fakeLogger();
    const target = fakeHost({ headersSent: true, requestId: 'req-3' });

    new AllExceptionsFilter(logger).catch(new Error('late failure'), target.host);

    expect(target.end).toHaveBeenCalledOnce();
    expect(target.status()).toBeUndefined();
    // The failure is still recorded: a truncated response with no log line is
    // exactly the incident nobody can explain afterwards.
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
