import { randomUUID } from 'node:crypto';
import type { Organization, User } from '@prisma/client';
import { Role, UserStatus, type AuthTokens, type AuthUser } from '@wasel/contracts';
import type TestAgent from 'supertest/lib/agent.js';
import { GLOBAL_PREFIX } from '../../src/bootstrap.js';
import { PasswordService } from '../../src/modules/auth/password.service.js';
import type { TestApp } from './create-test-app.js';

/**
 * Authentication fixtures for integration tests.
 *
 * Every other module's suite needs a signed-in principal, and hand-rolling one
 * per suite means three different opinions about how a user is seeded and, sooner
 * or later, a test that passes against a token the application would reject.
 * These helpers mint credentials the only way production does: a real row, a real
 * argon2 digest produced by the application's own `PasswordService`, and a real
 * `POST /auth/login`.
 *
 * Call them *after* `ctx.truncate()`, not before — truncation removes the rows.
 *
 * ```ts
 * const admin = await createUserAndLogin(ctx, { role: Role.ADMIN });
 * await admin.get('/sites').expect(200);
 *
 * // A second tenant, for the cross-tenant boundary test every module owes:
 * const other = await createUserAndLogin(ctx);
 * await other.get(`/sites/${siteInAdminsOrg}`).expect(404);
 * ```
 */

/** One supertest request, as returned by the agent's verb methods. */
export type HttpRequest = ReturnType<TestAgent['get']>;

/** Default password for seeded users. Satisfies the contract's password policy. */
export const TEST_PASSWORD = 'CorrectHorse7';

