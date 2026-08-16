/**
 * @framepilot/mcp-server/dispatch — route one MCP `tools/call` to the session.
 *
 * This is the pure, testable core behind the MCP server. It validates session
 * tool args, runs the requested tool through {@link EditorSession} (which enforces
 * the validate→apply invariants), delegates render/export action tools to the
 * sidecar via {@link RenderClient}, and maps every outcome (and every typed error)
 * to an MCP `CallToolResult`. `server.ts` is the only thing that wires this to a
 * transport, so all decision logic lives here.
 */
import { ZodError } from 'zod/v4';
import { EditorSession, SessionError, type SessionState } from './session.js';
import { RenderClient, RenderError } from './render-client.js';
import { AnalysisClient, AnalysisError, type AnalysisToolName } from './analysis-client.js';
import { getSessionTool } from './tools.js';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('mcp-server:dispatch');

/** MCP tool-call result (subset of the SDK's `CallToolResult`). */
export interface CallToolResult {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

const ok = (data: unknown): CallToolResult => {
  const structured = { result: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
};

const fail = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Map a thrown error to a stable, agent-readable MCP error result. */
const errorResult = (err: unknown): CallToolResult => {
  if (err instanceof SessionError) return fail(`[${err.code}] ${err.message}`);
  if (err instanceof RenderError) return fail(`[render_failed:${err.status}] ${err.message}`);
  if (err instanceof AnalysisError) return fail(`[analysis_failed:${err.status}] ${err.message}`);
  if (err instanceof ZodError) return fail(`[invalid_args] ${err.message}`);
  // Defensive: unknown errors are surfaced, never swallowed.
  return fail(`[internal_error] ${err instanceof Error ? err.message : String(err)}`);
};

/**
 * A compact view of session state (the full project is read via get_* tools).
 *
 * Deliberately identifies the open project by its stable in-project `id` and
 * display `name` — NOT by its on-disk `project.fp.json` path. Leaking the absolute
 * path invited the reported bypass where an agent with its own filesystem tools
 * edits the file directly, skipping validation/undo. The agent never needs the path
 * to drive the tools: session tools target the open project implicitly.
 */
interface StateView {
  readonly projectId: string;
  readonly projectName: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyLength: number;
}

const stateView = (s: SessionState): StateView => ({
  projectId: s.project.id,
  projectName: s.project.name,
  canUndo: s.canUndo,
  canRedo: s.canRedo,
  historyLength: s.historyLength,
});

async function callSessionTool(
  session: EditorSession,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<CallToolResult> {
  switch (name) {
    case 'open_project': {
      const { path } = getSessionTool(name)!.schema.parse(rawArgs) as { path?: string };
      // No path → open whatever project the FramePilot app currently has open.
      const state = path ? await session.openProject(path) : await session.openActiveProject();
      return ok(stateView(state));
    }
    case 'save_project': {
      const { path } = getSessionTool(name)!.schema.parse(rawArgs) as { path?: string };
      return ok(stateView(await session.saveProject(path)));
    }
    case 'undo':
      getSessionTool(name)!.schema.parse(rawArgs);
      return ok(stateView(session.undo()));
    case 'redo':
      getSessionTool(name)!.schema.parse(rawArgs);
      return ok(stateView(session.redo()));
    /* v8 ignore next 2 -- the only remaining session tool; exhaustive by construction. */
    default:
      getSessionTool(name)!.schema.parse(rawArgs);
      return ok({ patches: session.history() });
  }
}

async function callRegistryTool(
  session: EditorSession,
  renderClient: RenderClient | null,
  analysisClient: AnalysisClient | null,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = session.runTool(name, rawArgs);
  if (result.kind === 'read') return ok(result.data);
  if (result.kind === 'mutate') {
    return ok({
      applied: result.applied,
      patch: result.patch,
      validation: result.validation,
      diff: result.diff ?? null,
    });
  }
  if (result.kind === 'analysis') {
    // ffmpeg analysis runs in the Python engine (render-vs-preview rule). Save so
    // the sidecar reads the current project, then delegate to its analysis routes.
    if (!analysisClient) {
      return fail('[analysis_unavailable] FRAMEPILOT_PYTHON_API_URL is not set; cannot analyze.');
    }
    const state = await session.saveProject();
    const data = await analysisClient.analyze(
      result.name as AnalysisToolName,
      state.path,
      result.args,
    );
    if (name === 'transcribe') {
      const mutation = session.applyHostTranscript((data as { readonly words?: unknown }).words);
      await session.saveProject();
      return ok({
        applied: mutation.applied,
        patch: mutation.patch,
        validation: mutation.validation,
        // `diff` is only absent when `applied` is false, which set_transcript
        // (no timeline references to check) never produces; see applyHostTranscript.
        /* v8 ignore next */
        diff: mutation.diff ?? null,
      });
    }
    return ok({ analysis: name, result: data });
  }
  // Action tool (render_preview / export_video): save then delegate to the sidecar.
  // Named explicitly: the registry can grow an action tool without touching this
  // file, and defaulting an unknown action to "render" would silently export a
  // video the agent never asked for.
  if (name !== 'render_preview' && name !== 'export_video') {
    return fail(`[unsupported_action] '${name}' has no MCP host handler.`);
  }
  if (!renderClient) {
    return fail('[render_unavailable] FRAMEPILOT_PYTHON_API_URL is not set; cannot render.');
  }
  const state = await session.saveProject();
  const job = await renderClient.render({
    projectPath: state.path,
    preview: name === 'render_preview',
  });
  return ok({ action: name, job });
}

/**
 * Validate and execute one MCP tool call.
 *
 * @param session - The active editing session (enforces the edit invariants).
 * @param renderClient - Sidecar client for action tools, or null when unconfigured.
 * @param name - The requested tool name (session tool or registry tool).
 * @param rawArgs - Untrusted arguments from the agent.
 * @param analysisClient - Sidecar client for analysis tools, or null when unconfigured.
 * @returns An MCP `CallToolResult`; failures are returned with `isError: true`.
 */
export async function callTool(
  session: EditorSession,
  renderClient: RenderClient | null,
  name: string,
  rawArgs: Record<string, unknown> = {},
  analysisClient: AnalysisClient | null = null,
): Promise<CallToolResult> {
  log.action('MCP callTool', { tool: name, args: rawArgs });
  try {
    // Every tool but open_project needs a project already open. Fall back to the
    // app's active project so an agent can edit the GUI's open project directly,
    // without an explicit open_project call. A missing pointer surfaces no_project.
    if (name !== 'open_project') await session.ensureOpenProject();
    const result = getSessionTool(name)
      ? await callSessionTool(session, name, rawArgs)
      : await callRegistryTool(session, renderClient, analysisClient, name, rawArgs);
    log.debug('MCP callTool result', { tool: name, isError: result.isError ?? false });
    return result;
  } catch (err) {
    log.error('MCP callTool threw', { tool: name, error: String(err) });
    return errorResult(err);
  }
}
