#!/usr/bin/env node
/**
 * @framepilot/mcp-server/bin — the `framepilot-mcp` executable.
 *
 * Starts the FramePilot MCP server over **Streamable HTTP** (the transport Claude
 * Desktop and Claude Code attach to with `{ "type": "http", "url": ... }`). It reads:
 *   - FRAMEPILOT_PROJECTS_ROOT (optional): the sandbox root for project files.
 *     Defaults to `~/Documents/FramePilot Projects` — the same folder the desktop
 *     app uses — so it edits real projects out of the box.
 *   - FRAMEPILOT_PYTHON_API_URL (optional): the render sidecar; without it, the
 *     render_preview/export_video tools report that rendering is unavailable.
 *   - FRAMEPILOT_MCP_HOST/PORT/PATH (optional): listener overrides; defaults to the
 *     loopback address `http://127.0.0.1:19789/mcp`.
 *   - FRAMEPILOT_MCP_TOKEN (optional): shared bearer secret; when set, every request
 *     must carry `Authorization: Bearer <token>` (off by default).
 *   - FRAMEPILOT_MCP_MAX_BODY_BYTES / FRAMEPILOT_MCP_MAX_SESSIONS (optional): request
 *     hygiene caps (default 4 MB body, 64 concurrent sessions).
 *
 * See docs/guides/mcp-server.md for client configuration.
 */
import { renderClientFromEnv } from './render-client.js';
import { analysisClientFromEnv } from './analysis-client.js';
import { sessionFromEnv } from './session.js';
import { resolveHttpConfig, startHttpServer } from './http.js';

async function main(): Promise<void> {
  const session = sessionFromEnv();
  const renderClient = renderClientFromEnv();
  const analysisClient = analysisClientFromEnv();
  const config = resolveHttpConfig();
  await startHttpServer({ session, renderClient, analysisClient }, config);
  // Diagnostics go to stderr; stdout is left clean for tooling.
  process.stderr.write(
    `[framepilot-mcp] ready on http://${config.host}:${config.port}${config.path}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[framepilot-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
