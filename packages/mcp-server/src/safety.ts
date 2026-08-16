/**
 * @framepilot/mcp-server/safety — path sandbox for the MCP host.
 *
 * The implementation now lives in `@framepilot/shared-types/safety` so the MCP
 * host and the Electron main process enforce ONE containment rule (Phase 8
 * security audit finding 1.4 — the two TS sandboxes used to be hand-maintained
 * copies that could diverge). Re-exported here so existing importers
 * (`session.ts`, `index.ts`) are unchanged. See ADR 0025.
 */
export { PathTraversalError, resolveWithin } from '@framepilot/shared-types/safety';
