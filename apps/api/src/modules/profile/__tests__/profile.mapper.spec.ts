import { Role, UserStatus } from '@wasel/contracts';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_USER_SELECT,
  toAvatarSummary,
  toProfileDto,
  type ProfileRow,
} from '../profile.mapper.js';

const row: ProfileRow = {
  id: '9a8b7c6d-2222-4333-8444-555566667777',
  email: 'sara@wasel.test',
  fullName: 'Sara Khan',
  employeeCode: 'ENG-4',
  role: Role.MEMBER,
  status: UserStatus.ACTIVE,
  organizationId: '3f1a1b2c-1111-4222-8333-444455556666',
  organization: { name: 'Wasel', timezone: 'Asia/Riyadh' },
  avatar: null,
};

describe('PROFILE_USER_SELECT', () => {
  it('never selects the password digest or the revocation counter', () => {
    // The selection is the guarantee. A query written against it cannot hand a
    // hash to a caller, a log or an export, however the mapper later changes.
    const columns = Object.keys(PROFILE_USER_SELECT);
    expect(columns).not.toContain('passwordHash');
    expect(columns).not.toContain('tokenVersion');
    expect(columns).not.toContain('failedLoginAttempts');
    expect(columns).not.toContain('lockedUntil');
  });

  it('never drags the image bytes through the profile query', () => {
    // The whole reason `UserAvatar` is a separate table. This response is
    // fetched on every launch and written to device storage; pulling tens of
    // kilobytes of JPEG into it to draw a 24 px circle would undo the split.
    expect(Object.keys(PROFILE_USER_SELECT.avatar.select)).toEqual([
      'mimeType',
      'byteSize',
      'updatedAt',
    ]);
  });
});

describe('toAvatarSummary', () => {
  it('is null when no picture is set', () => {
    expect(toAvatarSummary(null)).toBeNull();
  });

  it('renders the timestamp as an ISO string, never a Date', () => {
    const summary = toAvatarSummary({
      mimeType: 'image/jpeg',
      byteSize: 4096,
      updatedAt: new Date('2026-09-07T10:15:30.250Z'),
    });
    expect(summary).toEqual({
      mimeType: 'image/jpeg',
      byteSize: 4096,
      updatedAt: '2026-09-07T10:15:30.250Z',
    });
  });

  it('reports a stored type outside the accepted set as no avatar at all', () => {
    // Only this module writes that column, and only after sniffing the bytes, so
    // this should be unreachable. "Should be unreachable" is exactly what makes a
    // restored backup or a manual data fix start advertising a content type the
    // serving route would refuse — and the client's model must not disagree with
    // what the server will actually do.
    expect(
      toAvatarSummary({
        mimeType: 'image/svg+xml',
        byteSize: 10,
        updatedAt: new Date('2026-09-07T10:15:30.250Z'),
      }),
    ).toBeNull();
  });
});

describe('toProfileDto', () => {
  it('flattens the organization join the client needs', () => {
    expect(toProfileDto(row)).toEqual({
      id: row.id,
      email: 'sara@wasel.test',
      fullName: 'Sara Khan',
      employeeCode: 'ENG-4',
      role: Role.MEMBER,
      status: UserStatus.ACTIVE,
      organizationId: row.organizationId,
      organizationName: 'Wasel',
      timezone: 'Asia/Riyadh',
      avatar: null,
    });
  });

  it('carries the avatar summary when one is set', () => {
    const dto = toProfileDto({
      ...row,
      avatar: {
        mimeType: 'image/png',
        byteSize: 2048,
        updatedAt: new Date('2026-09-07T10:15:30.250Z'),
      },
    });
    expect(dto.avatar).toEqual({
      mimeType: 'image/png',
      byteSize: 2048,
      updatedAt: '2026-09-07T10:15:30.250Z',
    });
  });

  it('preserves a missing employee code as null', () => {
    expect(toProfileDto({ ...row, employeeCode: null }).employeeCode).toBeNull();
  });
});
