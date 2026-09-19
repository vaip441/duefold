import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.duefold/**',
      '.*/**',
      'apps/web-client/dist/**',
      'deploy/k6/**',
      'test/fixtures/**/*.mjs',
      'modules/rooms-documents/src/processing/tool-adapter.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'playwright.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Template literals are used to emit generated source; numbers and
      // booleans interpolate deliberately there.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Security-relevant: a swallowed rejection can hide an authorization or
      // audit-persistence failure (fail closed).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      // Strict typing is a release requirement, not a preference.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Telemetry redaction: logging goes through the
      // module logger, never straight to stdout.
      'no-console': 'error',

      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'Dynamic code construction is prohibited.',
        },
        {
          selector: "CallExpression[callee.name='eval']",
          message: 'Dynamic code evaluation is prohibited.',
        },
      ],
    },
  },
  {
    // Generated registries are build output, reviewed through the generator.
    files: ['.duefold/generated/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    // CLI entry points legitimately write to stdio.
    files: ['packages/composition/src/cli.ts', 'apps/cli/src/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts', 'test/**/*.tsx', '**/*.unit.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Tests read JSON responses and index into them by key to assert on the
      // wire shape; dot access would assume a type the server did not promise.
      '@typescript-eslint/dot-notation': 'off',
    },
  },
  {
    // Browser specs assert on values Playwright types as non-nullable but which
    // are absent in the failure cases the test exists to catch.
    files: ['test/browser/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
