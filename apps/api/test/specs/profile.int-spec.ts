import { ErrorCode, Role, type ProfileDto } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { ProfileModule } from '../../src/modules/profile/profile.module.js';
import { ProfileAuditAction } from '../../src/modules/profile/profile.constants.js';
import {
  TEST_PASSWORD,
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

describe('profile', () => {
  let ctx: TestApp;
  let member: AuthenticatedActor;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, ProfileModule],
      env: { RATE_LIMIT_MAX: '100000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    member = await createUserAndLogin(ctx, { fullName: 'Sara Khan' });
  });

  describe('GET /profile', () => {
    it('returns the caller, their organization and no avatar', async () => {
      const response = await member.get('/profile').expect(200);

      expect(response.body).toMatchObject({
        id: member.user.id,
        email: member.user.email,
        fullName: 'Sara Khan',
        role: Role.MEMBER,
        organizationId: member.organization.id,
        organizationName: member.organization.name,
        timezone: member.organization.timezone,
        avatar: null,
      });
    });

    it('never returns a password hash', async () => {
      const response = await member.get('/profile').expect(200);
      expect(JSON.stringify(response.body)).not.toContain('argon2');
      expect(response.body).not.toHaveProperty('passwordHash');
      expect(response.body).not.toHaveProperty('tokenVersion');
    });

    it('is reachable by an administrator too — admins have profiles as well', async () => {
      const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
      const response = await admin.get('/profile').expect(200);
      expect(response.body.role).toBe(Role.ADMIN);
    });

    it('requires authentication', async () => {
      const response = await ctx.http.get('/api/v1/profile').expect(401);
      expect(response.body.code).toBe(ErrorCode.UNAUTHENTICATED);
    });
  });

  describe('PATCH /profile — the name', () => {
    it('renames the caller and keeps their session alive', async () => {
      const response = await member
        .patch('/profile')
        .send({ fullName: 'Sara A. Khan' })
        .expect(200);
      expect(response.body.fullName).toBe('Sara A. Khan');

      // The decisive assertion: a display name is not a credential, so nothing
      // was revoked and the very same token still works.
      await member.get('/profile').expect(200);
    });

    it('trims the name exactly as the contract specifies', async () => {
      const response = await member
        .patch('/profile')
        .send({ fullName: '  Sara Khan  ' })
        .expect(200);
      expect(response.body.fullName).toBe('Sara Khan');
    });

    it('needs no password to change a name', async () => {
      await member.patch('/profile').send({ fullName: 'Renamed Person' }).expect(200);
    });

    it.each([
      ['an empty patch', {}],
      ['a one-character name', { fullName: 'S' }],
      ['a name past 120 characters', { fullName: 'x'.repeat(121) }],
    ])('rejects %s', async (_label, body) => {
      const response = await member.patch('/profile').send(body).expect(400);
      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('ignores a role or status smuggled into the body', async () => {
      // Self-service must never be a privilege-escalation route. The contract
      // strips unknown keys, so the service never sees them.
      await member
        .patch('/profile')
        .send({ fullName: 'Sara Khan', role: Role.ADMIN, status: 'SUSPENDED' })
        .expect(200);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.user.id } });
      expect(row.role).toBe(Role.MEMBER);
      expect(row.status).toBe('ACTIVE');
    });
  });

  describe('PATCH /profile — the email address, which is half a credential', () => {
    it('refuses an email change that carries no current password', async () => {
      const response = await member.patch('/profile').send({ email: 'new@wasel.test' }).expect(400);

      expect(response.body.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'currentPassword' }),
      );

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.user.id } });
      expect(row.email).toBe(member.user.email);
    });

    it('refuses a wrong current password, and does not say which half was wrong', async () => {
      // This is the borrowed-unlocked-phone case: the attacker holds a live
      // session but not the password, and that is exactly where they stop.
      const response = await member
        .patch('/profile')
        .send({ email: 'attacker@evil.test', currentPassword: 'not-the-password' })
        .expect(401);

      expect(response.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.user.id } });
      expect(row.email).toBe(member.user.email);
    });

    it('records every refused attempt, because repetition is the signal', async () => {
      await member
        .patch('/profile')
        .send({ email: 'attacker@evil.test', currentPassword: 'wrong' })
        .expect(401);

      const entries = await ctx.prisma.auditLog.findMany({
        where: { actorId: member.user.id, action: ProfileAuditAction.EMAIL_CHANGE_REJECTED },
      });
      expect(entries).toHaveLength(1);
    });

    it('changes the address when the password is right', async () => {
      const response = await member
        .patch('/profile')
        .send({ email: 'Sara.New@Wasel.TEST', currentPassword: TEST_PASSWORD })
        .expect(200);

      // Normalised on the way in, so one human stays one account.
      expect(response.body.email).toBe('sara.new@wasel.test');
    });

    it('revokes every session, including the one that made the change', async () => {
      await member
        .patch('/profile')
        .send({ email: 'sara.new@wasel.test', currentPassword: TEST_PASSWORD })
        .expect(200);

      // The access token dies with the `tokenVersion` bump...
      const rejected = await member.get('/profile').expect(401);
      expect(rejected.body.code).toBe(ErrorCode.SESSION_REVOKED);

      // ...and the refresh chain that would otherwise mint replacements is dead
      // too, which is the half a token-version bump cannot do on its own.
      await ctx.http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: member.refreshToken })
        .expect(401);

      const sessions = await ctx.prisma.session.findMany({ where: { userId: member.user.id } });
      expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('leaves the account usable under the new address', async () => {
      await member
        .patch('/profile')
        .send({ email: 'sara.new@wasel.test', currentPassword: TEST_PASSWORD })
        .expect(200);

      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: 'sara.new@wasel.test', password: TEST_PASSWORD })
        .expect(200);

      // And the old address is genuinely gone, not merely shadowed.
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: member.user.email, password: TEST_PASSWORD })
        .expect(401);
    });

    it('revokes nothing when the submitted address is the one already held', async () => {
      // An edit form that always sends every field must not sign the user out
      // for changing nothing. Canonical forms are compared, not spellings.
      await member
        .patch('/profile')
        .send({ email: member.user.email.toUpperCase(), currentPassword: TEST_PASSWORD })
        .expect(200);

      await member.get('/profile').expect(200);
    });

    it('writes an identity-timeline entry naming both addresses', async () => {
      await member
        .patch('/profile')
        .send({ email: 'sara.new@wasel.test', currentPassword: TEST_PASSWORD })
        .expect(200);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { actorId: member.user.id, action: ProfileAuditAction.EMAIL_CHANGED },
      });
      // Without the previous address, "the email was changed" cannot answer
      // "changed from what?", which is the only question anybody asks it.
      expect(entry.metadata).toMatchObject({
        previousEmail: member.user.email,
        email: 'sara.new@wasel.test',
        sessionsRevoked: true,
      });
    });

    it('reports a collision as EMAIL_TAKEN against the email field', async () => {
      const colleague = await createUser(ctx, {
        organizationId: member.organization.id,
        email: 'taken@wasel.test',
      });

      const response = await member
        .patch('/profile')
        .send({ email: colleague.user.email, currentPassword: TEST_PASSWORD })
        .expect(409);

      expect(response.body.code).toBe(ErrorCode.EMAIL_TAKEN);
      // The client attaches the error to a specific input; a generic conflict
      // would leave the user staring at a form with nothing marked.
      expect(response.body.details).toContainEqual(expect.objectContaining({ path: 'email' }));

      // Nothing was revoked by a change that did not happen.
      await member.get('/profile').expect(200);
    });

    it('allows an address another *tenant* already uses', async () => {
      // `email` is unique per organization, not globally: the same human may
      // legitimately hold an account in two tenants.
      const other = await createUserAndLogin(ctx);
      await member
        .patch('/profile')
        .send({ email: other.user.email, currentPassword: TEST_PASSWORD })
        .expect(200);
    });
  });

  describe('the tenancy and authorization boundary', () => {
    it('offers no way to name another user at all', async () => {
      // The self-service routes take no id, so "a member cannot edit anyone
      // else" is not a check that could be forgotten — it is a shape the
      // controller cannot express. There is nothing to point at a colleague.
      const colleague = await createUser(ctx, { organizationId: member.organization.id });

      await member
        .patch(`/profile/${colleague.user.id}`)
        .send({ fullName: 'Hijacked' })
        .expect(404);
      await member.get(`/profile/${colleague.user.id}`).expect(404);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: colleague.user.id } });
      expect(row.fullName).not.toBe('Hijacked');
    });

    it('refuses a member the admin route that does edit other people', async () => {
      const colleague = await createUser(ctx, { organizationId: member.organization.id });
      const response = await member
        .patch(`/admin/users/${colleague.user.id}`)
        .send({ fullName: 'Hijacked' })
        .expect(403);
      expect(response.body.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('edits only the caller, never a namesake in another tenant', async () => {
      const other = await createUserAndLogin(ctx, { fullName: 'Sara Khan' });

      await member.patch('/profile').send({ fullName: 'Only Mine' }).expect(200);

      const theirs = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.user.id } });
      expect(theirs.fullName).toBe('Sara Khan');
    });
  });

  it('audits a profile edit under the owner as both actor and subject', async () => {
    await member.patch('/profile').send({ fullName: 'Audited Name' }).expect(200);

    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { actorId: member.user.id, action: ProfileAuditAction.PROFILE_UPDATED },
    });
    expect(entry.entityId).toBe(member.user.id);
    expect(entry.organizationId).toBe(member.organization.id);
    expect(entry.metadata).toMatchObject({ fields: 'fullName', emailChanged: false });
  });

  it('does not record the password among the fields it audits', async () => {
    await member
      .patch('/profile')
      .send({ email: 'sara.new@wasel.test', currentPassword: TEST_PASSWORD })
      .expect(200);

    const entries = await ctx.prisma.auditLog.findMany({ where: { actorId: member.user.id } });
    const raw = JSON.stringify(entries);
    expect(raw).not.toContain(TEST_PASSWORD);
    expect(raw).not.toContain('currentPassword');
  });

  it('keeps the profile shape in step with the contract', async () => {
    // The route is documented with `profileSchema`; parsing the real response
    // through it is what stops the two drifting.
    const { profileSchema } = await import('@wasel/contracts');
    const response = await member.get('/profile').expect(200);
    const parsed: ProfileDto = profileSchema.parse(response.body);
    expect(parsed.id).toBe(member.user.id);
  });
});
