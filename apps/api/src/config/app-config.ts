import { envSchema, type Env } from './env.schema.js';

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly idleTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

export interface JwtConfig {
  readonly accessSecret: string;
  readonly refreshSecret: string;
  readonly accessTtl: string;
  readonly refreshTtl: string;
}

export interface SecurityConfig {
  readonly loginMaxAttempts: number;
  readonly loginLockoutMinutes: number;
}

export interface RateLimitConfig {
  readonly max: number;
  readonly windowMs: number;
}

export interface LogConfig {
  readonly level: string;
  readonly pretty: boolean;
}

export interface SwaggerConfig {
  readonly enabled: boolean;
  readonly path: string;
}

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly bodyLimit: string;
}

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  /**
   * Configurations that are legal but almost certainly a mistake.
   *
   * Not errors: each has a defensible use (a locked-down staging box that sets
   * `NODE_ENV=production`, say), so refusing to boot would be wrong. They are
   * surfaced by `configureApp` at `warn` on the first line of the log instead.
   */
  readonly warnings: readonly string[];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly http: HttpConfig;
  readonly database: DatabaseConfig;
  readonly testDatabaseUrl: string | undefined;
  readonly jwt: JwtConfig;
  readonly security: SecurityConfig;
  readonly rateLimit: RateLimitConfig;
  readonly log: LogConfig;
  readonly swagger: SwaggerConfig;
}

/** Thrown instead of a ZodError so the boot failure reads as one actionable list. */
export class EnvValidationError extends Error {
  constructor(readonly problems: ReadonlyArray<{ variable: string; message: string }>) {
    super(
      [
        `Invalid environment: ${problems.length} problem${problems.length === 1 ? '' : 's'} found.`,
        ...problems.map(({ variable, message }) => `  • ${variable}: ${message}`),
        'See .env.example for the expected values.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

function collectWarnings(env: Env): string[] {
  const warnings: string[] = [];

  if (env.NODE_ENV === 'production' && env.SWAGGER_ENABLED === true) {
    warnings.push(
      'SWAGGER_ENABLED is true in production: the published document is a complete ' +
        'map of the attack surface, including which routes are unauthenticated.',
    );
  }

  return warnings;
}

function toAppConfig(env: Env): AppConfig {
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    warnings: Object.freeze(collectWarnings(env)),
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    http: Object.freeze({
      host: env.HOST,
      port: env.PORT,
      corsOrigins: Object.freeze([...env.CORS_ORIGINS]),
      trustProxyHops: env.TRUST_PROXY_HOPS,
      bodyLimit: env.BODY_LIMIT,
    }),
    database: Object.freeze({
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      idleTimeoutMs: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
    }),
    testDatabaseUrl: env.TEST_DATABASE_URL,
    jwt: Object.freeze({
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
    }),
    security: Object.freeze({
      loginMaxAttempts: env.LOGIN_MAX_ATTEMPTS,
      loginLockoutMinutes: env.LOGIN_LOCKOUT_MINUTES,
    }),
    rateLimit: Object.freeze({
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
    }),
    log: Object.freeze({
      level: env.LOG_LEVEL,
      // Pretty printing spawns a pino transport worker; default it on only where
      // a human reads the output, so tests and production stay on plain JSON.
      pretty: env.LOG_PRETTY ?? env.NODE_ENV === 'development',
    }),
    swagger: Object.freeze({
      enabled: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
      path: env.SWAGGER_PATH,
    }),
  });
}

/**
 * Validates a raw environment and projects it onto {@link AppConfig}.
 *
 * Pure: it never reads `process.env` itself, which is what makes the whole
 * matrix of production-hardening rules unit-testable without mutating globals.
 */
export function loadAppConfig(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Every issue is reported at once: fixing one variable per restart is a
    // miserable way to bring up a new environment.
    const problems = result.error.issues.map((issue) => ({
      variable: issue.path.map((segment) => String(segment)).join('.') || '(environment)',
      message: issue.message,
    }));
    throw new EnvValidationError(problems);
  }

  return toAppConfig(result.data);
}
