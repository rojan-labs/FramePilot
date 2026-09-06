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
import type { EditorInteractionContext } from './editor-context/interaction-context.js';
import type { AiImage, ToolCall } from './providers/types.js';
import type { RefusalCause } from './tool-refusal.js';

const log = createLogger('ai-sdk:tool-executor');

/**
 * What the host needs to run the call: the agent loop's WORKING project (with
 * the run's in-flight edits applied), so analysis reflects what the agent is
 * actually editing — not a stale on-disk copy.
 */
export interface HostExecutionContext {
  readonly project: Project;
  /**
   * The editor's live selection snapshot, when the driving surface has one.
   * Host tools that resolve "the selected clip" resolve against this, exactly
   * like mutate tools — never by guessing what the user pointed at. Absent ⇒
   * such tools must fail honestly rather than pick a clip themselves.
   */
  readonly interaction?: EditorInteractionContext;
  /**
   * The driving model's id, recorded as the provenance actor when a vision
   * commit persists what the model saw (plan B4.3). Optional: absent ⇒ a
   * generic `vision-model` actor, never a fabricated id.
   */
  readonly modelId?: string;
  /**
   * The run's analysis budget (plan B5.4). When present, the executor pre-checks a capped
   * call's charge before dispatch (an over-budget call fails honestly, never runs) and
   * records the real consumption after — transcription in minutes of audio the recognizer
   * got through, ffmpeg in wall-clock seconds the host measured around the dispatch.
   *
   * The shipped implementation of that contract is `sidecar-executor.ts#chargeAnalysisBudget`,
   * and it is the only one: an executor that accepts this field and never calls
   * `check`/`record` enforces nothing while reading as though it does, which is exactly
   * how this paragraph was false for every run before the wiring existed. If you write
   * another executor, wrap it in that helper rather than re-deriving the charges.
   *
   * Absent ⇒ no per-run analysis cap (back-compat for callers that don't thread one, e.g.
   * one-off MCP calls).
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
  /**
   * Which RULE this host refused under — set ONLY on a `failed` outcome the host reached
   * as a POLICY decision about the project it was handed, never on a failure of the work.
   *
   * ## Why a host needs this channel at all
   *
   * The orchestrator deliberately gives host outcomes no run-memory key
   * (`orchestrator.ts#deterministicFailureKey`): a sidecar restart, a download timeout, a
   * provider 5xx are transient, and remembering one as proof the tool cannot work would
   * lose the tool for the rest of the run over a bad network moment. That default is
   * right for everything a host can FAIL at, and wrong for the one thing a host can
   * REFUSE: `stock-host.ts` answers ADR 0140's picture-over-picture rule BEFORE spending
   * the download, by reading the same `editor-core` occupancy predicate `add_clip` uses.
   * Same rule, same working copy, same verdict every time — and until this field existed
   * the outcome had no way to say so, so on desktop that refusal cost nothing per
   * iteration and could repeat without limit. Run `369e8c82` spent roughly fifteen of its
   * sixty-eight minutes being refused this rule four times.
   *
   * A declared cause makes the outcome `deterministicFailure` and keys run memory on the
   * RULE rather than the sentence — the sentence names the asset and the times, so four
   * refusals of one rule banked four keys and matched nothing. Absent (the default, and
   * the right answer for every transient failure) ⇒ unkeyed and retryable, exactly as
   * before.
   *
   * Declare it only when the verdict is a function of the arguments and the project, and
   * would be identical if the call were repeated with nothing changed.
   */
  readonly refusalCause?: RefusalCause;
}

/**
 * Runs one analysis/action tool call on the host. Implementations MUST:
 * - resolve (never hang) — enforce their own transport timeout;
 * - honor `signal` (abort ⇒ reject with the signal's reason or return `cancelled`);
 * - never fabricate success: an unreachable engine is a `failed` outcome.
 */
export interface HostToolExecutor {
  run(call: ToolCall, ctx: HostExecutionContext, signal?: AbortSignal): Promise<HostToolOutcome>;
  /**
   * Tool names this surface can never fulfil — so they must not be ADVERTISED here.
   *
   * WHY a per-surface declaration rather than `available: false` in the registry:
   * `render_preview` and `export_video` are real on the MCP surface (`mcp-server/dispatch.ts`
   * saves and delegates to the sidecar) and unroutable on the desktop and browser agent
   * surfaces, where `planSidecarCall` has no route and the executor refuses with
   * `surface_unavailable`. One registry flag cannot say both. The executor knows which
   * surface it is, statically, before any call is made.
   *
   * WHY it matters: a tool the model can see, it will call. In one desktop run of
   * 2026-09-05 (`framepilot.runs.jsonl`) `render_preview` was called eight times in 86
   * minutes and refused identically each time; and every request on that surface paid the
   * two descriptors' schema tokens for tools that could not run. Dropping them from
   * advertisement removes the cause upstream of the repeat guard, and the cost.
   *
   * Optional and pure: absent means "everything registered is routable here", which is the
   * MCP server's truth and the previous behaviour everywhere. A wrapper that composes
   * executors MUST forward this, or the surface behind it silently loses the declaration —
   * the exact shape by which a sidecar-only fix once never reached the desktop.
   */
  unroutableTools?(): ReadonlySet<string>;
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
