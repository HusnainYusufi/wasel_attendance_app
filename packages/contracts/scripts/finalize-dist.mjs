import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stamp a `type` marker into each build output directory.
 *
 * The package itself is `"type": "module"`, so without this file every `.js`
 * under `dist/cjs` would be interpreted as ESM by Node and fail on its first
 * `require`. These two markers are what make the dual build actually resolvable:
 * NestJS (CommonJS) takes `dist/cjs`, Vite (ESM) takes `dist/esm`.
 */
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

for (const [dir, type] of [
  ['cjs', 'commonjs'],
  ['esm', 'module'],
]) {
  writeFileSync(join(dist, dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

console.log(
  'finalize-dist: wrote dist/cjs/package.json (commonjs) and dist/esm/package.json (module)',
);
