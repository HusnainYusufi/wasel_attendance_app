import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTestEnv, testDatabaseUrl } from './test-env.js';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Brings the test database up to the current migration set once per run.
 *
 * `migrate deploy` rather than `db push`: the integration suite must exercise the
 * same DDL that production will receive, including a migration that is broken or
 * out of order. Prisma 7 takes the connection string from `prisma.config.ts`,
 * which reads `DATABASE_URL` — so it is passed explicitly here rather than
 * relying on whatever the developer's `.env` happens to hold.
 */
export function setup(): void {
  applyTestEnv();

  const databaseUrl = testDatabaseUrl();
  const prismaBin = path.join(apiRoot, 'node_modules', '.bin', 'prisma');

  execFileSync(prismaBin, ['migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
