import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  API_ERROR_BODY_COMPONENT,
  contractSchemaRegistry,
  type JsonSchema,
} from './contract-schemas.js';

/**
 * `$ref` for a contract schema, falling back to an inline JSON Schema for a
 * locally-declared one. The fallback matters because a controller may compose a
 * one-off shape that never belonged in `@wasel/contracts`.
 */
export function schemaRef(schema: ZodType): JsonSchema {
  const name = contractSchemaRegistry().nameBySchema.get(schema);
  if (name) return { $ref: `#/components/schemas/${name}` };
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
    cycles: 'ref',
  });
}

export const errorResponseRef = (): JsonSchema => ({
  $ref: `#/components/schemas/${API_ERROR_BODY_COMPONENT}`,
});

/** Documents the request body using the same schema that validates it. */
export const ApiZodBody = (schema: ZodType): MethodDecorator =>
  ApiBody({ schema: schemaRef(schema) });

export const ApiZodResponse = (
  status: number,
  schema: ZodType,
  description?: string,
): MethodDecorator =>
  ApiResponse({ status, ...(description ? { description } : {}), schema: schemaRef(schema) });

/**
 * Documents the failure statuses a route can produce. Every one of them carries
 * the `ApiErrorBody` envelope, so the shape is asserted once here rather than
 * repeated per route.
 */
export const ApiErrorResponses = (...statuses: number[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: 'Error envelope', schema: errorResponseRef() }),
    ),
  );
