/**
 * @framepilot/ai-sdk/events — the streaming AI event model (Phase 11 M1, ADR 0033).
 *
 * The single architectural idea of the streaming sidebar: **everything the AI does
 * becomes a typed, append-only {@link AiEvent}**. A conversation IS an ordered list
 * of these. The UI is a pure function of that log: streaming is "append/patch
 * events"; persistence is "save the log"; interruption is "stop emitting events".
 *
 * Events carry a stable string `id` and **update in place by `id`** — a streamed
 * delta or a tool-status change re-emits the same `id` rather than appending a
 * duplicate row. {@link reduceEvents} folds the append-only log into a render-ready
 * {@link ConversationView}, merging delta chunks into their parent message and
 * tool results into their tool call.
 *
 * This module is pure (no I/O, no clock) and exhaustively tested: it is the
 * contract every later milestone depends on, treated like the timeline schema.
 */
import type { EditResult } from './assemble.js';
import type { ReferenceProfile } from './references/profile.js';
import type { ContextManifest } from './kernel/context/manifest.js';
import type { RunStatus } from './run-contracts.js';
export type { RunStatus } from './run-contracts.js';

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single tool invocation card. `cancelled` means the user stopped
 * the run while this call was in flight — never rendered as a success.
 */
export type ToolStatus = 'running' | 'completed' | 'warning' | 'failed' | 'cancelled';

/** A run status that ends a turn (no further events expected for it). */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** True when `status` is a terminal run state (completed/failed/cancelled). */
export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Reference + plan-step value types
// ---------------------------------------------------------------------------

/** A clickable chip pointing at a file/clip/track/asset the AI read or touched. */
export interface Reference {
  readonly kind: 'file' | 'clip' | 'track' | 'asset' | 'transition' | 'caption';
  /** The editor-side id (clipId/trackId/assetId/path) a click resolves against. */
  readonly id: string;
  /** Human-readable label shown on the chip. */
  readonly label: string;
}

