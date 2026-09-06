import { ErrorCode, type ApiErrorBody } from '@wasel/contracts';

/**
 * Every failure the client can produce, as one discriminated union.
 *
 * Screens branch on `error.code` (an `ErrorCode` from the contract) or on the
 * `kind` of transport failure. They must never branch on `message`: the message
 * is free to change, be localised, or be replaced by a generic string for a
 * 500 — the code is the stable part of the contract.
 */
export type FailureKind = 'http' | 'network' | 'timeout' | 'canceled';

export interface FieldError {
  path: string;
  message: string;
}

/** A structured, non-2xx response carrying the `ApiErrorBody` envelope. */
export class ApiError extends Error {
  readonly kind: FailureKind = 'http';
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: FieldError[];
  readonly requestId: string | undefined;
  readonly timestamp: string | undefined;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = body.statusCode;
    this.code = body.code;
    this.details = body.details ?? [];
    this.requestId = body.requestId;
    this.timestamp = body.timestamp;
  }
}

/** The request never reached a server, or the response never arrived. */
export class NetworkError extends Error {
  readonly kind: FailureKind = 'network';
  constructor(cause?: unknown) {
    super('Cannot reach the server. Check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** The client's own deadline elapsed. Distinct from `NetworkError`: the request
 *  may well have been applied on the server, so a retry is not always safe. */
export class TimeoutError extends Error {
  readonly kind: FailureKind = 'timeout';
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super('The server took too long to respond.');
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The caller aborted deliberately — a navigation, a superseded query. Never
 *  surface this to the user; it is not a failure. */
export class RequestCanceledError extends Error {
  readonly kind: FailureKind = 'canceled';
  constructor() {
    super('Request canceled.');
    this.name = 'RequestCanceledError';
  }
}

export type RequestFailure = ApiError | NetworkError | TimeoutError | RequestCanceledError;

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isErrorCode(error: unknown, ...codes: ErrorCode[]): boolean {
  return isApiError(error) && codes.includes(error.code);
}

export function isCanceled(error: unknown): error is RequestCanceledError {
  return error instanceof RequestCanceledError;
}

export function isOffline(error: unknown): error is NetworkError | TimeoutError {
  return error instanceof NetworkError || error instanceof TimeoutError;
}

/**
 * Field-level messages keyed by path, for wiring a 400 back onto form inputs.
 * Only the first message per path is kept — showing three messages under one
 * input is noise, and the first is always the most specific.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error)) return {};
  const out: Record<string, string> = {};
  for (const detail of error.details) {
    if (!(detail.path in out)) out[detail.path] = detail.message;
  }
  return out;
}

/**
 * A last-resort display string. Prefer an explicit, screen-specific message for
 * the codes a screen actually expects; this is the fallback for the rest.
 */
export function toDisplayMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === ErrorCode.INTERNAL_ERROR) {
      return 'Something went wrong on our end. Please try again.';
    }
    return error.message;
  }
  if (error instanceof TimeoutError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Coerces an unparseable or empty error response into the standard envelope. */
export function synthesizeErrorBody(status: number, fallbackText?: string): ApiErrorBody {
  const code: ErrorCode =
    status === 401
      ? ErrorCode.UNAUTHENTICATED
      : status === 403
        ? ErrorCode.FORBIDDEN
        : status === 404
          ? ErrorCode.NOT_FOUND
          : status === 429
            ? ErrorCode.RATE_LIMITED
            : ErrorCode.INTERNAL_ERROR;

  return {
    statusCode: status,
    code,
    message: fallbackText?.trim() || `Request failed with status ${status}.`,
    requestId: '',
    timestamp: new Date().toISOString(),
  };
}

/** Narrow an arbitrary parsed body to the contract envelope. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['message'] === 'string' &&
    typeof candidate['statusCode'] === 'number'
  );
}
