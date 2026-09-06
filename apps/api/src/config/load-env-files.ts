import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate `.env` locations, nearest first. Both are tried because the process
 * may be started from `apps/api` or from the monorepo root, and `dist/` sits one
 * directory deeper than `src/`.
 */
function candidatePaths(): string[] {
  const apiRoot = path.resolve(here, '..', '..');
  return [
    path.join(apiRoot, '.env'),
    path.resolve(apiRoot, '..', '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
}

let loaded = false;

/**
 * Loads `.env` files into `process.env` without ever overwriting a variable that
 * is already set. A real environment (CI, container, systemd unit) therefore
 * always beats a checked-out file, and the absence of every file is not an error
 * — which is what lets the test suite run on a bare CI machine.
 */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;

  for (const candidate of candidatePaths()) {
    loadDotenv({ path: candidate, override: false, quiet: true });
  }
}
