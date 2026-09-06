import { loadEnvFiles } from '../../src/config/load-env-files.js';

/**
 * Values a test run can safely invent. Every one is applied only when the real
 * environment does not already provide it, so a CI job that exports the whole set
 * keeps control, and a machine with no `.env` at all still boots the app.
 *
 * `TEST_DATABASE_URL` is absent on purpose: guessing a database to connect to is
 * how a test suite ends up truncating somebody's development data.
 */
const TEST_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  // Never actually bound: supertest drives an ephemeral server. Present only
  // because the schema requires a valid port.
  PORT: '3000',
  CORS_ORIGINS: 'http://localhost:5173,capacitor://localhost',
  JWT_ACCESS_SECRET: 'test-access-secret-not-used-for-real-signing',
  JWT_REFRESH_SECRET: 'test-refresh-secret-not-used-for-real-signing',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  SWAGGER_ENABLED: 'false',
  RATE_LIMIT_MAX: '10000',
  RATE_LIMIT_WINDOW_MS: '60000',
};

export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the test database with `pnpm db:up` ' +
        '(docker compose exposes it on port 5434) and export the variable, or ' +
        'create a .env from .env.example.',
    );
  }
  return url;
}

/**
 * Prepares `process.env` for a test process.
 *
 * `DATABASE_URL` is overwritten — not defaulted — so that a developer with a
 * populated `.env` cannot accidentally point the truncating integration suite at
 * their development database.
 */
export function applyTestEnv(): void {
  loadEnvFiles();

  process.env['NODE_ENV'] = 'test';
  for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
    process.env[key] ??= value;
  }
  process.env['DATABASE_URL'] = testDatabaseUrl();
}
