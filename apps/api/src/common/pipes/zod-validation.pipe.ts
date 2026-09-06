import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { Errors } from '../errors/app.exception.js';
import { formatZodIssues } from './zod-issue-formatter.js';

/**
 * Validates one handler argument against a contract schema.
 *
 * Returns the schema's **output**: contract schemas normalise as they validate
 * (`emailSchema` lowercases, `paginationQuerySchema` coerces strings to numbers
 * and applies defaults), so handing the handler the raw input would defeat the
 * point and reintroduce the `Ali@x.com` / `ali@x.com` duplicate-account class of
 * bug the contracts exist to prevent.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodType> implements PipeTransform<unknown, unknown> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // Nest puts the decorator's key here — `id` for `@Param('id', pipe)` — which
    // is the only place the name of a single-argument failure survives.
    const root =
      typeof metadata.data === 'string' && metadata.data.length > 0 ? metadata.data : undefined;
    throw Errors.validation(formatZodIssues(result.error.issues, root));
  }
}
