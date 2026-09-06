import type { PrismaService } from '../../src/prisma/prisma.service.js';

interface TableRow {
  tablename: string;
}

let cachedTables: readonly string[] | null = null;

/**
 * Every table in the `public` schema except Prisma's migration ledger.
 *
 * Discovered from the catalogue rather than listed by hand: a hard-coded list
 * silently stops truncating the day somebody adds a model, and the resulting
 * cross-test contamination looks like a flaky test rather than a stale list.
 *
 * An empty result is treated as a failure rather than memoised. It means the
 * migrations have not been applied to this database — and the old code cached
 * that empty array for the worker's life, so every later `truncateAll` was a
 * silent no-op and every test after it ran against another test's fixtures.
 */
async function discoverTables(prisma: PrismaService): Promise<readonly string[]> {
  if (cachedTables) return cachedTables;

  const rows = await prisma.$queryRaw<TableRow[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  const tables = rows.map((row) => row.tablename);
  if (tables.length === 0) {
    throw new Error(
      'truncateAll found no tables in the "public" schema. The test database has ' +
        'not been migrated — check TEST_DATABASE_URL and that `prisma migrate ' +
        'deploy` ran in the global setup.',
    );
  }

  // Only a non-empty discovery is memoised; a failure must be re-attempted.
  cachedTables = tables;
  return cachedTables;
}

/**
 * Empties every table in one statement.
 *
 * `TRUNCATE` over `DELETE` because it does not scan, and `CASCADE` because the
 * schema is a graph of foreign keys — truncating in dependency order by hand is
 * another list that rots. `RESTART IDENTITY` resets sequences so an id-ordering
 * assertion in one test is not perturbed by how many rows a previous test made.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  const tables = await discoverTables(prisma);

  const quoted = tables.map((table) => `"public"."${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
