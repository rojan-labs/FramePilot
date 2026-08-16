// Flat ESLint config (ESM) for this app.
// Canonical FramePilot lint baseline: @eslint/js recommended + typescript-eslint recommended.
// See plan/PLAN.md Phase 0 (lint/format/typecheck config).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // renderer/, engine-dist/, engine-build/ are packaging staging output
  // (scripts/copy-renderer.mjs, scripts/package-engine.mjs) — generated, not source.
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'renderer/**', 'engine-dist/**', 'engine-build/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.cts` files are CommonJS by design (Electron sandboxed preload cannot use
    // ESM) — `import x = require(...)` is the correct TS CJS syntax here.
    files: ['**/*.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Node build scripts (packaging staging): plain CLIs whose stdout/stderr IS
    // the interface — `console` is the Node global, not an app-logger bypass.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly' } },
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
