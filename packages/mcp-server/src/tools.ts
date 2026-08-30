/**
 * @framepilot/mcp-server/tools — the MCP tool surface, derived from the registry.
 *
 * AUTO-SYNC (a hard requirement): the editing/read/action tools are NOT hand-listed
 * here. {@link buildMcpTools} maps every *available* tool in the canonical
 * `TOOL_REGISTRY` (`@framepilot/ai-sdk`) to an MCP tool descriptor, reusing the
 * JSON Schema that registry already derived from each tool's Zod schema. So adding
 * a tool to the registry automatically exposes it over MCP — the parity test in
 * `tools.test.ts` guards this. On top of the registry tools we add a few
 * *session* tools (open/save/undo/redo/history) that have no registry equivalent
 * because they manage host state rather than the timeline.
 */
import { z } from 'zod/v4';
import { TOOL_REGISTRY } from '@framepilot/ai-sdk';

/** An MCP tool descriptor (shape consumed by the SDK's `tools/list`). */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** A host-level session tool plus the Zod schema used to validate its args. */
export interface SessionToolDef {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
}

const noArgs = z.object({}).strict();
const jsonSchema = (schema: z.ZodTypeAny): Record<string, unknown> =>
  z.toJSONSchema(schema) as Record<string, unknown>;

/** Session-management tools (no timeline mutation; manage the open project). */
export const SESSION_TOOLS: readonly SessionToolDef[] = [
  {
    name: 'open_project',
    description:
      'Open a project.fp.json (path relative to the projects root) and make it the active editing session, then edit it ONLY through these FramePilot tools — never by reading or writing the file directly. Omit `path` to open the project currently open in the FramePilot app.',
    schema: z.object({ path: z.string().optional() }).strict(),
  },
  {
    name: 'save_project',
    description:
      'Persist the active project atomically. This is the ONLY correct way to save edits made through the tools; never write project.fp.json yourself (that bypasses validation/undo and gets overwritten). Optionally provide a target path (inside the projects root); defaults to the open path.',
    schema: z.object({ path: z.string().optional() }).strict(),
  },
  {
    name: 'undo',
    description:
      'Reverse the most recently applied edit in the active project. Every tool edit is reversible via undo/redo — use these instead of manually reverting the file.',
    schema: noArgs,
  },
  {
    name: 'redo',
    description: 'Reapply the most recently undone edit in the active project.',
    schema: noArgs,
  },
  {
    name: 'get_patch_history',
    description: 'List the applied patch history (oldest first) for the active project.',
    schema: noArgs,
  },
];

/** Look up a session tool definition by name. */
export const getSessionTool = (name: string): SessionToolDef | undefined =>
  SESSION_TOOLS.find((t) => t.name === name);

/**
 * Build the full MCP tool list: session tools first, then every available
 * registry tool mapped to its descriptor. This is the single place tools are
 * advertised, so the registry and the MCP surface can never drift.
 */
/**
 * Tools flagged `hostUiOnly` that this surface can still serve.
 *
 * `hostUiOnly` carries two meanings at once: "needs live editor interaction
 * state" (the reason MCP refuses these) and "not mirrored into the Python
 * sidecar registry" (the reason the engine parity tests skip them). For almost
 * every tool those coincide. `caption_the_edit` is the case where they do not:
 * it is pure computation over the project — no selection, no playhead, no source
 * monitor — and is excluded from the mirror only because caption segmentation
 * must have exactly one authority (ADR 0071).
 *
 * Refusing it here would push MCP clients back onto `add_caption_layer` one cue
 * at a time, which is the whole failure this tool exists to remove. So the
 * narrow exception lives here, where the two meanings actually diverge, rather
 * than a second flag threaded through every guard.
 */
export const UI_INDEPENDENT_HOST_TOOLS: ReadonlySet<string> = new Set(['caption_the_edit']);

/** Can this surface serve `tool`? See {@link UI_INDEPENDENT_HOST_TOOLS}. */
export const servableOverMcp = (tool: {
  name: string;
  available: boolean;
  hostUiOnly?: boolean;
}): boolean => tool.available && (!tool.hostUiOnly || UI_INDEPENDENT_HOST_TOOLS.has(tool.name));

export const buildMcpTools = (): McpToolDescriptor[] => [
  ...SESSION_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonSchema(t.schema),
  })),
  // `hostUiOnly` tools need a human looking at FramePilot's own UI, which this surface
  // does not have — `ask_user` here would promise a question nobody could ever answer
  // (ADR 0055). An MCP client is an agent with its own user: if it wants to ask
  // something, it asks them directly and has no use for ours.
  ...TOOL_REGISTRY.filter(servableOverMcp).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as Record<string, unknown>,
  })),
];
