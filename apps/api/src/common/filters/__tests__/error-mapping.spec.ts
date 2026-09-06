import { BadRequestException, HttpException, InternalServerErrorException } from '@nestjs/common';
import { ErrorCode } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppException, Errors } from '../../errors/app.exception.js';
import { GENERIC_ERROR_MESSAGE, mapException, statusToErrorCode } from '../error-mapping.js';

function prismaError(code: string): Error {
  const error = new Error(`Prisma failure on table "users" column "email" (${code})`);
  error.name = 'PrismaClientKnownRequestError';
  Object.assign(error, { code, meta: { target: ['email'] } });
  return error;
}

describe('statusToErrorCode', () => {
  it.each([
    [401, ErrorCode.UNAUTHENTICATED],
    [403, ErrorCode.FORBIDDEN],
    [404, ErrorCode.NOT_FOUND],
    [409, ErrorCode.CONFLICT],
    [429, ErrorCode.RATE_LIMITED],
    [400, ErrorCode.VALIDATION_FAILED],
    [415, ErrorCode.VALIDATION_FAILED],
    [500, ErrorCode.INTERNAL_ERROR],
    [502, ErrorCode.INTERNAL_ERROR],
  ])('maps %i', (status, expected) => {
    expect(statusToErrorCode(status)).toBe(expected);
  });
});

describe('mapException', () => {
  it('passes an AppException through unchanged', () => {
    const mapped = mapException(Errors.conflict(ErrorCode.EMAIL_TAKEN, 'Email already registered'));

    expect(mapped).toMatchObject({
      statusCode: 409,
      code: ErrorCode.EMAIL_TAKEN,
      message: 'Email already registered',
      expected: true,
    });
  });

  it('keeps validation details', () => {
    const details = [{ path: 'user.email', message: 'Enter a valid email address' }];
    expect(mapException(Errors.validation(details)).details).toEqual(details);
  });

  it('treats a 5xx AppException as unexpected so it is logged at error level', () => {
    expect(mapException(new AppException(503, ErrorCode.INTERNAL_ERROR, 'down')).expected).toBe(
      false,
    );
  });

  it('converts a stray ZodError into a validation failure', () => {
    const result = z.object({ email: z.string().email() }).safeParse({ email: 'nope' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const mapped = mapException(result.error);
    expect(mapped.statusCode).toBe(400);
    expect(mapped.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(mapped.details?.[0]?.path).toBe('email');
  });

  it('maps P2002 to a conflict without echoing the column names', () => {
    const mapped = mapException(prismaError('P2002'));

    expect(mapped.statusCode).toBe(409);
    expect(mapped.code).toBe(ErrorCode.CONFLICT);
    expect(mapped.message).not.toContain('email');
    expect(mapped.message).not.toContain('users');
  });

  it('maps P2025 to not found', () => {
    expect(mapException(prismaError('P2025'))).toMatchObject({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('maps P2003 to a conflict', () => {
    expect(mapException(prismaError('P2003'))).toMatchObject({
      statusCode: 409,
      code: ErrorCode.CONFLICT,
    });
  });

  it('treats an unmapped Prisma code as a server fault, not a client error', () => {
    const mapped = mapException(prismaError('P2010'));

    expect(mapped.statusCode).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(mapped.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(mapped.expected).toBe(false);
  });

  it('maps a framework HttpException by status without echoing its message', () => {
    // body-parser rejects malformed JSON with a message that quotes the request
    // body verbatim. Only messages this codebase wrote may cross the wire.
    const mapped = mapException(
      new BadRequestException('Unexpected token \'t\', "this-is-not-json{{{" is not valid JSON'),
    );

    expect(mapped).toMatchObject({ statusCode: 400, code: ErrorCode.VALIDATION_FAILED });
    expect(mapped.message).not.toContain('this-is-not-json');
    expect(mapped.message).toBe('The request could not be processed');
  });

  it('does not echo the array of messages Nest sometimes produces', () => {
    const mapped = mapException(new BadRequestException(['first-leak', 'second-leak']));

    expect(mapped.message).not.toContain('first-leak');
    expect(mapped.message).not.toContain('second-leak');
  });

  it('keeps an AppException message the codebase wrote, below 500', () => {
    expect(mapException(Errors.notFound('Site')).message).toBe('Site not found');
  });

  it('replaces the message of a 5xx AppException, whoever raised it', () => {
    // `Errors.internal()` is safe by default, but `AppException` takes free text
    // and the tempting thing to pass is the cause's own message.
    const mapped = mapException(
      new AppException(
        500,
        ErrorCode.INTERNAL_ERROR,
        'pg: connection to 10.0.0.5:5432 failed for user wasel',
      ),
    );

    expect(mapped.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(mapped.message).not.toContain('10.0.0.5');
    expect(mapped.message).not.toContain('wasel');
    expect(mapped.expected).toBe(false);
  });

  it('keeps the author-written details of a 5xx AppException', () => {
    // Details are always written here, never derived from an internal failure,
    // so they are what tells an operator which dependency is down.
    const mapped = mapException(
      new AppException(503, ErrorCode.INTERNAL_ERROR, 'Service is not ready', [
        { path: 'database', message: 'unreachable' },
      ]),
    );

    expect(mapped.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(mapped.details).toEqual([{ path: 'database', message: 'unreachable' }]);
  });

  it('replaces the message of a 5xx HttpException with a generic one', () => {
    const mapped = mapException(
      new InternalServerErrorException('connect ECONNREFUSED 10.0.0.5:5432'),
    );

    expect(mapped.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(mapped.message).not.toContain('10.0.0.5');
    expect(mapped.expected).toBe(false);
  });

  it('normalises the throttler message', () => {
    const mapped = mapException(new HttpException('ThrottlerException: Too many requests', 429));

    expect(mapped.code).toBe(ErrorCode.RATE_LIMITED);
    expect(mapped.message).not.toContain('ThrottlerException');
  });

  it('maps an oversized payload to 413 rather than a server fault', () => {
    const error = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });

    expect(mapException(error)).toMatchObject({
      statusCode: 413,
      code: ErrorCode.VALIDATION_FAILED,
      expected: true,
    });
  });

  it.each([
    new Error('boom: password=hunter2'),
    'a thrown string',
    { weird: true },
    null,
    undefined,
  ])('reduces anything unrecognised to a generic 500', (thrown) => {
    const mapped = mapException(thrown);

    expect(mapped).toEqual({
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_ERROR_MESSAGE,
      expected: false,
    });
    expect(JSON.stringify(mapped)).not.toContain('hunter2');
  });
});
