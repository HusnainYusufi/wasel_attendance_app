import { Body, Param, Query } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

/**
 * Validated request body. Annotate the parameter with `z.output<typeof schema>`
 * — the *output* type, since contract schemas transform as they parse.
 */
export const ZodBody = <T extends ZodType>(schema: T): ParameterDecorator =>
  Body(new ZodValidationPipe(schema));

/** Validated query string. Coercion and defaults come from the schema. */
export const ZodQuery = <T extends ZodType>(schema: T): ParameterDecorator =>
  Query(new ZodValidationPipe(schema));

/**
 * Validated route parameter(s).
 *
 * With one argument the whole `params` object is validated; with two, a single
 * named parameter is — the common case being `@ZodParam('id', uuidSchema)`,
 * which turns a malformed id into a 400 instead of letting it reach Postgres and
 * come back as a 500 from a failed uuid cast.
 */
export function ZodParam<T extends ZodType>(schema: T): ParameterDecorator;
export function ZodParam<T extends ZodType>(name: string, schema: T): ParameterDecorator;
export function ZodParam<T extends ZodType>(
  nameOrSchema: string | T,
  maybeSchema?: T,
): ParameterDecorator {
  if (typeof nameOrSchema === 'string') {
    if (!maybeSchema) throw new TypeError('ZodParam(name, schema) requires a schema');
    return Param(nameOrSchema, new ZodValidationPipe(maybeSchema));
  }
  return Param(new ZodValidationPipe(nameOrSchema));
}
