/**
 * Canonical autonomous MCP projection.
 *
 * The legacy MCP surface remains available for compatibility. This opt-in list
 * exposes the smaller autonomous contract only where MCP has a complete host
 * implementation. UI-only questions, runtime-only recovery, and grouped proposal
 * tools are not advertised until MCP can execute them with identical semantics.
 */
import {
  AUTONOMOUS_TOOL_MANIFEST,
  routeAutonomousToolCall,
  type AutonomousToolCall,
} from '@framepilot/ai-sdk';
import { callTool, type CallToolResult } from './dispatch.js';
import type { EditorSession } from './session.js';
import type { RenderClient } from './render-client.js';
import type { AnalysisClient } from './analysis-client.js';
import type { McpToolDescriptor } from './tools.js';

const MCP_UNSUPPORTED = new Set([
  'ask_user',
  'propose_timeline_patch',
  'propose_project_patch',
  'verify_result',
]);

/** Names MCP can execute fully through the canonical router. */
export const AUTONOMOUS_MCP_TOOL_NAMES: readonly string[] = AUTONOMOUS_TOOL_MANIFEST.tools
  .filter(
    (tool) =>
      tool.status === 'ready' &&
      !MCP_UNSUPPORTED.has(tool.name) &&
      (tool.kind === 'registry' || tool.kind === 'composite'),
  )
  .map((tool) => tool.name)
  // The `0` arm is unreachable: manifest names are unique, which
  // `autonomous-tool-manifest`'s own parity test asserts. Kept rather than dropped so the
  // comparator stays a total order if that ever stops being true.
  /* v8 ignore next */
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const supported = new Set(AUTONOMOUS_MCP_TOOL_NAMES);

/** Build the compact autonomous MCP list from the canonical manifest. */
export function buildAutonomousMcpTools(): McpToolDescriptor[] {
  return AUTONOMOUS_TOOL_MANIFEST.tools
    .filter((tool) => supported.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Execute one advertised canonical MCP tool via the existing trusted dispatch. */
export async function callAutonomousTool(
  session: EditorSession,
  renderClient: RenderClient | null,
  call: AutonomousToolCall,
  analysisClient: AnalysisClient | null = null,
): Promise<CallToolResult> {
  if (!supported.has(call.name)) {
    return fail(
      `[autonomous_tool_unavailable] '${call.name}' is not available on the MCP surface.`,
    );
  }

  let route: ReturnType<typeof routeAutonomousToolCall>;
  try {
    route = routeAutonomousToolCall(call);
  } catch (error) {
    return fail(
      `[autonomous_route_failed] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (route.kind !== 'registry') {
    return fail(
      `[autonomous_tool_unavailable] '${call.name}' requires a host capability MCP does not expose.`,
    );
  }

  const results: CallToolResult[] = [];
  for (const inner of route.calls) {
    const result = await callTool(
      session,
      renderClient,
      inner.name,
      inner.arguments,
      analysisClient,
    );
    results.push(result);
    if (result.isError === true) return result;
  }
  if (results.length === 1) return results[0]!;

  const structured = results.map((result) => result.structuredContent ?? null);
  return {
    content: [
      {
        type: 'text',
        text: results.map((result) => result.content.map((item) => item.text).join('\n')).join('\n'),
      },
    ],
    structuredContent: { results: structured },
  };
}
