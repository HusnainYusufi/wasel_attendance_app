import { describe, expect, it } from 'vitest';
import {
  hasPrismaErrorCode,
  isForeignKeyViolation,
  isKnownPrismaError,
  isNotFound,
  isUniqueViolation,
  PrismaErrorCode,
  uniqueViolationConstraint,
  uniqueViolationFields,
} from '../prisma-errors.js';

function knownError(code: string, meta?: Record<string, unknown>): Error {
  const error = new Error(`prisma ${code}`);
  error.name = 'PrismaClientKnownRequestError';
  Object.assign(error, { code, ...(meta ? { meta } : {}) });
  return error;
}

/** Shape produced by Prisma 7 when a driver adapter surfaces the Postgres error. */
function adapterUniqueError(index: string, table: string): Error {
  return knownError(PrismaErrorCode.UNIQUE_VIOLATION, {
    modelName: 'User',
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23505',
        kind: 'UniqueConstraintViolation',
        constraint: { index },
        table,
      },
    },
  });
}

describe('isKnownPrismaError', () => {
  it.each([null, undefined, 'P2002', 42, new Error('plain'), {}])(
    'rejects a non-Prisma value',
    (value) => {
      expect(isKnownPrismaError(value)).toBe(false);
    },
  );

  it('accepts an error carrying the Prisma name and a P-code', () => {
    expect(isKnownPrismaError(knownError('P2002'))).toBe(true);
  });

  it('rejects an error whose code is not a Prisma code', () => {
    expect(isKnownPrismaError(knownError('ECONNREFUSED'))).toBe(false);
  });
});

describe('unique violations', () => {
  it('recognises the adapter shape and extracts the constraint name', () => {
    const error = adapterUniqueError('users_organizationId_email_key', 'users');

    expect(isUniqueViolation(error)).toBe(true);
    expect(uniqueViolationConstraint(error)).toBe('users_organizationId_email_key');
    expect(uniqueViolationFields(error)).toEqual(['organizationId', 'email']);
  });

  it('matches on the exact constraint name', () => {
    const error = adapterUniqueError('users_organizationId_email_key', 'users');
    expect(isUniqueViolation(error, 'users_organizationId_email_key')).toBe(true);
    expect(isUniqueViolation(error, 'users_organizationId_employeeCode_key')).toBe(false);
  });

  it('distinguishes the two unique constraints on users', () => {
    const emailCollision = adapterUniqueError('users_organizationId_email_key', 'users');
    const codeCollision = adapterUniqueError('users_organizationId_employeeCode_key', 'users');

    expect(isUniqueViolation(emailCollision, ['organizationId', 'email'])).toBe(true);
    expect(isUniqueViolation(emailCollision, ['organizationId', 'employeeCode'])).toBe(false);
    expect(isUniqueViolation(codeCollision, ['organizationId', 'employeeCode'])).toBe(true);
    expect(isUniqueViolation(codeCollision, ['organizationId', 'email'])).toBe(false);
  });

  it('refuses to guess from a field shared by both constraints', () => {
    // `organizationId` participates in both unique constraints on `users`. Under
    // subset matching this returned true for either collision, so a caller
    // narrowing on it would report EMAIL_TAKEN for an employee-code clash and the
    // client would attach the error to the wrong input. Partial targets must not
    // match at all.
    const emailCollision = adapterUniqueError('users_organizationId_email_key', 'users');
    const codeCollision = adapterUniqueError('users_organizationId_employeeCode_key', 'users');

    expect(isUniqueViolation(emailCollision, 'organizationId')).toBe(false);
    expect(isUniqueViolation(codeCollision, 'organizationId')).toBe(false);
    expect(isUniqueViolation(emailCollision, 'email')).toBe(false);
    expect(isUniqueViolation(emailCollision, ['email'])).toBe(false);
  });

  it('requires every field of a composite target to match', () => {
    const error = adapterUniqueError('users_organizationId_email_key', 'users');
    expect(isUniqueViolation(error, ['organizationId', 'email'])).toBe(true);
    expect(isUniqueViolation(error, ['organizationId', 'employeeCode'])).toBe(false);
  });

  it('still understands the legacy meta.target shape', () => {
    const error = knownError(PrismaErrorCode.UNIQUE_VIOLATION, {
      target: ['organizationId', 'email'],
    });
    expect(uniqueViolationFields(error)).toEqual(['organizationId', 'email']);
    expect(isUniqueViolation(error, ['organizationId', 'email'])).toBe(true);
  });

  it('accepts a string meta.target', () => {
    const error = knownError(PrismaErrorCode.UNIQUE_VIOLATION, { target: 'slug' });
    expect(uniqueViolationFields(error)).toEqual(['slug']);
  });

  it('prefers explicit constraint fields over decomposing the index name', () => {
    const error = knownError(PrismaErrorCode.UNIQUE_VIOLATION, {
      driverAdapterError: {
        cause: {
          constraint: { fields: ['work_date', 'user_id'], index: 'ignored_idx' },
          table: 'attendance_records',
        },
      },
    });
    expect(uniqueViolationFields(error)).toEqual(['work_date', 'user_id']);
  });

  it('returns nothing useful for a non-unique error rather than guessing', () => {
    expect(uniqueViolationFields(knownError(PrismaErrorCode.RECORD_NOT_FOUND))).toEqual([]);
    expect(uniqueViolationConstraint(knownError(PrismaErrorCode.RECORD_NOT_FOUND))).toBeNull();
  });
});

describe('other codes', () => {
  it('recognises a missing record', () => {
    expect(isNotFound(knownError(PrismaErrorCode.RECORD_NOT_FOUND))).toBe(true);
    expect(isNotFound(knownError(PrismaErrorCode.UNIQUE_VIOLATION))).toBe(false);
  });

  it('recognises a foreign key violation', () => {
    expect(isForeignKeyViolation(knownError(PrismaErrorCode.FOREIGN_KEY_VIOLATION))).toBe(true);
    expect(isForeignKeyViolation(new Error('nope'))).toBe(false);
  });

  it('exposes a generic code check', () => {
    expect(hasPrismaErrorCode(knownError('P2002'), PrismaErrorCode.UNIQUE_VIOLATION)).toBe(true);
    expect(hasPrismaErrorCode(knownError('P2002'), PrismaErrorCode.RECORD_NOT_FOUND)).toBe(false);
  });
});
