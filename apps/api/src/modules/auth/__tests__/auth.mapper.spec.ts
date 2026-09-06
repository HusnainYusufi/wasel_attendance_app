import { Role, UserStatus, authUserSchema } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import { AUTH_USER_SELECT, toAuthUser, type AuthUserRow } from '../auth.mapper.js';

const ROW: AuthUserRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'member@wasel.test',
  fullName: 'Member One',
  employeeCode: 'EMP-1',
  role: Role.MEMBER,
  status: UserStatus.ACTIVE,
  organizationId: '22222222-2222-4222-8222-222222222222',
  organization: { name: 'Wasel', timezone: 'Asia/Riyadh' },
};

describe('toAuthUser', () => {
  it('produces a value the contract schema accepts', () => {
    expect(authUserSchema.safeParse(toAuthUser(ROW)).success).toBe(true);
  });

  it('flattens the organization onto the user', () => {
    expect(toAuthUser(ROW)).toMatchObject({
      organizationId: ROW.organizationId,
      organizationName: 'Wasel',
      timezone: 'Asia/Riyadh',
    });
  });

  it('preserves a null employee code rather than inventing one', () => {
    expect(toAuthUser({ ...ROW, employeeCode: null }).employeeCode).toBeNull();
  });

  it('cannot leak a password hash, because the selection never reads one', () => {
    // The guarantee is structural: `passwordHash` is absent from the projection,
    // so no query written against it can carry a digest into a response or a log.
    expect(Object.keys(AUTH_USER_SELECT)).not.toContain('passwordHash');
    expect(JSON.stringify(toAuthUser(ROW))).not.toContain('passwordHash');
  });
});
