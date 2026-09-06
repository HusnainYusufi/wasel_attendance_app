import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * SWC rather than the default esbuild transform: esbuild does not implement
 * `emitDecoratorMetadata`, and without `design:paramtypes` every NestJS
 * constructor injection in the suite fails to resolve.
 */
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  // Vite 7 transforms TypeScript with Oxc by default, which — like esbuild before
  // it — drops decorator metadata. It is switched off so SWC owns the transform.
  oxc: false,
  test: {
    // Pool settings are run-wide in Vitest, not per project. Files run one at a
    // time because the integration project shares a single PostgreSQL database:
    // two files truncating concurrently would delete each other's fixtures, and
    // the failure would read as flakiness rather than as a configuration bug.
    // Each file still gets its own worker, so module state does not leak between
    // files.
    pool: 'forks',
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // Colocated with the code under test, per the module convention.
          include: ['src/**/*.spec.ts'],
          setupFiles: ['./test/setup/unit-setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/**/*.int-spec.ts'],
          globalSetup: ['./test/setup/global-setup.ts'],
          setupFiles: ['./test/setup/integration-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/main.ts', 'src/**/*.spec.ts'],
    },
  },
});
