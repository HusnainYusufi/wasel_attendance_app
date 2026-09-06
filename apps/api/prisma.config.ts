import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the datasource URL out of `schema.prisma` into this file, and
 * stopped auto-loading `.env`. We therefore load it explicitly.
 *
 * Both locations are attempted because the Prisma CLI may run with its working
 * directory at either the monorepo root (`pnpm db:migrate`) or at `apps/api`
 * (`pnpm --filter @wasel/api db:migrate`). `dotenv` ignores files that do not
 * exist, and never overwrites a variable that is already set — so a real
 * environment (CI, production) always wins over a checked-out file.
 */
for (const candidate of ['.env', path.join('..', '..', '.env')]) {
  loadEnv({ path: path.resolve(process.cwd(), candidate), quiet: true });
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
