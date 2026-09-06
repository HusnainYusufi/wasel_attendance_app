import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@wasel/contracts';
import { AppException, Errors } from '../app.exception.js';

describe('AppException', () => {
  it('pairs the HTTP status with a machine-readable code', () => {
    const exception = new AppException(418, ErrorCode.CONFLICT, 'teapot');

    expect(exception.getStatus()).toBe(418);
    expect(exception.code).toBe(ErrorCode.CONFLICT);
    expect(exception.message).toBe('teapot');
    expect(exception.getResponse()).toEqual({ code: ErrorCode.CONFLICT, message: 'teapot' });
  });

  it('carries field-level details when given them', () => {
    const details = [{ path: 'email', message: 'required' }];
    const exception = new AppException(400, ErrorCode.VALIDATION_FAILED, 'bad', details);

    expect(exception.details).toEqual(details);
    expect(exception.getResponse()).toMatchObject({ details });
  });

  it('omits details entirely when there are none', () => {
    const exception = new AppException(404, ErrorCode.NOT_FOUND, 'gone');
    expect(exception.getResponse()).not.toHaveProperty('details');
  });
});

describe('Errors helpers', () => {
  it.each([
    [Errors.validation([{ path: 'a', message: 'b' }]), 400, ErrorCode.VALIDATION_FAILED],
    [Errors.invalidCredentials(), 401, ErrorCode.INVALID_CREDENTIALS],
    [Errors.unauthenticated(), 401, ErrorCode.UNAUTHENTICATED],
    [Errors.unauthenticated(ErrorCode.TOKEN_EXPIRED), 401, ErrorCode.TOKEN_EXPIRED],
    [Errors.forbidden(), 403, ErrorCode.FORBIDDEN],
    [Errors.notFound('Site'), 404, ErrorCode.NOT_FOUND],
    [Errors.conflict(ErrorCode.EMAIL_TAKEN, 'taken'), 409, ErrorCode.EMAIL_TAKEN],
    [Errors.unprocessable(ErrorCode.OUT_OF_RANGE, 'far'), 422, ErrorCode.OUT_OF_RANGE],
    [Errors.rateLimited(), 429, ErrorCode.RATE_LIMITED],
    [Errors.internal(), 500, ErrorCode.INTERNAL_ERROR],
  ])('produces the documented status/code pair', (exception, status, code) => {
    expect(exception.getStatus()).toBe(status);
    expect(exception.code).toBe(code);
  });

  it('does not reveal whether the email or the password was wrong', () => {
    const message = Errors.invalidCredentials().message.toLowerCase();
    expect(message).not.toContain('user');
    expect(message).not.toContain('exist');
    expect(message).toContain('invalid');
  });

  it('names the missing entity so the client can say what was not found', () => {
    expect(Errors.notFound('Organization').message).toBe('Organization not found');
  });
});