/** One line of the live agent plan checklist. */
export interface PlanStep {
  readonly id: string;
  readonly label: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  /**
   * Supporting context for the step: while a planned (ledger) step is running it
   * carries the turn's derived intent (U2); on failure it carries WHY, surfaced on
   * hover of the status mark so the error is discoverable without scrolling (#4).
   */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// The AiEvent union
// ---------------------------------------------------------------------------

/** Fields shared by every event. All ids are stable strings keyed by the UI. */
export interface AiEventBase {
  /** Stable id; deltas/status-updates re-emit the same id to update in place. */
  readonly id: string;
  readonly conversationId: string;
  /** Epoch ms — for ordering and date grouping. */
  readonly ts: number;
  /** Groups every event produced by one user turn. */
  readonly turnId: string;
}

/**
 * A file the user attached to ONE message, owned by that message forever.
 *
 * Deliberately not the composer's `Attachment`. The composer's version carries the
 * transient half of the lifecycle — `status: 'analyzing'`, an `error` to retry from —
 * which is state about work in progress, not about the message. Once the message is
 * sent, that work is over: what remains is what was attached, and it can never change
 * again. Keeping the two types apart is what stops a chat bubble re-rendering because a
 * spinner somewhere else moved.
 *
 * `profile` is the analysis the model reads. It is carried ON the message so a turn's
 * references can be rebuilt from the conversation log alone — which is also what makes
 * Retry replay the same references rather than whatever the composer happens to hold
 * three turns later.
 */
export interface MessageAttachment {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'audio' | 'timeline' | 'project' | 'document';
  readonly name: string;
  /** What the reference is for; shown on the bubble's tile. */
  readonly role?: ReferenceProfile['role'];
  /** Where the imported copy lives, relative to the projects root. */
  readonly path?: string;
  /**
   * The measured profile, when one was produced. Absent for a kind that cannot be
   * analyzed, and for an attachment sent before its analysis finished — in both cases
   * the attachment is still shown on the message, because the user attached it and a
   * bubble that hides it is lying about what was sent.
   *
   * Typed as the SDK's own `ReferenceProfile`, not the IPC mirror of it. The host
   * returns the looser `AiStreamReferenceProfile` (`video`/`image` widened to
   * `Record<string, unknown>`), and the sidebar used to bridge the two with an
   * `as unknown as` — a cast that would keep compiling if either side changed shape.
   * The profile is parsed against `ReferenceProfileSchema` where it enters, so
   * everything downstream of that boundary holds the canonical type.
   */
  readonly profile?: ReferenceProfile;
}

/** The prompt the user sent, with anything they attached to it. */
export interface UserMessageEvent extends AiEventBase {
  readonly type: 'user_message';
  readonly text: string;
  /**
   * Attachments this message owns. Absent on messages sent before attachments were
   * message-owned, and on messages sent with nothing attached — an empty array and an
   * absent one mean the same thing to every reader.
   */
  readonly attachments?: readonly MessageAttachment[];
}

/** A streamed token chunk; appended to the assistant message keyed by `parentId`. */
export interface AssistantDeltaEvent extends AiEventBase {
  readonly type: 'assistant_delta';
  /** The id of the assistant message this chunk belongs to. */
  readonly parentId: string;
  readonly chunk: string;
}

/** Terminal assistant message — canonical markdown so a reload renders identically. */
export interface AssistantMessageEvent extends AiEventBase {
  readonly type: 'assistant_message';
  readonly text: string;
}

/** A concise reasoning SUMMARY list (never raw chain-of-thought). Updated in place. */
export interface ReasoningEvent extends AiEventBase {
  readonly type: 'reasoning';
  readonly summaries: readonly string[];
  /** True once reasoning is finished (stops the "Thinking…" animation). */
  readonly done: boolean;
}

/**
 * A streamed token chunk of the CURRENT reasoning line — appended to the last
 * summary of the {@link ReasoningEvent} keyed by `parentId`. Mirrors
 * {@link AssistantDeltaEvent} so live reasoning costs O(chunk) per token instead of
 * re-shipping the whole accumulated text (which made long agent turns O(n²) over
 * IPC and in the persisted log — the root cause of "buffered" reasoning).
 */
export interface ReasoningDeltaEvent extends AiEventBase {
  readonly type: 'reasoning_delta';
  /** The id of the reasoning node this chunk extends (the turn's fixed reasoning id). */
  readonly parentId: string;
  readonly chunk: string;
}

/** The live agent checklist (steps + status). Updated in place. */
export interface PlanEvent extends AiEventBase {
  readonly type: 'plan';
  readonly steps: readonly PlanStep[];
}

/** A tool invocation; mutated in place across its lifecycle by re-emitting the id. */
export interface ToolCallEvent extends AiEventBase {
  readonly type: 'tool_call';
  readonly toolName: string;
  readonly status: ToolStatus;
  /** Wall-clock runtime once finished (ms). */
  readonly runtimeMs?: number;
  /** Optional human-readable title overriding the tool name. */
  readonly title?: string;
  /** Compact one-line rendering of the call's arguments (U4 card fidelity). */
  readonly argsSummary?: string;
}

/** The expandable detail attached to a {@link ToolCallEvent} by `toolCallId`. */
export interface ToolResultEvent extends AiEventBase {
  readonly type: 'tool_result';
  /** The id of the {@link ToolCallEvent} this result belongs to. */
  readonly toolCallId: string;
  readonly summary?: string;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly files?: readonly string[];
  readonly clips?: readonly string[];
  readonly tracks?: readonly string[];
  readonly logs?: readonly string[];
  readonly warnings?: readonly string[];
}

/** One choice offered by an {@link AskEvent} — the model's own words. */
export interface AskOption {
  readonly label: string;
  /** One line on what picking this means; absent when the label says it all. */
  readonly description?: string;
}

/**
 * The model is asking the editor something and the run is PAUSED until they answer (P12).
 *
 * Everything here is authored by the model, not by us: it decides when its own progress
 * depends on a person, what to ask, and what the choices are. So the event carries text
 * rather than a code — a host renders whatever arrives, which is what lets questions we
 * never anticipated work as well as the ones we did. `options` absent ⇒ free-text answer.
 *
 * The host answers by resolving the run's `askUser` control keyed by {@link toolCallId};
 * the answer returns to the model as that tool call's result.
 */
export interface AskEvent extends AiEventBase {
  readonly type: 'ask';
  /** The `tool_call` this question belongs to — the key an answer is routed back on. */
  readonly toolCallId: string;
  readonly question: string;
  readonly options?: readonly AskOption[];
}

/** A produced edit operation, surfaced as a human-readable action card. */
export interface TimelineActionEvent extends AiEventBase {
  readonly type: 'timeline_action';
  /** e.g. 'Added' | 'Deleted' | 'Moved' | 'Split' | 'Trimmed' | 'Added transition'. */
  readonly action: string;
  readonly detail: string;
  readonly refs?: readonly Reference[];
}

/**
 * A reviewable patch (what/why/before-after); wraps the existing {@link EditResult}.
 *
 * `variants` (H1.5 / AGENT-NATIVE-COMPLETION-PLAN.md P13.1 — "variations / A-B compare")
 * is present only for an opt-in multi-candidate `edit`-mode run: each entry is a REAL,
 * independently proposed + assembled candidate (never a recipe/planner/agent result —
 * those are deterministic or already-converged single proposals, so "variations" of them
 * would just be the identical result run twice, which this SDK never fabricates). `edit`
 * always mirrors `variants[0]` when `variants` is set, so every existing single-proposal
 * consumer (before this feature existed) keeps working unchanged.
 */
export interface DiffEvent extends AiEventBase {
  readonly type: 'diff';
  readonly edit: EditResult;
  /**
   * Outcome of the temporal/perceptual gate when that gate was requested by the host.
   * `unverified` remains a human-review proposal and must never enter an auto-commit path.
   * Absent preserves legacy/manual-review routes that did not request temporal acquisition.
   */
  readonly verification?: 'verified' | 'unverified';
  readonly variants?: readonly EditResult[];
  /**
   * `'turn'` — one agent turn's validated ops, emitted live mid-run so hosts can
   * apply/review each step as it lands (auto mode applies instantly). `'run'` —
   * a whole single-proposal run (`edit` mode). Absent = legacy
   * single-proposal semantics, treated the same as `'run'`.
   */
  readonly scope?: 'turn' | 'run';
  /** 0-based agent turn index; present only when `scope === 'turn'`. */
  readonly turnIndex?: number;
  /**
   * Groups every `scope:'turn'` diff of ONE agent run under a shared id (plan B5.3),
   * so a host can collapse a whole analysis/edit burst into a single review/undo step
   * instead of N per-turn steps — the per-turn diffs are still emitted individually
   * (ADR 0056), the run id is the optional grouping key over them. Absent on
   * single-proposal runs (they are already one step).
   */
  readonly runId?: string;
  /** Host-authoritative commit projection for pre-authorized desktop runs. */
  readonly commit?: {
    readonly state: 'committed' | 'stale';
    readonly revision?: number;
    readonly rebased?: boolean;
    readonly reason?: string;
  };
  /**
   * Plan step (`step-1`, `step-2`, …) whose turn produced this edit, when the run drafted
   * a plan. Lets a host render the edit as the step's own outcome instead of a separate
   * card repeating what the step already says. Absent on single-proposal routes, which
   * never draft a plan.
   */
  readonly planStepId?: string;
}

/**
 * What a read-only perceptual review observed about an edit that has ALREADY been applied.
 *
 * Review is a reader (see `review-findings.ts`): it never proposes a patch, so a finding is
 * an observation the agent repairs in an ordinary turn, not a gate the edit has to pass.
 * `resolved` flips to true once a later turn's edit rewrote the region this finding names —
 * that is the same intersection rule that decides staleness, read as "the agent fixed it".
 */
export interface ReviewFindingEvent extends AiEventBase {
  readonly type: 'review_finding';
  /** 0-based agent turn whose edit was reviewed. */
  readonly turnIndex: number;
  /** See {@link DiffEvent.planStepId}. */
  readonly planStepId?: string;
  /** Plain-language statement of what review found. */
  readonly detail: string;
  /** Where in the programme it was found, for a jump affordance. */
  readonly atSeconds?: number;
  /** True once a later edit addressed it. */
  readonly resolved: boolean;
  /** `temporal:*` / `vision:*` provenance for the run record. */
  readonly lineage?: readonly string[];
}

/** 0..1 progress for a long op (analyze/render/export). */
export interface ProgressEvent extends AiEventBase {
  readonly type: 'progress';
  readonly label: string;
  /** Clamped to [0, 1] by {@link reduceEvents}. */
  readonly value: number;
}

/** Clickable file/clip/track chips the AI read. */
export interface ReferenceEvent extends AiEventBase {
  readonly type: 'reference';
  readonly refs: readonly Reference[];
}

/** An informational system notice. */
export interface NotificationEvent extends AiEventBase {
  readonly type: 'notification';
  readonly text: string;
  /**
   * A machine-inspectable tag for WHY this notice fired (e.g. a specific planner-path
   * degrade reason — `orchestrator.ts`'s `PlannerFallbackReason`), so a caller can branch
   * on the reason without string-matching `text` (AGENT-NATIVE-COMPLETION-PLAN.md P11.2 —
   * "honest, inspectable fallback"). Omitted for a plain informational notice with no
   * structured reason to carry (mirrors {@link ErrorEvent.retryable}'s "additive, optional"
   * shape — every existing notification producer is unaffected).
   */
  readonly reason?: string;
  /** Extra human-readable specifics beyond `text` (mirrors {@link ErrorEvent.detail}). */
  readonly detail?: string;
}

/** A non-fatal warning. */
export interface WarningEvent extends AiEventBase {
  readonly type: 'warning';
  readonly text: string;
}

/** A failure card: what/why/retry/copy-logs. */
export interface ErrorEvent extends AiEventBase {
  readonly type: 'error';
  readonly message: string;
  readonly detail?: string;
  readonly retryable?: boolean;
}

/** Run lifecycle (idle→thinking→…→completed/failed/cancelled). */
export interface StatusEvent extends AiEventBase {
  readonly type: 'status';
  readonly status: RunStatus;
}

/**
 * A resumable snapshot of an interrupted agent run (R3 C2). Emitted when an agent run
 * is cancelled mid-flight and persisted in the conversation event log (no new store),
 * so a later **Resume** can continue from the last applied step instead of restarting.
 * `ops` is the flattened, already-validated operation list applied so far (serialisable
 * plain JSON); `stepsCompleted` is how many turns had run.
 */
export interface CheckpointEvent extends AiEventBase {
  readonly type: 'checkpoint';
  /** The run's goal (the user's request) — echoed so Resume needs no extra lookup. */
  readonly goal: string;
  /** The operations applied so far (flattened, validated). Replayed to rebuild state. */
  readonly ops: readonly unknown[];
  /** The human-readable action log at the interruption point. */
  readonly log: readonly string[];
  /** How many agent turns had completed when the run was interrupted. */
  readonly stepsCompleted: number;
  /**
   * The run's task memory at the interruption point (ADR 0075), as plain JSON.
   *
   * Replaying `ops` rebuilds the PROJECT; this rebuilds the RUN — the stage it had
   * reached, the facts it had established, the decisions it had committed. Without it a
   * resumed run has the edits but not the reasoning behind them, and starts over at
   * orientation. Optional and untyped here so the event surface stays additive: readers
   * validate it with `parseWorkingState`, which drops anything it cannot understand.
   */
  readonly working?: unknown;
}

/** Machine-authored causal ledger snapshot emitted at reducer boundaries. */
export interface RunStateEvent extends AiEventBase {
  readonly type: 'run_state';
  readonly working: unknown;
}

/**
 * A DAG task began executing (plan/AI-ORCHESTRATION-REDESIGN.md §12, Phase K0.2).
 *
 * Emitted per dispatched task node so the sidebar can show *what is running in parallel*.
 * The reducer folds them into view-level `tasks` (NOT the `nodes` list), so a consumer that
 * ignores them is unaffected.
 *
 * **No production path emits these today.** The planner route was their only emitter and it
 * was retired (ADR 0126). They are deliberately kept rather than deleted, because they are
 * part of the PERSISTED event vocabulary: conversations recorded before the convergence still
 * contain them, and `reduceEvents` must keep folding them for that history to render. The
 * emitter is retained as the one tested way to construct them — the alternative is
 * hand-built literals in the renderer's tests, which would let the constructor and the fold
 * drift apart.
 *
 * If a future feature wants parallel-task cards (batch analysis, proxy generation), this is
 * the vocabulary to reuse. Do not invent a second one.
 */
export interface TaskStartedEvent extends AiEventBase {
  readonly type: 'task_started';
  /** Stable id of the DAG node — task_finished/effect_progress reference it. */
  readonly taskId: string;
  /** Human-readable label (e.g. "Analyze silence · A-roll"). */
  readonly label: string;
  /** Scheduler resource class ('ffmpeg' | 'model' | 'pure' | 'render' | …). */
  readonly resourceClass?: string;
}

/** A DAG task reached a terminal status. Updates the task keyed by `taskId`. */
export interface TaskFinishedEvent extends AiEventBase {
  readonly type: 'task_finished';
  readonly taskId: string;
  readonly status: 'completed' | 'warning' | 'failed' | 'cancelled';
  /** Wall-clock runtime (ms); when omitted the reducer derives it from the start ts. */
  readonly runtimeMs?: number;
}

/**
 * Streamed 0..1 progress from a long host/render effect, attributed to the DAG task
 * it runs (plan §12). Folds onto that task's `progress`; a progress for an unknown
 * task is ignored (its `task_started` must arrive first — mirrors `tool_result`).
 */
export interface EffectProgressEvent extends AiEventBase {
  readonly type: 'effect_progress';
  readonly taskId: string;
  readonly label: string;
  /** Clamped to [0, 1] by {@link reduceEvents}. */
  readonly value: number;
}

/**
 * A run's real, priced cost (P7.1 — `graph-executor.ts`'s `GraphRunResult.cost`/
 * `recipe-executor.ts`'s `RecipeRunResult.cost`/`plan-driver.ts`'s
 * the run's accumulated cost). Carries the RAW numbers — never rendered directly
 * (lens §2.5.6: the default sidebar shows only creator-language, never a token/$
 * meter); a host app folds this into creator language via
 * `kernel/cost/usage-summary.ts`'s `summarizeUsage`, and a dev/pro settings toggle
 * may additionally show these raw numbers. Emitted once per run, after the run's
 * result settles and before its terminal `status`.
 */
export interface UsageEvent extends AiEventBase {
  readonly type: 'usage';
  readonly tokens: number;
  readonly usd: number;
  /**
   * How many model calls this run actually made, independent of what they reported.
   *
   * WHY it is separate from `tokens`: a $0/0-token run means two completely different
   * things depending on this number. Zero calls is a *deterministic recipe* — genuinely
   * free, and the sidebar says "Instant · no AI needed". A run with calls but no reported
   * tokens is a provider that answered without a usage report; calling that "no AI needed"
   * is a lie about a run that spent real money. Consumers that only price a run can keep
   * ignoring this; `kernel/cost/usage-summary.ts` reads it to tell the two apart.
   *
   * Optional so an emitter that cannot count calls (or a persisted event from before this
   * field existed) is not forced to fabricate one — `undefined` means "unknown", which
   * `summarizeUsage` treats conservatively.
   */
  readonly modelCalls?: number;
}

/**
 * Occupancy of the context sent to the model for the most recent call in this turn.
 *
 * This is deliberately separate from {@link UsageEvent}: context occupancy describes
 * one active request, while cost is cumulative across every model call in a run. The
 * first event for a call is an estimate from the exact request payload; providers that
 * report input usage update it with an exact count after settlement.
 */
export interface ContextUsageEvent extends AiEventBase {
  readonly type: 'context_usage';
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly estimated: boolean;
  /**
   * The full account of what this request contained (ADR 0080): every section with its
   * cost, what compaction removed, the four distinct token figures, and the state of the
   * durable run memory that outlives the request.
   *
   * The three scalar fields above are kept as a projection of it so existing consumers
   * keep working, but they are exactly the shape that made the old indicator
   * uninterpretable — a number with no attribution. New UI reads the manifest.
   *
   * Optional because a caller may emit occupancy without having assembled one; absent
   * means "no breakdown available", never "nothing was included".
   */
  readonly manifest?: ContextManifest;
}

/** Monotonic, append-only. A conversation IS an ordered list of these. */
export type AiEvent =
  | UserMessageEvent
  | AssistantDeltaEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | ReasoningDeltaEvent
  | PlanEvent
  | ToolCallEvent
  | ToolResultEvent
  | AskEvent
  | TimelineActionEvent
  | DiffEvent
  | ReviewFindingEvent
  | ProgressEvent
  | ReferenceEvent
  | NotificationEvent
  | WarningEvent
  | ErrorEvent
  | StatusEvent
  | CheckpointEvent
  | RunStateEvent
  | TaskStartedEvent
  | TaskFinishedEvent
  | EffectProgressEvent
  | UsageEvent
  | ContextUsageEvent;

// ---------------------------------------------------------------------------
// Reduced view — what the UI renders
// ---------------------------------------------------------------------------

export interface UserNode {
  readonly kind: 'user';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly text: string;
  /** What was attached to this message — rendered in its own bubble. */
  readonly attachments?: readonly MessageAttachment[];
}

export interface AssistantNode {
  readonly kind: 'assistant';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly text: string;
  /** True while only deltas have arrived; false once the terminal message lands. */
  readonly streaming: boolean;
}

export interface ReasoningNode {
  readonly kind: 'reasoning';
  readonly id: string;
  /** The FIRST reasoning event's timestamp — when thinking became visible. */
  readonly ts: number;
  readonly turnId: string;
  readonly summaries: readonly string[];
  readonly done: boolean;
  /**
   * Real elapsed thinking time (ms), derived from event timestamps when the
   * `done` event lands — drives the "Thought for Ns" header (U3).
   */
  readonly thoughtMs?: number;
}

export interface PlanNode {
  readonly kind: 'plan';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly steps: readonly PlanStep[];
}

export interface ToolNode {
  readonly kind: 'tool';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly toolName: string;
  readonly status: ToolStatus;
  readonly runtimeMs?: number;
  readonly title?: string;
  /** Compact one-line rendering of the call's arguments (U4). */
  readonly argsSummary?: string;
  /** The expandable detail, attached when its {@link ToolResultEvent} arrives. */
  readonly result?: ToolResultEvent;
  /**
   * The model's pending question (P12), attached when its {@link AskEvent} arrives.
   * Present ⇒ this call is a question to the editor; while the node is still `running`
   * the run is blocked on their answer, and a host renders the prompt + options here.
   * The answer arrives as the node's ordinary `result`.
   */
  readonly ask?: AskEvent;
}

export interface TimelineActionNode {
  readonly kind: 'timeline_action';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly action: string;
  readonly detail: string;
  readonly refs?: readonly Reference[];
}

export interface DiffNode {
  readonly kind: 'diff';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly edit: EditResult;
  /** See {@link DiffEvent.variants} — present only for an opt-in variations run. */
  readonly variants?: readonly EditResult[];
  /** See {@link DiffEvent.scope}. */
  readonly scope?: 'turn' | 'run';
  /** See {@link DiffEvent.turnIndex}. */
  readonly turnIndex?: number;
  /** See {@link DiffEvent.runId} — groups a run's per-turn diffs into one review/undo step. */
  readonly runId?: string;
  /** See {@link DiffEvent.commit}. */
  readonly commit?: DiffEvent['commit'];
  /** See {@link DiffEvent.verification}. */
  readonly verification?: DiffEvent['verification'];
  /** See {@link DiffEvent.planStepId}. */
  readonly planStepId?: string;
}

/** See {@link ReviewFindingEvent}. */
export interface ReviewFindingNode {
  readonly kind: 'review_finding';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly turnIndex: number;
  readonly planStepId?: string;
  readonly detail: string;
  readonly atSeconds?: number;
  readonly resolved: boolean;
  readonly lineage?: readonly string[];
}

export interface ProgressNode {
  readonly kind: 'progress';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly label: string;
  readonly value: number;
}

export interface ReferenceNode {
  readonly kind: 'reference';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly refs: readonly Reference[];
}

/** notification/warning/error collapse to one node distinguished by `level`. */
export interface NoticeNode {
  readonly kind: 'notice';
  readonly id: string;
  readonly ts: number;
  readonly turnId: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
  readonly detail?: string;
  readonly retryable?: boolean;
  /** See {@link NotificationEvent.reason} — threaded through so the reduced view stays inspectable. */
  readonly reason?: string;
}

export type ViewNode =
  | UserNode
  | AssistantNode
  | ReasoningNode
  | PlanNode
  | ToolNode
  | TimelineActionNode
  | DiffNode
  | ReviewFindingNode
  | ProgressNode
  | ReferenceNode
  | NoticeNode;

/**
 * A DAG task's live view (plan/AI-ORCHESTRATION-REDESIGN.md §12, K0.2). Folded from
 * `task_started`/`task_finished`/`effect_progress`, exposed on {@link ConversationView.tasks}
 * — NOT in `nodes` — so a "what's running in parallel" surface can render the running
 * set while every existing node consumer ignores it.
 */
export interface TaskView {
  readonly taskId: string;
  /** When the task first became visible (its `task_started` ts); preserved across updates. */
  readonly ts: number;
  readonly turnId: string;
  readonly label: string;
  /** `running` until a `task_finished` lands, then its terminal status. */
  readonly status: ToolStatus;
  readonly resourceClass?: string;
  /** Wall-clock runtime once finished (ms). */
  readonly runtimeMs?: number;
  /** Latest streamed effect progress in [0, 1], if any arrived. */
  readonly progress?: number;
}

/** The render-ready projection of an event log. */
export interface ConversationView {
  /** Ordered by first appearance; each node updated in place by id. */
  readonly nodes: readonly ViewNode[];
  /** The latest run status (drives the header + state animations). */
  readonly status: RunStatus;
  /**
   * Live DAG tasks (K0.2), ordered by first appearance. Present only when at least
   * one task event arrived (mirrors {@link ConversationView.checkpoint}) so the view
   * shape is unchanged for the common no-task case.
   */
  readonly tasks?: readonly TaskView[];
  /**
   * The most-recent resumable checkpoint from an interrupted agent run (R3 C2), if any.
   * The sidebar offers **Resume** when this is present and the run was cancelled. Cleared
   * (undefined) once a new terminal message or a fresh run supersedes it.
   */
  readonly checkpoint?: CheckpointEvent;
  /** Latest causal ledger for durable recovery and the development inspector. */
  readonly runState?: RunStateEvent;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Settle every reasoning node that CANNOT still be thinking, as a pure projection over
 * the folded nodes. Two rules, both structural — neither invents thinking that did not
 * happen, and a late `reasoning done` event still reconciles the stored node exactly:
 *
 * 1. **Only the last reasoning node may be live.** A run thinks in one place at a time:
 *    a step's thinking is over the moment the NEXT step opens its own node. Without this
 *    a single dropped `done` event stranded a "Thinking…" shimmer in the middle of the
 *    transcript for the rest of the session — two, three, four of them stacked up in one
 *    thread, which is what "the thinking shows twice" actually was. The `done` event is
 *    droppable in practice (a host remount can lose the un-persisted tail of the log), so
 *    the reduced view must not depend on receiving it.
 * 2. **A terminal run has no live thinking.** Once the run is completed/failed/cancelled
 *    no further reasoning events can arrive, so the last node settles too.
 *
 * A node settled by this projection has no measured `thoughtMs` of its own (that number
 * only rides the `done` event), so it borrows the elapsed time up to the next node — the
 * same quantity the settle event would have carried: how long the model worked before the
 * run visibly moved on. With nothing after it, the node settles with no duration at all
 * rather than a fabricated one.
 */
function settleStaleReasoning(nodes: readonly ViewNode[], terminal: boolean): ViewNode[] {
  let lastReasoning = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i]?.kind === 'reasoning') {
      lastReasoning = i;
      break;
    }
  }
  return nodes.map((node, index) => {
    if (node.kind !== 'reasoning' || node.done) return node;
    // Rule 1 settles every node but the last; rule 2 settles the last one too.
    if (index === lastReasoning && !terminal) return node;
    const next = nodes[index + 1];
    return {
      ...node,
      done: true,
      ...(node.thoughtMs === undefined && next ? { thoughtMs: next.ts - node.ts } : {}),
    };
  });
}

