/**
 * `pnpm db:seed` — brings a fresh database up to a usable state.
 *
 * Three properties matter more than anything this script creates:
 *
 *  1. **It is idempotent.** Every object is looked up before it is created, and
 *     a lost race is absorbed by catching the unique violation and re-reading.
 *     Running it twice is a no-op, so it is safe in a container entrypoint, in a
 *     deploy hook, and after a `git pull` when nobody remembers whether it has
 *     been run.
 *  2. **It never overwrites.** An existing admin keeps its password. A seed that
 *     "helpfully" resets credentials is a privilege-escalation primitive for
 *     anyone who can trigger a redeploy.
 *  3. **It refuses to put a public password on a production database.** The
 *     value in `.env.example` is in the repository, in shell history and in
 *     every developer's terminal scrollback.
 *
 * This is a standalone `tsx` script, not part of the Nest application, so
 * reading `process.env` here is correct where it would be a bug anywhere in
 * `src/` — but it is *validated* before use, with the same contract schemas the
 * API validates its own input with. It reuses the application's argon2
 * parameters for the same reason: a seeded digest produced with weaker settings
 * than the running code verifies against is a silent downgrade for the one
 * account that has every permission.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Organization, Site, User } from '@prisma/client';
import {
  Role,
  SITE_RADIUS_DEFAULT_M,
  SITE_RADIUS_MAX_M,
  SITE_RADIUS_MIN_M,
  emailSchema,
  fullNameSchema,
  latitudeSchema,
  longitudeSchema,
  passwordSchema,
  timezoneSchema,
} from '@wasel/contracts';
import { hash as argon2Hash } from 'argon2';
import { z } from 'zod';
import { loadEnvFiles } from '../src/config/load-env-files.js';
import { ARGON2_OPTIONS } from '../src/modules/auth/auth.constants.js';
import { PrismaClient } from '../src/prisma/prisma-client.js';
import { isUniqueViolation } from '../src/prisma/prisma-errors.js';

/**
 * Passwords that are public knowledge because they ship in `.env.example`.
 * Seeding an administrator with one of these outside development is the same as
 * seeding no password at all.
 *
 * The list is checked against the file rather than merely written to match it:
 * a hand-maintained copy of somebody else's constant drifts, and the drift here
 * is silent and disarms the guard. `admin-seed.int-spec.ts` fails if
 * `.env.example` ever publishes a password this list does not name.
 */
