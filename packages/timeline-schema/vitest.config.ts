import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Stress fixtures (~160MB parse-budget project) need headroom beyond the
    // vitest default when the full turbo graph runs in parallel.
    testTimeout: 30_000,
  },
});
