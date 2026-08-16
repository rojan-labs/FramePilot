/**
 * Vitest config for @framepilot/editor-core.
 *
 * These are core deterministic modules (PRD §16.1 / AGENTS.md §5): the timeline
 * operations, patch engine, history, and validator carry the correctness burden and
 * are expected to be tested across their real branches. Coverage is reported but not
 * gated on a percentage — a number does not tell you whether the behavior is tested.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
