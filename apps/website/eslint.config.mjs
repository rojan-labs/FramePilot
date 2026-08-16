import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Flat ESLint config mirroring the repo's other packages (js + typescript-eslint),
 *  scoped to the app source. Next-specific rules are covered by `next build`. */
export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'out/**',
      'node_modules/**',
      'public/**',
      'next-env.d.ts',
      'src/lib/pricing.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