/**
 * An incremental fold of an append-only event log into a {@link ConversationView}.
 *
 * `push` consumes one event in O(1) amortized; `view` materializes the current
 * projection. This is what a streaming consumer should hold onto — re-reducing the
 * whole log per streamed token is O(n²) per turn and was the measured root cause of
 * laggy ("buffered") streaming on long conversations. {@link reduceEvents} remains
 * the pure one-shot form built on top of this builder.
 */
export interface ConversationViewBuilder {
  /** Consume one event (same merge rules as {@link reduceEvents}). */
  push(event: AiEvent): void;
  /** Materialize the current view (new object each call; nodes ordered by first appearance). */
  view(): ConversationView;
}

/** Create an empty incremental {@link ConversationViewBuilder}. */
export function createConversationViewBuilder(): ConversationViewBuilder {
  const order: string[] = [];
  const byId = new Map<string, ViewNode>();
  let status: RunStatus = 'idle';
  let checkpoint: CheckpointEvent | undefined;
  let runState: RunStateEvent | undefined;
  // Task lifecycle is folded OUTSIDE `nodes` (view-level `tasks`), so node consumers
  // ignore it. Ordered by first appearance, updated in place by taskId.
  const taskOrder: string[] = [];
  const tasksById = new Map<string, TaskView>();

  const upsert = (node: ViewNode): void => {
    if (!byId.has(node.id)) order.push(node.id);
    byId.set(node.id, node);
  };

  const upsertTask = (task: TaskView): void => {
    if (!tasksById.has(task.taskId)) taskOrder.push(task.taskId);
    tasksById.set(task.taskId, task);
  };

  // Where a producer's reasoning node id currently points, and how many blocks have used
  // it (see `openReasoning`). Empty for every log whose producer already keys one node per
  // model call — which is all of them today (`streamAssistant` derives the scope), so this
  // is a floor under the invariant, not the mechanism that implements it.
  const reasoningAlias = new Map<string, string>();
  const reasoningBlocks = new Map<string, number>();

  /**
   * Resolve the node a reasoning event belongs to, FORKING a new node when the producer
   * reuses an id that already carries a settled block.
   *
   * Thinking is append-only in the transcript: a block that has finished is a record of
   * what the model actually thought at that point, and no later block may take its place.
   * A settled node receiving a fresh (`done: false`) event is therefore never an update —
   * it is a *second* block wearing the first one's id, and merging them is exactly the
   * "the new thinking replaced the old one, above the tools it came after" bug. Forking to
   * `${id}#2` keeps both, in order, each with its own expandable body.
   *
   * The fold owns this because the event log is a public wire format: it arrives over IPC,
   * from persisted history, and from producers this package does not control. Correct
   * producers never trip it (every distinct block already carries a distinct id), so the
   * alias map stays empty on the normal path.
   */
  const openReasoning = (producerId: string, done: boolean): string => {
    const current = reasoningAlias.get(producerId) ?? producerId;
    const node = byId.get(current);
    if (done || node?.kind !== 'reasoning' || !node.done) return current;
    const block = (reasoningBlocks.get(producerId) ?? 1) + 1;
    reasoningBlocks.set(producerId, block);
    const forked = `${producerId}#${block}`;
    reasoningAlias.set(producerId, forked);
    return forked;
  };

  const push = (event: AiEvent): void => {
    switch (event.type) {
      case 'user_message':
        upsert({
          kind: 'user',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          text: event.text,
          ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
        });
        break;
      case 'assistant_delta': {
        const prev = byId.get(event.parentId);
        const base: AssistantNode =
          prev?.kind === 'assistant'
            ? prev
            : {
                kind: 'assistant',
                id: event.parentId,
                ts: event.ts,
                turnId: event.turnId,
                text: '',
                streaming: true,
              };
        upsert({ ...base, text: base.text + event.chunk, streaming: true });
        break;
      }
      case 'assistant_message':
        upsert({
          kind: 'assistant',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          text: event.text,
          streaming: false,
        });
        break;
      case 'reasoning': {
        // Keep the FIRST event's timestamp as the node's ts so the settling event
        // can derive the real elapsed thinking time ("Thought for Ns", U3).
        const nodeId = openReasoning(event.id, event.done);
        const prev = byId.get(nodeId);
        const startTs = prev?.kind === 'reasoning' ? prev.ts : event.ts;
        upsert({
          kind: 'reasoning',
          id: nodeId,
          ts: startTs,
          turnId: event.turnId,
          summaries: event.summaries,
          done: event.done,
          ...(event.done
            ? { thoughtMs: (prev?.kind === 'reasoning' && prev.thoughtMs) || event.ts - startTs }
            : {}),
        });
        break;
      }
      case 'reasoning_delta': {
        // A chunk arriving on a SETTLED node is the start of a new block, not an
        // amendment to a finished one — it forks exactly like a fresh `reasoning` event
        // (see `openReasoning`), so a dropped/late settle can never splice two separate
        // thoughts into one accordion.
        const nodeId = openReasoning(event.parentId, false);
        const prev = byId.get(nodeId);
        // A delta with no reasoning node yet starts one (mirrors assistant_delta).
        const base: ReasoningNode =
          prev?.kind === 'reasoning'
            ? prev
            : {
                kind: 'reasoning',
                id: nodeId,
                ts: event.ts,
                turnId: event.turnId,
                summaries: [],
                done: false,
              };
        const summaries =
          base.summaries.length === 0
            ? [event.chunk]
            : [
                ...base.summaries.slice(0, -1),
                base.summaries[base.summaries.length - 1] + event.chunk,
              ];
        upsert({ ...base, summaries, done: false });
        break;
      }
      case 'plan':
        upsert({
          kind: 'plan',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          steps: event.steps,
        });
        break;
      case 'tool_call': {
        const prev = byId.get(event.id);
        const result = prev?.kind === 'tool' ? prev.result : undefined;
        // Keep the RUNNING event's ts across status transitions so the live
        // elapsed timer (U4) measures from when the call actually started.
        const startTs = prev?.kind === 'tool' ? prev.ts : event.ts;
        const argsSummary =
          event.argsSummary ?? (prev?.kind === 'tool' ? prev.argsSummary : undefined);
        upsert({
          kind: 'tool',
          id: event.id,
          ts: startTs,
          turnId: event.turnId,
          toolName: event.toolName,
          status: event.status,
          ...(event.runtimeMs !== undefined ? { runtimeMs: event.runtimeMs } : {}),
          ...(event.title !== undefined ? { title: event.title } : {}),
          ...(argsSummary !== undefined ? { argsSummary } : {}),
          ...(result !== undefined ? { result } : {}),
        });
        break;
      }
      case 'tool_result': {
        const prev = byId.get(event.toolCallId);
        if (prev?.kind === 'tool') {
          upsert({ ...prev, result: event });
        }
        // A result with no matching tool call is ignored (the call must come first).
        break;
      }
      case 'ask': {
        // Same contract as `tool_result`: the question hangs off the call it belongs to,
        // so one node carries the whole exchange (asked → answered) and an orphan
        // question — one whose call never arrived — is ignored rather than rendered
        // as a prompt nobody could answer.
        const prev = byId.get(event.toolCallId);
        if (prev?.kind === 'tool') {
          upsert({ ...prev, ask: event });
        }
        break;
      }
      case 'timeline_action':
        upsert({
          kind: 'timeline_action',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          action: event.action,
          detail: event.detail,
          ...(event.refs !== undefined ? { refs: event.refs } : {}),
        });
        break;
      case 'diff':
        // A proposed edit with zero operations has nothing to review — a plan-only
        // turn, a chat reply, or a run whose tool calls all failed/were rejected.
        // Rendering it as a "Proposed edit · 0 operations" card (with Accept/Reject)
        // is misleading and inflates the batch "Apply all N" count, so we drop it
        // from the view. The event itself is still emitted (SDK contract) for
        // programmatic consumers; only the reviewable node is suppressed.
        if (event.edit.patch.operations.length > 0) {
          upsert({
            kind: 'diff',
            id: event.id,
            ts: event.ts,
            turnId: event.turnId,
            edit: event.edit,
            ...(event.variants ? { variants: event.variants } : {}),
            ...(event.scope !== undefined ? { scope: event.scope } : {}),
            ...(event.turnIndex !== undefined ? { turnIndex: event.turnIndex } : {}),
            ...(event.runId !== undefined ? { runId: event.runId } : {}),
            ...(event.commit !== undefined ? { commit: event.commit } : {}),
            ...(event.verification !== undefined ? { verification: event.verification } : {}),
            ...(event.planStepId !== undefined ? { planStepId: event.planStepId } : {}),
          });
        }
        break;
      case 'review_finding':
        upsert({
          kind: 'review_finding',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          turnIndex: event.turnIndex,
          detail: event.detail,
          resolved: event.resolved,
          ...(event.planStepId !== undefined ? { planStepId: event.planStepId } : {}),
          ...(event.atSeconds !== undefined ? { atSeconds: event.atSeconds } : {}),
          ...(event.lineage !== undefined ? { lineage: event.lineage } : {}),
        });
        break;
      case 'progress':
        upsert({
          kind: 'progress',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          label: event.label,
          value: clamp01(event.value),
        });
        break;
      case 'reference':
        upsert({
          kind: 'reference',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          refs: event.refs,
        });
        break;
      case 'notification':
        upsert({
          kind: 'notice',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          level: 'info',
          text: event.text,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
        break;
      case 'warning':
        upsert({
          kind: 'notice',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          level: 'warning',
          text: event.text,
        });
        break;
      case 'error':
        upsert({
          kind: 'notice',
          id: event.id,
          ts: event.ts,
          turnId: event.turnId,
          level: 'error',
          text: event.message,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
        });
        break;
      case 'status':
        status = event.status;
        // A run that finishes successfully supersedes any pending resume checkpoint.
        if (event.status === 'completed') checkpoint = undefined;
        break;
      case 'checkpoint':
        // Not a visible node — it drives the Resume affordance via the view.
        checkpoint = event;
        break;
      case 'run_state':
        // Not a visible transcript node; it drives durability and diagnostics.
        runState = event;
        break;
      case 'task_started': {
        // Keep the earliest ts (and any progress already seen) so a running task's
        // elapsed time measures from when it actually started.
        const prev = tasksById.get(event.taskId);
        upsertTask({
          taskId: event.taskId,
          ts: prev?.ts ?? event.ts,
          turnId: event.turnId,
          label: event.label,
          status: 'running',
          ...(event.resourceClass !== undefined ? { resourceClass: event.resourceClass } : {}),
          ...(prev?.progress !== undefined ? { progress: prev.progress } : {}),
        });
        break;
      }
      case 'task_finished': {
        const prev = tasksById.get(event.taskId);
        // Derive runtime from the recorded start when the event doesn't carry it.
        const runtimeMs = event.runtimeMs ?? (prev ? event.ts - prev.ts : undefined);
        upsertTask({
          taskId: event.taskId,
          ts: prev?.ts ?? event.ts,
          turnId: event.turnId,
          label: prev?.label ?? event.taskId,
          status: event.status,
          ...(prev?.resourceClass !== undefined ? { resourceClass: prev.resourceClass } : {}),
          ...(runtimeMs !== undefined ? { runtimeMs } : {}),
          ...(prev?.progress !== undefined ? { progress: prev.progress } : {}),
        });
        break;
      }
      case 'effect_progress': {
        const prev = tasksById.get(event.taskId);
        // A progress for an unknown task is ignored (its task_started must come
        // first — same rule as tool_result vs tool_call).
        if (prev) upsertTask({ ...prev, progress: clamp01(event.value) });
        break;
      }
      case 'usage':
      case 'context_usage':
        // Telemetry events stay in the append-only log for host-level indicators;
        // they do not create transcript rows.
        break;
    }
  };

  return {
    push,
    view: () => {
      const nodes = settleStaleReasoning(
        order.map((id) => byId.get(id) as ViewNode),
        isTerminalStatus(status),
      );
      return {
        nodes,
        status,
        ...(checkpoint ? { checkpoint } : {}),
        ...(runState ? { runState } : {}),
        ...(taskOrder.length
          ? { tasks: taskOrder.map((id) => tasksById.get(id) as TaskView) }
          : {}),
      };
    },
  };
}

/**
 * Fold an append-only {@link AiEvent} log into a render-ready {@link ConversationView}.
 *
 * Merge rules (the "update in place by id" contract):
 * - `assistant_delta` appends `chunk` to the assistant node keyed by `parentId`,
 *   creating a streaming node if none exists yet.
 * - `assistant_message` finalizes that node (canonical text, `streaming: false`).
 * - `reasoning_delta` appends `chunk` to the LAST summary line of the reasoning
 *   node keyed by `parentId` (a canonical `reasoning` event always precedes it).
 * - `tool_result` attaches to the {@link ToolNode} keyed by `toolCallId`.
 * - `status` updates the view-level status only (it is not a visible node).
 * - every other event maps to one node keyed by its own id; re-emitting the same
 *   id replaces that node (tool-status transitions, plan/reasoning/progress updates).
 *
 * Pure and deterministic: same log → same view. Streaming consumers should prefer
 * {@link createConversationViewBuilder} to avoid re-folding the log per event.
 *
 * @param events - The conversation's append-only event log, in order.
 * @returns The ordered nodes plus the latest run status.
 */
export function reduceEvents(events: readonly AiEvent[]): ConversationView {
  const builder = createConversationViewBuilder();
  for (const event of events) builder.push(event);
  return builder.view();
}

// ---------------------------------------------------------------------------
// Turn emitter — deterministic event construction for one user turn
// ---------------------------------------------------------------------------

/** Identifies the conversation/turn an emitter stamps onto every event. */
export interface TurnRef {
  readonly conversationId: string;
  readonly turnId: string;
  /** Clock for `ts` (injectable for deterministic tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Detail attached to a {@link ToolResultEvent} (everything but the base/ids). */
export type ToolResultDetail = Omit<
  ToolResultEvent,
  'id' | 'conversationId' | 'ts' | 'turnId' | 'type' | 'toolCallId'
>;

/**
 * Builds the events of one user turn with stable, in-place-mergeable ids.
 *
 * - The assistant message uses a fixed per-turn id ({@link TurnEmitter.assistantId})
 *   so its deltas and terminal message merge in the reducer.
 * - `reasoning`/`plan`/`progress` use fixed ids (per turn, per progress label) so
 *   repeated emissions update in place rather than appending duplicates.
 * - `toolCall`/`toolResult` are keyed by the provider's tool-call id so a result
 *   attaches to its call and status transitions mutate the same card.
 * - one-off events (status/delta/timeline-action/diff/reference/notice) get a
 *   monotonic per-turn sequence id.
 */
export interface TurnEmitter {
  /** The stable id of this turn's assistant message (parent of its deltas). */
  readonly assistantId: string;
  /**
   * The emitter's current monotonic sequence counter (the number stamped into the
   * LAST one-off event id, `${turnId}:kind:seq`). The Conductor driver reads this
   * after a handler streams its fine events so the next reducer fold continues the
   * SAME sequence — the run's event ids stay byte-identical to `streamAgent`'s single
   * emitter across the split control/execution boundary (K1.2 parity, §7).
   */
  seq(): number;
  status(status: RunStatus): StatusEvent;
  userMessage(text: string, attachments?: readonly MessageAttachment[]): UserMessageEvent;
  delta(parentId: string, chunk: string): AssistantDeltaEvent;
  assistant(id: string, text: string): AssistantMessageEvent;
  /**
   * A reasoning snapshot. `key` scopes the reasoning node so a run can carry MORE than
   * one thinking block: omitted ⇒ the turn's single node `${turnId}:reasoning` (chat/edit,
   * unchanged); given ⇒ a per-step node `${turnId}:reasoning:${key}` so each agent step's
   * thinking is its own accordion, interleaved in order and never overwriting the last.
   */
  reasoning(summaries: readonly string[], done: boolean, key?: string | number): ReasoningEvent;
  /**
   * A token chunk extending the current reasoning line — O(chunk) per event. `key` MUST
   * match the {@link TurnEmitter.reasoning} snapshot that opened the line so the chunk
   * lands on the right (possibly per-step) node.
   */
  reasoningDelta(chunk: string, key?: string | number): ReasoningDeltaEvent;
  plan(steps: readonly PlanStep[]): PlanEvent;
  toolCall(
    id: string,
    toolName: string,
    status: ToolStatus,
    extra?: { runtimeMs?: number; title?: string; argsSummary?: string },
  ): ToolCallEvent;
  toolResult(toolCallId: string, detail: ToolResultDetail): ToolResultEvent;
  /** The model's question to the editor; the run waits for the answer (P12). */
  ask(toolCallId: string, question: string, options?: readonly AskOption[]): AskEvent;
  timelineAction(action: string, detail: string, refs?: readonly Reference[]): TimelineActionEvent;
  /** `variants` — see {@link DiffEvent.variants} (opt-in `edit`-mode variations run, P13.1). */
  diff(
    edit: DiffEvent['edit'],
    variants?: readonly EditResult[],
    opts?: {
      scope?: DiffEvent['scope'];
      turnIndex?: number;
      runId?: string;
      planStepId?: string;
    },
  ): DiffEvent;
  /**
   * Emit/update a progress bar. `key` gives the bar a stable id so its `label` and
   * `value` can change in place across a run (one moving bar); when omitted the id is
   * keyed by `label` (a new label ⇒ a new bar), preserving the original behavior.
   */
  progress(label: string, value: number, key?: string): ProgressEvent;
  reference(refs: readonly Reference[]): ReferenceEvent;
  notification(text: string, opts?: { reason?: string; detail?: string }): NotificationEvent;
  warning(text: string): WarningEvent;
  error(message: string, opts?: { detail?: string; retryable?: boolean }): ErrorEvent;
  /** A resumable snapshot of an interrupted agent run (R3 C2). */
  checkpoint(detail: {
    goal: string;
    ops: readonly unknown[];
    log: readonly string[];
    stepsCompleted: number;
    working?: unknown;
  }): CheckpointEvent;
  /** Snapshot the canonical causal ledger without consuming the one-off event sequence. */
  runState(working: unknown): RunStateEvent;
  /** A DAG task began executing (K0.2). */
  taskStarted(taskId: string, label: string, resourceClass?: string): TaskStartedEvent;
  /** A DAG task reached a terminal status (K0.2). */
  taskFinished(
    taskId: string,
    status: TaskFinishedEvent['status'],
    runtimeMs?: number,
  ): TaskFinishedEvent;
  /** Streamed 0..1 progress for a task's long effect (K0.2). */
  effectProgress(taskId: string, label: string, value: number): EffectProgressEvent;
  /** A run's real, priced cost (P7.1) — raw numbers; the host formats them (never rendered raw by default). */
  usage(cost: { tokens: number; usd: number; modelCalls?: number }): UsageEvent;
  /** Current model call's prompt occupancy; re-emitted with exact provider usage when available. */
  contextUsage(detail: {
    usedTokens: number;
    contextWindow: number;
    estimated: boolean;
    manifest?: ContextManifest;
  }): ContextUsageEvent;
}

/**
 * Create a {@link TurnEmitter} for one conversation turn.
 *
 * `startSeq` seeds the monotonic one-off-event counter (default 0). The Conductor
 * driver passes the reducer's current {@link ConductorState.seq} so a handler's fine
 * events (deltas, tool results, actions, diff) continue the SAME id sequence the pure
 * reducer threads — keeping the split control/execution path byte-identical to
 * `streamAgent`'s single emitter (K1.2 parity, §7).
 */
export function createTurnEmitter(ref: TurnRef, startSeq = 0): TurnEmitter {
  const now = ref.now ?? Date.now;
  const assistantId = `${ref.turnId}:assistant`;
  let seq = startSeq;
  const seqId = (prefix: string): string => {
    seq += 1;
    return `${ref.turnId}:${prefix}:${seq}`;
  };
  // A reasoning node's stable id: the turn's single node when unkeyed (chat/edit), else
  // a per-step node so an agent run's thinking blocks stay distinct and ordered.
  const reasoningId = (key?: string | number): string =>
    key === undefined ? `${ref.turnId}:reasoning` : `${ref.turnId}:reasoning:${key}`;
  const base = (id: string): AiEventBase => ({
    id,
    conversationId: ref.conversationId,
    ts: now(),
    turnId: ref.turnId,
  });

  return {
    assistantId,
    seq: () => seq,
    status: (status) => ({ ...base(seqId('status')), type: 'status', status }),
    userMessage: (text, attachments) => ({
      ...base(seqId('user')),
      type: 'user_message',
      text,
      ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    }),
    delta: (parentId, chunk) => ({
      ...base(seqId('delta')),
      type: 'assistant_delta',
      parentId,
      chunk,
    }),
    assistant: (id, text) => ({ ...base(id), type: 'assistant_message', text }),
    reasoning: (summaries, done, key) => ({
      ...base(reasoningId(key)),
      type: 'reasoning',
      summaries,
      done,
    }),
    reasoningDelta: (chunk, key) => ({
      ...base(seqId('rdelta')),
      type: 'reasoning_delta',
      parentId: reasoningId(key),
      chunk,
    }),
    plan: (steps) => ({ ...base(`${ref.turnId}:plan`), type: 'plan', steps }),
    toolCall: (id, toolName, status, extra) => ({
      ...base(id),
      type: 'tool_call',
      toolName,
      status,
      ...(extra?.runtimeMs !== undefined ? { runtimeMs: extra.runtimeMs } : {}),
      ...(extra?.title !== undefined ? { title: extra.title } : {}),
      ...(extra?.argsSummary !== undefined ? { argsSummary: extra.argsSummary } : {}),
    }),
    toolResult: (toolCallId, detail) => ({
      ...base(seqId('result')),
      type: 'tool_result',
      toolCallId,
      ...detail,
    }),
    ask: (toolCallId, question, options) => ({
      ...base(seqId('ask')),
      type: 'ask',
      toolCallId,
      question,
      ...(options && options.length > 0 ? { options } : {}),
    }),
    timelineAction: (action, detail, refs) => ({
      ...base(seqId('action')),
      type: 'timeline_action',
      action,
      detail,
      ...(refs !== undefined ? { refs } : {}),
    }),
    diff: (edit, variants, opts) => ({
      ...base(seqId('diff')),
      type: 'diff',
      edit,
      ...(variants ? { variants } : {}),
      ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts?.turnIndex !== undefined ? { turnIndex: opts.turnIndex } : {}),
      ...(opts?.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts?.planStepId !== undefined ? { planStepId: opts.planStepId } : {}),
    }),
    progress: (label, value, key) => ({
      ...base(`${ref.turnId}:progress:${key ?? label}`),
      type: 'progress',
      label,
      value,
    }),
    reference: (refs) => ({ ...base(seqId('reference')), type: 'reference', refs }),
    notification: (text, opts) => ({
      ...base(seqId('notice')),
      type: 'notification',
      text,
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
    }),
    warning: (text) => ({ ...base(seqId('notice')), type: 'warning', text }),
    error: (message, opts) => ({
      ...base(seqId('notice')),
      type: 'error',
      message,
      ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
      ...(opts?.retryable !== undefined ? { retryable: opts.retryable } : {}),
    }),
    checkpoint: (detail) => ({
      ...base(`${ref.turnId}:checkpoint`),
      type: 'checkpoint',
      ...detail,
    }),
    runState: (working) => ({
      ...base(`${ref.turnId}:run-state`),
      type: 'run_state',
      working,
    }),
    taskStarted: (taskId, label, resourceClass) => ({
      ...base(`${ref.turnId}:task-start:${taskId}`),
      type: 'task_started',
      taskId,
      label,
      ...(resourceClass !== undefined ? { resourceClass } : {}),
    }),
    taskFinished: (taskId, status, runtimeMs) => ({
      ...base(`${ref.turnId}:task-end:${taskId}`),
      type: 'task_finished',
      taskId,
      status,
      ...(runtimeMs !== undefined ? { runtimeMs } : {}),
    }),
    effectProgress: (taskId, label, value) => ({
      ...base(`${ref.turnId}:effect:${taskId}`),
      type: 'effect_progress',
      taskId,
      label,
      value,
    }),
    usage: (cost) => ({
      ...base(seqId('usage')),
      type: 'usage',
      tokens: cost.tokens,
      usd: cost.usd,
      ...(cost.modelCalls !== undefined ? { modelCalls: cost.modelCalls } : {}),
    }),
    contextUsage: (detail) => ({
      ...base(`${ref.turnId}:context-usage`),
      type: 'context_usage',
      usedTokens: Math.max(0, Math.round(detail.usedTokens)),
      contextWindow: Math.max(1, Math.round(detail.contextWindow)),
      estimated: detail.estimated,
      ...(detail.manifest ? { manifest: detail.manifest } : {}),
    }),
  };
}
