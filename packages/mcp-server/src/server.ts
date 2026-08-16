/**
 * @framepilot/mcp-server/server — wire the editing core to the MCP SDK.
 *
 * Thin glue: it registers two request handlers on a low-level MCP `Server` —
 * `tools/list` (advertises {@link buildMcpTools}) and `tools/call` (routes to
 * {@link callTool}). All decision logic lives in `dispatch.ts`/`session.ts`, which
 * are unit-tested; this module is excluded from coverage because it only binds the
 * SDK types to those functions. `http.ts` connects the returned `Server` to the
 * Streamable HTTP transport (see ADR 0015).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { callTool } from './dispatch.js';
import type { RenderClient } from './render-client.js';
import type { AnalysisClient } from './analysis-client.js';
import type { EditorSession } from './session.js';
import { buildMcpTools } from './tools.js';

export interface ServerDeps {
  readonly session: EditorSession;
  readonly renderClient: RenderClient | null;
  readonly analysisClient: AnalysisClient | null;
}

/**
 * Top-level MCP `instructions` (returned to the client in `initialize`). This is
 * the primary, model-facing steer that keeps an external agent inside FramePilot's
 * validated/reversible edit path instead of editing the project file directly with
 * its own filesystem/Bash/Edit tools — the confirmed bypass this fixes. It reaches
 * the client model itself (unlike the human-facing guide), so it is authoritative.
 */
export const INSTRUCTIONS =
  'You are connected to an ACTIVE FramePilot editing session for the video project ' +
  'the user currently has open. Make EVERY edit through these FramePilot tools: they ' +
  'validate each change, apply it atomically, and keep it reversible/undoable. Do NOT ' +
  'read or write project.fp.json (or any media file) directly with filesystem, Bash, or ' +
  'Edit tools — direct file edits bypass validation and undo, will be silently ' +
  'overwritten by the app or by save_project, and can corrupt the project. Read project ' +
  'state with get_project_state and get_timeline (never from disk), change it only with ' +
  'the mutation tools, persist with save_project, and use undo/redo/get_patch_history to ' +
  'review or reverse edits.';

/** Build a configured (but not yet connected) MCP `Server` for FramePilot. */
export function createServer({ session, renderClient, analysisClient }: ServerDeps): Server {
  const server = new Server(
    { name: 'framepilot', version: '0.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildMcpTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ServerResult> => {
    const { name, arguments: args } = request.params;
    // Our CallToolResult is a structural subset of the SDK's tool result.
    return callTool(
      session,
      renderClient,
      name,
      args ?? {},
      analysisClient,
    ) as Promise<ServerResult>;
  });

  return server;
}
