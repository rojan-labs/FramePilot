/**
 * Vitest config for @framepilot/mcp-server.
 *
 * The editing surface (sandbox, session, tool exposure, dispatch, render client)
 * is core deterministic logic and is expected to be tested across its real branches
 * — it is the gate that keeps an external agent inside the validate→apply→save
 * invariants. Coverage is reported but not gated on a percentage. The
 * barrel index and the transport glue (`server.ts` wires the MCP SDK to the
 * Streamable HTTP transport, `http.ts` is the loopback HTTP listener, `bin.ts` is
 * the executable) carry no business logic and are excluded.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__fixtures__/**',
        'src/index.ts',
        'src/server.ts',
        'src/http.ts',
        'src/bin.ts',
      ],
    },
  },
});
