import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '@wasel/contracts';
import { GENERIC_ERROR_MESSAGE } from '../../src/common/filters/error-mapping.js';
import { LEAKED_SECRET, ProbeModule } from '../support/probe.module.js';
import { createTestApp, type TestApp } from '../support/index.js';

const UUID = '3f1a1b2c-1111-4222-8333-444455556666';

describe('error envelope', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [ProbeModule] });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('never leaks the cause of an unhandled error', async () => {
    const response = await ctx.http.get('/api/v1/__probe/unhandled').expect(500);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(LEAKED_SECRET);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('stack');
    expect(serialised).not.toContain('at Object');

    expect(response.body).toEqual({
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_ERROR_MESSAGE,
      requestId: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('logs the real cause against the request id the client received', async () => {
    ctx.logs.clear();
    const response = await ctx.http.get('/api/v1/__probe/unhandled').expect(500);

    const logged = ctx.logs
      .records()
      .filter((record) => record['requestId'] === response.body.requestId);
    expect(logged.length).toBeGreaterThan(0);
    expect(ctx.logs.raw()).toContain(LEAKED_SECRET);
  });

  it('preserves the status and code of an AppException', async () => {
    const response = await ctx.http.get('/api/v1/__probe/app-error').expect(404);
    expect(response.body).toMatchObject({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'Site not found',
    });
  });

  it('maps a Prisma unique violation to 409 without naming the columns', async () => {
    const response = await ctx.http.get('/api/v1/__probe/conflict').expect(409);

    expect(response.body).toMatchObject({ statusCode: 409, code: ErrorCode.CONFLICT });
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('organizationId');
    expect(serialised).not.toContain('Unique constraint');
    expect(serialised).not.toContain('P2002');
  });

  it('maps a Prisma missing-record error to 404', async () => {
    const response = await ctx.http.get('/api/v1/__probe/prisma-missing').expect(404);
    expect(response.body).toMatchObject({ statusCode: 404, code: ErrorCode.NOT_FOUND });
    expect(JSON.stringify(response.body)).not.toContain('P2025');
  });

  it('answers an unknown route with the envelope, not an HTML page', async () => {
    const response = await ctx.http.get('/api/v1/does-not-exist').expect(404);
    expect(response.headers['content-type']).toContain('application/json');
    // Pinned exactly: this is the fallback handler's own sentence, and it is the
    // only way to tell it apart from a router-produced 404 that happens to carry
    // the same status.
    expect(response.body).toMatchObject({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'The requested endpoint does not exist',
    });
  });

  it('answers an unknown route outside the API prefix with the envelope', async () => {
    const response = await ctx.http.get('/totally/elsewhere').expect(404);
    expect(response.body).toMatchObject({
      code: ErrorCode.NOT_FOUND,
      message: 'The requested endpoint does not exist',
    });
  });

  it('does not reflect a malformed request body back to the caller', async () => {
    // body-parser's own message quotes the body verbatim. It is the caller's own
    // input, so not a cross-user disclosure — but the envelope's contract is that
    // the message is always one of ours, and a client may show it to a user.
    const response = await ctx.http
      .post('/api/v1/__probe/validate')
      .set('Content-Type', 'application/json')
      .send('this-is-not-json{{{')
      .expect(400);

    expect(response.body).toMatchObject({ statusCode: 400, code: ErrorCode.VALIDATION_FAILED });
    expect(JSON.stringify(response.body)).not.toContain('this-is-not-json');
    expect(JSON.stringify(response.body)).not.toContain('Unexpected token');
  });

  it('rejects an oversized body with 413 from the exception filter, not the terminal handler', async () => {
    // Two code paths can produce this identical 413 — `mapException` when the
    // parser error reaches the Nest filter, and `createFinalErrorHandler` when it
    // escapes the router — so the response body alone cannot say which fired. The
    // log line can, and the answer is the filter: body parsing happens inside
    // Nest's middleware chain, so the terminal handler's 413 branch only covers
    // middleware mounted outside Nest and is unreachable from a request.
    ctx.logs.clear();
    const response = await ctx.http
      .post('/api/v1/__probe/validate')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(400_000) })
      .expect(413);

    expect(response.body).toMatchObject({
      statusCode: 413,
      code: ErrorCode.VALIDATION_FAILED,
    });
    expect(ctx.logs.raw()).toContain('AllExceptionsFilter');
    expect(ctx.logs.raw()).not.toContain('Request failed outside the router');
  });

  it('answers 413 with the envelope even for a URL that matches no route', async () => {
    // Same path, different entry point: the parser rejects the body before
    // routing, so the answer must still be the envelope rather than Express's
    // finalhandler HTML.
    const response = await ctx.http
      .post('/totally/elsewhere')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(400_000) })
      .expect(413);

    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      statusCode: 413,
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('echoes a safe inbound request id and replaces an unsafe one', async () => {
    const clean = await ctx.http
      .get('/api/v1/__probe/ok')
      .set('x-request-id', 'trace-abc.123')
      .expect(200);
    expect(clean.headers['x-request-id']).toBe('trace-abc.123');

    const dirty = await ctx.http
      .get('/api/v1/__probe/ok')
      .set('x-request-id', 'evil injected')
      .expect(200);
    expect(dirty.headers['x-request-id']).not.toBe('evil injected');
    expect(dirty.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('validation failures', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [ProbeModule] });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('reports dot-joined paths for nested and indexed fields', async () => {
    const response = await ctx.http
      .post('/api/v1/__probe/validate')
      .send({ user: { email: 'nope', age: 12 }, items: [{ id: 'not-a-uuid' }] })
      .expect(400);

    expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    const paths = (response.body.details as Array<{ path: string }>).map((detail) => detail.path);
    expect(paths).toEqual(expect.arrayContaining(['user.email', 'user.age', 'items.0.id']));
  });

  it('returns parsed, transformed output to the handler', async () => {
    const response = await ctx.http
      .post('/api/v1/__probe/validate')
      .send({ user: { email: 'a@b.co', age: 30 }, items: [{ id: UUID }] })
      .expect(201);

    expect(response.body).toEqual({ user: { email: 'a@b.co', age: 30 }, items: [{ id: UUID }] });
  });

  it('coerces and defaults query parameters', async () => {
    const defaults = await ctx.http.get('/api/v1/__probe/paginate').expect(200);
    expect(defaults.body).toEqual({ page: 1, pageSize: 25 });

    const explicit = await ctx.http.get('/api/v1/__probe/paginate?page=3&pageSize=50').expect(200);
    expect(explicit.body).toEqual({ page: 3, pageSize: 50 });

    const invalid = await ctx.http.get('/api/v1/__probe/paginate?pageSize=5000').expect(400);
    expect((invalid.body.details as Array<{ path: string }>)[0]?.path).toBe('pageSize');
  });

  it('validates a single route parameter', async () => {
    await ctx.http.get(`/api/v1/__probe/entity/${UUID}`).expect(200, { id: UUID });

    const bad = await ctx.http.get('/api/v1/__probe/entity/nope').expect(400);
    expect(bad.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    // The parameter's own name, not an empty path: a client with three uuid
    // parameters on one route cannot otherwise tell which one it got wrong.
    expect(bad.body.details).toEqual([{ path: 'id', message: 'Must be a valid UUID' }]);
  });
});
