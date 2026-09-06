import { z } from 'zod';
import { API_PATH_PREFIX } from '../common/http/api-prefix.js';

/**
 * Secrets shipped in `.env.example`. They exist so a developer can boot in one
 * step, which is exactly why they must never survive into production: they are
 * public knowledge and would let anyone mint valid tokens.
 */
export const PLACEHOLDER_SECRETS: readonly string[] = [
  'change-me-dev-only-access-secret-min-32-chars',
  'change-me-dev-only-refresh-secret-min-32-chars',
];

export const MIN_SECRET_LENGTH = 32;

/** Below this a "secret" is a repeated character, not a key. */
const MIN_SECRET_DISTINCT_CHARACTERS = 8;

const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const portSchema = z.coerce.number().int().min(1).max(65_535);

/** `1`/`true`/`yes`/`on` (any case) are true; `0`/`false`/`no`/`off` are false. */
const booleanish = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off']))
  .transform((v) => v === '1' || v === 'true' || v === 'yes' || v === 'on');

const positiveInt = (max: number) => z.coerce.number().int().positive().max(max);

/**
 * Postgres connection string. Checked with the URL parser rather than a regex so
 * that a malformed DSN fails at boot instead of on the first query.
 */
const postgresUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'postgresql:' || url.protocol === 'postgres:';
    } catch {
      return false;
    }
  }, 'Must be a postgresql:// connection string');

/**
 * `15m`, `30d`, `3600s`… — the format `@nestjs/jwt` forwards to `jsonwebtoken`.
 *
 * The unit is **mandatory**. `jsonwebtoken` passes a bare number to `ms()`, which
 * reads it as *milliseconds*: an operator writing `JWT_ACCESS_TTL=900` meaning
 * fifteen minutes gets 0.9 seconds, boots cleanly, and 401s every authenticated
 * request in the fleet. A leading zero is refused for the same reason — `0s` and
 * `0` are both "every token is already expired", spelled as if deliberate.
 */
const jwtTtlSchema = z
  .string()
  .trim()
  .regex(
    /^[1-9]\d*(ms|s|m|h|d|w|y)$/,
    'Must be a duration with an explicit unit such as 15m, 24h or 30d ' +
      '(a bare number is read as milliseconds)',
  );

/**
 * Length alone does not make a secret: `' '.repeat(40)` and `'a'.repeat(40)` both
 * clear a 32-character minimum while carrying almost no entropy. Whitespace is
 * refused outright because it is usually a copy-paste accident that would
 * silently change the signing key.
 */
const secretSchema = z
  .string()
  .min(MIN_SECRET_LENGTH, `Must be at least ${MIN_SECRET_LENGTH} characters`)
  .refine((value) => !/\s/.test(value), 'Must not contain whitespace')
  .refine(
    (value) => new Set(value).size >= MIN_SECRET_DISTINCT_CHARACTERS,
    `Must contain at least ${MIN_SECRET_DISTINCT_CHARACTERS} distinct characters`,
  );

/**
 * `scheme://host[:port]` and nothing else — the exact string a browser puts in
 * the `Origin` header.
 *
 * A trailing slash or a path is the common typo (`https://app.example/`), and it
 * fails *open in the wrong direction*: the entry simply never matches any real
 * origin, so the deployment looks configured while every browser request is
 * rejected. `capacitor://localhost` is a legitimate origin for the mobile shell,
 * so the scheme is not restricted to http/https.
 */
const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+$/i;

/**
 * Comma-separated CORS allowlist. `*` is preserved verbatim here (rather than
 * being rejected outright) so that the production check below can report it as a
 * deliberate, named failure instead of a confusing parse error.
 */
const corsOriginsSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .refine((origins) => origins.length > 0, 'At least one origin is required')
  .refine(
    (origins) => origins.every((origin) => origin === '*' || ORIGIN_PATTERN.test(origin)),
    'Each entry must be an origin such as https://app.example — no path, no trailing slash',
  );

/**
 * Express `trust proxy`. A hop count is the only safe form behind a known
 * ingress: `true` makes `X-Forwarded-For` fully client-controlled, which lets an
 * attacker forge the IP recorded in the audit log and dodge per-IP rate limits.
 *
 * Note that any value above 0 also makes the rate limiter's key space partly
 * client-controlled — see `RATE_LIMIT_WINDOW_MS`.
 */
