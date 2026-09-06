import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ApiErrorBody } from '@wasel/contracts';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { REQUEST_ID_HEADER, resolveRequestId, sanitizeRequestId } from '../logging/request-id.js';
import { mapException } from './error-mapping.js';

/**
 * The single place a non-2xx response is produced.
 *
 * Two properties matter more than anything else here:
 *  1. Every failure leaves as the `ApiErrorBody` envelope, so the client has one
 *     shape to parse and one `code` to branch on.
 *  2. Nothing about an unexpected failure crosses the wire. Stack traces, SQL,
 *     constraint names and file paths stay in the log, correlated to the client's
 *     response only by `requestId`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    // `id` is contributed to the request by pino-http's `genReqId`.
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId =
      sanitizeRequestId(request.id) ?? resolveRequestId(request.headers?.[REQUEST_ID_HEADER]);
    const mapped = mapException(exception);

    const logContext = {
      requestId,
      statusCode: mapped.statusCode,
      code: mapped.code,
      method: request.method,
      // `route.path` (`/users/:id`) rather than the concrete URL keeps ids out of
      // the log line while still identifying the endpoint.
      path: request.route?.path ?? request.url,
    };

    if (mapped.expected) {
      this.logger.warn(logContext, 'Request rejected');
    } else {
      this.logger.error({ ...logContext, err: exception }, 'Unhandled exception');
    }

    // Streaming responses and failures inside a late interceptor can arrive here
    // after the headers have gone out; rewriting the status would throw.
    if (response.headersSent) {
      response.end();
      return;
    }

    const body: ApiErrorBody = {
      statusCode: mapped.statusCode,
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details ? { details: mapped.details } : {}),
      requestId,
      timestamp: new Date().toISOString(),
    };

    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.status(mapped.statusCode).json(body);
  }
}
