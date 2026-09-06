import * as contracts from '@wasel/contracts';
import { z, type ZodType } from 'zod';

export type JsonSchema = Record<string, unknown>;

/**
 * Schemas whose *input* shape is what a client sends. Everything else is
 * documented by its output shape, which is what a client receives.
 *
 * The distinction is load-bearing: `paginationQuerySchema` accepts
 * `?page=2` (a string) and produces a number, and `emailSchema` accepts any case
 * and produces lowercase. Documenting one side for both directions would publish
 * a contract that half of the traffic violates.
 */
const INPUT_SCHEMA_SUFFIXES = /(?:Request|Query|Params|Body)Schema$/;

/** `loginRequestSchema` → `LoginRequest`; `authUserSchema` → `AuthUser`. */
export function schemaComponentName(exportName: string): string {
  const base = exportName.replace(/Schema$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function isZodSchema(value: unknown): value is ZodType {
  return value instanceof z.ZodType;
}

export interface ContractSchemaRegistry {
  /** OpenAPI `components.schemas`, keyed by component name. */
  components: Record<string, JsonSchema>;
  /** Reverse index so a decorator can turn a schema object into a `$ref`. */
  nameBySchema: Map<ZodType, string>;
}

/**
 * Builds `components.schemas` straight from `@wasel/contracts`.
 *
 * Enumerating the package's exports — rather than listing schemas here — is the
 * whole point: a contract added tomorrow appears in the documentation with no
 * edit to this file, and no parallel set of DTO classes can drift out of sync
 * with the schemas that actually validate the traffic.
 */
export function buildContractSchemaRegistry(): ContractSchemaRegistry {
  const components: Record<string, JsonSchema> = {};
  const nameBySchema = new Map<ZodType, string>();

  for (const [exportName, value] of Object.entries(contracts)) {
    if (!isZodSchema(value)) continue;

    const name = schemaComponentName(exportName);
    components[name] = z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: INPUT_SCHEMA_SUFFIXES.test(exportName) ? 'input' : 'output',
      // `.transform()` has no JSON Schema equivalent; documenting the surrounding
      // shape is far more useful than refusing to emit the schema at all.
      unrepresentable: 'any',
      cycles: 'ref',
    });
    nameBySchema.set(value, name);
  }

  return { components, nameBySchema };
}

let memoised: ContractSchemaRegistry | null = null;

/**
 * The registry, built once. Derived entirely from static module exports, so
 * rebuilding it per decorator would re-run every schema conversion on every
 * controller in the application.
 */
export function contractSchemaRegistry(): ContractSchemaRegistry {
  memoised ??= buildContractSchemaRegistry();
  return memoised;
}

/** Hand-written because `ApiErrorBody` is a TypeScript interface, not a schema. */
export const API_ERROR_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['statusCode', 'code', 'message', 'requestId', 'timestamp'],
  properties: {
    statusCode: { type: 'integer', example: 400 },
    code: { type: 'string', enum: Object.values(contracts.ErrorCode) },
    message: { type: 'string' },
    details: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'message'],
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
    // Not `format: uuid`: a caller-supplied `x-request-id` is echoed back
    // whenever it matches `sanitizeRequestId`, so most real ids are not UUIDs and
    // a generated client would reject the very responses it needs to report.
    requestId: { type: 'string', example: '3f1a1b2c-1111-4222-8333-444455556666' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

export const API_ERROR_BODY_COMPONENT = 'ApiErrorBody';
