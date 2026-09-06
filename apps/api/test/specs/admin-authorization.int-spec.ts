import { Role } from '@wasel/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminModule } from '../../src/modules/admin/admin.module.js';
import { AuthModule } from '../../src/modules/auth/auth.module.js';
import {
  createTestApp,
  createUserAndLogin,
  type AuthenticatedActor,
  type TestApp,
} from '../support/index.js';

/** Any syntactically valid uuid; the guard rejects before the row is looked up. */
const SOME_ID = '00000000-0000-4000-8000-000000000000';
const RANGE = 'from=2026-03-01&to=2026-03-31';

/**
 * Every route the admin module publishes.
 *
 * The paths are pinned: `apps/mobile/src/api/endpoints.ts` already calls exactly
 * these, so a rename here is a broken client. Reaching a **403** rather than a
 * 404 is what proves both halves at once — the route exists, and it is guarded.
 */
const ROUTES: ReadonlyArray<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string }> = [
  { method: 'get', path: '/admin/overview' },
  { method: 'get', path: '/admin/users' },
  { method: 'post', path: '/admin/users' },
  { method: 'get', path: `/admin/users/${SOME_ID}` },
  { method: 'patch', path: `/admin/users/${SOME_ID}` },
  { method: 'delete', path: `/admin/users/${SOME_ID}` },
  { method: 'post', path: `/admin/users/${SOME_ID}/password` },
  { method: 'get', path: '/admin/sites' },
  { method: 'post', path: '/admin/sites' },
  { method: 'get', path: `/admin/sites/${SOME_ID}` },
  { method: 'patch', path: `/admin/sites/${SOME_ID}` },
  { method: 'delete', path: `/admin/sites/${SOME_ID}` },
  { method: 'get', path: '/admin/organization' },
  { method: 'patch', path: '/admin/organization' },
  { method: 'get', path: `/admin/reports/attendance?${RANGE}` },
  { method: 'get', path: `/admin/reports/export?${RANGE}&format=csv` },
];

describe('admin authorization', () => {
  let ctx: TestApp;
  let member: AuthenticatedActor;

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
    member = await createUserAndLogin(ctx, { role: Role.MEMBER });
  });

  it.each(ROUTES)('refuses a MEMBER on $method $path', async ({ method, path }) => {
    const response = await member[method](path).send({});
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(ROUTES)(
    'refuses an unauthenticated caller on $method $path',
    async ({ method, path }) => {
      const response = await ctx.http[method](`/api/v1${path}`).send({});
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    },
  );

  it('refuses a suspended administrator, whatever their role says', async () => {
    const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
    await ctx.prisma.user.update({
      where: { id: admin.user.id },
      data: { status: 'SUSPENDED' },
    });

    const response = await admin.get('/admin/overview');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });

  it('admits an administrator to the same routes', async () => {
    const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
    for (const { method, path } of ROUTES) {
      const response = await admin[method](path).send({});
      // 400/404/422 are legitimate answers to an empty body or a missing row;
      // 403 never is.
      expect({ path, status: response.status }).not.toMatchObject({ status: 403 });
    }
  });
});
