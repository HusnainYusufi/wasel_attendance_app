import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/index.js';

/** Every `$ref` string anywhere in the document. */
function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') found.push(value);
    else collectRefs(value, found);
  }
  return found;
}

function resolveRef(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

describe('OpenAPI documentation', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ env: { SWAGGER_ENABLED: 'true' } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('serves Swagger UI outside the versioned prefix', async () => {
    const response = await ctx.http.get('/api/docs').expect(200);
    expect(response.text).toContain('Swagger UI');
  });

  it('publishes schemas derived from the Zod contracts', async () => {
    const response = await ctx.http.get('/api/docs-json').expect(200);
    const schemas = response.body.components.schemas as Record<string, unknown>;

    expect(response.body.openapi).toMatch(/^3\./);
    expect(Object.keys(schemas).length).toBeGreaterThan(30);
    expect(schemas['LoginRequest']).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['email', 'password']),
    });
    expect(schemas['ApiErrorBody']).toMatchObject({
      required: expect.arrayContaining(['statusCode', 'code', 'message', 'requestId']),
    });
  });

  it('documents a query schema by its input shape, so page arrives as a string', async () => {
    const response = await ctx.http.get('/api/docs-json').expect(200);
    const schemas = response.body.components.schemas as Record<
      string,
      { properties?: Record<string, unknown>; required?: unknown }
    >;

    // `paginationQuerySchema` coerces `?page=2` into a number and defaults both
    // fields; documenting the output shape would publish a contract every real
    // request violates. Asserting the properties as well, because "no `required`"
    // is also true of `{}`.
    const pagination = schemas['PaginationQuery'];
    expect(Object.keys(pagination?.properties ?? {})).toEqual(
      expect.arrayContaining(['page', 'pageSize']),
    );
    expect(pagination?.required).toBeUndefined();
  });

  it('joins its own server URL to its own paths without doubling the prefix', async () => {
    // `.addServer('/api/v1')` while Nest's scanner already emits the prefix made
    // every documented path resolve to `/api/v1/api/v1/...` — a 404 for every
    // "Try it out" and every generated client.
    const document = (await ctx.http.get('/api/docs-json').expect(200)).body as {
      servers?: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };

    const base = document.servers?.[0]?.url ?? '';
    const documentedPath = Object.keys(document.paths).find((path) =>
      path.endsWith('/health/live'),
    );
    expect(documentedPath).toBeDefined();

    const response = await ctx.http.get(`${base}${documentedPath as string}`);
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(200);
  });

  it('resolves every $ref it publishes', async () => {
    // A document that references a component it does not define renders as an
    // empty box in Swagger UI and fails outright in a client generator.
    const document = (await ctx.http.get('/api/docs-json').expect(200)).body as Record<
      string,
      unknown
    >;

    const refs = [...new Set(collectRefs(document))];
    expect(refs.length).toBeGreaterThan(0);

    const unresolved = refs.filter((ref) => resolveRef(document, ref) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('relaxes the content security policy only on the docs route', async () => {
    const docs = await ctx.http.get('/api/docs').expect(200);
    const api = await ctx.http.get('/api/v1/health/live').expect(200);

    expect(docs.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(api.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('marks API responses uncacheable and emits no ETag', async () => {
    const api = await ctx.http.get('/api/v1/health/live').expect(200);

    expect(api.headers['cache-control']).toBe('no-store');
    expect(api.headers['etag']).toBeUndefined();
  });
});

describe('OpenAPI when disabled', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ env: { SWAGGER_ENABLED: 'false' } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('does not expose the documentation', async () => {
    const response = await ctx.http.get('/api/docs').expect(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
