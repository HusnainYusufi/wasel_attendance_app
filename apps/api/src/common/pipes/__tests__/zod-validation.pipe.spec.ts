import type { ArgumentMetadata } from '@nestjs/common';
import { ErrorCode, emailSchema, paginationQuerySchema } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppException } from '../../errors/app.exception.js';
import { formatIssuePath, formatZodIssues } from '../zod-issue-formatter.js';
import { ZodValidationPipe } from '../zod-validation.pipe.js';

const META: ArgumentMetadata = { type: 'body' };

function runPipe<T extends z.ZodType>(schema: T, value: unknown): unknown {
  return new ZodValidationPipe(schema).transform(value, META);
}

function detailsOf(schema: z.ZodType, value: unknown): Array<{ path: string; message: string }> {
  try {
    runPipe(schema, value);
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const exception = error as AppException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.code).toBe(ErrorCode.VALIDATION_FAILED);
    return exception.details ?? [];
  }
  throw new Error('expected the pipe to reject');
}

describe('formatIssuePath', () => {
  it.each([
    [[], ''],
    [['email'], 'email'],
    [['user', 'email'], 'user.email'],
    [['items', 0, 'id'], 'items.0.id'],
    [['a', 1, 'b', 2], 'a.1.b.2'],
  ])('joins %j into %s', (path, expected) => {
    expect(formatIssuePath(path)).toBe(expected);
  });
});

describe('ZodValidationPipe', () => {
  it('returns the schema output, not the raw input', () => {
    // `emailSchema` trims and lowercases: handing the handler the raw value is how
    // `Ali@x.com` and `ali@x.com` become two accounts.
    expect(runPipe(emailSchema, '  Ali@Example.COM ')).toBe('ali@example.com');
  });

  it('applies coercion and defaults from a query schema', () => {
    expect(runPipe(paginationQuerySchema, {})).toEqual({ page: 1, pageSize: 25 });
    expect(runPipe(paginationQuerySchema, { page: '4', pageSize: '10' })).toEqual({
      page: 4,
      pageSize: 10,
    });
  });

  it('reports a nested path with dots', () => {
    const schema = z.object({ user: z.object({ email: z.string().email('bad email') }) });
    expect(detailsOf(schema, { user: { email: 'nope' } })).toEqual([
      { path: 'user.email', message: 'bad email' },
    ]);
  });

  it('reports an array index as a path segment', () => {
    const schema = z.object({ items: z.array(z.object({ id: z.string().uuid('bad id') })) });
    expect(detailsOf(schema, { items: [{ id: 'ok-not' }, { id: 'also-not' }] })).toEqual([
      { path: 'items.0.id', message: 'bad id' },
      { path: 'items.1.id', message: 'bad id' },
    ]);
  });

  it('reports every failing field, not only the first', () => {
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    const paths = detailsOf(schema, {}).map((detail) => detail.path);
    expect(paths).toEqual(['a', 'b', 'c']);
  });

  it('uses an empty path for a form-level refinement', () => {
    const schema = z.object({ from: z.string(), to: z.string() }).refine((v) => v.from <= v.to, {
      message: 'from must precede to',
    });
    expect(detailsOf(schema, { from: 'b', to: 'a' })).toEqual([
      { path: '', message: 'from must precede to' },
    ]);
  });

  it('honours an explicit path on a refinement', () => {
    const schema = z
      .object({ from: z.string(), to: z.string() })
      .refine((v) => v.from <= v.to, { message: 'bad range', path: ['from'] });
    expect(detailsOf(schema, { from: 'b', to: 'a' })[0]?.path).toBe('from');
  });

  it('rejects a null body rather than passing it through', () => {
    expect(detailsOf(z.object({ a: z.string() }), null).length).toBeGreaterThan(0);
  });

  it('does not echo the rejected value in the details', () => {
    const schema = z.object({ password: z.string().min(50, 'too short') });
    const details = detailsOf(schema, { password: 'hunter2' });
    expect(JSON.stringify(details)).not.toContain('hunter2');
  });
});

describe('formatZodIssues', () => {
  it('maps issues to path/message pairs', () => {
    const result = z.object({ n: z.number() }).safeParse({ n: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodIssues(result.error.issues)).toEqual([
      { path: 'n', message: expect.any(String) },
    ]);
  });
});

describe('named argument paths', () => {
  const PARAM_META: ArgumentMetadata = { type: 'param', data: 'id' };

  it('names the argument a scalar failure belongs to', () => {
    // `@ZodParam('id', uuidSchema)` used to report `path: ''`, indistinguishable
    // from a form-level error and unattachable to an input.
    try {
      new ZodValidationPipe(z.string().uuid('Must be a valid UUID')).transform('nope', PARAM_META);
    } catch (error) {
      expect((error as AppException).details).toEqual([
        { path: 'id', message: 'Must be a valid UUID' },
      ]);
      return;
    }
    throw new Error('expected the pipe to reject');
  });

  it('prefixes a nested path with the argument name', () => {
    const schema = z.object({ from: z.string().min(3, 'too short') });
    try {
      new ZodValidationPipe(schema).transform({ from: 'x' }, { type: 'query', data: 'range' });
    } catch (error) {
      expect((error as AppException).details).toEqual([
        { path: 'range.from', message: 'too short' },
      ]);
      return;
    }
    throw new Error('expected the pipe to reject');
  });

  it('leaves the path alone when the decorator addressed no single argument', () => {
    expect(detailsOf(z.object({ a: z.string() }), {})).toEqual([
      { path: 'a', message: expect.any(String) },
    ]);
  });
});
