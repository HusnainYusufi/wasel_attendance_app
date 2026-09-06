import { HttpException } from '@nestjs/common';
import { ErrorCode } from '@wasel/contracts';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The one exception type the API throws on purpose.
 *
 * It carries a stable machine-readable `code` alongside the HTTP status so the
 * global filter can render the `ApiErrorBody` envelope without inspecting
 * anything framework-specific, and so clients can branch on `code` rather than
 * on prose that is free to change.
 */
export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super({ code, message, ...(details ? { details } : {}) }, status);
    this.name = 'AppException';
  }
}

/**
 * Named constructors for every failure the client is expected to understand.
 * Prefer these over `new AppException(...)`: they keep status and code paired
 * correctly, which is the pairing that silently rots when written by hand.
 */
export const Errors = {
  validation(details: ErrorDetail[], message = 'Validation failed'): AppException {
    return new AppException(400, ErrorCode.VALIDATION_FAILED, message, details);
  },

  invalidCredentials(): AppException {
    // Deliberately does not distinguish "no such user" from "wrong password":
    // the difference is a free account-enumeration oracle.
    return new AppException(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
  },

  unauthenticated(
    code: ErrorCode = ErrorCode.UNAUTHENTICATED,
    message = 'Authentication is required',
  ): AppException {
    return new AppException(401, code, message);
  },

  forbidden(message = 'You do not have access to this resource'): AppException {
    return new AppException(403, ErrorCode.FORBIDDEN, message);
  },

  notFound(entity: string): AppException {
    return new AppException(404, ErrorCode.NOT_FOUND, `${entity} not found`);
  },

  conflict(code: ErrorCode, message: string): AppException {
    return new AppException(409, code, message);
  },

  unprocessable(code: ErrorCode, message: string): AppException {
    return new AppException(422, code, message);
  },

  rateLimited(message = 'Too many requests; please slow down'): AppException {
    return new AppException(429, ErrorCode.RATE_LIMITED, message);
  },

  /**
   * Only for a genuinely unexpected condition the caller wants to surface with a
   * request id. Ordinary bugs should propagate: the filter turns any unknown
   * throwable into this same envelope without leaking the cause.
   *
   * Takes no message on purpose. The one every caller reaches for is the cause's
   * — `Errors.internal(err.message)` — and that is a connection string, a SQL
   * fragment or a file path on its way to the client. Put the detail in the log;
   * the client gets the request id and correlates.
   */
  internal(): AppException {
    return new AppException(500, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred');
  },
} as const;
