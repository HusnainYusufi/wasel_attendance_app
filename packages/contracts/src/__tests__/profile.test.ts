import { describe, expect, it } from 'vitest';
import { Role, UserStatus } from '../constants.js';
import {
  AVATAR_ENCODE_MIME_TYPE,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_EDGE_PX,
  AVATAR_MIME_TYPES,
  avatarMimeTypeSchema,
  avatarSummarySchema,
  profileSchema,
  updateProfileRequestSchema,
} from '../profile.js';

const ORGANIZATION_ID = '3f1a1b2c-1111-4222-8333-444455556666';
const USER_ID = '9a8b7c6d-2222-4333-8444-555566667777';

describe('avatar constants', () => {
  it('excludes SVG from the accepted types', () => {
    // An SVG is a document that can carry script; served from the API's origin
    // an SVG avatar is stored XSS aimed at everyone who opens the directory.
    expect(AVATAR_MIME_TYPES).not.toContain('image/svg+xml');
    expect(avatarMimeTypeSchema.safeParse('image/svg+xml').success).toBe(false);
  });

  it('accepts exactly the three web-safe raster types', () => {
    expect([...AVATAR_MIME_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('re-encodes to a type the server will accept', () => {
    // The client encodes to this; if it ever drifted out of the accepted set,
    // every upload from every device would be refused.
    expect(AVATAR_MIME_TYPES).toContain(AVATAR_ENCODE_MIME_TYPE);
  });

  it('leaves generous headroom over a re-encoded image', () => {
    // A 512 px JPEG is tens of kilobytes; the cap is a guard against a hostile
    // client, not a constraint a real upload should ever meet.
    expect(AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(AVATAR_MAX_EDGE_PX).toBe(512);
  });
});

describe('avatarSummarySchema', () => {
  it('accepts a well-formed summary', () => {
    const parsed = avatarSummarySchema.parse({
      mimeType: 'image/jpeg',
      byteSize: 4096,
      updatedAt: '2026-09-07T10:00:00.000Z',
    });
    expect(parsed.byteSize).toBe(4096);
  });

  it.each([
    ['a zero-byte image', { mimeType: 'image/jpeg', byteSize: 0 }],
    ['a fractional size', { mimeType: 'image/png', byteSize: 1.5 }],
    ['an unsupported type', { mimeType: 'image/gif', byteSize: 10 }],
  ])('rejects %s', (_label, patch) => {
    const candidate = { updatedAt: '2026-09-07T10:00:00.000Z', ...patch };
    expect(avatarSummarySchema.safeParse(candidate).success).toBe(false);
  });
});

describe('profileSchema', () => {
  const base = {
    id: USER_ID,
    email: 'sara@wasel.test',
    fullName: 'Sara Khan',
    employeeCode: 'ENG-4',
    role: Role.MEMBER,
    status: UserStatus.ACTIVE,
    organizationId: ORGANIZATION_ID,
    organizationName: 'Wasel',
    timezone: 'Asia/Riyadh',
  };

  it('carries the authenticated principal plus the avatar', () => {
    const parsed = profileSchema.parse({
      ...base,
      avatar: { mimeType: 'image/jpeg', byteSize: 2048, updatedAt: '2026-09-07T10:00:00.000Z' },
    });
    expect(parsed.avatar?.mimeType).toBe('image/jpeg');
    expect(parsed.organizationName).toBe('Wasel');
  });

  it('models "no picture set" as null rather than an absent key', () => {
    // `undefined` and `null` would render differently in a client that checks
    // `'avatar' in profile`; the API always states the answer.
    expect(profileSchema.safeParse({ ...base, avatar: null }).success).toBe(true);
    expect(profileSchema.safeParse(base).success).toBe(false);
  });
});

describe('updateProfileRequestSchema', () => {
  it('accepts a name-only change with no password', () => {
    // A display name is not a credential; demanding a password to fix a typo in
    // it would be friction with nothing on the other side of the trade.
    const parsed = updateProfileRequestSchema.parse({ fullName: '  Sara Khan ' });
    expect(parsed).toEqual({ fullName: 'Sara Khan' });
  });

  it('normalises the address exactly as every other email field does', () => {
    const parsed = updateProfileRequestSchema.parse({
      email: '  Sara.Khan@WASEL.test ',
      currentPassword: 'hunter2hunter2',
    });
    expect(parsed.email).toBe('sara.khan@wasel.test');
  });

  it('refuses an email change that carries no current password', () => {
    // The step-up that turns "held an unlocked phone" into "knows the password".
    const result = updateProfileRequestSchema.safeParse({ email: 'new@wasel.test' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === 'currentPassword')).toBe(true);
  });

  it('refuses an empty patch', () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
    // A password on its own is not an edit — that is `POST /auth/change-password`.
    expect(updateProfileRequestSchema.safeParse({ currentPassword: 'x'.repeat(12) }).success).toBe(
      false,
    );
  });

  it.each([
    ['a one-character name', { fullName: 'S' }],
    ['a malformed address', { email: 'not-an-email', currentPassword: 'hunter2hunter2' }],
    ['an empty current password', { email: 'a@b.co', currentPassword: '' }],
  ])('rejects %s', (_label, body) => {
    expect(updateProfileRequestSchema.safeParse(body).success).toBe(false);
  });

  it('does not accept a role or status smuggled alongside a name', () => {
    // Self-service must never be a privilege-escalation route. Zod strips
    // unknown keys, so the parsed value is what the service acts on.
    const parsed = updateProfileRequestSchema.parse({
      fullName: 'Sara Khan',
      role: Role.ADMIN,
      status: UserStatus.SUSPENDED,
    } as unknown as { fullName: string });
    expect(parsed).toEqual({ fullName: 'Sara Khan' });
  });
});
