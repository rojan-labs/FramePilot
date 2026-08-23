/**
 * Vitest config for @framepilot/ai-sdk.
 *
 * The tool registry + input validation are core deterministic modules
 * (PRD §16.1 / AGENTS.md §5) and are expected to be tested across their real
 * branches; the rest of the SDK (context builder, memory store, orchestrator,
 * providers) is fully deterministic too (providers take an injected `fetch`), so it
 * is testable the same way. Coverage is reported but not gated on a percentage.
 * Fixtures and the barrel index carry no logic and are excluded.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The langchain provider import and the frozen streamAgent golden runs take
    // multiple seconds each once v8 coverage instrumentation and turbo's
    // package parallelism stack up; the vitest 5s default made them
    // load-dependent flakes.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/kernel/index.ts',
        'src/kernel/proposers/index.ts',
        'src/__fixtures__/**',
        // Type-only modules (interfaces/types compile to nothing).
        'src/tool-context.ts',
        'src/providers/types.ts',
        'src/agent.ts',
        'src/kernel/commands.ts',
        // Env-resolution glue for the provider factory (not a deterministic
        // logic module); its defensive browser/env branches are infrastructure.
        'src/providers/index.ts',
      ],
    },
  },
});
