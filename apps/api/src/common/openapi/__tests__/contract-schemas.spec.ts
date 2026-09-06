import * as contracts from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_ERROR_BODY_SCHEMA,
  buildContractSchemaRegistry,
  schemaComponentName,
  type JsonSchema,
} from '../contract-schemas.js';
import { errorResponseRef, schemaRef } from '../zod-api.decorators.js';

const registry = buildContractSchemaRegistry();

describe('schemaComponentName', () => {
  it.each([
    ['loginRequestSchema', 'LoginRequest'],
    ['authUserSchema', 'AuthUser'],
    ['paginationQuerySchema', 'PaginationQuery'],
  ])('turns %s into %s', (exportName, expected) => {
    expect(schemaComponentName(exportName)).toBe(expected);
  });
});

describe('buildContractSchemaRegistry', () => {
  it('converts every exported contract schema, with none skipped', () => {
    const exportedSchemas = Object.entries(contracts).filter(
      ([, value]) => value instanceof z.ZodType,
    );

    expect(exportedSchemas.length).toBeGreaterThan(30);
    expect(Object.keys(registry.components)).toHaveLength(exportedSchemas.length);

    for (const [exportName] of exportedSchemas) {
      expect(registry.components).toHaveProperty(schemaComponentName(exportName));
    }
  });

  it('documents a request schema by its input shape', () => {
    // `paginationQuerySchema` accepts `?page=2` as a string and produces a
    // number, and defaults both fields. Publishing the output shape would
    // document a contract that every real query violates.
    //
    // The properties are asserted alongside the absent `required`, because
    // "contains no `required`" is equally true of `{}` — the assertion would
    // survive the schema being dropped altogether.
    const pagination = registry.components['PaginationQuery'] as
      | { type?: string; properties?: Record<string, unknown>; required?: unknown }
      | undefined;

    expect(pagination?.type).toBe('object');
    expect(Object.keys(pagination?.properties ?? {})).toEqual(
      expect.arrayContaining(['page', 'pageSize']),
    );
    expect(pagination?.required).toBeUndefined();
  });

  it('documents a response schema by its output shape', () => {
    expect(registry.components['AuthTokens']).toMatchObject({
      required: expect.arrayContaining(['accessToken', 'refreshToken', 'expiresIn']),
    });
  });

  it('emits OpenAPI 3.0 flavoured JSON Schema', () => {
    // Draft 2020-12 would emit `exclusiveMinimum` as a number and `$defs`, which
    // Swagger UI 3.0 does not understand.
    expect(JSON.stringify(registry.components)).not.toContain('$schema');
    expect(JSON.stringify(registry.components)).not.toContain('$defs');
  });

  it('indexes schemas back to their component names', () => {
    expect(registry.nameBySchema.get(contracts.loginRequestSchema)).toBe('LoginRequest');
  });
});

describe('schemaRef', () => {
  it('references a contract schema rather than inlining it', () => {
    expect(schemaRef(contracts.loginRequestSchema)).toEqual({
      $ref: '#/components/schemas/LoginRequest',
    });
  });

  it('inlines a schema declared outside the contracts package', () => {
    const local = z.object({ note: z.string() });
    expect(schemaRef(local)).toMatchObject({ type: 'object' });
  });

  it('points errors at the shared envelope', () => {
    expect(errorResponseRef()).toEqual({ $ref: '#/components/schemas/ApiErrorBody' });
  });
});

describe('API_ERROR_BODY_SCHEMA', () => {
  it('enumerates every error code the API can return', () => {
    const codes = (API_ERROR_BODY_SCHEMA['properties'] as Record<string, { enum: string[] }>)[
      'code'
    ]?.enum;
    expect(codes).toEqual(expect.arrayContaining(Object.values(contracts.ErrorCode)));
  });

  it('requires the correlation fields a client needs to report a failure', () => {
    expect(API_ERROR_BODY_SCHEMA['required']).toEqual(
      expect.arrayContaining(['statusCode', 'code', 'message', 'requestId', 'timestamp']),
    );
  });

  it('does not claim requestId is a UUID', () => {
    // A caller-supplied `x-request-id` is echoed back whenever it satisfies
    // `sanitizeRequestId`, so most real ids are not UUIDs. A generated client
    // validating `format: uuid` would reject the very responses it needs in order
    // to report a failure.
    const requestId = (API_ERROR_BODY_SCHEMA['properties'] as Record<string, JsonSchema>)[
      'requestId'
    ];
    expect(requestId).toMatchObject({ type: 'string' });
    expect(requestId?.['format']).toBeUndefined();
  });
});
