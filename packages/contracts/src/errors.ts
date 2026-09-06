/**
 * Stable, machine-readable error codes.
 *
 * The mobile client switches on `code` — never on the human-readable `message`,
 * which is free to change or be localised without breaking clients.
 */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  // 401
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  NOT_CHECKED_IN: 'NOT_CHECKED_IN',
  ALREADY_CHECKED_OUT: 'ALREADY_CHECKED_OUT',
  /**
   * A shift opened on an earlier business day is still open. Distinct from
   * `ALREADY_CHECKED_IN`, which means "you already opened *this* business day":
   * the action that resolves this one is a check-out, not waiting for tomorrow.
   */
  SHIFT_STILL_OPEN: 'SHIFT_STILL_OPEN',
  /**
   * A check-out arrived so soon after the check-in that the day would be stored
   * as zero minutes worked. Almost always a double tap; the shift stays open.
   */
  SHIFT_TOO_SHORT: 'SHIFT_TOO_SHORT',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  EMPLOYEE_CODE_TAKEN: 'EMPLOYEE_CODE_TAKEN',
  SITE_NAME_TAKEN: 'SITE_NAME_TAKEN',
  // 422 — request was well-formed but the domain rule rejected it
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  NO_ACTIVE_SITE: 'NO_ACTIVE_SITE',
  LOW_GPS_ACCURACY: 'LOW_GPS_ACCURACY',
  LAST_ADMIN: 'LAST_ADMIN',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Uniform error envelope returned by every non-2xx API response. */
export interface ApiErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  /** Field-level detail for VALIDATION_FAILED. */
  details?: Array<{ path: string; message: string }>;
  /** Correlates a client-visible failure with a server log line. */
  requestId: string;
  timestamp: string;
}
