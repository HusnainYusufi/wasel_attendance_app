import type { Request, Response } from 'express';
import { ErrorCode } from '@wasel/contracts';
import { describe, expect, it, vi } from 'vitest';
import { GENERIC_ERROR_MESSAGE } from '../error-mapping.js';
import { createFinalErrorHandler, createNotFoundHandler } from '../fallback-handlers.js';

interface CapturedResponse {
  response: Response;
  status: () => number | undefined;
  body: () => Record<string, unknown> | undefined;
  headers: Map<string, string>;
}

function fakeResponse(headersSent = false): CapturedResponse {
  let status: number | undefined;
  let body: Record<string, unknown> | undefined;
  const headers = new Map<string, string>();

  const response = {
    headersSent,
    setHeader: (name: string, value: string) => headers.set(name, value),
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  return { response, status: () => status, body: () => body, headers };
}

function fakeRequest(headers: Record<string, string> = {}): Request {
  return { headers, url: '/somewhere' } as unknown as Request;
}

describe('createNotFoundHandler', () => {
  it('answers an unmatched route with the error envelope', () => {
    const captured = fakeResponse();
    createNotFoundHandler()(fakeRequest(), captured.response, vi.fn());

    expect(captured.status()).toBe(404);
    expect(captured.body()).toMatchObject({ statusCode: 404, code: ErrorCode.NOT_FOUND });
    expect(captured.headers.get('x-request-id')).toEqual(expect.any(String));
  });

  it('reuses a safe inbound request id', () => {
    const captured = fakeResponse();
    createNotFoundHandler()(
      fakeRequest({ 'x-request-id': 'inbound-1' }),
      captured.response,
      vi.fn(),
    );

    expect(captured.body()).toMatchObject({ requestId: 'inbound-1' });
  });

  it('steps aside once the response has begun', () => {
    const captured = fakeResponse(true);
    const next = vi.fn();
    createNotFoundHandler()(fakeRequest(), captured.response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(captured.status()).toBeUndefined();
  });
});

describe('createFinalErrorHandler', () => {
  it('maps an oversized payload to 413', () => {
    const captured = fakeResponse();
    const onError = vi.fn();
    const error = Object.assign(new Error('too large'), { type: 'entity.too.large' });

    createFinalErrorHandler(onError)(error, fakeRequest(), captured.response, vi.fn());

    expect(captured.status()).toBe(413);
    expect(captured.body()).toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('never forwards the message of a middleware error', () => {
    const captured = fakeResponse();
    const error = Object.assign(new Error('ENOENT /etc/wasel/private.pem'), { status: 400 });

    createFinalErrorHandler(vi.fn())(error, fakeRequest(), captured.response, vi.fn());

    expect(captured.status()).toBe(400);
    expect(JSON.stringify(captured.body())).not.toContain('private.pem');
  });

  it('falls back to a generic 500 for an unclassified failure', () => {
    const captured = fakeResponse();
    createFinalErrorHandler(vi.fn())(
      new Error('db password leak: hunter2'),
      fakeRequest(),
      captured.response,
      vi.fn(),
    );

    expect(captured.status()).toBe(500);
    expect(captured.body()).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_ERROR_MESSAGE,
    });
    expect(JSON.stringify(captured.body())).not.toContain('hunter2');
  });

  it('reports the failure to the logger callback with the request id', () => {
    const captured = fakeResponse();
    const onError = vi.fn();
    const error = new Error('boom');

    createFinalErrorHandler(onError)(
      error,
      fakeRequest({ 'x-request-id': 'trace-9' }),
      captured.response,
      vi.fn(),
    );

    expect(onError).toHaveBeenCalledWith(error, 'trace-9');
  });

  it('delegates when the response is already streaming', () => {
    const captured = fakeResponse(true);
    const next = vi.fn();
    const error = new Error('late');

    createFinalErrorHandler(vi.fn())(error, fakeRequest(), captured.response, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(captured.status()).toBeUndefined();
  });
});
