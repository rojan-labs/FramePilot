import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Stress fixtures (~75MB parse-budget project) need headroom beyond the
    // vitest default when coverage instrumentation and the full turbo graph
    // run on a 2-vCPU CI runner.
    testTimeout: 60_000,
    // MK4.6 budget tests are CPU-bound wall-clock measurements. Coverage
    // instrumentation multiplies their cost and starves the other packages'
    // workers on a 2-vCPU runner (which is how an unrelated editor-core test
    // hit its 5 s timeout). CI runs them alone, uninstrumented, with
    // FRAMEPILOT_RUN_PERF=1; every other run skips them.
    exclude: [
      ...(process.env.FRAMEPILOT_RUN_PERF === '1'
        ? []
        : ['**/*.perf.test.{ts,tsx}']),
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
