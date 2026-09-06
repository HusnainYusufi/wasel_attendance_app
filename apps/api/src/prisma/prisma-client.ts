import prismaPkg from '@prisma/client';

/**
 * Single ESM interop point for the generated Prisma client.
 *
 * `@prisma/client` re-exports the generated client with
 * `module.exports = { ...require('.prisma/client/default') }`, a spread that
 * Node's CommonJS named-export detector cannot see through. A plain
 * `import { PrismaClient } from '@prisma/client'` therefore throws
 * "Named export 'PrismaClient' not found" at runtime in this ESM package. The
 * default import always works, so the destructure happens here once instead of
 * being rediscovered — the hard way — in every module.
 *
 * Types are unaffected and may still be imported directly:
 * `import type { User, Prisma } from '@prisma/client'`.
 */
export const { PrismaClient, Prisma } = prismaPkg;
