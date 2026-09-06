import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'prisma/migrations'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CONVENTIONS.md §6: no `any`. Use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A floating promise in a request handler is a silently swallowed failure —
      // the response is already sent by the time it rejects.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  {
    // Nest's decorator metadata and Prisma's generated types make some unsafe-*
    // rules fire on correct code; the type checker already covers these paths.
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // Tests legitimately construct malformed values to prove they are rejected.
    files: ['**/__tests__/**/*.ts', 'test/**/*.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/require-await': 'off',
      // Passing a mock method as a value (`expect(svc.method)`) is the normal
      // shape of an assertion, not an accidental `this` unbinding.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['*.config.ts', '*.config.js', 'prisma.config.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
);
