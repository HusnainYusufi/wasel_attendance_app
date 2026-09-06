import { Role, UserStatus, type UserDto } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import { AdminUsersService } from '../../src/modules/admin/admin-users.service.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import { PasswordService } from '../../src/modules/auth/password.service.js';
import {
  TEST_PASSWORD,
  createTestApp,
  createUser,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

const STRONG_PASSWORD = 'Sunflower42Bridge';

/** Longer than Prisma's 5 s interactive-transaction timeout, so the wait bites. */
const LOCK_HOLD_MS = 8_000;

describe('admin users', () => {
  let ctx: TestApp;
  let admin: AuthenticatedActor;

  beforeAll(async () => {
    ctx = await createTestApp({
      imports: [AuthModule, AdminModule],
      env: { RATE_LIMIT_MAX: '100000' },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.truncate();
    admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
  });

  describe('GET /admin/users', () => {
    it('lists the tenant, newest first', async () => {
      await createUser(ctx, { organizationId: admin.organization.id, fullName: 'Zoe Nasser' });

      const response = await admin.get('/admin/users').expect(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toMatchObject({ page: 1, total: 2, hasNext: false });
      expect(response.body.data[0].fullName).toBe('Zoe Nasser');
    });

    it('never returns a password hash', async () => {
      const response = await admin.get('/admin/users').expect(200);
      expect(JSON.stringify(response.body)).not.toContain('argon2');
      expect(response.body.data[0]).not.toHaveProperty('passwordHash');
    });

    it('excludes soft-deleted employees', async () => {
      await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'Departed Employee',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const response = await admin.get('/admin/users').expect(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data.map((u: UserDto) => u.fullName)).not.toContain('Departed Employee');
    });

    it('searches name, email and employee code case-insensitively', async () => {
      await createUser(ctx, {
        organizationId: admin.organization.id,
        fullName: 'Layla Haddad',
        email: 'layla@wasel.test',
        employeeCode: 'ENG-7',
      });

      for (const term of ['layla', 'LAYLA', 'HADDAD', 'wasel.test', 'eng-7']) {
        const response = await admin.get(`/admin/users?search=${term}`).expect(200);
        expect(
          response.body.data.some((u: UserDto) => u.fullName === 'Layla Haddad'),
          `search=${term}`,
        ).toBe(true);
      }
    });

    it('filters by role and status', async () => {
      await createUser(ctx, {
        organizationId: admin.organization.id,
        status: UserStatus.SUSPENDED,
      });

      const admins = await admin.get(`/admin/users?role=${Role.ADMIN}`).expect(200);
      expect(admins.body.meta.total).toBe(1);

      const suspended = await admin.get(`/admin/users?status=${UserStatus.SUSPENDED}`).expect(200);
      expect(suspended.body.meta.total).toBe(1);
    });

    it('pages to the boundary and past it', async () => {
      for (let i = 0; i < 2; i += 1) {
        await createUser(ctx, { organizationId: admin.organization.id });
      }

      const first = await admin.get('/admin/users?page=1&pageSize=2').expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta).toMatchObject({ totalPages: 2, hasNext: true, hasPrevious: false });

      const last = await admin.get('/admin/users?page=2&pageSize=2').expect(200);
      expect(last.body.data).toHaveLength(1);
      expect(last.body.meta).toMatchObject({ hasNext: false, hasPrevious: true });

      const past = await admin.get('/admin/users?page=3&pageSize=2').expect(200);
      expect(past.body.data).toHaveLength(0);
      expect(past.body.meta).toMatchObject({ total: 3, hasNext: false });
    });

    it.each([
      ['page=0', 'page'],
      ['pageSize=0', 'pageSize'],
      ['pageSize=101', 'pageSize'],
      ['role=OWNER', 'role'],
    ])('rejects ?%s', async (query, path) => {
      const response = await admin.get(`/admin/users?${query}`).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details.some((d: { path: string }) => d.path === path)).toBe(true);
    });

    it('shows one tenant nothing of another', async () => {
      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      await createUser(ctx, { organizationId: other.organization.id, fullName: 'Their Employee' });

      const response = await admin.get('/admin/users').expect(200);
      expect(response.body.data.map((u: UserDto) => u.fullName)).not.toContain('Their Employee');
      expect(response.body.meta.total).toBe(1);
    });
  });

  describe('POST /admin/users', () => {
    const body = {
      email: 'New.Hire@Wasel.test',
      password: STRONG_PASSWORD,
      fullName: 'New Hire',
      employeeCode: 'EMP-100',
    };

    it('creates a member whose password works at the login endpoint', async () => {
      const response = await admin.post('/admin/users').send(body).expect(201);
      // The contract lowercases on the way in, so one human is one account.
      expect(response.body).toMatchObject({
        email: 'new.hire@wasel.test',
        role: Role.MEMBER,
        status: UserStatus.ACTIVE,
      });

      // Proves the digest was produced with the parameters the running code
      // verifies against — a second, weaker hasher would fail exactly here.
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: 'new.hire@wasel.test', password: STRONG_PASSWORD })
        .expect(200);
    });

    it('can create another administrator', async () => {
      const response = await admin
        .post('/admin/users')
        .send({ ...body, role: Role.ADMIN })
        .expect(201);
      expect(response.body.role).toBe(Role.ADMIN);
    });

    it('writes an audit row naming the actor and the new employee', async () => {
      const response = await admin.post('/admin/users').send(body).expect(201);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'admin.user.created', entityId: response.body.id },
      });
      expect(audit).toMatchObject({
        organizationId: admin.organization.id,
        actorId: admin.user.id,
        entityType: 'User',
      });
      expect(audit?.ipAddress).not.toBeNull();
    });

    it('reports a duplicate email as EMAIL_TAKEN', async () => {
      await admin.post('/admin/users').send(body).expect(201);
      const response = await admin
        .post('/admin/users')
        .send({ ...body, employeeCode: 'EMP-101' })
        .expect(409);
      expect(response.body.code).toBe('EMAIL_TAKEN');
    });

    it('reports a duplicate employee code as EMPLOYEE_CODE_TAKEN', async () => {
      await admin.post('/admin/users').send(body).expect(201);
      const response = await admin
        .post('/admin/users')
        .send({ ...body, email: 'other@wasel.test' })
        .expect(409);
      expect(response.body.code).toBe('EMPLOYEE_CODE_TAKEN');
    });

    it('allows the same email in a different tenant', async () => {
      await admin.post('/admin/users').send(body).expect(201);

      const other = await createUserAndLogin(ctx, { role: Role.ADMIN });
      await other.post('/admin/users').send(body).expect(201);
    });

    it.each([
      [{ ...body, email: 'not-an-email' }, 'email'],
      [{ ...body, password: 'short' }, 'password'],
      [{ ...body, password: 'nodigitsatallhere' }, 'password'],
      [{ ...body, fullName: 'A' }, 'fullName'],
      [{ ...body, employeeCode: 'has spaces' }, 'employeeCode'],
      [{ ...body, role: 'OWNER' }, 'role'],
    ])('rejects an invalid body (%#)', async (payload, path) => {
      const response = await admin.post('/admin/users').send(payload).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details.some((d: { path: string }) => d.path === path)).toBe(true);
    });

    it('never logs the plaintext password', async () => {
      await admin.post('/admin/users').send(body).expect(201);
      expect(ctx.logs.raw()).not.toContain(STRONG_PASSWORD);
    });
  });

  describe('GET /admin/users/:id', () => {
    it('returns an employee of this tenant', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      const response = await admin.get(`/admin/users/${target.user.id}`).expect(200);
      expect(response.body.id).toBe(target.user.id);
    });

    it('answers 404 for an employee of another tenant', async () => {
      const other = await createUserAndLogin(ctx);
      const response = await admin.get(`/admin/users/${other.user.id}`).expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('rejects a malformed id before it reaches the database', async () => {
      const response = await admin.get('/admin/users/not-a-uuid').expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /admin/users/:id', () => {
    it('updates the fields it is given and leaves the rest alone', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });

      const response = await admin
        .patch(`/admin/users/${target.user.id}`)
        .send({ fullName: 'Renamed Person', status: UserStatus.SUSPENDED })
        .expect(200);

      expect(response.body).toMatchObject({
        fullName: 'Renamed Person',
        status: UserStatus.SUSPENDED,
        email: target.user.email,
        role: Role.MEMBER,
      });
    });

    it('clears an employee code when sent null', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      const response = await admin
        .patch(`/admin/users/${target.user.id}`)
        .send({ employeeCode: null })
        .expect(200);
      expect(response.body.employeeCode).toBeNull();
    });

    it('reports a colliding employee code', async () => {
      const first = await createUser(ctx, {
        organizationId: admin.organization.id,
        employeeCode: 'TAKEN-1',
      });
      const second = await createUser(ctx, { organizationId: admin.organization.id });

      const response = await admin
        .patch(`/admin/users/${second.user.id}`)
        .send({ employeeCode: first.user.employeeCode ?? 'TAKEN-1' })
        .expect(409);
      expect(response.body.code).toBe('EMPLOYEE_CODE_TAKEN');
    });

    it('rejects an empty patch', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      const response = await admin.patch(`/admin/users/${target.user.id}`).send({}).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    /**
     * Correcting a typo'd sign-in address.
     *
     * Until this existed the only remedy was delete-and-recreate, which leaves
     * every attendance record pointing at the soft-deleted row: the person
     * vanishes from their own history and their hours are counted against a name
     * nobody can look up.
     */
    describe('changing the email', () => {
      it('renames the account, normalised, and lets them sign in with it', async () => {
        const target = await createUserAndLogin(ctx, { organizationId: admin.organization.id });

        const response = await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: '  Corrected.Address@Wasel.TEST ' })
          .expect(200);
        expect(response.body.email).toBe('corrected.address@wasel.test');

        await ctx.http
          .post('/api/v1/auth/login')
          .send({ email: 'corrected.address@wasel.test', password: target.password })
          .expect(200);
        // The old address is genuinely gone, not merely aliased.
        await ctx.http
          .post('/api/v1/auth/login')
          .send({ email: target.user.email, password: target.password })
          .expect(401);
      });

      it('keeps the attendance history attached to the same row', async () => {
        // The whole reason this route exists rather than delete-and-recreate.
        const target = await createUser(ctx, { organizationId: admin.organization.id });

        await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: 'kept@wasel.test' })
          .expect(200);

        const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
        expect(row.id).toBe(target.user.id);
        expect(row.deletedAt).toBeNull();
        expect(row.createdAt.getTime()).toBe(target.user.createdAt.getTime());
      });

      it('reports a collision as EMAIL_TAKEN, not as a generic conflict', async () => {
        // `isUniqueViolation` matches the exact constraint or the complete field
        // set; a partial target silently stops matching and this surfaces as a
        // bare 409 that the mobile client cannot attach to the email input.
        const occupant = await createUser(ctx, {
          organizationId: admin.organization.id,
          email: 'occupied@wasel.test',
        });
        const target = await createUser(ctx, { organizationId: admin.organization.id });

        const response = await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: 'occupied@wasel.test' })
          .expect(409);
        expect(response.body.code).toBe('EMAIL_TAKEN');

        // Nothing moved: not the target, and not the account it collided with.
        const untouched = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: target.user.id },
        });
        expect(untouched.email).toBe(target.user.email);
        expect(untouched.tokenVersion).toBe(target.user.tokenVersion);
        const occupantRow = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: occupant.user.id },
        });
        expect(occupantRow.email).toBe('occupied@wasel.test');
      });

      it('catches a collision that differs only in case', async () => {
        // The normalisation is why `Occupied@Wasel.test` cannot become a second
        // account; without it this is a 200 and the tenant has two rows for one
        // human, one of which can never sign in.
        await createUser(ctx, {
          organizationId: admin.organization.id,
          email: 'occupied@wasel.test',
        });
        const target = await createUser(ctx, { organizationId: admin.organization.id });

        const response = await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: 'OCCUPIED@WASEL.TEST' })
          .expect(409);
        expect(response.body.code).toBe('EMAIL_TAKEN');
      });

      it('does not collide with the same address in another tenant', async () => {
        // The index is `(organizationId, email)`: one human may legitimately hold
        // an account in two organizations.
        const other = await createUserAndLogin(ctx);
        const target = await createUser(ctx, { organizationId: admin.organization.id });

        const response = await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: other.user.email })
          .expect(200);
        expect(response.body.email).toBe(other.user.email);
      });

      it('revokes every session the account holds', async () => {
        // The address is half of the credential pair, and the case this route
        // exists for is an address that belonged to somebody else — who may be
        // holding a live session on the account right now.
        const target = await createUserAndLogin(ctx, { organizationId: admin.organization.id });
        await target.get('/auth/me').expect(200);

        await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: 'moved@wasel.test' })
          .expect(200);

        const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
        expect(row.tokenVersion).toBe(target.user.tokenVersion + 1);

        // The access token dies with `tokenVersion` …
        await target.get('/auth/me').expect(401);
        // … and the refresh chain that would otherwise mint replacements dies too.
        const sessions = await ctx.prisma.session.findMany({ where: { userId: target.user.id } });
        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
      });

      it('leaves the sessions alone when the address did not actually move', async () => {
        // An edit form that always sends every field must not sign somebody out
        // for pressing Save on an unchanged address — including one re-typed in a
        // different case, which normalises to the value already stored.
        const target = await createUserAndLogin(ctx, { organizationId: admin.organization.id });

        await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: target.user.email.toUpperCase(), fullName: 'Same Address' })
          .expect(200);

        const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
        expect(row.tokenVersion).toBe(target.user.tokenVersion);
        expect(row.fullName).toBe('Same Address');
        await target.get('/auth/me').expect(200);
      });

      it('audits both addresses and the revocation', async () => {
        const target = await createUser(ctx, {
          organizationId: admin.organization.id,
          email: 'typo@wasel.test',
        });

        await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: 'fixed@wasel.test' })
          .expect(200);

        const entry = await ctx.prisma.auditLog.findFirstOrThrow({
          where: { action: 'admin.user.updated', entityId: target.user.id },
        });
        // The old address is the one fact about the account that cannot be
        // reconstructed from the current row.
        expect(entry.metadata).toMatchObject({
          previousEmail: 'typo@wasel.test',
          email: 'fixed@wasel.test',
          sessionsRevoked: true,
        });
      });

      it('does not claim a rename when only the name changed', async () => {
        const target = await createUser(ctx, { organizationId: admin.organization.id });
        await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ fullName: 'Just A Rename' })
          .expect(200);

        const entry = await ctx.prisma.auditLog.findFirstOrThrow({
          where: { action: 'admin.user.updated', entityId: target.user.id },
        });
        expect(entry.metadata).not.toHaveProperty('previousEmail');
      });

      it('rejects a malformed address before it reaches the database', async () => {
        const target = await createUser(ctx, { organizationId: admin.organization.id });
        const response = await admin
          .patch(`/admin/users/${target.user.id}`)
          .send({ email: 'not-an-address' })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(response.body.details.map((d: { path: string }) => d.path)).toContain('email');
      });

      it('cannot rename an employee of another tenant', async () => {
        const other = await createUserAndLogin(ctx);
        await admin
          .patch(`/admin/users/${other.user.id}`)
          .send({ email: 'hijacked@wasel.test' })
          .expect(404);

        const untouched = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.user.id } });
        expect(untouched.email).toBe(other.user.email);
      });
    });

    it('cannot reach another tenant', async () => {
      const other = await createUserAndLogin(ctx);
      await admin.patch(`/admin/users/${other.user.id}`).send({ fullName: 'Hijacked' }).expect(404);

      const untouched = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: other.user.id },
      });
      expect(untouched.fullName).toBe(other.user.fullName);
    });
  });

  describe('the last administrator', () => {
    it('cannot be demoted', async () => {
      const response = await admin
        .patch(`/admin/users/${admin.user.id}`)
        .send({ role: Role.MEMBER })
        .expect(422);
      expect(response.body.code).toBe('LAST_ADMIN');
    });

    it('cannot be suspended', async () => {
      const response = await admin
        .patch(`/admin/users/${admin.user.id}`)
        .send({ status: UserStatus.SUSPENDED })
        .expect(422);
      expect(response.body.code).toBe('LAST_ADMIN');
    });

    it('cannot be deleted', async () => {
      const response = await admin.delete(`/admin/users/${admin.user.id}`).expect(422);
      expect(response.body.code).toBe('LAST_ADMIN');
    });

    it('can still be renamed', async () => {
      await admin
        .patch(`/admin/users/${admin.user.id}`)
        .send({ fullName: 'Still The Admin' })
        .expect(200);
    });

    it('can be demoted once a second administrator exists', async () => {
      await createUser(ctx, { organizationId: admin.organization.id, role: Role.ADMIN });
      await admin.patch(`/admin/users/${admin.user.id}`).send({ role: Role.MEMBER }).expect(200);
    });

    it('does not count a suspended or soft-deleted administrator as cover', async () => {
      await createUser(ctx, {
        organizationId: admin.organization.id,
        role: Role.ADMIN,
        status: UserStatus.SUSPENDED,
      });
      await createUser(ctx, {
        organizationId: admin.organization.id,
        role: Role.ADMIN,
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const response = await admin
        .patch(`/admin/users/${admin.user.id}`)
        .send({ role: Role.MEMBER })
        .expect(422);
      expect(response.body.code).toBe('LAST_ADMIN');
    });

    it('is not protected by another tenant having administrators', async () => {
      await createUserAndLogin(ctx, { role: Role.ADMIN });
      const response = await admin.delete(`/admin/users/${admin.user.id}`).expect(422);
      expect(response.body.code).toBe('LAST_ADMIN');
    });

    /**
     * The race the rule exists for.
     *
     * Two requests arrive together, each removing one of the last two
     * administrators. A read-then-write check passes in both — each sees the
     * other's still-uncommitted admin — and the tenant ends up locked out. The
     * `SELECT … FOR UPDATE` in `AdminUsersService.lockActiveAdmins` makes the
     * loser re-read after the winner commits, so it sees the demotion and
     * refuses.
     */
    it('survives two concurrent removals of the last two administrators', async () => {
      const second = await createUser(ctx, {
        organizationId: admin.organization.id,
        role: Role.ADMIN,
      });

      // Driven at the service, not over HTTP. Two supertest requests are only
      // *probably* in flight together — measured, their transactions were 5 ms
      // apart and never overlapped — so an HTTP-level race test proves nothing
      // and passes just as happily with the locking removed. Starting both
      // transactions in the same tick is what actually opens the window.
      const users = ctx.app.get(AdminUsersService);
      const auth = {
        userId: admin.user.id,
        organizationId: admin.organization.id,
        role: Role.ADMIN,
        tokenVersion: admin.user.tokenVersion,
      };
      const client = { ipAddress: '127.0.0.1', userAgent: 'race-test' };

      const outcomes = await Promise.allSettled([
        users.update(auth, second.user.id, { role: Role.MEMBER }, client),
        users.remove(auth, admin.user.id, client),
      ]);

      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'LAST_ADMIN',
        status: 422,
      });

      const survivors = await ctx.prisma.user.count({
        where: {
          organizationId: admin.organization.id,
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
      });
      expect(survivors).toBe(1);
    });

    it('rejects the loser of two concurrent HTTP removals as well', async () => {
      const second = await createUser(ctx, {
        organizationId: admin.organization.id,
        role: Role.ADMIN,
      });

      const [demoteOther, deleteSelf] = await Promise.all([
        admin.patch(`/admin/users/${second.user.id}`).send({ role: Role.MEMBER }),
        admin.delete(`/admin/users/${admin.user.id}`),
      ]);

      const statuses = [demoteOther.status, deleteSelf.status];
      expect(statuses.filter((status) => status === 422)).toHaveLength(1);
      expect([demoteOther, deleteSelf].find((r) => r.status === 422)?.body.code).toBe('LAST_ADMIN');

      const survivors = await ctx.prisma.user.count({
        where: {
          organizationId: admin.organization.id,
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
      });
      expect(survivors).toBe(1);
    });
  });

  describe('the admin lock', () => {
    /**
     * Holds every active-administrator row of the tenant, exactly as
     * `lockActiveAdmins` does, for long enough to outlast an interactive
     * transaction's default 5 s timeout.
     */
    function holdAdminLock(organizationId: string): Promise<void> {
      return ctx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "users"
            WHERE "organizationId" = ${organizationId}::uuid
              AND "role" = 'ADMIN'::"Role"
              AND "status" = 'ACTIVE'::"UserStatus"
              AND "deletedAt" IS NULL
            ORDER BY "id"
            FOR UPDATE`;
          await new Promise((resolve) => setTimeout(resolve, LOCK_HOLD_MS));
        },
        { timeout: LOCK_HOLD_MS + 10_000, maxWait: 10_000 },
      );
    }

    /**
     * Two properties at once, because both need the same eight-second lock.
     *
     * Renaming an ordinary member cannot change the administrator quorum, so it
     * has no business queueing behind a tenant-wide `SELECT … FOR UPDATE` over
     * every admin — and when it did, the wait was bounded by Prisma's 5 s
     * transaction timeout and surfaced as `500 INTERNAL_ERROR` with a `P2028`.
     * A change that *can* move the quorum still takes the lock, still waits, and
     * now says so with a retryable `409` instead of claiming the server broke.
     */
    it('lets an unrelated rename through, and reports a real wait as a retryable conflict', async () => {
      const member = await createUser(ctx, { organizationId: admin.organization.id });
      const peer = await createUser(ctx, {
        organizationId: admin.organization.id,
        role: Role.ADMIN,
      });

      const holder = holdAdminLock(admin.organization.id);
      // Let the holding transaction actually take the locks first.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const startedAt = Date.now();
      const [rename, suspend] = await Promise.all([
        admin
          .patch(`/admin/users/${member.user.id}`)
          .send({ fullName: 'Renamed While Locked' })
          .then((response) => ({ response, elapsed: Date.now() - startedAt })),
        admin.patch(`/admin/users/${peer.user.id}`).send({ status: UserStatus.SUSPENDED }),
      ]);
      await holder;

      expect(rename.response.status).toBe(200);
      expect((rename.response.body as UserDto).fullName).toBe('Renamed While Locked');
      expect(rename.elapsed).toBeLessThan(LOCK_HOLD_MS);

      expect(suspend.status).toBe(409);
      expect(suspend.body.code).toBe('CONFLICT');
    });
  });

  describe('DELETE /admin/users/:id', () => {
    it('soft-deletes and revokes every session', async () => {
      const target = await createUserAndLogin(ctx, {
        organizationId: admin.organization.id,
      });

      await admin.delete(`/admin/users/${target.user.id}`).expect(204);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
      // The row survives: attendance records point at it, and an employee
      // leaving must not delete last month's report.
      expect(row.deletedAt).not.toBeNull();
      expect(row.tokenVersion).toBe(target.user.tokenVersion + 1);

      const sessions = await ctx.prisma.session.findMany({ where: { userId: target.user.id } });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

      // Their phone stops working immediately, and they cannot sign back in.
      await target.get('/auth/me').expect(401);
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: target.user.email, password: target.password })
        .expect(401);
    });

    it('is idempotent-ish: a second delete is a 404, not a 500', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      await admin.delete(`/admin/users/${target.user.id}`).expect(204);
      await admin.delete(`/admin/users/${target.user.id}`).expect(404);
    });

    it('cannot reach another tenant', async () => {
      const other = await createUserAndLogin(ctx);
      await admin.delete(`/admin/users/${other.user.id}`).expect(404);

      const untouched = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.user.id } });
      expect(untouched.deletedAt).toBeNull();
    });
  });

  describe('POST /admin/users/:id/password', () => {
    it('sets a new password and kills the old sessions immediately', async () => {
      const target = await createUserAndLogin(ctx, { organizationId: admin.organization.id });

      await admin
        .post(`/admin/users/${target.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(204);

      // The access token in flight dies with the `tokenVersion` bump…
      await target.get('/auth/me').expect(401);
      // …and so does the refresh token that would have replaced it.
      await ctx.http
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: target.refreshToken })
        .expect(401);

      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: target.user.email, password: TEST_PASSWORD })
        .expect(401);
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: target.user.email, password: STRONG_PASSWORD })
        .expect(200);
    });

    it('clears a brute-force lockout', async () => {
      const target = await createUser(ctx, {
        organizationId: admin.organization.id,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 3_600_000),
      });

      await admin
        .post(`/admin/users/${target.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(204);

      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
      expect(row.failedLoginAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });

    it('rejects a weak password', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      const response = await admin
        .post(`/admin/users/${target.user.id}/password`)
        .send({ newPassword: 'weak' })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('cannot reset a password in another tenant', async () => {
      const other = await createUserAndLogin(ctx);
      await admin
        .post(`/admin/users/${other.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(404);

      // Their credentials still work.
      await ctx.http
        .post('/api/v1/auth/login')
        .send({ email: other.user.email, password: other.password })
        .expect(200);
    });

    /**
     * The one reset that hands the caller somebody else's identity.
     *
     * Every ADMIN in a two-role product already has total authority over the
     * tenant — including creating another administrator — so this is not an
     * escalation, and gating it on re-authentication would not close any path
     * that is not already open. What it *is* is impersonation of a specific
     * colleague, whose sessions die at the same moment, and that deserves an
     * action an alert can be built on rather than one row among every routine
     * "I reset an employee's password".
     */
    it('records a peer-administrator reset under its own audit action', async () => {
      const peer = await createUser(ctx, {
        organizationId: admin.organization.id,
        role: Role.ADMIN,
      });

      await admin
        .post(`/admin/users/${peer.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(204);

      const rows = await ctx.prisma.auditLog.findMany({
        where: { organizationId: admin.organization.id, entityId: peer.user.id },
      });
      expect(rows.map((row) => row.action)).toEqual(['admin.user.admin_password_reset']);
      expect(rows[0]?.metadata).toMatchObject({ selfService: false, targetRole: Role.ADMIN });
    });

    it('keeps an ordinary employee reset, and a self-service one, on the ordinary action', async () => {
      const member = await createUser(ctx, { organizationId: admin.organization.id });

      await admin
        .post(`/admin/users/${member.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(204);
      await admin
        .post(`/admin/users/${admin.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(204);

      const rows = await ctx.prisma.auditLog.findMany({
        where: { organizationId: admin.organization.id, action: { startsWith: 'admin.user.' } },
        select: { action: true, entityId: true, metadata: true },
      });
      expect(rows.map((row) => row.action)).toEqual([
        'admin.user.password_reset',
        'admin.user.password_reset',
      ]);
      expect(rows.find((row) => row.entityId === admin.user.id)?.metadata).toMatchObject({
        selfService: true,
      });
    });

    /**
     * The window between the existence check and the write.
     *
     * `updateMany` reports "the row is gone" by changing nothing rather than by
     * throwing, so ignoring its count answered `204` and wrote an audit row
     * claiming a password had been set on an account that no longer existed —
     * leaving an administrator confident about a credential that works nowhere.
     */
    it('does not claim success when the target is deleted between the read and the write', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      const passwords = ctx.app.get(PasswordService);
      const hash = passwords.hash.bind(passwords);
      const spy = vi.spyOn(passwords, 'hash').mockImplementation(async (plain: string) => {
        // Hashing happens after the target is read and before it is written, so
        // this lands the delete exactly in the window the bug lived in.
        await ctx.prisma.user.update({
          where: { id: target.user.id },
          data: { deletedAt: new Date() },
        });
        return hash(plain);
      });

      try {
        const response = await admin
          .post(`/admin/users/${target.user.id}/password`)
          .send({ newPassword: STRONG_PASSWORD })
          .expect(404);
        expect(response.body.code).toBe('NOT_FOUND');
      } finally {
        spy.mockRestore();
      }

      const rows = await ctx.prisma.auditLog.findMany({
        where: { organizationId: admin.organization.id, action: { startsWith: 'admin.user.' } },
      });
      expect(rows).toHaveLength(0);
      // The sessions of a user nobody successfully reset are not revoked either.
      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
      expect(row.tokenVersion).toBe(target.user.tokenVersion);
    });

    it('never logs the new password', async () => {
      const target = await createUser(ctx, { organizationId: admin.organization.id });
      await admin
        .post(`/admin/users/${target.user.id}/password`)
        .send({ newPassword: STRONG_PASSWORD })
        .expect(204);
      expect(ctx.logs.raw()).not.toContain(STRONG_PASSWORD);
    });
  });
});