const trustProxySchema = z.coerce.number().int().min(0).max(10).default(0);

/**
 * Upper bound on the rate-limit window.
 *
 * `@nestjs/throttler`'s in-memory storage never evicts: it holds one entry per
 * (tracker, route) and one `setTimeout` per request for the whole window. A long
 * window therefore multiplies resident memory by the request rate, and with
 * `TRUST_PROXY_HOPS > 0` the tracker is derived from a client-supplied header, so
 * the key space is partly attacker-controlled. Fifteen minutes bounds that; a
 * shared Redis store is the real answer for more than one replica.
 */
const MAX_RATE_LIMIT_WINDOW_MS = 900_000;

export const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    PORT: portSchema.default(3000),
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    CORS_ORIGINS: corsOriginsSchema,

    DATABASE_URL: postgresUrlSchema,
    TEST_DATABASE_URL: postgresUrlSchema.optional(),
    DATABASE_POOL_MAX: positiveInt(1000).default(10),
    DATABASE_POOL_IDLE_TIMEOUT_MS: positiveInt(3_600_000).default(30_000),
    DATABASE_CONNECT_TIMEOUT_MS: positiveInt(120_000).default(10_000),

    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    JWT_ACCESS_TTL: jwtTtlSchema.default('15m'),
    JWT_REFRESH_TTL: jwtTtlSchema.default('30d'),

    LOGIN_MAX_ATTEMPTS: positiveInt(100).default(5),
    LOGIN_LOCKOUT_MINUTES: positiveInt(1440).default(15),
    // Per replica, not per fleet: the counter lives in this process's memory, so
    // N replicas admit N × RATE_LIMIT_MAX requests per window.
    RATE_LIMIT_MAX: positiveInt(1_000_000).default(100),
    RATE_LIMIT_WINDOW_MS: positiveInt(MAX_RATE_LIMIT_WINDOW_MS).default(60_000),

    LOG_LEVEL: logLevelSchema,
    LOG_PRETTY: booleanish.optional(),

    SWAGGER_ENABLED: booleanish.optional(),
    SWAGGER_PATH: z
      .string()
      .trim()
      .regex(/^\/[A-Za-z0-9/_-]*$/, 'Must be an absolute path such as /api/docs')
      .default('/api/docs'),

    TRUST_PROXY_HOPS: trustProxySchema,
    BODY_LIMIT: z
      .string()
      .trim()
      // `[1-9]\d*` rather than `\d+`: `0mb` parses, and body-parser reads a zero
      // limit as "reject every body", which looks like a routing bug.
      .regex(/^[1-9]\d*(b|kb|mb)$/i, 'Must be a byte size such as 256kb')
      .default('256kb'),
  })
  .superRefine((env, ctx) => {
    // A shared signing key means a refresh token verifies as an access token,
    // collapsing the whole rotation/revocation design into nothing.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'Must differ from JWT_ACCESS_SECRET',
      });
    }

    // A docs path that is a prefix of the API path makes *every* API route
    // "documentation" as far as the security-header middleware is concerned, and
    // it silently serves the whole API under the relaxed Swagger CSP —
    // `script-src 'self' 'unsafe-inline'` instead of `default-src 'none'`.
    // Failing the boot is the only outcome an operator will notice.
    const docsPath = env.SWAGGER_PATH.replace(/\/+$/, '');
    if (
      docsPath === '' ||
      API_PATH_PREFIX === docsPath ||
      API_PATH_PREFIX.startsWith(`${docsPath}/`)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAGGER_PATH'],
        message: `Must not be "/" or a prefix of ${API_PATH_PREFIX}; it would relax the content security policy for the whole API`,
      });
    }

    if (env.NODE_ENV !== 'production') return;

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (PLACEHOLDER_SECRETS.includes(env[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Must not be the .env.example placeholder in production',
        });
      }
    }

    if (env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'Wildcard "*" is not allowed in production; list explicit origins',
      });
    }
  });

export type Env = z.output<typeof envSchema>;