export const PLACEHOLDER_PASSWORDS: readonly string[] = [
  'Admin123!Change',
  'ChangeMe123!',
  'password123',
];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `SEED_ADMIN_PASSWORD` as published in the repository's `.env.example`, if it is there. */
export function publishedAdminPassword(
  envExample = path.resolve(HERE, '..', '..', '..', '.env.example'),
): string | null {
  let contents: string;
  try {
    contents = readFileSync(envExample, 'utf8');
  } catch {
    // Absent in a deployed image, which is normal and not a reason to refuse.
    return null;
  }
  const match = /^\s*SEED_ADMIN_PASSWORD\s*=\s*(.*)$/m.exec(contents);
  if (match?.[1] === undefined) return null;
  const value = match[1].trim().replace(/^['"]|['"]$/g, '');
  return value === '' ? null : value;
}

/**
 * Is this the password everybody already has?
 *
 * Reads `.env.example` as well as the list above, so a placeholder added to the
 * file — but not here — is still refused rather than quietly accepted.
 */
export function isPlaceholderPassword(password: string): boolean {
  if (PLACEHOLDER_PASSWORDS.includes(password)) return true;
  return publishedAdminPassword() === password;
}

const DEFAULT_SITE = {
  name: 'Head Office',
  // Riyadh — a sensible default for the `Asia/Riyadh` tenant this ships with,
  // and one an administrator is expected to move to their real address.
  latitude: 24.7136,
  longitude: 46.6753,
} as const;

const seedEnvSchema = z.object({
  /**
   * Required, deliberately without a default.
   *
   * A default of `development` makes the production refusal below fail *open* on
   * exactly the environments that need it most: an unset `NODE_ENV` is the normal
   * state of a container image and of most CI runners, and it would silently
   * become "development" and skip the check. An ambiguous answer to "is this
   * production?" has to be an error, not an assumption.
   */
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    error: 'Set NODE_ENV explicitly to development, test or production before seeding',
  }),
  DATABASE_URL: z
    .string()
    .trim()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'postgresql:' || url.protocol === 'postgres:';
      } catch {
        return false;
      }
    }, 'Must be a postgresql:// connection string'),

  SEED_ADMIN_EMAIL: emailSchema,
  SEED_ADMIN_PASSWORD: passwordSchema,
  SEED_ADMIN_NAME: fullNameSchema.default('Wasel Administrator'),

  SEED_ORG_NAME: z.string().trim().min(2).max(120).default('Wasel'),
  SEED_ORG_SLUG: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Must be a lowercase slug, e.g. acme-logistics')
    .optional(),
  SEED_ORG_TIMEZONE: timezoneSchema.default('UTC'),

  SEED_SITE_NAME: z.string().trim().min(2).max(120).default(DEFAULT_SITE.name),
  SEED_SITE_LATITUDE: z.coerce.number().pipe(latitudeSchema).default(DEFAULT_SITE.latitude),
  SEED_SITE_LONGITUDE: z.coerce.number().pipe(longitudeSchema).default(DEFAULT_SITE.longitude),
  SEED_SITE_RADIUS_M: z.coerce
    .number()
    .int()
    .min(SITE_RADIUS_MIN_M)
    .max(SITE_RADIUS_MAX_M)
    .default(SITE_RADIUS_DEFAULT_M),
});

type SeedEnv = z.output<typeof seedEnvSchema>;

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** `postgresql://user:secret@host/db` → `postgresql://user:***@host/db`. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password !== '') url.password = '***';
    return url.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  // A name written entirely in a non-Latin script reduces to nothing. Falling
  // back beats emitting an empty slug into a UNIQUE column.
  return slug === '' ? 'wasel' : slug;
}

export function readEnv(source: NodeJS.ProcessEnv): SeedEnv {
  const result = seedEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(environment)'}: ${issue.message}`)
      .join('\n');
    throw new SeedError(
      `Cannot seed: the environment is invalid.\n${problems}\nSee .env.example for the expected values.`,
    );
  }
  return result.data;
}

/** The only environments in which a publicly-known password is acceptable. */
const PLACEHOLDER_PASSWORD_ALLOWED: readonly SeedEnv['NODE_ENV'][] = ['development', 'test'];

/**
 * The one refusal.
 *
 * Deliberately checked against `NODE_ENV` rather than guessed from the host in
 * the connection string: "is this database production" is not something a regex
 * over a hostname can answer, and a check that is wrong half the time trains
 * people to work around it.
 *
 * Stated as an allowlist rather than as `!== 'production'`. The two are the same
 * sentence read in opposite directions, and only one of them is safe to get
 * wrong: a denylist has to enumerate every environment that is dangerous, so an
 * environment nobody thought of — `staging`, `preview`, or the empty string —
 * lands on the permissive side. The password published in the repository is
 * acceptable in development and in test, and nowhere else.
 */
export function assertSafeForTarget(env: SeedEnv): void {
  if (!isPlaceholderPassword(env.SEED_ADMIN_PASSWORD)) return;
  if (PLACEHOLDER_PASSWORD_ALLOWED.includes(env.NODE_ENV)) return;

  throw new SeedError(
    `Refusing to seed a ${env.NODE_ENV} database with the example administrator password.\n` +
      '  SEED_ADMIN_PASSWORD is one of the placeholders published in .env.example, so it\n' +
      '  is public knowledge. Set a real one and run again:\n' +
      '    SEED_ADMIN_PASSWORD="$(openssl rand -base64 24)" pnpm db:seed',
  );
}

