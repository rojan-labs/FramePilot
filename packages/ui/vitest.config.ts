/**
 * Vitest config for @framepilot/ui — jsdom environment for component tests.
 * See plan/PLAN.md Phase 3.2 / 4.3.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild handles the JSX transform for tests (automatic runtime, no Babel needed).
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
