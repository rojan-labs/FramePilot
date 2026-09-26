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
    // The caption property sweeps (`captions/derive.property.test.ts`, hundreds of derivations
    // per test) take about 0.4 s each on a laptop but 5 s and more once v8 coverage and turbo's
    // package parallelism share a CI runner, so the 5 s default failed them on load alone. The
    // timeout catches a hang; it is not a speed budget.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
