import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Stress fixtures (~75MB parse-budget project) need headroom beyond the
    // vitest default when coverage instrumentation and the full turbo graph
    // run on a 2-vCPU CI runner.
    testTimeout: 60_000,
  },
});