const apiPath = (path: string): string =>
  path.startsWith(`/${GLOBAL_PREFIX}`)
    ? path
    : `/${GLOBAL_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;

export interface CreateOrganizationOptions {
  name?: string;
  slug?: string;
  /** IANA zone. Attendance suites should set this deliberately, not inherit UTC. */
  timezone?: string;
  workdayStart?: string;
  workdayEnd?: string;
  /** Local time the business day rolls over. Night-shift suites must set this. */
  dayStartsAt?: string;
  lateGraceMinutes?: number;
  maxAccuracyMeters?: number;
  /** Defaults to the column's own `true`, which is the pre-existing behaviour. */
  enforceGeofence?: boolean;
}

export async function createOrganization(
  ctx: TestApp,
  options: CreateOrganizationOptions = {},
): Promise<Organization> {
  const suffix = randomUUID().slice(0, 8);
  return ctx.prisma.organization.create({
    data: {
      name: options.name ?? `Test Org ${suffix}`,
      // Unique per row: the column is UNIQUE and a fixed slug turns the second
      // organization in a test file into a confusing P2002.
      slug: options.slug ?? `test-org-${suffix}`,
      ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
      ...(options.workdayStart === undefined ? {} : { workdayStart: options.workdayStart }),
      ...(options.workdayEnd === undefined ? {} : { workdayEnd: options.workdayEnd }),
      ...(options.dayStartsAt === undefined ? {} : { dayStartsAt: options.dayStartsAt }),
      ...(options.lateGraceMinutes === undefined
        ? {}
        : { lateGraceMinutes: options.lateGraceMinutes }),
      ...(options.maxAccuracyMeters === undefined
        ? {}
        : { maxAccuracyMeters: options.maxAccuracyMeters }),
      ...(options.enforceGeofence === undefined
        ? {}
        : { enforceGeofence: options.enforceGeofence }),
    },
  });
}

export interface CreateUserOptions {
  /** Existing tenant to place the user in. A fresh organization is created when omitted. */
  organizationId?: string;
  organization?: CreateOrganizationOptions;
  email?: string;
  password?: string;
  fullName?: string;
  employeeCode?: string | null;
  role?: Role;
  status?: UserStatus;
  tokenVersion?: number;
  /** Set to soft-delete the user on creation. */
  deletedAt?: Date | null;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
}

export interface SeededUser {
  user: User;
  organization: Organization;
  /** The plaintext password, so the test can log in or change it. */
  password: string;
}

/**
 * Creates a user without signing them in — for the fixtures a login must reject:
 * suspended, soft-deleted, already locked.
 *
 * The digest comes from the application's own `PasswordService`, so the argon2
 * parameters can never drift from the ones the running code verifies against.
 */
export async function createUser(
  ctx: TestApp,
  options: CreateUserOptions = {},
): Promise<SeededUser> {
  const organization = options.organizationId
    ? await ctx.prisma.organization.findUniqueOrThrow({ where: { id: options.organizationId } })
    : await createOrganization(ctx, options.organization);

  const password = options.password ?? TEST_PASSWORD;
  const passwordHash = await ctx.app.get(PasswordService).hash(password);
  const suffix = randomUUID().slice(0, 8);

  const user = await ctx.prisma.user.create({
    data: {
      organizationId: organization.id,
      // Lowercased because the contract normalises the address on the way in and
      // the lookup is a plain equality — a mixed-case fixture simply never matches.
      email: (options.email ?? `user-${suffix}@wasel.test`).trim().toLowerCase(),
      passwordHash,
      fullName: options.fullName ?? `Test User ${suffix}`,
      employeeCode: options.employeeCode === undefined ? `EMP-${suffix}` : options.employeeCode,
      role: options.role ?? Role.MEMBER,
      status: options.status ?? UserStatus.ACTIVE,
      ...(options.tokenVersion === undefined ? {} : { tokenVersion: options.tokenVersion }),
      ...(options.deletedAt === undefined ? {} : { deletedAt: options.deletedAt }),
      ...(options.failedLoginAttempts === undefined
        ? {}
        : { failedLoginAttempts: options.failedLoginAttempts }),
      ...(options.lockedUntil === undefined ? {} : { lockedUntil: options.lockedUntil }),
    },
  });

  return { user, organization, password };
}

export interface AuthenticatedActor extends SeededUser {
  tokens: AuthTokens;
  accessToken: string;
  refreshToken: string;
  /** The `AuthUser` the login returned, already in contract shape. */
  authUser: AuthUser;
  /** Adds this actor's bearer token to a request built elsewhere. */
  authorize: (request: HttpRequest) => HttpRequest;
  /**
   * Verb helpers bound to this actor. Paths are relative to the API prefix, so
   * `get('/sites')` hits `/api/v1/sites`; an absolute `/api/v1/...` also works.
   */
  get: (path: string) => HttpRequest;
  post: (path: string) => HttpRequest;
  put: (path: string) => HttpRequest;
  patch: (path: string) => HttpRequest;
  delete: (path: string) => HttpRequest;
}

/**
 * Seeds a user and signs them in through the real login endpoint.
 *
 * Going through HTTP rather than minting a token directly is deliberate: the
 * returned token is one the guard has already proved it accepts, so a suite using
 * it cannot pass against a credential production would refuse.
 */
export async function createUserAndLogin(
  ctx: TestApp,
  options: CreateUserOptions = {},
): Promise<AuthenticatedActor> {
  const seeded = await createUser(ctx, options);

  const response = await ctx.http
    .post(apiPath('/auth/login'))
    .send({ email: seeded.user.email, password: seeded.password });

  if (response.status === 429) {
    throw new Error(
      'createUserAndLogin: the login endpoint is rate limited (it is deliberately ' +
        'stricter than the global limit — see LoginThrottleGuard). A suite that signs ' +
        "in many users needs a bigger budget: createTestApp({ env: { RATE_LIMIT_MAX: '100000' } }).",
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `createUserAndLogin: login returned ${response.status} ` +
        `(${JSON.stringify(response.body)}). Seed an inactive user with createUser() instead.`,
    );
  }

  const body = response.body as { user: AuthUser; tokens: AuthTokens };
  return { ...seeded, ...actorFrom(ctx, body.tokens, body.user) };
}

/** The request helpers, for a token obtained some other way (a manual refresh, say). */
export function authorizedRequests(
  ctx: TestApp,
  accessToken: string,
): Pick<AuthenticatedActor, 'authorize' | 'get' | 'post' | 'put' | 'patch' | 'delete'> {
  const authorize = (request: HttpRequest): HttpRequest =>
    request.set('Authorization', `Bearer ${accessToken}`);

  return {
    authorize,
    get: (path) => authorize(ctx.http.get(apiPath(path))),
    post: (path) => authorize(ctx.http.post(apiPath(path))),
    put: (path) => authorize(ctx.http.put(apiPath(path))),
    patch: (path) => authorize(ctx.http.patch(apiPath(path))),
    delete: (path) => authorize(ctx.http.delete(apiPath(path))),
  };
}

function actorFrom(
  ctx: TestApp,
  tokens: AuthTokens,
  authUser: AuthUser,
): Omit<AuthenticatedActor, keyof SeededUser> {
  return {
    tokens,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    authUser,
    ...authorizedRequests(ctx, tokens.accessToken),
  };
}
