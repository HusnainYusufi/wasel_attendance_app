import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadAppConfig } from '../app-config.js';
import { PLACEHOLDER_SECRETS } from '../env.schema.js';

const ACCESS_SECRET = 'unit-access-secret-4f2b9c1e-not-for-real-signing';
const REFRESH_SECRET = 'unit-refresh-secret-7a1d6e3b-not-for-real-signing';

const VALID_ENV = {
  NODE_ENV: 'development',
  PORT: '3000',
  CORS_ORIGINS: 'http://localhost:5173, capacitor://localhost',
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/db?schema=public',
  JWT_ACCESS_SECRET: ACCESS_SECRET,
  JWT_REFRESH_SECRET: REFRESH_SECRET,
} satisfies NodeJS.ProcessEnv;

function problemsOf(env: NodeJS.ProcessEnv): Array<{ variable: string; message: string }> {
  try {
    loadAppConfig(env);
  } catch (error) {
    if (error instanceof EnvValidationError) return [...error.problems];
    throw error;
  }
  throw new Error('expected loadAppConfig to reject');
}

function variablesRejectedFor(overrides: NodeJS.ProcessEnv): string[] {
  return problemsOf({ ...VALID_ENV, ...overrides }).map((problem) => problem.variable);
}

describe('loadAppConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = loadAppConfig(VALID_ENV);

    expect(config.nodeEnv).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.http.corsOrigins).toEqual(['http://localhost:5173', 'capacitor://localhost']);
    expect(config.jwt.accessTtl).toBe('15m');
    expect(config.rateLimit.max).toBe(100);
    expect(config.rateLimit.windowMs).toBe(60_000);
    expect(config.database.poolMax).toBe(10);
    expect(config.http.trustProxyHops).toBe(0);
    expect(config.http.bodyLimit).toBe('256kb');
    expect(config.warnings).toEqual([]);
  });

  it('enables swagger and pretty logs outside production by default', () => {
    expect(loadAppConfig(VALID_ENV).swagger.enabled).toBe(true);
    expect(loadAppConfig(VALID_ENV).log.pretty).toBe(true);
    expect(loadAppConfig({ ...VALID_ENV, NODE_ENV: 'test' }).log.pretty).toBe(false);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = problemsOf({
      NODE_ENV: 'staging',
      PORT: 'not-a-number',
      CORS_ORIGINS: '',
      DATABASE_URL: 'mysql://localhost/db',
      JWT_ACCESS_SECRET: 'short',
      JWT_REFRESH_SECRET: 'also-short',
    });

    const variables = problems.map((problem) => problem.variable);
    expect(variables).toEqual(
      expect.arrayContaining([
        'NODE_ENV',
        'PORT',
        'CORS_ORIGINS',
        'DATABASE_URL',
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
      ]),
    );
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });

  it('rejects a missing required variable', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = VALID_ENV;
    expect(problemsOf(withoutDatabase).map((p) => p.variable)).toContain('DATABASE_URL');
  });

  it('accepts a non-postgres URL never', () => {
    expect(variablesRejectedFor({ DATABASE_URL: 'not a url' })).toContain('DATABASE_URL');
  });

  describe('secrets', () => {
    it('rejects secrets shorter than 32 characters', () => {
      expect(variablesRejectedFor({ JWT_ACCESS_SECRET: 'x'.repeat(31) })).toContain(
        'JWT_ACCESS_SECRET',
      );
    });

    it('rejects a long secret with almost no entropy', () => {
      // Length is not entropy: both of these clear a 32-character minimum while
      // being trivially guessable, and the second is a copy-paste accident.
      expect(variablesRejectedFor({ JWT_ACCESS_SECRET: 'a'.repeat(40) })).toContain(
        'JWT_ACCESS_SECRET',
      );
      expect(variablesRejectedFor({ JWT_ACCESS_SECRET: ' '.repeat(40) })).toContain(
        'JWT_ACCESS_SECRET',
      );
    });

    it('rejects a secret containing whitespace', () => {
      expect(
        variablesRejectedFor({ JWT_ACCESS_SECRET: `${ACCESS_SECRET.slice(0, 20)} tail-of-secret` }),
      ).toContain('JWT_ACCESS_SECRET');
    });

    it('rejects reusing one secret for both tokens', () => {
      expect(
        variablesRejectedFor({
          JWT_ACCESS_SECRET: ACCESS_SECRET,
          JWT_REFRESH_SECRET: ACCESS_SECRET,
        }),
      ).toContain('JWT_REFRESH_SECRET');
    });
  });

  describe('JWT TTLs', () => {
    it.each(['15m', '900s', '24h', '30d', '1w', '1y', '500ms'])('accepts %s', (ttl) => {
      expect(loadAppConfig({ ...VALID_ENV, JWT_ACCESS_TTL: ttl }).jwt.accessTtl).toBe(ttl);
    });

    it.each(['900', '3600', '86400', '0'])(
      'rejects the unitless %s, which jsonwebtoken reads as milliseconds',
      (ttl) => {
        // `JWT_ACCESS_TTL=900` meaning fifteen minutes yields a 0.9-second token:
        // the fleet boots cleanly and 401s every authenticated request.
        expect(variablesRejectedFor({ JWT_ACCESS_TTL: ttl })).toContain('JWT_ACCESS_TTL');
      },
    );

    it.each(['0s', '0m', '00h'])('rejects the already-expired %s', (ttl) => {
      expect(variablesRejectedFor({ JWT_ACCESS_TTL: ttl })).toContain('JWT_ACCESS_TTL');
    });

    it.each(['15 m', 'fifteen-minutes', '15minutes', '-5m', '1.5h'])('rejects %s', (ttl) => {
      expect(variablesRejectedFor({ JWT_ACCESS_TTL: ttl })).toContain('JWT_ACCESS_TTL');
    });

    it('applies the same rule to the refresh TTL', () => {
      expect(variablesRejectedFor({ JWT_REFRESH_TTL: '2592000' })).toContain('JWT_REFRESH_TTL');
    });
  });

  describe('booleanish flags', () => {
    it.each(['1', 'true', 'TRUE', 'yes', 'on', ' On '])('reads %s as enabled', (value) => {
      expect(loadAppConfig({ ...VALID_ENV, SWAGGER_ENABLED: value }).swagger.enabled).toBe(true);
    });

    it.each(['0', 'false', 'FALSE', 'no', 'off', ' Off '])('reads %s as disabled', (value) => {
      expect(loadAppConfig({ ...VALID_ENV, SWAGGER_ENABLED: value }).swagger.enabled).toBe(false);
    });

    it.each(['', 'maybe', '2', 'y'])('rejects the ambiguous %s', (value) => {
      expect(variablesRejectedFor({ SWAGGER_ENABLED: value })).toContain('SWAGGER_ENABLED');
    });
  });

  describe('BODY_LIMIT', () => {
    it.each(['256kb', '1mb', '512b', '2MB'])('accepts %s', (limit) => {
      expect(loadAppConfig({ ...VALID_ENV, BODY_LIMIT: limit }).http.bodyLimit).toBe(limit);
    });

    it.each(['0mb', '0kb', '0b'])('rejects %s, which rejects every body', (limit) => {
      expect(variablesRejectedFor({ BODY_LIMIT: limit })).toContain('BODY_LIMIT');
    });

    it.each(['256', 'big', '256 kb', '256gb'])('rejects %s', (limit) => {
      expect(variablesRejectedFor({ BODY_LIMIT: limit })).toContain('BODY_LIMIT');
    });
  });

  describe('SWAGGER_PATH', () => {
    it.each(['/api/docs', '/docs', '/internal/openapi'])('accepts %s', (path) => {
      expect(loadAppConfig({ ...VALID_ENV, SWAGGER_PATH: path }).swagger.path).toBe(path);
    });

    it.each(['/', '/api', '/api/', '/api/v1'])(
      'rejects %s, which would relax the CSP for the whole API',
      (path) => {
        // With `/api` every `/api/v1/...` route matches the docs branch of the
        // security-header middleware and is served under
        // `script-src 'self' 'unsafe-inline'` instead of `default-src 'none'`.
        expect(variablesRejectedFor({ SWAGGER_PATH: path })).toContain('SWAGGER_PATH');
      },
    );

    it.each(['api/docs', 'https://elsewhere.test/docs', '/api/docs?x=1'])(
      'rejects the non-absolute path %s',
      (path) => {
        expect(variablesRejectedFor({ SWAGGER_PATH: path })).toContain('SWAGGER_PATH');
      },
    );
  });

  describe('CORS_ORIGINS', () => {
    it('accepts an origin with a non-web scheme, as the mobile shell sends', () => {
      expect(
        loadAppConfig({ ...VALID_ENV, CORS_ORIGINS: 'capacitor://localhost' }).http.corsOrigins,
      ).toEqual(['capacitor://localhost']);
    });

    it.each([
      ['garbage origin value', 'not an origin at all'],
      ['https://app.example/', 'a trailing slash never matches a real Origin header'],
      ['https://app.example/path', 'a path never matches a real Origin header'],
      ['app.example', 'no scheme'],
    ])('rejects %s (%s)', (origin) => {
      expect(variablesRejectedFor({ CORS_ORIGINS: origin })).toContain('CORS_ORIGINS');
    });

    it('rejects one bad entry hidden among good ones', () => {
      expect(
        variablesRejectedFor({ CORS_ORIGINS: 'https://app.wasel.test,https://app.example/' }),
      ).toContain('CORS_ORIGINS');
    });
  });

  describe('rate limiting', () => {
    it('caps the window, because the in-memory store never evicts an entry', () => {
      expect(
        loadAppConfig({ ...VALID_ENV, RATE_LIMIT_WINDOW_MS: '900000' }).rateLimit.windowMs,
      ).toBe(900_000);
      expect(variablesRejectedFor({ RATE_LIMIT_WINDOW_MS: '900001' })).toContain(
        'RATE_LIMIT_WINDOW_MS',
      );
    });
  });

  describe('production hardening', () => {
    const productionEnv = { ...VALID_ENV, NODE_ENV: 'production' };

    it('rejects the .env.example placeholder secrets', () => {
      const [accessPlaceholder, refreshPlaceholder] = PLACEHOLDER_SECRETS;
      const problems = problemsOf({
        ...productionEnv,
        JWT_ACCESS_SECRET: accessPlaceholder,
        JWT_REFRESH_SECRET: refreshPlaceholder,
      });

      expect(problems.map((p) => p.variable)).toEqual(
        expect.arrayContaining(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']),
      );
    });

    it('accepts the same placeholders outside production', () => {
      const [accessPlaceholder, refreshPlaceholder] = PLACEHOLDER_SECRETS;
      expect(() =>
        loadAppConfig({
          ...VALID_ENV,
          JWT_ACCESS_SECRET: accessPlaceholder,
          JWT_REFRESH_SECRET: refreshPlaceholder,
        }),
      ).not.toThrow();
    });

    it('rejects a wildcard CORS origin', () => {
      const problems = problemsOf({ ...productionEnv, CORS_ORIGINS: '*' });
      expect(problems.map((p) => p.variable)).toContain('CORS_ORIGINS');
    });

    it('rejects a wildcard hidden among real origins', () => {
      const problems = problemsOf({
        ...productionEnv,
        CORS_ORIGINS: 'https://app.wasel.test,*',
      });
      expect(problems.map((p) => p.variable)).toContain('CORS_ORIGINS');
    });

    it('accepts a hardened production environment', () => {
      const config = loadAppConfig({
        ...productionEnv,
        CORS_ORIGINS: 'https://app.wasel.test',
      });

      expect(config.isProduction).toBe(true);
      expect(config.swagger.enabled).toBe(false);
      expect(config.log.pretty).toBe(false);
      expect(config.warnings).toEqual([]);
    });

    it('warns — but still boots — when the documentation is published in production', () => {
      // Not fatal: a locked-down staging box that reports itself as production is
      // a legitimate reason to want the docs. It must still be impossible to do
      // by accident and never notice.
      const config = loadAppConfig({
        ...productionEnv,
        CORS_ORIGINS: 'https://app.wasel.test',
        SWAGGER_ENABLED: 'true',
      });

      expect(config.swagger.enabled).toBe(true);
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain('SWAGGER_ENABLED');
    });

    it('does not warn when the documentation is left off', () => {
      const config = loadAppConfig({
        ...productionEnv,
        CORS_ORIGINS: 'https://app.wasel.test',
        SWAGGER_ENABLED: 'false',
      });
      expect(config.warnings).toEqual([]);
    });
  });

  it('lists every problem in the thrown message', () => {
    try {
      loadAppConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('.env.example');
      return;
    }
    throw new Error('expected loadAppConfig to reject an empty environment');
  });
});
