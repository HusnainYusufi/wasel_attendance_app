import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Column widths in `audit_logs` / `sessions`; an over-long value must be cut, not rejected. */
const IP_ADDRESS_MAX = 45;
const USER_AGENT_MAX = 512;

/**
 * Where a request came from, as recorded on sessions and audit rows.
 *
 * Both fields are attacker-controlled — the user agent entirely, the address as
 * far as the configured proxy-hop count allows — so both are truncated to the
 * column width here. Letting a 40 kB `User-Agent` reach Postgres turns a login
 * into a 500 and, worse, into a way to make audit writes fail selectively.
 */
export interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

function truncate(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export function clientInfoFromRequest(request: Request): ClientInfo {
  // `request.ip` honours Express's `trust proxy` hop count, which the bootstrap
  // sets from configuration. Reading `x-forwarded-for` directly would take a
  // header any client can forge, and put a fabricated address in the audit log.
  return {
    ipAddress: truncate(request.ip, IP_ADDRESS_MAX),
    userAgent: truncate(request.headers?.['user-agent'], USER_AGENT_MAX),
  };
}

/** Injects the caller's address and user agent, for session and audit records. */
export const ClientContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ClientInfo =>
    clientInfoFromRequest(context.switchToHttp().getRequest<Request>()),
);
