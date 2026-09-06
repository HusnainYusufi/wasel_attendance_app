import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

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

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  /**
   * Attached only when a URL is actually present.
   *
   * Prisma's `env()` helper throws the moment this module is evaluated, and this
   * file is evaluated by *every* Prisma CLI command — including `prisma generate`,
   * which runs on `postinstall` and needs no database whatsoever. Resolving it
   * eagerly therefore made `pnpm install` fail outright on any checkout without a
   * `.env`: a fresh clone, and CI, where the APK job never touches a database.
   *
   * Omitting the key instead defers the complaint to the commands that genuinely
   * need a connection (`migrate`, `db push`, `studio`), which report a missing
   * datasource clearly and at a moment when it is actionable.
   */
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