type Outcome = 'created' | 'existing';

interface Step {
  label: string;
  outcome: Outcome;
  detail: string;
}

export interface SeedResult {
  steps: Step[];
  /**
   * Settings the seed declined to apply because the row already existed.
   *
   * Printed rather than swallowed: "it never overwrites" is the right policy and
   * a silent one is how an operator concludes their `SEED_ORG_TIMEZONE` took
   * effect when it did not.
   */
  warnings: string[];
}

/**
 * Create-if-absent, race-tolerant.
 *
 * The lookup is not a guarantee — two entrypoints starting at once both pass it
 * — so the unique violation is caught and turned into the same "already there"
 * answer the lookup would have given. That is the only way to be idempotent
 * *and* concurrent without a lock.
 */
async function ensure<T>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<{ row: T; outcome: Outcome }> {
  const found = await find();
  if (found !== null) return { row: found, outcome: 'existing' };

  try {
    return { row: await create(), outcome: 'created' };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await find();
    if (raced === null) throw error;
    return { row: raced, outcome: 'existing' };
  }
}

/** The generated client's instance type; the constructor itself is a value import. */
type Db = InstanceType<typeof PrismaClient>;

/**
 * Refuses to continue when the administrator's address is held by a deleted row.
 *
 * `users` is unique on `(organizationId, email)` **including** soft-deleted rows,
 * so a deleted administrator both blocks the address and — if the lookup ignores
 * `deletedAt`, as this one used to — is mistaken for a live account. The tenant
 * is then left with no active administrator while the seed reports success and
 * exits 0, which is the worst of the available outcomes: nobody can sign in and
 * nothing says so.
 *
 * Reviving the row is not the seed's decision to make. Restoring an administrator
 * somebody deleted is a deliberate act, not a side effect of a redeploy hook.
 */
async function assertAdminEmailAvailable(
  prisma: Db,
  organizationId: string,
  email: string,
): Promise<void> {
  const deleted = await prisma.user.findFirst({
    where: { organizationId, email, NOT: { deletedAt: null } },
    select: { id: true, role: true, deletedAt: true },
  });
  if (deleted === null) return;

  throw new SeedError(
    `Cannot seed the administrator: ${email} is held by a soft-deleted user in this\n` +
      `  organization (id ${deleted.id}, role ${deleted.role}, deleted ${deleted.deletedAt?.toISOString() ?? 'unknown'}).\n` +
      '  The unique constraint covers deleted rows, so no new account can take that\n' +
      '  address, and restoring one is a decision rather than something a seed should\n' +
      '  do on its own. Either clear its deletedAt deliberately, or seed a different\n' +
      '  SEED_ADMIN_EMAIL.',
  );
}

