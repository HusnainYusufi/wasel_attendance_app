/**
 * Typed predicates over Prisma's error codes.
 *
 * Modules must not string-match on Prisma internals. Beyond the obvious fragility
 * — the message text is not part of Prisma's public contract — the shape moved in
 * version 7: with a driver adapter, a `P2002` no longer carries `meta.target` but
 * the underlying Postgres index name, nested under
 * `meta.driverAdapterError.cause.constraint`. Every consumer that had hand-rolled
 * `err.meta.target.includes('email')` broke silently on that upgrade. This module
 * is the one place that knows about it.
 */

/** Documented Prisma error codes this codebase reacts to. */
export const PrismaErrorCode = {
  /** Unique constraint failed. */
  UNIQUE_VIOLATION: 'P2002',
  /** Foreign key constraint failed. */
  FOREIGN_KEY_VIOLATION: 'P2003',
  /** An operation depended on records that were not found. */
  RECORD_NOT_FOUND: 'P2025',
  /**
   * An interactive transaction could not be completed — in practice, its timeout
   * expired while it waited for a lock another transaction held.
   */
  TRANSACTION_FAILED: 'P2028',
} as const;
export type PrismaErrorCode = (typeof PrismaErrorCode)[keyof typeof PrismaErrorCode];

export interface KnownPrismaError {
  readonly name: string;
  readonly code: string;
  readonly meta?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural rather than `instanceof`: under pnpm the generated client can be
 * reached through more than one module path, and two copies of the same class
 * fail `instanceof` while being the same error.
 */
export function isKnownPrismaError(error: unknown): error is KnownPrismaError {
  if (!isRecord(error)) return false;
  return (
    error['name'] === 'PrismaClientKnownRequestError' &&
    typeof error['code'] === 'string' &&
    error['code'].startsWith('P')
  );
}

export function hasPrismaErrorCode(error: unknown, code: PrismaErrorCode): boolean {
  return isKnownPrismaError(error) && error.code === code;
}

interface AdapterConstraintCause {
  table?: string;
  constraint?: { index?: string; fields?: string[] };
}

function adapterCause(error: KnownPrismaError): AdapterConstraintCause | null {
  const adapterError = error.meta?.['driverAdapterError'];
  if (!isRecord(adapterError)) return null;
  const cause = adapterError['cause'];
  return isRecord(cause) ? cause : null;
}

/**
 * The database-level constraint (index) name, when the driver reports one —
 * `users_organizationId_email_key`, for instance.
 *
 * This is the exact identifier: prefer it over field matching when a table
 * carries several unique constraints and the distinction decides which error code
 * the client sees.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  if (!hasPrismaErrorCode(error, PrismaErrorCode.UNIQUE_VIOLATION)) return null;
  const index = adapterCause(error as KnownPrismaError)?.constraint?.index;
  return typeof index === 'string' ? index : null;
}

/**
 * Best-effort field names behind a unique violation.
 *
 * Three sources, in order of reliability: `meta.target` (Prisma's own field list,
 * present without a driver adapter), the adapter's explicit `constraint.fields`,
 * and finally the index name decomposed using Prisma's default naming convention
 * (`<table>_<field>…_key`). The last is a convention, not a guarantee — a field
 * containing an underscore, or a hand-named index, will not decompose — which is
 * why {@link uniqueViolationConstraint} exists for callers that need certainty.
 */
export function uniqueViolationFields(error: unknown): string[] {
  if (!hasPrismaErrorCode(error, PrismaErrorCode.UNIQUE_VIOLATION)) return [];
  const known = error as KnownPrismaError;

  const target = known.meta?.['target'];
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target.filter((v): v is string => typeof v === 'string');

  const cause = adapterCause(known);
  if (Array.isArray(cause?.constraint?.fields)) {
    return cause.constraint.fields.filter((v): v is string => typeof v === 'string');
  }

  const index = cause?.constraint?.index;
  if (typeof index !== 'string') return [];

  const table = cause?.table;
  const withoutTable =
    typeof table === 'string' && index.startsWith(`${table}_`)
      ? index.slice(table.length + 1)
      : index;

  return withoutTable
    .replace(/_(key|pkey|idx|unique)$/, '')
    .split('_')
    .filter((segment) => segment.length > 0);
}

/**
 * True for a `P2002` unique-constraint failure.
 *
 * `target` narrows the check. Pass either the constraint name, or the *complete*
 * set of fields the constraint covers — order does not matter, but a partial set
 * does not match.
 *
 * The exactness is the whole point. `users` collides on both
 * `(organizationId, email)` and `(organizationId, employeeCode)`, and those must
 * surface as `EMAIL_TAKEN` and `EMPLOYEE_CODE_TAKEN`. Under subset matching,
 * `isUniqueViolation(err, 'organizationId')` is true for both, so a caller would
 * silently report the wrong field — and the mobile client, which branches on the
 * error code, would attach the error to the wrong input.
 *
 * @example
 * isUniqueViolation(err, 'users_organizationId_email_key')   // by constraint name
 * isUniqueViolation(err, ['organizationId', 'email'])        // by complete field set
 * isUniqueViolation(err, 'slug')                             // single-field constraint
 */
export function isUniqueViolation(error: unknown, target?: string | readonly string[]): boolean {
  if (!hasPrismaErrorCode(error, PrismaErrorCode.UNIQUE_VIOLATION)) return false;
  if (target === undefined) return true;

  if (typeof target === 'string' && uniqueViolationConstraint(error) === target) return true;

  const fields = uniqueViolationFields(error);
  const wanted = typeof target === 'string' ? [target] : target;
  if (wanted.length === 0 || wanted.length !== fields.length) return false;

  const covered = new Set(fields);
  return wanted.every((field) => covered.has(field));
}

/** True for a `P2025` "record not found" failure from update/delete/connect. */
export function isNotFound(error: unknown): boolean {
  return hasPrismaErrorCode(error, PrismaErrorCode.RECORD_NOT_FOUND);
}

/**
 * True for a `P2028` interactive-transaction failure.
 *
 * Almost always the default 5 s timeout expiring behind somebody else's row
 * locks. It is a *transient* condition — the same request will usually succeed a
 * moment later — so a caller that lets it reach the global filter turns
 * contention into `500 INTERNAL_ERROR`, which tells the client nothing and reads
 * as a bug in the server rather than as "try again".
 */
export function isTransactionFailure(error: unknown): boolean {
  return hasPrismaErrorCode(error, PrismaErrorCode.TRANSACTION_FAILED);
}

/** True for a `P2003` foreign-key violation. */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPrismaErrorCode(error, PrismaErrorCode.FOREIGN_KEY_VIOLATION);
}
