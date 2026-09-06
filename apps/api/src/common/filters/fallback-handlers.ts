import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { ApiErrorBody } from '@wasel/contracts';
import { ErrorCode } from '@wasel/contracts';
import { REQUEST_ID_HEADER, resolveRequestId, sanitizeRequestId } from '../logging/request-id.js';
import { GENERIC_ERROR_MESSAGE, statusToErrorCode } from './error-mapping.js';

/**
 * Terminal Express handlers for the two windows a Nest exception filter cannot
 * reach: a URL that matches no route, and an error thrown by middleware that runs
 * before Nest's router (helmet, compression, the CORS origin callback).
 *
 * Without these, Express answers with its own `finalhandler`, which renders an
 * HTML page — carrying a stack trace outside production — instead of the
 * `ApiErrorBody` envelope every client is written against.
 */

function requestIdOf(request: Request): string {
  return (
    sanitizeRequestId((request as { id?: unknown }).id) ??
    resolveRequestId(request.headers?.[REQUEST_ID_HEADER])
  );
}

function sendEnvelope(
  response: Response,
  requestId: string,
  statusCode: number,
  code: ErrorCode,
  message: string,
): void {
  const body: ApiErrorBody = {
    statusCode,
    code,
    message,
    requestId,
    timestamp: new Date().toISOString(),
  };
  response.setHeader(REQUEST_ID_HEADER, requestId);
  response.status(statusCode).json(body);
}

/** Registered after every route: anything still unmatched is a 404. */
export function createNotFoundHandler(): RequestHandler {
  return (request, response, next) => {
    if (response.headersSent) {
      next();
      return;
    }
    sendEnvelope(
      response,
      requestIdOf(request),
      404,
      ErrorCode.NOT_FOUND,
      'The requested endpoint does not exist',
    );
  };
}

interface MiddlewareError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Express only treats a four-argument middleware as an error handler, and only
 * consults handlers registered after the point that threw — hence "final". It
 * covers failures in middleware that runs before Nest's router (the security
 * headers, compression, the CORS origin callback), which no Nest filter sees.
 *
 * The message is always one of ours: an error escaping arbitrary middleware may
 * carry a file path or a configuration value in its own message.
 */
export function createFinalErrorHandler(
  onError: (error: unknown, requestId: string) => void,
): ErrorRequestHandler {
  return (error: MiddlewareError, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = requestIdOf(request);
    onError(error, requestId);

    const status = error?.status ?? error?.statusCode ?? 500;

    if (error?.type === 'entity.too.large' || status === 413) {
      sendEnvelope(
        response,
        requestId,
        413,
        ErrorCode.VALIDATION_FAILED,
        'Request payload is too large',
      );
      return;
    }

    if (status >= 400 && status < 500) {
      sendEnvelope(
        response,
        requestId,
        status,
        statusToErrorCode(status),
        'The request could not be processed',
      );
      return;
    }

    sendEnvelope(response, requestId, 500, ErrorCode.INTERNAL_ERROR, GENERIC_ERROR_MESSAGE);
  };
}
