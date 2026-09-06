import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Inbound request ids are attacker-controlled. Anything outside this alphabet is
 * discarded and replaced with a fresh UUID, because an id containing newlines
 * would let a caller forge extra lines in a line-delimited log, and an unbounded
 * one would let them pad every log record at will.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return SAFE_REQUEST_ID.test(value) ? value : undefined;
}

export function generateRequestId(): string {
  return randomUUID();
}

/** Reads a usable id from an inbound header value, else mints one. */
export function resolveRequestId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return sanitizeRequestId(raw) ?? generateRequestId();
}
