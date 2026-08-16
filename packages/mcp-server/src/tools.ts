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
  ...TOOL_REGISTRY.filter((t) => t.available && !t.hostUiOnly).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as Record<string, unknown>,
  })),
];
