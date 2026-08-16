/**
 * @framepilot/ai-sdk/tool-executor — the host seam that ACTUALLY runs
 * analysis/action tools (plan/AGENT-NATIVE-UX.md Phase T).
 *
 * WHY this exists: `analysis` tools (`analyze_silence`, `detect_scenes`,
 * `detect_beats`) and `action` tools (`render_preview`, `export_video`) run
 * ffmpeg/MoviePy, and the media engine is Python-only (AGENTS.md
 * render-vs-preview hard rule) — the orchestrator must never run them
 * in-process. Before this seam existed the orchestrator reported such calls
 * `completed` instantly with no data ("runs on the host" with no host), so the
 * model looped re-requesting analysis it never received and the UI showed
 * checkmarks for work that never ran.
 *
 * The host (browser session, desktop main process, MCP server) injects an
 * implementation into the {@link Orchestrator}; the agent loop AWAITS it between
 * the tool card's `running` and terminal states, feeds the returned data back
 * into the model's context, and honors the run's AbortSignal. No executor
 * configured ⇒ the call fails HONESTLY — never a fabricated success.
 *
 * Sandbox note: tools themselves still cannot touch the filesystem or network
 * (PRD §18.2) — only the orchestrator holds the executor, and hosts scope their
 * implementation to the engine sidecar's analysis routes.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { AnalysisBudget } from './kernel/cost/analysis-caps.js';
import type { AiImage, ToolCall } from './providers/types.js';

const log = createLogger('ai-sdk:tool-executor');

/**
 * What the host needs to run the call: the agent loop's WORKING project (with
 * the run's in-flight edits applied), so analysis reflects what the agent is
 * actually editing — not a stale on-disk copy.
 */
export interface HostExecutionContext {
  readonly project: Project;
  /**
   * The driving model's id, recorded as the provenance actor when a vision
   * commit persists what the model saw (plan B4.3). Optional: absent ⇒ a
   * generic `vision-model` actor, never a fabricated id.
   */
  readonly modelId?: string;
  /**
   * The run's analysis budget (plan B5.4). When present, the executor
   * pre-checks a capped call's charge before dispatch (an over-budget call
   * fails honestly, never runs) and records the real consumption after. Absent
   * ⇒ no per-run analysis cap is enforced (back-compat for callers that don't
   * thread one, e.g. one-off MCP calls).
   */
  readonly analysisBudget?: AnalysisBudget;
}

/** What actually happened when the host ran a tool call. */
export interface HostToolOutcome {
  /**
   * `completed` — ran and returned data; `warning` — ran but had nothing to do;
   * `failed` — could not run or errored; `cancelled` — aborted mid-run.
   */
  readonly status: 'completed' | 'warning' | 'failed' | 'cancelled';
  /** One-line human summary shown on the tool card. */
  readonly summary: string;
  /** The full structured result (surfaced in the card's details popup AND fed
   *  back to the model as a bounded preview). */
  readonly data?: unknown;
  /**
   * Images this call produced, to be shown to the model on its NEXT turn.
   *
   * WHY a separate channel from `data`: everything in `data` reaches the model as text
   * in the run's action log, and an image is not text. `get_frame` renders a picture of
   * the timeline, and a base64 blob pasted into a log line is both unreadable to the
   * model and ruinous to the prompt budget. These are attached as real image content on
   * the next request instead (see `Orchestrator.agentMessages`), and never enter the
   * action log.
   *
   * Ignored end to end when the driving model has no vision — the tool is not even
   * offered in that case (`agentTools`), so this stays empty rather than being sent and
   * dropped.
   */
  readonly images?: readonly AiImage[];
}

/**
 * Rewrite a memoized image-bearing payload for a replay that carries NO image.
 *
 * The run memo answers a repeated call from its stored outcome, but the orchestrator
 * deliberately drops the stored PICTURE: a frame is only worth looking at as the
 * timeline is now, so re-showing a pre-edit frame under a post-edit question is the one
 * failure `get_frame` exists to prevent.
 *
 * Dropping the image while forwarding a payload that still SAYS an image is attached is
 * worse than either honest option. `get_frame`'s data carries "The frame itself is
 * attached to this turn as an image", and passing that through on a memo hit instructs
 * the model to read a picture it was never sent — so it either refuses a question it had
 * the evidence to answer, or describes a frame from imagination. The facts (time, size,
 * duration) are still true and still useful, so only the claim of attachment changes.
 *
 * @param data - The memoized outcome's `data`.
 * @returns The same facts under an honest note, or `data` unchanged when it is not an
 *   object payload.
 */
export function withReplayedImageNote(data: unknown): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  return {
    ...(data as Record<string, unknown>),
    // Deliberately NOT "ask for it again": the run memo answers an identical call from the
    // same stored outcome, so an instruction to retry the same moment is an instruction to
    // loop until the turn budget runs out. The way back to a picture is a DIFFERENT call.
    note:
      'This image was already rendered earlier in this run and shown to you then, so it is ' +
      'NOT attached to this turn — only the facts above are. Answer from what you saw and ' +
      'from those facts. Asking again for this exact moment returns this same record and no ' +
      'picture; to see something new, ask for a different time or different options.',
  };
}

/**
 * Runs one analysis/action tool call on the host. Implementations MUST:
 * - resolve (never hang) — enforce their own transport timeout;
 * - honor `signal` (abort ⇒ reject with the signal's reason or return `cancelled`);
 * - never fabricate success: an unreachable engine is a `failed` outcome.
 */
export interface HostToolExecutor {
  run(call: ToolCall, ctx: HostExecutionContext, signal?: AbortSignal): Promise<HostToolOutcome>;
}

/**
 * Normalize an executor rejection into an honest outcome. An abort is the
 * user's cancellation (`cancelled`), anything else is a real failure with the
 * error's message so the model and the user both see the cause.
 */
export function outcomeFromExecutorError(
  call: ToolCall,
  error: unknown,
  aborted: boolean,
): HostToolOutcome {
  if (aborted || (error instanceof Error && error.name === 'AbortError')) {
    log.warn('outcomeFromExecutorError → cancelled', { tool: call.name });
    return { status: 'cancelled', summary: `Stopped "${call.name}" — run cancelled` };
  }
  const reason = error instanceof Error ? error.message : String(error);
  log.error('outcomeFromExecutorError → failed', { tool: call.name, reason });
  return {
    status: 'failed',
    summary: `"${call.name}" failed: ${reason}`,
    data: reason,
  };
}