export async function seed(env: SeedEnv, prisma: Db): Promise<SeedResult> {
  const slug = env.SEED_ORG_SLUG ?? slugify(env.SEED_ORG_NAME);
  const warnings: string[] = [];

  const organization = await ensure<Organization>(
    () => prisma.organization.findUnique({ where: { slug } }),
    () =>
      prisma.organization.create({
        data: { name: env.SEED_ORG_NAME, slug, timezone: env.SEED_ORG_TIMEZONE },
      }),
  );

  const organizationId = organization.row.id;

  if (organization.outcome === 'existing' && organization.row.timezone !== env.SEED_ORG_TIMEZONE) {
    warnings.push(
      `SEED_ORG_TIMEZONE=${env.SEED_ORG_TIMEZONE} was ignored: "${slug}" already exists with ` +
        `timezone ${organization.row.timezone}, and the seed never overwrites. This is the one ` +
        'setting that changes what an attendance record means — every workDate already stored ' +
        `is a calendar day in ${organization.row.timezone} — so change it from the admin panel, ` +
        'where the consequences are visible.',
    );
  }

  await assertAdminEmailAvailable(prisma, organizationId, env.SEED_ADMIN_EMAIL);

  const admin = await ensure<User>(
    () =>
      prisma.user.findFirst({
        // `deletedAt: null` or the tenant can end up with a "seeded" administrator
        // that cannot sign in: soft-deleted users are refused at login.
        where: { organizationId, email: env.SEED_ADMIN_EMAIL, deletedAt: null },
      }),
    async () =>
      prisma.user.create({
        data: {
          organizationId,
          email: env.SEED_ADMIN_EMAIL,
          // The application's own parameters, imported rather than restated.
          passwordHash: await argon2Hash(env.SEED_ADMIN_PASSWORD, ARGON2_OPTIONS),
          fullName: env.SEED_ADMIN_NAME,
          role: Role.ADMIN,
        },
      }),
  );

  const site = await ensure<Site>(
    () =>
      prisma.site.findFirst({
        where: { organizationId, name: env.SEED_SITE_NAME },
      }),
    () =>
      prisma.site.create({
        data: {
          organizationId,
          name: env.SEED_SITE_NAME,
          latitude: env.SEED_SITE_LATITUDE,
          longitude: env.SEED_SITE_LONGITUDE,
          radiusMeters: env.SEED_SITE_RADIUS_M,
        },
      }),
  );

  const steps: Step[] = [
    {
      label: 'organization',
      outcome: organization.outcome,
      detail: `${organization.row.name} (${organization.row.slug}, ${organization.row.timezone})`,
    },
    {
      label: 'admin user',
      outcome: admin.outcome,
      detail:
        admin.outcome === 'created'
          ? admin.row.email
          : `${admin.row.email} — password left unchanged`,
    },
    {
      label: 'site',
      outcome: site.outcome,
      detail: `${site.row.name} (${site.row.latitude}, ${site.row.longitude}, r=${site.row.radiusMeters}m)`,
    },
  ];

  return { steps, warnings };
}

function report(env: SeedEnv, result: SeedResult): void {
  const { steps, warnings } = result;
  const created = steps.filter((step) => step.outcome === 'created').length;

  console.log('Wasel Attendance — database seed');
  console.log(`  environment  ${env.NODE_ENV}`);
  console.log(`  database     ${redactUrl(env.DATABASE_URL)}`);
  console.log('');
  for (const step of steps) {
    console.log(`  ${step.label.padEnd(13)}${step.outcome.padEnd(10)}${step.detail}`);
  }
  console.log('');

  for (const warning of warnings) {
    console.warn(`  warning      ${warning}`);
  }
  if (warnings.length > 0) console.log('');

  if (created === 0) {
    console.log('Nothing to do — everything was already present.');
    return;
  }

  console.log(`${created} created, ${steps.length - created} already present.`);
  if (steps.some((step) => step.label === 'admin user' && step.outcome === 'created')) {
    console.log(
      `Sign in as ${env.SEED_ADMIN_EMAIL} with SEED_ADMIN_PASSWORD, then change it immediately.`,
    );
  }
}

async function main(): Promise<void> {
  loadEnvFiles();

  const env = readEnv(process.env);
  assertSafeForTarget(env);

  // Prisma 7 has no `url` in schema.prisma; the connection comes from a driver
  // adapter, exactly as `PrismaService` builds it for the application.
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    application_name: 'wasel-seed',
  });
  const prisma = new PrismaClient({ adapter });

  try {
    report(env, await seed(env, prisma));
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Only when this file *is* the command being run.
 *
 * Without the guard, importing anything from here — which the seed's own tests
 * do, so that the environment rules can be exercised without a subprocess —
 * would connect to a database and start writing rows as a side effect.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof SeedError) {
      console.error(`\n${error.message}\n`);
    } else {
      console.error('\nSeed failed:\n', error);
    }
    process.exitCode = 1;
  });
}
