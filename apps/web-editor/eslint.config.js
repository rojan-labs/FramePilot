// Flat ESLint config (ESM) for this app.
// Canonical FramePilot lint baseline: @eslint/js recommended + typescript-eslint recommended.
// See plan/PLAN.md Phase 0 (lint/format/typecheck config).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
