import { HttpException } from '@nestjs/common';
import { ErrorCode } from '@wasel/contracts';
import { ZodError } from 'zod';
import { AppException, type ErrorDetail } from '../errors/app.exception.js';
import { formatZodIssues } from '../pipes/zod-issue-formatter.js';
import { isKnownPrismaError, PrismaErrorCode } from '../../prisma/prisma-errors.js';

/**
 * What the client is allowed to be told about an unhandled failure. Anything more
 * specific risks echoing a SQL fragment, a file path or a schema detail.
 */
export const GENERIC_ERROR_MESSAGE = 'An unexpected error occurred';

export interface MappedError {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
  /** False when the failure is a server fault and must be logged at `error`. */
  expected: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Neutral wording for a failure this codebase did not author.
 *
 * A framework `HttpException` carries whatever message the framework felt like
 * writing, and body-parser's includes a verbatim slice of the request body —
 * `Unexpected token 't', "this-is-not-json{{{" is not valid JSON`. That is the
 * caller's own input rather than another user's, so it is not a disclosure, but
 * it does break the property the whole envelope rests on: the message is always
 * one of ours, and a client may therefore show it to a user.
 */
const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: 'The request could not be processed',
  401: 'Authentication is required',
  403: 'You do not have access to this resource',
  404: 'The requested resource was not found',
  405: 'That method is not allowed on this resource',
  406: 'The requested representation is not available',
  409: 'The request conflicts with the current state of the resource',
  413: 'Request payload is too large',
  415: 'That content type is not supported',
  422: 'The request could not be processed',
  429: 'Too many requests; please slow down',
};

function genericMessageForStatus(status: number): string {
  if (status >= 500) return GENERIC_ERROR_MESSAGE;
  return STATUS_MESSAGES[status] ?? 'The request could not be processed';
}

/**
 * Closest contract code for a framework-thrown `HttpException`.
 *
 * 422 falls back to `VALIDATION_FAILED` because there is no generic
 * "unprocessable" code; domain code should reach for `Errors.unprocessable()`
 * with a specific code (`OUT_OF_RANGE`, `NO_ACTIVE_SITE`, …) instead of relying
 * on this fallback.
 */
export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_FAILED;
  }
}

/**
 * Prisma's own error messages embed the model, column and constraint names, and
 * `meta.target` is literally a list of column names. None of that crosses the
 * wire: only the status and a neutral sentence do.
 */
function mapPrismaError(code: string): MappedError | null {
  switch (code) {
    case PrismaErrorCode.UNIQUE_VIOLATION:
      return {
        statusCode: 409,
        code: ErrorCode.CONFLICT,
        message: 'A record with these details already exists',
        expected: true,
      };
    case PrismaErrorCode.RECORD_NOT_FOUND:
      return {
        statusCode: 404,
        code: ErrorCode.NOT_FOUND,
        message: 'The requested record was not found',
        expected: true,
      };
    case PrismaErrorCode.FOREIGN_KEY_VIOLATION:
      return {
        statusCode: 409,
        code: ErrorCode.CONFLICT,
        message: 'The request references a record that does not exist',
        expected: true,
      };
    default:
      // An unmapped Prisma code means the query itself is wrong: a server fault.
      return null;
  }
}

/**
 * The 4xx status carried by a plain `http-errors` object, if any.
 *
 * body-parser and `raw-body` reject with these rather than with a Nest
 * `HttpException`, and Nest's Express adapter does not translate them: unmapped,
 * an oversized payload answers 500 (reading as a server bug rather than "your
 * request was too big") and a client that hangs up mid-upload — which is exactly
 * what a forced shutdown does to every in-flight request — logs an "unhandled
 * exception" at `error` for something that is nobody's fault.
 */
function clientErrorStatus(exception: unknown): number | null {
  if (!isRecord(exception)) return null;
  if (exception['type'] === 'entity.too.large') return 413;

  const status = exception['status'] ?? exception['statusCode'];
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  return status;
}

/** Projects any throwable onto the wire format. Never throws. */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppException) {
    const statusCode = exception.getStatus();
    const expected = statusCode < 500;
    return {
      statusCode,
      code: exception.code,
      // A 5xx is a server fault whoever raised it, and `AppException` takes a
      // free-text message: `Errors.internal(err.message)` is exactly how a
      // connection string or a SQL fragment reaches the client, which is what the
      // rest of this file exists to prevent. The author-written `details` survive,
      // because those are never derived from an internal failure.
      message: expected ? exception.message : GENERIC_ERROR_MESSAGE,
      ...(exception.details ? { details: exception.details } : {}),
      expected,
    };
  }

  if (exception instanceof ZodError) {
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Validation failed',
      details: formatZodIssues(exception.issues),
      expected: true,
    };
  }

  if (isKnownPrismaError(exception)) {
    const mapped = mapPrismaError(exception.code);
    if (mapped) return mapped;
  }

  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    return {
      statusCode,
      code: statusToErrorCode(statusCode),
      message: genericMessageForStatus(statusCode),
      expected: statusCode < 500,
    };
  }

  const status = clientErrorStatus(exception);
  if (status !== null) {
    return {
      statusCode: status,
      code: statusToErrorCode(status),
      message: genericMessageForStatus(status),
      expected: true,
    };
  }

  return {
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: GENERIC_ERROR_MESSAGE,
    expected: false,
  };
}
