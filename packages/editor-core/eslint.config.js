// Flat ESLint config (ESM) for this package.
// Canonical FramePilot lint baseline: @eslint/js recommended + typescript-eslint recommended.
// Kept identical across packages to avoid cross-package dependency cycles.
// See plan/PLAN.md Phase 0 (lint/format/typecheck config).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node build scripts (plain ESM, not TS) run under node, so declare its globals —
    // `no-undef` otherwise flags `console`/`process` (TS files get these from the
    // type-checker instead). Mirrors packages/ai-sdk.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    rules: {
      // A leading underscore marks an intentionally unused binding (placeholder
      // params on stubs, event-handler args, destructured rest). Standard
      // convention; everything else still errors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
