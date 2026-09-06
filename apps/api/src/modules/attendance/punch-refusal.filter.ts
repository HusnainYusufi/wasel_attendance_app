import { Catch, type ArgumentsHost } from '@nestjs/common';
import { ErrorCode, PunchOutcome } from '@wasel/contracts';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../../common/errors/app.exception.js';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter.js';
import { PunchRefusalAuditService } from './punch-refusal.service.js';

/**
 * Refusals raised above the service, and the audit row each one owes.
 *
 * Only codes that cannot originate inside `AttendanceService` belong here — a
 * rejection it decides itself already wrote its own event, and filing a second
 * would double-count every out-of-range punch in the dashboard.
 */
const AUDITED_REFUSALS = new Map<ErrorCode, PunchOutcome>([
  [ErrorCode.ACCOUNT_SUSPENDED, PunchOutcome.REJECTED_ACCOUNT_SUSPENDED],
]);

/**
 * Restores CONVENTIONS §2.5 for punches refused before the service sees them.
 *
 * A globally registered guard throws while the request is still inside the
 * route's execution context, so a filter bound to this controller catches it —
 * which is the only seam that can observe an authentication refusal without the
 * attendance module reaching into the auth module or the kernel.
 *
 * Rendering is inherited unchanged: every response still leaves through
 * `AllExceptionsFilter`, so the `ApiErrorBody` envelope, the request id and the
 * log line are identical to those of any other failure. The audit write is
 * awaited before the response goes out, so a client that sees the 403 knows the
 * attempt is already on record.
 */
@Catch(AppException)
export class PunchRefusalFilter extends AllExceptionsFilter {
  constructor(
    logger: PinoLogger,
    private readonly refusals: PunchRefusalAuditService,
  ) {
    super(logger);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const outcome =
      exception instanceof AppException ? AUDITED_REFUSALS.get(exception.code) : undefined;

    if (outcome === undefined) {
      super.catch(exception, host);
      return;
    }

    void this.refusals
      .record(host.switchToHttp().getRequest<Request>(), outcome)
      .finally(() => super.catch(exception, host));
  }
}
