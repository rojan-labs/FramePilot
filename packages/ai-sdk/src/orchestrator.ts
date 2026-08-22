/**
 * @framepilot/ai-sdk/orchestrator — AI orchestrator (PRD §8.2).
 *
 * The orchestrator is the ONLY component that turns a model's tool calls into a
 * timeline {@link Patch}. It builds context, asks the provider for tool calls,
 * validates each call's args against the tool's schema, runs the tool handler to
 * get typed {@link Operation}s, assembles a reviewable patch, validates it
 * (PRD §8.5), and computes a before/after diff. The model never produces a raw
 * mutation — this is where AGENTS.md invariant 5 is enforced.
 *
 * Modes implemented here: chat, plan, edit, autocomplete (plan/PLAN.md §4.2) and —
 * Phase 7 — the multi-step `agent` loop and the `review` critic pass.
 */
import { type AnyOperation, applyProjectPatch } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import {
  TranscriptWordSchema,
  type Asset,
  type CaptionStyle,
  type Clip,
  type Folder,
  type Project,
  type Track,
} from '@framepilot/timeline-schema';
import type { AgentOptions, AgentRun, AgentStep, ReviewResult } from './agent.js';
import { checkableAcceptance } from './acceptance.js';
import { type EditResult, assembleEdit } from './assemble.js';
import {
  TOOL_CONCURRENCY_ENV,
  mapBounded,
  partitionConcurrencyBatches,
  resolveToolConcurrency,
} from './concurrency.js';
import {
  type AssembledSection,
  type ContextInput,
  assembleContext,
  buildContext,
  estimateTokens,
} from './context-builder.js';
import {
  type CritiqueOptions,
  type CritiqueReport,
  critique,
  explicitDurationTargetSeconds,
  timelineDuration,
} from './critic.js';
import { describeOperation, describeToolCall } from './describe.js';
import {
  type AiEvent,
  type AskOption,
  type PlanStep,
  type RunStatus,
  type ToolStatus,
  type TurnEmitter,
  type TurnRef,
  createTurnEmitter,
  isTerminalStatus,
} from './events.js';
import {
  type CommandClassification,
  FALLBACK_CLASSIFICATION,
  buildClassifierMessages,
  parseClassification,
  projectHeaderOf,
} from './kernel/command-classifier.js';
import type { Command } from './kernel/commands.js';
import type {
  AgentTurnResult,
  AwaitApprovalEffect,
  ConductorResult,
  ConductorState,
  DescribedAction,
  DraftPlanEffect,
  FinalizeEffect,
  ResumeEffect,
  RunTurnEffect,
  RunVerifyEffect,
} from './kernel/conductor.js';
import {
  DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
  DIMINISHING_RETURNS_TURNS,
  PLAN_STEP_HEADROOM,
  STALL_CONFIRM_TURNS,
  type TurnCallFact,
  turnLearnedSomethingNew,
} from './kernel/conductor.js';
import { type AnalysisBudget, createAnalysisBudget } from './kernel/cost/analysis-caps.js';
import { estimateUsd } from './kernel/cost/cost-meter.js';
import { stageAllowsRole, toolRole } from './kernel/stage-policy.js';
import { buildStateBriefing, distil } from './kernel/briefing.js';
import { createNarrationFilter } from './kernel/narration.js';
import { alignBeatBackedBoundaries } from './kernel/beat-grid/beat-alignment.js';
import { beatGridFor } from './kernel/semantic-index/semantic-index.js';
import { describeUnrecovered, ensureContextInvariants } from './kernel/context/invariants.js';
import { EvidenceStore, evidenceScopeFor } from './kernel/evidence-store.js';
import type { RunStage, RunWorkingState } from './kernel/working-state.js';
import { type ConductorHandlers, runAgentGraph } from './kernel/agent-graph.js';
import {
  type EffectRuntime,
  type EffectRuntimeObserver,
  type StructuredEffectExecutor,
  createEffectRuntime,
} from './kernel/effect-runtime.js';
import { EditorRunLifecycleProjector } from './kernel/editor-run-projection.js';
import type { EditorRunStageEvent } from './kernel/editor-run-lifecycle.js';
import { type ModelTier } from './kernel/proposers/types.js';
import { type RunRecording, createRecordingEffectRuntime } from './kernel/replay/replay.js';
import type { TemporalEvidenceAcquirer } from './temporal-evidence-client.js';
import {
  planTemporalEvidenceForEdit,
  reviewTemporalEvidence,
  type TemporalReviewReport,
} from './temporal-review.js';
import type { ProjectVisionFrameAcquirer } from './vision-evidence-client.js';
import { planVisionObjectivesForEdit } from './vision-objective-planner.js';
import {
  reviewVisionObjectives,
  type VisionJudge,
  type VisionMediaEgressConsent,
  type VisionReviewerIdentity,
} from './vision-review.js';
import { type ProjectNames, projectNames } from './names.js';
import {
  AGENT_PLAN_DRAFT_INSTRUCTION,
  PLAN_MODE_INSTRUCTION,
  questionModeInstruction,
  agentActionsBlock,
  framesBlock,
  agentActionRecoveryBlock,
  agentModeInstruction,
  agentPlanBlock,
  agentSkillsBlock,
  agentSteeringBlock,
  repairPassInstruction,
} from './prompts.js';
import type {
  AiCompletionRequest,
  AiImage,
  AiMessage,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ToolCall,
} from './providers/types.js';
import {
  capabilitiesFor,
  supportsVision,
  type CapabilitySource,
} from './providers/model-capabilities.js';
import {
  type ContextManifest,
  type DurableMemoryStatus,
  buildRequestManifest,
  memoryStatusFrom,
  withProviderUsage,
} from './kernel/context/manifest.js';
import { ProviderError } from './reliability/types.js';
import type { ContextTier, Usage } from './reliability/types.js';
import type { AgentRunControls, AskUser, AskUserOption } from './run-controls.js';
import { createSteeringQueue } from './run-controls.js';
import { combineSignals } from './reliability/signals.js';
import {
  REVIEW_CONCURRENCY_ENV,
  REVIEW_STEERING_PREAMBLE,
  ReviewFindingQueue,
  resolveReviewConcurrency,
  touchedRegionOf,
  type ReviewFinding,
  type ReviewFindingScope,
  type TouchedRegion,
} from './review-findings.js';
import { BUNDLED_SKILLS, skillsByName } from './skills.js';
import { MAX_IDENTITY_KEY_CHARS, boundedKeySegment } from './stable-key.js';
import type { ToolContext } from './tool-context.js';
import {
  ToolInvocationError,
  describeArgValidationError,
  operationsForCall,
  sanitizeToolArgs,
} from './tool-dispatch.js';
import { type HostToolExecutor, type HostToolOutcome } from './tool-executor.js';
import { withToolInputContract } from './tool-input-contract.js';
import { concurrencySafe, getTool, toolDescriptors } from './tool-registry.js';
import { IMPLICIT_ONLY_TOOL_NAMES, QUESTION_ROUTE_PERMISSIONS, selectTools } from './tool-scope.js';
import { type WipeGuardContext, detectTimelineWipe, wipeGuardFor } from './wipe-guard.js';

export type { EditResult } from './assemble.js';

/**
 * Fixed number of candidate takes an opt-in `edit`-mode **variations** run proposes
 * (H1.5 / AGENT-NATIVE-COMPLETION-PLAN.md P13.1 — "variations / A-B compare"). Deliberately
 * a small constant, not a user-tunable dial: each extra candidate is one more REAL,
 * separately billed model call, and the cost-honesty invariant (lens §2.5.6, P7.1/P7.2)
 * means that cost must always be shown, never hidden behind a bigger "give me more options"
 * knob.
 */
export const EDIT_VARIATION_COUNT = 2;

/**
 * Per-candidate sampling `temperature` (reuses the knob every {@link AiProvider} already
 * accepts — see providers/types.ts's `AiCompletionRequest.temperature` — no new sampling
 * machinery). Candidate 0 stays at the provider's own default (`undefined`) so it matches
 * exactly what a plain, non-variations `edit()`/`streamEdit()` call already produces;
 * candidate 1 explores a higher-temperature alternative take. Kept in lockstep with
 * {@link EDIT_VARIATION_COUNT} (one entry per candidate).
 */
const VARIATION_TEMPERATURES: readonly (number | undefined)[] = [undefined, 0.9];

/**
 * The `ModelTier` an `edit`-mode call is priced at for the variations run's combined-cost
 * accounting. `edit()`/`streamEdit()` do not run through the tier-routed effect runtime (that
 * machinery is for the recipe/planner DAG, P3.4) — they call the single injected provider
 * directly — so there is no per-call tier to read. `'mid'` mirrors `plan-driver.ts`'s
 * `DEFAULT_MODEL_TIER`, the same default an untiered EditProposer-class call already prices
 * at elsewhere in this codebase.
 */
const VARIATION_PRICING_TIER: ModelTier = 'mid';

/**
 * What one model call needs to know about its own context, beyond the payload.
 *
 * `tier` and `contextWindow` were the whole of it; the rest is what the context manifest
 * (ADR 0080) needs so the composer can explain a change in occupancy instead of just
 * showing a number that moved. Every added field is optional — a caller that supplies
 * none still gets a manifest derived from the payload, only coarser.
 */
export interface ModelCallContext {
  readonly tier: ModelTier;
  readonly contextWindow: number;
  /** Whether `contextWindow` is the model's real window or the provider's floor. */
  readonly windowSource?: CapabilitySource;
  /** Tokens held back for the reply; defaults to the selected model's output cap. */
  readonly reservedOutputTokens?: number;
  /**
   * The tier account from `assembleContext`. The ONLY way a dropped section reaches the
   * manifest — a trimmed tier leaves no trace in the payload, so a payload-derived
   * manifest cannot know compaction happened.
   */
  readonly assembled?: {
    readonly sections: readonly AssembledSection[];
    readonly droppedTokenEstimate: number;
  };
  /** The run's durable memory, so the UI can say what survived a shrinking prompt. */
  readonly memory?: DurableMemoryStatus;
}

/**
 * The model window for a run, shared by context assembly and UI telemetry.
 *
 * An explicit `budget` on the request wins — a caller that deliberately constrains the
 * prompt has said what it means. Otherwise the window comes from the provider and model
 * actually selected (ADR 0080), so switching model in Settings moves the capacity the
 * composer shows instead of leaving one hardcoded 190K in place for every provider.
 */
function contextWindowFor(input: ContextInput, provider?: AiProvider): number {
  if (input.budget?.contextWindow !== undefined) return input.budget.contextWindow;
  return capabilitiesFor(provider?.name, provider?.modelId).contextWindow;
}

/** The tokens held back for the model's reply — never available to the prompt. */
function reservedOutputFor(input: ContextInput, provider?: AiProvider): number {
  if (input.budget?.maxOutputTokens !== undefined) return input.budget.maxOutputTokens;
  return capabilitiesFor(provider?.name, provider?.modelId).maxOutputTokens;
}

/**
 * The cost a delegated run starts with: what the caller already spent on this turn
 * before handing off (today: {@link Orchestrator.streamAuto}'s ADR 0055 classifier call).
 *
 * `modelCalls` counts calls, not tokens, and is the reason this is a named type rather
 * than the bare `{tokens, usd}` it used to be: a provider that answers a streamed call
 * without a usage report prices to zero, and a run that is zero *because nothing was
 * called* must not be confused with one that is zero *because nobody reported*. See
 * `kernel/cost/usage-summary.ts`.
 */
export interface RunCostSeed {
  readonly tokens: number;
  readonly usd: number;
  /** Model calls already made for this turn. Absent ⇒ unknown, counted as none. */
  readonly modelCalls?: number;
}

/**
 * Convert a provider response's actually-reported usage into the run-level
 * `{tokens, usd}` pair a `usage` event carries (P7.1/P7.2 cost-honesty). Never
 * fabricated: a call that reported no usage (or wasn't made at all — `usage` is
 * `undefined`) prices to a zero cost, exactly like every other cost site in this file
 * (see {@link Orchestrator.editVariations}).
 */
function costFromUsage(
  usage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined,
  tier: ModelTier = 'mid',
): { tokens: number; usd: number } {
  if (!usage) return { tokens: 0, usd: 0 };
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return { tokens: input + output, usd: estimateUsd(tier, { input, output }) };
}

/**
 * Default cap on agent turns (safety backstop against a non-terminating model). Mirrors
 * `kernel/conductor.ts#DEFAULT_MAX_AGENT_STEPS` exactly — see that file's comment for
 * why this was raised from 8 to 30 (movie/documentary-length plans need real headroom).
 */
const DEFAULT_MAX_AGENT_STEPS = 30;

/** Blast-radius bounds for one agent run (R3 C1). Mirrors `kernel/conductor.ts`. */
const DEFAULT_MAX_OPS_PER_TURN = 100;
const DEFAULT_MAX_OPS_PER_RUN = 800;
const USER_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/** How many recent step notes the agent context keeps verbatim before digesting (B4). */
const AGENT_LOG_RECENT = 6;

/**
 * How many model turns the question route (`streamChat`) may spend on tools (E5.5)
 * before it must answer. Small on purpose: a Q&A turn reads and asks — it never edits —
 * so a handful of lookups plus one `ask_user` round-trip is the whole legitimate need.
 * The final turn is issued WITHOUT tools, so the loop always ends in a real answer.
 */
const QUESTION_ROUTE_TOOL_TURNS = 4;

/**
 * How many skill playbooks one run may pin into its context (ADR 0057).
 *
 * A pinned body rides in EVERY later turn, so this is the one place the pin costs
 * context budget (R2 B2) — the bundle allows up to {@link MAX_SKILLS} (32) skills at
 * ~3 KB each, which a model that loads indiscriminately could turn into a ~100 KB
 * per-turn prompt. Bounded the way every other budget here is: by whole records with
 * an explicit, honest refusal — never a silent mid-body cut (the exact defect this
 * ledger exists to fix). Set above the ~5 skills a real multi-discipline run loads
 * (beat sync + keyframes + grading + audio + transitions), so the cap is a backstop
 * against a spinning model, not a limit a legitimate run meets.
 */
const MAX_PINNED_SKILLS = 8;

/**
 * Tools whose successful result is EVIDENCE ABOUT WHAT IS IN THE FOOTAGE.
 *
 * `detect_scenes` is deliberately absent: it reports where hard cuts are, and on an unedited
 * single take it legitimately returns none — which says nothing about where the interesting
 * moments sit (see `withEmptyAnalysisReading`). Metadata, timings and the timeline summary are
 * not evidence about content either.
 */
const CONTENT_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'map_footage',
  'describe_footage',
  'search_visual',
  'get_frame',
  'get_mapped_transcript',
  'transcribe',
]);

/**
 * How many new picture clips a run may place on the strength of no content evidence at all
 * before its report says so.
 *
 * Not a block — the editor may well want the first thirty seconds, and refusing that would be
 * worse than saying nothing. But a montage assembled from a long recording with nothing read
 * about what is IN it is a guess, and in the captured run the guess was presented as though it
 * were grounded ("the footage map gives chapters" — no footage map was ever read). Three is
 * the point where "I trimmed this" becomes "I chose these moments".
 */
const UNEVIDENCED_SHOT_CAVEAT_THRESHOLD = 3;

/** Did this call produce real evidence about what is in the footage? */
function isContentEvidenceFact(fact: { readonly key: string; readonly status: string }): boolean {
  if (fact.status !== 'completed') return false;
  const name = fact.key.split(':')[0] ?? '';
  return CONTENT_EVIDENCE_TOOLS.has(name);
}

/**
 * How many times one agent step re-issues its model call after an UNUSABLE response.
 *
 * Two failures land after a 200 and so cannot be retried by `ResilientProvider` (which
 * replays a stream only before its first chunk): an empty completion, and a reply that stops
 * mid-clause without asking for a tool. Both are the provider dropping work, not the model
 * having nothing to say — and both used to end the run. One extra attempt is enough to ride
 * out a dropped request without turning a real dead end into a loop.
 */
const MAX_UNUSABLE_TURN_RETRIES = 1;

/**
 * Why this step's response cannot be used, or `undefined` when it can.
 *
 * - `empty` — no prose and no tool call at all. There is nothing to act on and nothing to
 *   show; the provider reported silence.
 * - `truncated` — the PROVIDER said it stopped early (`finish_reason: 'length'` /
 *   `stop_reason: 'max_tokens'`) and the reply asked for no tool, so the step ends on an
 *   unfinished sentence with nothing proposed. Only the provider's own verdict counts here:
 *   judging the prose instead would retry finished two-word answers ("all done") and still
 *   miss a fragment that happens to end on a period.
 */
export function unusableTurnReason(
  turn: { readonly text: string; readonly calls: readonly unknown[]; readonly truncated?: boolean },
  appliedOpsSoFar: number,
  stage: RunStage | undefined,
): 'empty' | 'truncated' | undefined {
  if (turn.calls.length > 0) return undefined;
  if (turn.text.trim() === '') return 'empty';
  // A truncated reply after work has landed is survivable — the run keeps the edits and the
  // reducer settles it — and a run already at verify/complete is allowed to finish on prose.
  if (appliedOpsSoFar > 0) return undefined;
  if (stage === 'verify' || stage === 'complete') return undefined;
  return turn.truncated === true ? 'truncated' : undefined;
}

// Named `orchestratorLog` (not `log`) because the agent-run closure has a local
// `log: string[]` action ledger that would otherwise shadow it.
const orchestratorLog = createLogger('ai-sdk:orchestrator');

/** Fallback chitchat reply when the classifier routes to small talk but supplies no text. */
const DEFAULT_CHITCHAT_REPLY =
  "Hi! I'm your editing copilot. Tell me what you'd like to do with your timeline — " +
  'trim silences, add captions, punch in, build an intro, or anything else.';

/**
 * Marker replacing an old, re-derivable read/analysis payload in the action log
 * (E2, plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md). The wording tells the model the
 * data is one cheap call away — and the run's read memo makes that repeat call free.
 */
export const CLEARED_RESULT_MARKER = '[old result cleared — re-read if needed]';

/** Estimated log size (tokens) above which the payload-clearing tier engages (E2.2). */
export const AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000;

/** The most recent log entries whose payloads are never cleared (E2.2's "last N turns"). */
export const AGENT_LOG_PAYLOAD_FRESH = 2;

/** Payloads shorter than this are kept — clearing them saves nothing worth a re-read. */
const MIN_CLEARABLE_PAYLOAD_CHARS = 160;

/**
 * One ` → payload` segment of a log entry, bounded by the `'; '` note joiner (or end
 * of entry). Dot-all so the multiline digests (search hits, extracted frames) clear as
 * one payload rather than leaking their tail lines.
 */
const NOTE_PAYLOAD = / → (.*?)(?=; |$)/gs;

/**
 * Clear the re-derivable payloads of ONE old log entry in place (E2.1/E2.2), keeping
 * the "what was called and whether it succeeded" prefix before each ` → `.
 *
 * The whitelist is structural: only read/analysis results carry the ` → payload` shape
 * (see `runAgentCall` — `${desc} → ${preview}` / `${summary} → ${preview}`), so
 * mutation notes (`Trimmed Intro · 0s–3.2s`), validator rejections (`Rejected "…" —`),
 * and plan/steering lines are untouched by construction. Explicitly spared on top:
 * steering entries (the editor's own words) and `ask_user` answers (`→ they
 * answered: …` — human guidance, not re-derivable data), plus any payload under
 * {@link MIN_CLEARABLE_PAYLOAD_CHARS} (clearing a one-liner buys nothing). Pure.
 */
export function clearNotePayloads(entry: string): string {
  if (entry.startsWith('Steering:')) return entry;
  return entry.replace(NOTE_PAYLOAD, (match, payload: string) => {
    if (payload.startsWith('they answered:')) return match;
    if (payload.length < MIN_CLEARABLE_PAYLOAD_CHARS) return match;
    return ` → ${CLEARED_RESULT_MARKER}`;
  });
}

/**
 * Bound the agent action log fed back each turn (R2 B4 + E2). Two tiers, cheapest
 * first:
 *
 * 1. **Micro-compaction (E2.2)** — when the estimated log size exceeds
 *    {@link AGENT_LOG_CLEAR_THRESHOLD_TOKENS}, the re-derivable read/analysis payloads
 *    of every entry except the freshest {@link AGENT_LOG_PAYLOAD_FRESH} are cleared in
 *    place (see {@link clearNotePayloads}) — the model keeps the full call history but
 *    stops paying for stale data it can re-read for free via the run memo. Token
 *    estimation is the shared chars/4 heuristic ({@link estimateTokens}, E2.3).
 * 2. **Rolling window (R2 B4)** — the last `recent` entries ride verbatim (well,
 *    post-clearing); older ones collapse into a single deterministic digest line.
 *
 * Pure.
 */
export function compactAgentLog(
  log: readonly string[],
  recent: number = AGENT_LOG_RECENT,
): string[] {
  const cleared =
    estimateTokens(log.join('\n')) > AGENT_LOG_CLEAR_THRESHOLD_TOKENS
      ? log.map((entry, i) =>
          i < log.length - AGENT_LOG_PAYLOAD_FRESH ? clearNotePayloads(entry) : entry,
        )
      : [...log];
  if (cleared.length <= recent) return cleared;
  const omitted = cleared.length - recent;
  return [
    `(… ${omitted} earlier step${omitted === 1 ? '' : 's'} summarized for brevity)`,
    ...cleared.slice(-recent),
  ];
}

/**
 * Critic checks an agent CAN plausibly fix by editing the timeline, so a repair pass
 * targets only these (R3 C3). Render-gated checks (black frames) are excluded — the
 * agent can't fix pixels without a preview render (honestly gated, not stubbed).
 */
const FIXABLE_CHECKS = new Set<string>(['duration_target', 'request_match', 'audio_clipping']);

/**
 * Parse a model's plan text into a clean list of step lines (R3 C4). Strips blank
 * lines and any leading "1." / "1)" / "- " markers; caps the count so a runaway
 * response can't bloat the ledger. Pure.
 */
export function parsePlanLines(text: string, max = 12): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, max);
}

/** A line that begins with a numbered ("1." / "1)") or bulleted ("-" / "*" / "•") marker. */
const PLAN_LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+/;

/**
 * Split a plan-draft response into its two surfaces (AGENT-NATIVE-UX U2, "clean todo"):
 * the **actionable steps** (the numbered/bulleted list → the todo ledger) and the
 * surrounding **prose** (an intro sentence, or a trailing question the agent asks →
 * a chat message). Cursor-style: the checklist holds only real steps; narration and
 * questions live in the conversation, never as fake todo rows.
 *
 * A response that uses list markers is split on them. A response with no markers at
 * all keeps the legacy behavior — every line is a step — so a plain numberless plan
 * still yields a ledger rather than vanishing into prose. Pure.
 */
export function parseAgentPlan(text: string, max = 12): { message: string; steps: string[] } {
  const steps: string[] = [];
  const prose: string[] = [];
  for (const line of text.split('\n')) {
    if (PLAN_LIST_ITEM.test(line)) {
      const step = line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim();
      if (step) steps.push(step);
    } else if (line.trim()) {
      prose.push(line.trim());
    }
  }
  // No markers → the model wrote no list; fall back to the legacy "every line is a step"
  // parse so a numberless plan still produces a ledger (behavior-preserving).
  if (steps.length === 0) return { message: '', steps: parsePlanLines(text, max) };
  return { message: prose.join('\n'), steps: steps.slice(0, max) };
}

/** AI orchestration modes (PRD §8.2). */
export type AiMode = 'chat' | 'plan' | 'edit' | 'agent' | 'autocomplete' | 'review';

/**
 * Identifies the conversation/turn a streaming run emits into, plus an optional
 * {@link AbortSignal} that interrupts it (Phase 11 M1, ADR 0033). The signal is
 * threaded to the provider so abort cancels the upstream request, not just the loop.
 */
export interface StreamOptions extends TurnRef {
  readonly signal?: AbortSignal;
  /** Logical durable run id; provider attempts keep this while `turnId` may change. */
  readonly runId?: string;
}

/** One editing route compiled behind the shared EditorRun entry point. */
export type EditorRunRequest =
  | {
      readonly route: 'edit';
      readonly variations?: boolean;
    }
  | {
      readonly route: 'agent';
      readonly agentOptions?: AgentOptions;
      readonly initialCost?: RunCostSeed;
    };

/** Live, deliberately non-serialisable controls kept outside the EditorRun request. */
export interface VisionRunReviewControls {
  readonly acquire: ProjectVisionFrameAcquirer;
  readonly judge: VisionJudge;
  readonly reviewer: VisionReviewerIdentity;
  readonly mediaEgressConsent?: VisionMediaEgressConsent;
}

export interface EditorRunControls {
  readonly agent?: AgentRunControls;
  /** Serializable lifecycle side channel for durable host projection and recovery. */
  readonly onLifecycleEvent?: (event: EditorRunStageEvent) => void;
  /** Host-owned deterministic render-evidence acquisition; absent preserves legacy behavior. */
  readonly temporalEvidence?: TemporalEvidenceAcquirer;
  /** Optional semantic gate. Requests are planned by the SDK; hosts only supply bounded IO. */
  readonly visionReview?: VisionRunReviewControls;
}

/**
 * Where {@link Orchestrator.streamAssistant} routes a run's streamed text:
 * a live assistant message (`assistant`) or nowhere (`silent`). Agent-mode turn
 * text streams into per-turn assistant *segments* (U1) — the reasoning node is
 * reserved for actual model thinking, so no sink writes to it.
 */
type StreamSink =
  | {
      readonly kind: 'assistant';
      readonly id: string;
      /**
       * Route reasoning-model chain-of-thought (`reasoning-delta` chunks) into a live
       * reasoning panel. Enabled for chat/edit (the turn's single reasoning node) AND for
       * agent steps, which pass a {@link StreamSink.reasoningKey} so each step's thinking
       * is its own interleaved accordion instead of clobbering a shared per-run node.
       */
      readonly captureReasoning?: boolean;
      /**
       * Scopes the captured reasoning to a per-step node (`${turnId}:reasoning:${key}`),
       * and opens that node EAGERLY so the step shows a "Thinking…" row from the moment it
       * starts. Omitted ⇒ the node is scoped to this call's assistant segment instead (see
       * `reasoningScope` in {@link Orchestrator.streamAssistant}) and opens lazily. Only
       * meaningful with `captureReasoning`.
       */
      readonly reasoningKey?: string | number;
    }
  | { readonly kind: 'silent' };

/**
 * Yield a provider's response as {@link ProviderChunk}s, preferring its native
 * `stream()` and falling back to draining `complete()` for providers that do not
 * implement streaming (ADR 0033) — so a non-streaming provider still works, just
 * not incrementally.
 */
async function* providerChunks(
  provider: AiProvider,
  request: AiCompletionRequest,
  signal?: AbortSignal,
): AsyncGenerator<ProviderChunk> {
  if (provider.stream) {
    yield* provider.stream(request, signal);
    return;
  }
  const response = await provider.complete(request, signal);
  if (response.reasoning) yield { type: 'reasoning-delta', text: response.reasoning };
  if (response.text) yield { type: 'text-delta', text: response.text };
  for (const call of response.toolCalls ?? []) yield { type: 'tool-call', call };
  // A `complete()`-only provider's real usage (P7.1) previously vanished here — never
  // forwarded as a chunk, so no caller draining this fallback ever saw it (C1). Mirrors
  // the streaming providers' convention (see `anthropic.ts`'s `parseAnthropicSse`): a
  // `usage` chunk immediately before the terminal `done`.
  if (response.usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
      },
    };
  }
  yield { type: 'done', text: response.text };
}

/**
 * Narrow one raw `question` gate payload entry to an {@link AskUserOption}, dropping it
 * when malformed. Extracted to its own top-level function (rather than inline in
 * {@link Orchestrator.controlEffectExecutor}) so its defensive guard — the ask_user
 * tool's Zod schema (`askOptionSchema`) requires every option to be an object with a
 * string `label` before this effect is ever dispatched — has an isolated coverage scope.
 */
/* v8 ignore start -- see the doc comment: not reachable from the schema-gated caller. */
function parseAskOption(option: unknown): AskUserOption[] {
  if (typeof option !== 'object' || !option) return [];
  const candidate = option as { label?: unknown; description?: unknown };
  if (typeof candidate.label !== 'string') return [];
  /* v8 ignore stop */
  return [
    {
      label: candidate.label,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
    },
  ];
}

/**
 * Await an external control while making runtime cancellation/timeout authoritative.
 *
 * v8 ignore reasoning for this whole function: the sole caller (controlEffectExecutor,
 * via runStructuredWithPolicy) always passes a live AbortController's signal — never
 * undefined — and the Conductor short-circuits an already-cancelled run before ever
 * dispatching the plan-approval/question effect that reaches here. So `signal` is
 * always defined and never already-aborted at the moment this function runs; the
 * `!signal` early return, the synchronous `signal.aborted` pre-check, and the
 * non-Error/non-string reason fallback are kept for a future control (or a race this
 * function is deliberately defensive against) but are not reachable from today's two
 * callers.
 */
/* v8 ignore start */
async function waitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  const abortError = (): Error =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error(typeof signal.reason === 'string' ? signal.reason : 'Effect cancelled.');
  if (signal.aborted) throw abortError();
  /* v8 ignore stop */
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      /* v8 ignore start -- both current callers (plan-approval/question gates)
         resolve their promise, never reject it; kept for a future control whose
         `pending` genuinely can. */
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
      /* v8 ignore stop */
    );
  });
}

/** Human labels for the context tiers, for the honest trim notice (R2 B2). */
const TIER_LABELS: Record<ContextTier, string> = {
  system: 'system contract',
  prompt: 'request',
  selection: 'selection detail',
  pinned: 'pinned context',
  history: 'earlier conversation',
  memory: 'project memory',
  skills: 'skills manifest',
  timeline: 'full timeline detail',
  transcript: 'transcript',
};

/**
 * Emit one {@link NotificationEvent} per tier dropped to fit the model's context
 * window — never silent (R2 B2). No-op when nothing was trimmed.
 */
function* trimNotices(
  emit: ReturnType<typeof createTurnEmitter>,
  trimmed: readonly ContextTier[],
): Generator<AiEvent> {
  for (const tier of trimmed) {
    yield emit.notification(
      `Context was large, so the ${TIER_LABELS[tier]} was trimmed to fit the model's window.`,
    );
  }
}

/**
 * Apply the beat-grid boundary rule to one turn's operations, when — and only when — this
 * run gathered beat evidence.
 *
 * ## The gate is the agent's own decision
 *
 * `detect_beats` is a tool the model elects. If it never called it, this returns the
 * operations untouched and nothing about the run changes. There is no beat-sync mode, no
 * request classifier deciding a prompt "is rhythmic", and no user-facing toggle — which is
 * exactly the property that makes this an execution guarantee rather than a hardcoded
 * technique. The model decides that the music matters; the runtime then makes sure the cuts
 * actually land on it, because that is frame arithmetic against 300 onsets and no model
 * should be doing it in its head (ADR 0076's two-timebases rule, same reasoning).
 *
 * ## Why the project grid is resolved here
 *
 * `alignBeatBackedBoundaries` can recover a grid from a proposal that places the music
 * itself, but not from music placed on an EARLIER turn — it would report the asset as
 * absent and reject a perfectly good cut. {@link beatGridFor} translates the analyzed
 * asset's onsets through the clips already on the timeline, which is the normal case once a
 * montage is under way, and the module falls back to the proposal when that comes back
 * empty.
 *
 * Returns the operations unchanged when there is no beat evidence, so a run that never
 * looked at the music pays one map lookup.
 */
function alignTurnToBeatGrid(
  working: Project,
  turnOps: AnyOperation[],
  rawBeats: unknown,
  hardSync = false,
): { ok: true; operations: AnyOperation[]; offGrid?: string } | { ok: false; error: string } {
  if (rawBeats === undefined) return { ok: true, operations: turnOps };

  const projectGrid = beatGridFor(working, rawBeats)?.times;
  const aligned = alignBeatBackedBoundaries(working, turnOps, projectGrid, rawBeats, hardSync);
  if (!aligned.ok) return aligned;
  return {
    ok: true,
    operations: [...aligned.operations],
    ...(aligned.offGrid ? { offGrid: aligned.offGrid } : {}),
  };
}

/**
 * One operation as a line an editor can read: the action, WHAT it happened to, and the
 * detail when there is one.
 *
 * The subject is the point. `describeOperation` returns an empty `detail` for anything with
 * no start/end — every caption-style op, among others — so a caller that renders
 * `${action}: ${detail}` unconditionally produced the captured run's completion report:
 *
 *     - Set track caption style:
 *     - Set track caption style:
 *     …eight times, each a dangling colon over nothing.
 *
 * Naming the track instead ("Set track caption style Caption 1") is the difference between a
 * receipt and a shrug. Shared by the tool-result note and the completion report so the two
 * cannot drift into describing the same edit differently.
 */
function operationLine(op: AnyOperation, names?: ProjectNames): string {
  const described = describeOperation(op, names);
  const ref = described.refs[0]?.label;
  const head = [described.action, ref].filter(Boolean).join(' ');
  return described.detail ? `${head} · ${described.detail}` : head;
}

/**
 * Summarize applied operations into one past-tense line for a tool-result note /
 * agent log, e.g. `Trimmed Intro.mp4 · 0s–3.2s; Added captions`. Uses `names` to
 * resolve clip/track/asset ids to friendly labels. Returns '' for no ops.
 *
 * ## Why the CALL is named when the operations cannot name it
 *
 * Several tools are higher-level intents that compile down to a shared operation.
 * `auto_emphasize_captions` — "read the transcript, pick the words that carry the meaning,
 * and accent them" — emits one `set_track_caption_style`, exactly like the plain
 * `set_track_caption_style` tool does. Described by its operation alone, both calls produce
 * the identical line:
 *
 *     Set track caption style Caption 1
 *
 * That line is not just a cosmetic mismatch with the activity card, which correctly reads
 * "Emphasising key words in the captions". It is what the RUN remembers: this note is the
 * tool result, the agent log entry, and the `ALREADY APPLIED — do not repeat` row in the
 * state briefing. In the captured run the model therefore could not tell its four styling
 * calls apart from its emphasis attempts; it read "the track style has been set multiple
 * times" turn after turn, kept re-deriving what was still outstanding, and the emphasis it
 * was actually trying to land never did.
 *
 * So when the call's own name is not among the operations it produced, the note leads with
 * what was ASKED FOR and follows with what CHANGED — the same `intent → outcome` idiom the
 * briefing's {@link distil} uses. When the tool and the operation are the same thing
 * (`trim_clip` → `trim_clip`), naming both would only restate it, and the line is unchanged.
 */
function summarizeOperations(
  ops: readonly AnyOperation[],
  names?: ProjectNames,
  call?: { readonly name: string; readonly arguments: unknown },
): string {
  const outcome = ops.map((op) => operationLine(op, names)).join('; ');
  if (!call || outcome === '') return outcome;
  if (ops.some((op) => op.type === call.name)) return outcome;
  return `${describeToolCall(call, names)} → ${outcome}`;
}

/**
 * How much of a turn signature stays readable before it is replaced by its digest.
 *
 * A signature is only ever compared for equality and embedded in an idempotency key,
 * which the run contract caps at {@link MAX_IDENTITY_KEY_CHARS} (`run-contracts.ts`'s
 * `identityKeySchema`). Serialising every argument verbatim made that cap a function of
 * how much editing one turn did: a montage turn that cut thirty clips produced a
 * multi-kilobyte key, and the whole run snapshot then failed to parse —
 * `effects.6.idempotencyKey: Too big` — taking the run down with it.
 */
const IDENTITY_PREFIX_RESERVE_CHARS = 160; // room for `${runId}:${planId}:${decisionId}:` plus the eventual digest suffix `boundedKeySegment` appends if the composite key still overflows.
const SIGNATURE_PREFIX_CHARS = MAX_IDENTITY_KEY_CHARS - IDENTITY_PREFIX_RESERVE_CHARS;

/**
 * A stable, bounded signature of a turn's tool calls (names + arguments), used to detect
 * a *spinning* agent: a turn that made no progress and repeats a signature we have
 * already seen make no progress means the model is stuck, so the run should stop.
 * A novel no-progress turn is allowed to continue (e.g. a no-op "organize" when the
 * bin is already tidy, or a first failed call the model can now retry from the
 * surfaced error).
 *
 * Long turns keep a readable head and carry a digest of the whole thing, so two turns
 * that differ only past the cut-off still compare as different.
 */
function turnSignature(calls: readonly ToolCall[]): string {
  const full = calls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join('|');
  return boundedKeySegment(full, SIGNATURE_PREFIX_CHARS);
}

/**
 * Read arguments that select a WINDOW into an otherwise fixed body of data, rather than
 * naming a different subject. Dropped from a read's {@link callNoveltyKey} — see there
 * for why — but never from its {@link callMemoKey}.
 */
const WINDOW_ARG_KEYS = new Set(['start', 'end']);

/**
 * The **memo key** for one call: what {@link HostCallContext.evidence} stores a read's
 * result under. Always the FULL arguments, because the memo serves real data back to the
 * model and a coarser key would answer `get_transcript{start:60,end:180}` with the words
 * from `{start:0,end:60}`. Correctness first: novelty accounting is allowed to be
 * approximate, cached data never is.
 */
function callMemoKey(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/**
 * The **novelty key** for one call: what the reducer uses to decide whether this call
 * could have taught the model anything it did not already have (see `TurnCallFact`).
 * Deliberately coarser than both {@link turnSignature} and {@link callMemoKey}: it
 * answers "is this a new question?", not "is this the same bytes?".
 *
 * Coarser for **analysis** tools — keyed by `name + assetId`, dropping the tuning
 * arguments. That is the precise fix for the spin the no-progress guard exists to catch:
 * `detect_beats` on the same track at sensitivity 1.5, then 3.5, then 2 is the same
 * question asked three ways, and re-analysing the same media cannot reveal something new
 * about it. Analysing a DIFFERENT asset is genuinely new, and keying on the asset keeps
 * it so.
 *
 * Coarser for **reads** in the same spirit, and for a failure seen in the wild that the
 * analysis rule alone did not cover: a run that re-read the transcript every turn at a
 * different window (`{0,60}` → `{0,120}` → `{60,180}` → …) looked novel on every turn,
 * reset the stall streak on every turn, and researched until the step cap without ever
 * editing. Window arguments ({@link WINDOW_ARG_KEYS}) therefore do not confer novelty —
 * re-reading a different slice of the same unchanged transcript is the same question,
 * exactly as re-running the same analysis at a new sensitivity is. Identity-bearing
 * arguments (`clipId`, `assetId`, `name`, …) are KEPT, so reading a different clip, asset
 * or skill stays genuinely novel.
 *
 * Note this only governs how much *runway* a repeat buys the run. The model still gets
 * correct, fresh data for the window it asked for — that is {@link callMemoKey}'s job.
 */
/**
 * The question an `ask_user` call is putting to the editor, or `undefined` when the call
 * is not an ask (or its arguments do not parse). Pure — used to emit the `ask` event
 * before the turn blocks; the authoritative validation stays in `runAgentCall`, which
 * fails the call's own card when the model malformed it.
 */
function askQuestionFor(
  call: ToolCall,
): { question: string; options?: readonly AskOption[] } | undefined {
  const tool = getTool(call.name);
  if (tool?.kind !== 'ask') return undefined;
  try {
    return tool.parse(sanitizeToolArgs(tool, call.arguments)) as {
      question: string;
      options?: readonly AskOption[];
    };
  } catch {
    return undefined;
  }
}

export function callNoveltyKey(call: ToolCall): string {
  const tool = getTool(call.name);
  if (tool?.kind === 'analysis') {
    const assetId = (call.arguments as { assetId?: unknown }).assetId;
    return `${call.name}:${typeof assetId === 'string' ? assetId : '*'}`;
  }
  if (tool?.kind === 'read') {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const identifying = Object.keys(args)
      .filter((k) => !WINDOW_ARG_KEYS.has(k))
      .sort()
      .map((k) => `${k}=${JSON.stringify(args[k])}`)
      .join(',');
    return `${call.name}:${identifying}`;
  }
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/**
 * The specific {@link RunStatus} a turn's tool calls honestly represent (C2,
 * plan/ORCHESTRATOR-GAP-CLOSURE.md): `reading` when every call is a plain data read,
 * `searching` when every call is read/analysis with at least one ffmpeg-backed
 * analysis call (detect_beats/analyze_silence/… — closer to "searching the media"
 * than a plain read), and `running_tool` for anything else — a mutating/action call,
 * a mix that includes one, or an unknown/unavailable tool name (conservative
 * default: never claims a more specific status for a call that isn't even a real,
 * resolvable tool).
 */
function statusForToolCalls(calls: readonly ToolCall[]): RunStatus {
  const kinds = calls.map((c) => getTool(c.name)?.kind);
  // A question outranks whatever else the turn is doing: the run is about to STOP and
  // wait for a person, and saying "Reading…" while it does would be a lie.
  if (kinds.includes('ask')) return 'awaiting_answer';
  if (kinds.every((k) => k === 'read')) return 'reading';
  if (kinds.every((k) => k === 'read' || k === 'analysis')) return 'searching';
  return 'running_tool';
}

export { ToolInvocationError };

/** Optional collaborators the host injects into an {@link Orchestrator}. */
export interface OrchestratorOptions {
  /**
   * Runs analysis/action tools on the host (engine sidecar). Without it such
   * calls fail honestly — the orchestrator NEVER fabricates a host result.
   */
  readonly executor?: HostToolExecutor;
  /**
   * Dev/debug affordance (P7.3, plan/AGENT-NATIVE-COMPLETION-PLAN.md): when true, every
   * effect an agent run executes is captured via
   * `createRecordingEffectRuntime` and, once the run settles, handed to
   * {@link OrchestratorOptions.onRecording} — a dev console or test can then replay it
   * with `createReplayEffectRuntime` and **zero** provider/host calls (`replay.ts`).
   * OFF by default (no cost in the common path); not a replay UI/inspector — that
   * dev panel is P7.5, explicitly out of scope here.
   */
  readonly recordEffects?: boolean;
  /** Receives the just-completed run's {@link RunRecording} when `recordEffects` is on. */
  readonly onRecording?: (recording: RunRecording) => void;
  /** Awaited durable audit observer for every fine-grained runtime effect. */
  readonly effectObserver?: EffectRuntimeObserver;
}

/** Per-call host context threaded through {@link Orchestrator.runAgentCall}. */
interface HostCallContext {
  /** The run's abort signal — Stop cancels an in-flight host tool too. */
  readonly signal?: AbortSignal;
  /** The sole execution boundary for host I/O, deduplication, and durable observation. */
  readonly effectRuntime: EffectRuntime;
  /**
   * The run's evidence store (`kernel/evidence-store.ts`): every read's full payload,
   * keyed by call and reachable by handle for the rest of the run.
   *
   * Two jobs at once, and it must do both. As a **memo**, a repeat read on unchanged
   * state is answered from here and marked non-novel, so re-reading teaches the reducer
   * nothing and costs nothing. As a **retrieval surface**, the payload stays available —
   * a hit returns the data, and `recall_evidence` can fetch more of it later. The old
   * `readCache` did only the first job while claiming the second ("this is already in
   * your context"), which is how the agent ended up with no path back to its own
   * findings.
   *
   * Invalidation is scoped to what an applied patch actually changed, not blanket —
   * see {@link EvidenceStore.invalidate}. Paths without a store simply re-execute reads,
   * which is always safe (reads are side-effect free).
   */
  readonly evidence?: EvidenceStore;
  /**
   * The run's most recent raw `detect_beats` payload, for the beat-grid boundary rule
   * (`kernel/beat-grid/beat-alignment.ts`).
   *
   * A per-run mutable box rather than a field on the Orchestrator, which serves concurrent
   * runs — exactly the threading ADR 0126 named as the missing piece. Analysis results are
   * NOT kept in the evidence store (only reads and `measure_color` are), so this is the one
   * place the payload survives the turn that fetched it.
   */
  readonly beatEvidence?: { current?: unknown; hardSync?: boolean };
  /**
   * The run's analysis budget (plan B5.4). Threaded into the host executor so a
   * capped call (frames extracted, ffmpeg seconds, transcription minutes) that
   * would exceed the per-run budget fails honestly instead of running. Non-optional:
   * every `HostCallContext` this file constructs threads the run's up-front
   * `createAnalysisBudget()` result — never a budget-less call.
   */
  readonly analysisBudget: AnalysisBudget;
  /**
   * Per-run ledger of skill playbooks already loaded (name → rendered body), which
   * {@link Orchestrator.agentMessages} pins into every subsequent turn's context.
   * A skill is therefore fetched ONCE: a repeat `load_skill` is answered by pointing
   * at the copy already in context instead of re-pasting multiple KB into the turn's
   * log note. Non-optional for the same reason as {@link analysisBudget}: every
   * `HostCallContext` this file constructs threads the run's ledger.
   */
  readonly loadedSkills: Map<string, string>;
  /**
   * Resolves the model's own questions (P12). Optional on purpose: only a surface with a
   * live editor in front of it can answer, so the non-streaming paths leave it out and
   * `ask_user` degrades honestly rather than inventing what the editor "said".
   */
  readonly askUser?: AskUser;
  /**
   * Records a durable note for later runs (see `AgentRunControls.rememberDecision`).
   * Optional and fire-and-forget: absent ⇒ nothing is recorded.
   */
  readonly rememberDecision?: (note: { readonly title: string; readonly body: string }) => void;
  /**
   * The run's timeline wipe guard (agent continuity): a delete op that would
   * clear a whole multi-clip track of pre-run work is rejected with a
   * corrective note instead of applied — the deterministic backstop for the
   * "ripple-delete everything and start over" failure loop. Optional: paths
   * that do not thread one (or a run whose user prompt asked for a reset —
   * see {@link wipeGuardFor}) simply run unguarded.
   */
  readonly wipeGuard?: WipeGuardContext;
}

/** What one tool call settled to — {@link Orchestrator.runAgentCall}'s result. */
interface AgentCallOutcome {
  ops: AnyOperation[];
  note: string;
  summary: string;
  /**
   * What this call CONCLUDED, for `distil` to record as a fact — as opposed to
   * {@link summary}, which is the short action label the tool card shows.
   *
   * They are the same string for most calls, and for an in-process read they must not
   * be: a read's `summary` is its descriptor ("Reading the timeline"), so the fact
   * `distil` built read "Reading the timeline → Reading the timeline". A run's whole
   * memory of what it had learned was a list of restatements of what it had DONE, which
   * is why a real montage run re-derived the project's shape on six consecutive turns,
   * re-read the media bin it had already read, and spent 391 seconds in one thinking
   * block. The digest that belongs there was already being computed one line away, for
   * the action log. Absent ⇒ `summary` is the conclusion too.
   */
  finding?: string;
  status: ToolStatus;
  data?: unknown;
  /** The working copy advanced by this call's validated ops (mutating calls only). */
  project?: Project;
  /** How many proposed ops the validator rejected (drives the empty-run notice). */
  rejectedOpCount?: number;
  /**
   * The run's memo served this call — no engine work ran and no new information
   * arrived. Absent ⇒ false. Feeds the reducer's productive/spinning split.
   */
  fromCache?: boolean;
  /**
   * Images this call produced (`get_frame`), to be attached to the NEXT turn's request
   * as real image content. Never enters `note` — see `HostToolOutcome.images`.
   */
  images?: readonly AiImage[];
}

/** Bound a JSON value to a short single-line preview for model-facing notes. */
function previewJson(value: unknown, max = 240): string {
  const data = JSON.stringify(value) ?? 'null';
  return data.length > max ? `${data.slice(0, max)}…` : data;
}

/**
 * Analysis-result preview cap. Wider than {@link previewJson}'s 240-char default so a
 * detect_beats/analyze_silence payload's numbers survive in the fed-back note instead
 * of being sliced off (the same class of bug as the read digest below).
 */
const ANALYSIS_PREVIEW_MAX = 1200;

/**
 * How many records (assets, folders, clips, transcript words) a read digest lists in
 * full before collapsing the tail to a count. A read exists to hand the agent REAL ids;
 * capping by RECORD COUNT (not characters) guarantees whole ids are never cut mid-token,
 * and the "N more" tail tells the model to narrow (filter) rather than invent ids.
 */
const READ_DIGEST_MAX_ITEMS = 300;

/**
 * Visual evidence is much denser than an id listing: each packet can carry a scene
 * caption plus overlapping dialogue. Keep a useful time-ordered/ranked window, then
 * drop whole packets with an explicit tail rather than cutting JSON mid-caption.
 */
const VISUAL_DIGEST_MAX_PACKETS = 24;

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;
const round2 = (n: number): string => (Math.round(n * 100) / 100).toString();
const round3 = (n: number): string => (Math.round(n * 1000) / 1000).toString();
const round4 = (n: number): string => (Math.round(n * 10_000) / 10_000).toString();

/** One line per asset: id + kind + duration + folder + filename. Ids are never elided. */
function assetLine(a: Asset): string {
  const parts = [a.id, a.kind];
  if (typeof a.durationSeconds === 'number') parts.push(`${round2(a.durationSeconds)}s`);
  if (a.folderId) parts.push(`in:${a.folderId}`);
  return `${parts.join(' ')} (${baseName(a.path)})`;
}

const folderLine = (f: Folder): string =>
  `${f.id} "${f.name}"${f.parentId ? ` under ${f.parentId}` : ''}`;

const clipLine = (c: Clip): string =>
  `${c.id} asset=${c.assetId} ${round2(c.start)}–${round2(c.end)}s`;

/**
 * One line per clip record that carries SOURCE timing — the `get_clips` row shape and the
 * `get_timeline_map` span shape, which differ only in their id field and their tail.
 *
 * Why source in/out is spelled out rather than left in the JSON: the sequence half of a
 * clip's timing reaches the model from three places (the context block's
 * `clipId[start–end s]`, `get_timeline`'s digest, this line), and the source half reached
 * it from none of them once the payload was cut. A run asked to vary where each clip
 * STARTS IN ITS ASSET was then reading the millisecond suffix of the clip id as if it were
 * a source offset — it encodes the timeline start (`deriveClipId`), so that guess is a
 * trap, and the only cure is to print the real number.
 *
 * `speed` is shown only when it is not 1x: at 1x it is noise on every row, and off 1x it
 * is the reason source and sequence spans disagree.
 */
function sourceTimedClipLine(record: Record<string, unknown>): string {
  const id = String(record.id ?? record.clipId ?? 'unknown-clip');
  const num = (value: unknown): string => (typeof value === 'number' ? round2(value) : '?');
  const speed = typeof record.speed === 'number' ? record.speed : 1;
  const rate = speed === 1 ? '' : ` ×${round2(speed)}`;
  const effects =
    typeof record.effectCount === 'number' && record.effectCount > 0
      ? ` fx=${record.effectCount}`
      : '';
  const keyframes =
    typeof record.keyframeCount === 'number' && record.keyframeCount > 0
      ? ` kf=${record.keyframeCount}`
      : '';
  return (
    `- ${id} asset=${String(record.assetId ?? '?')} track=${String(record.trackId ?? '?')} ` +
    `seq ${num(record.start)}–${num(record.end)}s ` +
    `src ${num(record.sourceStart)}–${num(record.sourceEnd)}s${rate}${effects}${keyframes}`
  );
}

/** The records of a clip-listing payload, or `undefined` when this is not one. */
function clipRecords(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] | undefined {
  const value = obj[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined;
}

/**
 * Render up to {@link READ_DIGEST_MAX_ITEMS} records, then collapse the remainder to a
 * "(… N more …)" line so a huge library/timeline stays bounded WITHOUT silently cutting
 * a partial JSON that reads as complete. `narrow` (when given) tells the model how to
 * see the omitted records instead of guessing at them.
 */
function boundedRecords<T>(
  items: readonly T[],
  render: (item: T) => string,
  noun: string,
  narrow?: string,
): string {
  if (items.length === 0) return `no ${noun}`;
  const lines = items.slice(0, READ_DIGEST_MAX_ITEMS).map(render);
  if (items.length > READ_DIGEST_MAX_ITEMS) {
    const omitted = items.length - READ_DIGEST_MAX_ITEMS;
    lines.push(`(… ${omitted} more ${noun} not shown${narrow ? `; ${narrow}` : ''})`);
  }
  return lines.join('\n');
}

/**
 * Digest a verification report: the verdict, then the issue KINDS with counts, then one
 * worked example of each.
 *
 * WHY not previewJson: `verify_captions` and `verify_transitions` had no digest arm, so
 * both fell to a 1200-escaped-character JSON slice — and because `briefing.ts#distil`
 * takes the FIRST LINE of a digest as the run's durable fact, the run's memory of its own
 * verification became `{"ok":false,"issues":[{"code":"caption_spans_cut","clipId":"cap…`,
 * cut mid-string. A run cannot act on that: it knows something failed and not what.
 *
 * Forty cues with two problems each is also sixty-eight lines of near-identical prose,
 * which is the other half of the same defect — a report nobody can read is a report
 * nobody acts on. Grouping by code answers "what is wrong here" in one line and keeps
 * one full detail per kind so the fix is still specific.
 */
function verificationDigest(obj: Record<string, unknown>, subject: string): string | undefined {
  // Absent `issues` is not "no issues" — it is a payload of a different shape, and saying
  // "verified clean" about one would be the exact dishonesty this module exists to end.
  // Undefined hands the caller back to the bounded JSON preview.
  if (!Array.isArray(obj.issues)) return undefined;
  const issues = obj.issues as Record<string, unknown>[];
  const count = typeof obj[`${subject}Count`] === 'number' ? obj[`${subject}Count`] : undefined;
  const checked =
    count === undefined ? '' : `, ${String(count)} ${subject}${count === 1 ? '' : 's'} checked`;
  if (obj.ok === true || issues.length === 0) {
    return `verified clean${checked}`;
  }
  const byCode = new Map<string, Record<string, unknown>[]>();
  for (const issue of issues) {
    const code = String(issue.code ?? 'unknown');
    byCode.set(code, [...(byCode.get(code) ?? []), issue]);
  }
  const kinds = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length);
  const head = `NOT verified${checked} — ${issues.length} issue${
    issues.length === 1 ? '' : 's'
  } of ${kinds.length} kind${kinds.length === 1 ? '' : 's'}: ${kinds
    .map(([code, group]) => `${group.length}x ${code}`)
    .join(', ')}`;
  const examples = kinds.map(([code, group]) => {
    const first = group[0] as Record<string, unknown>;
    return `${code}: ${String(first.detail ?? '')}`;
  });
  return [head, ...examples].join('\n');
}

/**
 * Digest a catalog whose IDS are the deliverable, grouped by category.
 *
 * `apply_effect` and `add_transition` refuse an id that is not in the catalog — correctly
 * — so a catalog the model cannot read whole is a catalog it cannot use, and it is right
 * to refuse to guess. This is the same defect ADR 0128 fixed for
 * `discover_caption_styles`, on the two sibling catalogs it did not reach.
 */
function catalogDigest(
  obj: Record<string, unknown>,
  key: string,
  idField: string,
  noun: string,
): string | undefined {
  if (!Array.isArray(obj[key])) return undefined;
  const entries = obj[key] as Record<string, unknown>[];
  if (entries.length === 0) return `no ${noun} match (${String(obj.matched ?? 0)} in catalog)`;
  const head = `${String(obj.returned ?? entries.length)} of ${String(
    obj.matched ?? entries.length,
  )} matching ${noun}`;
  const byCategory = new Map<string, string[]>();
  for (const entry of entries) {
    const category = String(entry.category ?? 'other');
    byCategory.set(category, [...(byCategory.get(category) ?? []), String(entry[idField])]);
  }
  return [
    head,
    ...[...byCategory.entries()].map(([category, ids]) => `${category}: ${ids.join(', ')}`),
  ].join('\n');
}

function assetsDigest(assets: readonly Asset[]): string {
  return `${assets.length} asset${assets.length === 1 ? '' : 's'}:\n${boundedRecords(
    assets,
    assetLine,
    'assets',
    'filter list_assets by kind/folderId to see the rest',
  )}`;
}

/**
 * One-line rendering of a caption track's committed style.
 *
 * WHY the digest must carry this: `timelineDigest` rendered track id/type/flags/clips and
 * nothing else, so the fact distilled from a `get_timeline` read was "5 tracks, 87 clips:
 * …". The style — the single field a "restyle the captions" request is ABOUT — lived only
 * in the raw payload, which sits in a rolling last-N-steps log window. Two turns later the
 * run had forgotten the answer it had already read and went looking for it again. A digest
 * that omits the field the request names is what turns a read into a loop.
 */
function captionStyleLine(style: CaptionStyle): string {
  const parts: string[] = [`template=${style.templateId ?? 'none'}`];
  if (style.display) parts.push(style.display);
  if (style.fontFamily) parts.push(style.fontFamily);
  const accent = style.accent;
  if (accent && accent.mode !== 'none') {
    const words = accent.keywords?.length ? ` (${accent.keywords.length} keywords)` : '';
    parts.push(`accent=${accent.mode}${words}`);
  }
  return parts.join(' · ');
}

function timelineDigest(tracks: readonly Track[]): string {
  if (tracks.length === 0) return 'timeline: no tracks';
  // Head line first, because the first line of a digest becomes the run's FACT about
  // this read (`distil`). Without it the fact was one arbitrary track's clip list.
  const clips = tracks.reduce((sum, t) => sum + t.clips.length, 0);
  // The committed caption style belongs in the HEAD, not on the per-track line below it.
  // ADR 0128 added it to this digest so the answer would survive the rolling log window —
  // but `distil` keeps only the first line, so it never reached the fact, and the run that
  // asked "use a different caption style" still had a memory that said
  // `5 tracks, 87 clips: layer_caption_4(40), …` and went looking for what it had read.
  // Only caption/overlay tracks carry a style and a project has one or two, so this costs
  // a clause, not a paragraph.
  const styled = tracks
    .filter((t) => t.captionStyle !== undefined)
    .map((t) => `${t.id} style: ${captionStyleLine(t.captionStyle as CaptionStyle)}`);
  const head = `${tracks.length} track${tracks.length === 1 ? '' : 's'}, ${clips} clip${
    clips === 1 ? '' : 's'
  }: ${tracks.map((t) => `${t.id}(${t.clips.length})`).join(', ')}${
    styled.length > 0 ? ` — ${styled.join('; ')}` : ''
  }`;
  return [head]
    .concat(
      tracks.map((t) => {
        const flags = [t.locked && 'locked', t.hidden && 'hidden', t.muted && 'muted']
          .filter(Boolean)
          .join(',');
        const style = t.captionStyle ? ` style: ${captionStyleLine(t.captionStyle)}` : '';
        const trackHead = `${t.id} [${t.type}${flags ? ` ${flags}` : ''}]${style}`;
        const body =
          t.clips.length === 0 ? 'empty' : `\n${boundedRecords(t.clips, clipLine, 'clips')}`;
        return `${trackHead}: ${body}`;
      }),
    )
    .join('\n');
}

/**
 * Model-facing digest of a READ tool's result. A read's whole purpose is to give the
 * agent the REAL ids it must reference next; the old code fed back `previewJson(value)`,
 * a blind 240-char slice of the JSON, which for anything but a tiny project dropped
 * almost every asset id. The model — having "seen" list_assets succeed but with the ids
 * cut off — then fabricated plausible sequential ids (asset_img_9723, asset_img_9724, …)
 * that the validator correctly rejected as unknown assets. This digest keeps EVERY id,
 * drops heavy fields (path→filename, media/effects/keyframes), and bounds huge lists by
 * dropping WHOLE records with an explicit "N more" line — never a silent mid-list cut.
 * The full untruncated object still reaches the UI popup via the call's `data`.
 */
/** One digest line per `search_media` hit — every id and time survives (B2.3). */
function searchHitLine(hit: Record<string, unknown>): string {
  const type = String(hit.type ?? 'hit');
  const ids = [hit.assetId, hit.markerId].filter((id): id is string => typeof id === 'string');
  const time =
    typeof hit.start === 'number'
      ? typeof hit.end === 'number' && hit.end !== hit.start
        ? ` ${hit.start}–${hit.end}s`
        : ` @${hit.start}s`
      : '';
  const placements = Array.isArray(hit.placements)
    ? hit.placements
        .map((p) => {
          const placement = (p ?? {}) as Record<string, unknown>;
          return `${String(placement.clipId)} ${String(placement.start)}–${String(placement.end)}s`;
        })
        .join(', ')
    : '';
  const snippet = typeof hit.snippet === 'string' ? ` "${hit.snippet}"` : '';
  return `- ${type}${ids.length ? ` ${ids.join(' ')}` : ''}${time}:${snippet}${
    placements ? ` → on timeline: ${placements}` : ''
  }`;
}

/** Collapse provider prose to one readable line without cutting evidence mid-thought. */
function evidenceText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/** One complete visual-evidence record: identity, asset time, rank, provenance, evidence. */
function visualPacketLine(packet: Record<string, unknown>): string {
  const assetId = typeof packet.assetId === 'string' ? packet.assetId : 'unknown-asset';
  const sceneId =
    typeof packet.sceneId === 'string' || typeof packet.sceneId === 'number'
      ? String(packet.sceneId)
      : 'unknown';
  const t0 = typeof packet.t0 === 'number' ? round2(packet.t0) : '?';
  const t1 = typeof packet.t1 === 'number' ? round2(packet.t1) : '?';
  // RRF scores are intentionally small; four decimals preserve useful ordering that
  // two-decimal display would flatten into a row of identical 0.02 values.
  const score = typeof packet.score === 'number' ? round4(packet.score) : '?';
  const sources = Array.isArray(packet.sources)
    ? packet.sources.filter((source): source is string => typeof source === 'string')
    : [];
  const caption = evidenceText(packet.caption);
  const transcript = evidenceText(packet.transcriptOverlap);
  return [
    `- asset=${assetId} scene=${sceneId} asset-time=${t0}–${t1}s rrf=${score} sources=${sources.length > 0 ? sources.join(',') : 'none'}`,
    `  visible caption: ${caption || '(none)'}`,
    `  overlapping dialogue: ${transcript || '(none)'}`,
  ].join('\n');
}

/**
 * Model-facing visual result. The generic JSON preview used to cut the packet list at
 * 1200 characters, often leaving only a low-value safety/status caption and hiding the
 * later concrete scene descriptions. This keeps whole packets and teaches the model
 * what RRF and missing/generic captions do (and do not) prove.
 */
function visualEvidenceDigest(obj: Record<string, unknown>): string {
  const packets = (Array.isArray(obj.packets) ? obj.packets : []) as Record<string, unknown>[];
  const reason = evidenceText(obj.reason);
  if (packets.length === 0) return reason ? `no visual evidence: ${reason}` : 'no visual evidence';

  const backend = typeof obj.backend === 'string' ? ` via ${obj.backend}` : '';
  const shown = packets.slice(0, VISUAL_DIGEST_MAX_PACKETS).map(visualPacketLine);
  if (packets.length > VISUAL_DIGEST_MAX_PACKETS) {
    shown.push(
      `(… ${packets.length - VISUAL_DIGEST_MAX_PACKETS} more visual packets not shown; narrow assetIds/timeRange or refine the query)`,
    );
  }
  return [
    `${packets.length} visual evidence packet${packets.length === 1 ? '' : 's'}${backend}.`,
    'rrf is fused retrieval rank, not confidence. Ground an edit in a concrete visible',
    'caption plus its asset time and sources; generic safety/status text or a missing',
    'caption is not enough evidence of what the shot shows.',
    ...shown,
  ].join('\n');
}

export function summarizeReadResult(toolName: string, value: unknown): string {
  const obj = (value ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'search_media':
    case 'find_similar': {
      // A hit's whole purpose is the ids/times the model must reference next —
      // same rationale as the list_assets digest, so nothing here is sliced away.
      // find_similar returns the same hit shape (B3.3), so one digest serves both.
      const hits = (Array.isArray(obj.hits) ? obj.hits : []) as Record<string, unknown>[];
      if (hits.length === 0) return 'no matches';
      return `${hits.length} match${hits.length === 1 ? '' : 'es'}:\n${boundedRecords(
        hits,
        searchHitLine,
        'matches',
        'refine the query or raise limit to see the rest',
      )}`;
    }
    case 'search_visual':
    case 'describe_footage':
      return visualEvidenceDigest(obj);
    case 'session_context': {
      // The sections are markdown the user effectively wrote (their rejections,
      // their reasons). previewJson would JSON-escape and mid-cut them; the
      // engine already bounded every section (B6.3), so pass them through as
      // prose. Empty sections are omitted rather than shown as noise.
      const sections: readonly (readonly [label: string, key: string])[] = [
        ['Rejected before (do not repeat)', 'corrections'],
        ['Accepted before', 'decisions'],
        ['Working style (all projects)', 'soul'],
        ['Last session', 'sessionNote'],
        ['Media bin', 'binSummary'],
      ];
      const blocks = sections
        .map(([label, key]) => [label, typeof obj[key] === 'string' ? obj[key].trim() : ''])
        .filter(([, body]) => body !== '')
        .map(([label, body]) => `${label}:\n${body}`);
      return blocks.length === 0 ? 'nothing learned about this project yet' : blocks.join('\n\n');
    }
    case 'list_assets': {
      const assets = (obj.assets ?? []) as Asset[];
      const folders = (obj.folders ?? []) as Folder[];
      const folderPart = folders.length
        ? `\n${folders.length} folder${folders.length === 1 ? '' : 's'}:\n${boundedRecords(folders, folderLine, 'folders')}`
        : '';
      return `${assetsDigest(assets)}${folderPart}`;
    }
    case 'get_project_state': {
      const project = value as Project;
      const folders = project.folders ?? [];
      const folderPart = folders.length ? ` · ${folders.length} folders` : '';
      return `${assetsDigest(project.assets ?? [])}${folderPart}\ntimeline:\n${timelineDigest(
        project.timeline?.tracks ?? [],
      )}\ntranscript: ${(project.transcript ?? []).length} words`;
    }
    case 'get_timeline': {
      const tracks = (obj.tracks ?? []) as Track[];
      return timelineDigest(tracks);
    }
    // Every read whose whole point is SOURCE timing used to land in the `default` arm
    // below, which is `previewJson` at 1200 escaped characters — about four records. A
    // 42-clip project's timeline map is ~8.8 KB, a 50-row `get_clips` page ~12 KB, so the
    // run was handed the first four rows, a bare `…`, and no way to tell how much was
    // missing. It then reasoned about the clips it could not see: this is the identical
    // defect the `detect_beats` digest below already exists to fix, on the tools that
    // answer "where in the asset does this clip start?" — the question the montage run was
    // actually asked. Bound by whole records, ids and both time pairs intact.
    case 'get_clips': {
      const clips = clipRecords(obj, 'clips');
      // Defensive: a payload without a `clips` array is not this shape.
      if (!clips) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const total = typeof obj.total === 'number' ? obj.total : clips.length;
      const more =
        obj.hasMore === true
          ? ` — more remain; raise offset to page on (total ${total})`
          : ` of ${total} total`;
      return `${clips.length} clip${clips.length === 1 ? '' : 's'}${more}:\n${boundedRecords(
        clips,
        sourceTimedClipLine,
        'clips',
        'narrow get_clips by trackId/start/end or page with offset',
      )}`;
    }
    case 'get_timeline_map':
    case 'map_time': {
      // `map_time` answers three shapes; only the no-argument one is the whole map.
      const spans = clipRecords(obj, 'spans');
      if (!spans) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const duration = typeof obj.duration === 'number' ? round2(obj.duration) : '?';
      return `timeline map, ${spans.length} clip${
        spans.length === 1 ? '' : 's'
      }, sequence duration ${duration}s, revision ${String(obj.revision ?? '?')}:\n${boundedRecords(
        spans,
        sourceTimedClipLine,
        'clips',
        'read a window with get_clips (trackId/start/end, offset/limit) instead',
      )}`;
    }
    case 'detect_beats': {
      // The beat grid is the whole deliverable — and it went through the default JSON
      // preview, which sliced a 366-beat / 13.6 KB payload at 1200 escaped chars: the
      // model saw 33 beats, covering the first 15s of a 20s track, ending mid-number.
      // It was then asked to cut to a grid it had never received. Same defect class as
      // the load_skill truncation; the fix is the same shape as the read digests — bound
      // by whole records with an explicit tail, never a blind character cut.
      const beats = (Array.isArray(obj.beats) ? obj.beats : []) as Record<string, unknown>[];
      const times = beats
        .map((b) => b?.time)
        .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
      if (times.length === 0) return 'no beats detected';
      const bpm = typeof obj.bpm === 'number' ? ` · ~${Math.round(obj.bpm)} BPM` : '';
      const first = times[0] as number;
      const last = times[times.length - 1] as number;
      // Detector onsets are observations, not a mathematically uniform tempo grid.
      // Average BPM cannot reconstruct swing, drift, syncopation, or onset jitter — and
      // those exact timestamps are the edit contract. Times-only encoding is compact
      // enough to preserve the complete result while dropping per-beat strength fields.
      const exactGrid = times.map(round3).join(', ');
      const span = `from ${round3(first)}s to ${round3(last)}s`;
      return `${times.length} exact beat onsets${bpm}, ${span}:\n${exactGrid}`;
    }
    case 'get_timeline_summary': {
      // The cheap orientation read. Through `previewJson` its per-track rows were the
      // first thing cut, which defeats the only reason to prefer it over get_timeline.
      const tracks = (Array.isArray(obj.tracks) ? obj.tracks : []) as Record<string, unknown>[];
      const duration =
        typeof obj.durationSeconds === 'number' ? `${round2(obj.durationSeconds)}s` : '?';
      const head = `sequence ${duration}, ${String(obj.trackCount ?? tracks.length)} tracks, ${String(
        obj.clipCount ?? '?',
      )} clips, ${String(obj.transcriptWordCount ?? 0)} transcript words`;
      if (tracks.length === 0) return head;
      return `${head}:\n${boundedRecords(
        tracks,
        (t) =>
          `${String(t.id)} [${String(t.type)}] ${String(t.clipCount ?? 0)} clips${
            typeof t.firstClipStart === 'number' && typeof t.lastClipEnd === 'number'
              ? ` ${round2(t.firstClipStart)}–${round2(t.lastClipEnd)}s`
              : ''
          }`,
        'tracks',
      )}`;
    }
    case 'get_clip': {
      // A single clip read for its ids and BOTH time pairs; JSON-escaped at 1200 chars a
      // caption clip's cue words alone could push its style and source range off the end.
      const clip = (obj.clip ?? {}) as Record<string, unknown>;
      if (typeof clip.id !== 'string') return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const cue = clip.captionCue as Record<string, unknown> | undefined;
      const lines = [`${sourceTimedClipLine(clip)} on ${String(obj.trackId ?? clip.trackId)}`];
      const effects = (Array.isArray(clip.effects) ? clip.effects : []) as Record<
        string,
        unknown
      >[];
      if (effects.length > 0) {
        lines.push(`effects: ${effects.map((e) => String(e.type)).join(', ')}`);
      }
      if (clip.captionStyle) {
        lines.push(`cue style override: ${captionStyleLine(clip.captionStyle as CaptionStyle)}`);
      }
      if (cue && typeof cue.text === 'string') {
        const words = Array.isArray(cue.words) ? cue.words.length : 0;
        lines.push(
          `cue (${words} words, from revision ${String(cue.derivedFromRevision ?? '?')}): ${cue.text.replace(/\n/g, ' / ')}`,
        );
      }
      return lines.join('\n');
    }
    case 'get_mapped_transcript': {
      // The words carry the SEQUENCE timings every cue is built from. previewJson gave
      // back about four of them, so a run asked to caption 81 words received five.
      const words = (Array.isArray(obj.words) ? obj.words : []) as Record<string, unknown>[];
      if (words.length === 0) return 'no mapped words — the edited timeline carries no speech';
      const dropped =
        typeof obj.droppedCount === 'number' && obj.droppedCount > 0
          ? `, ${obj.droppedCount} dropped by cuts`
          : '';
      // The RUN bounds ride in the head, because they are the segmentation contract: a cue
      // may cross any number of picture cuts and no run boundary. This line becomes the
      // run's durable fact (`briefing.ts#distil` keeps the first line), so a later turn
      // knows where it may break a cue without re-reading anything.
      const runs = (Array.isArray(obj.runs) ? obj.runs : []) as Record<string, unknown>[];
      const runPart =
        runs.length === 0
          ? ''
          : ` in ${runs.length} speech run${runs.length === 1 ? '' : 's'} (${runs
              .slice(0, 8)
              .map((r) => `${round3(Number(r.start))}–${round3(Number(r.end))}s`)
              .join(', ')}${runs.length > 8 ? ', …' : ''})`;
      const head = `${words.length} mapped words${dropped}${runPart}, revision ${String(
        obj.revision ?? '?',
      )}`;
      // Sequence times only: the source times are in the payload for anyone who recalls
      // it, but a cue is authored against the sequence and doubling the numbers here
      // halves how many words fit.
      return `${head}:\n${boundedRecords(
        words,
        (w) => `${round3(Number(w.start))}–${round3(Number(w.end))}s ${String(w.word)}`,
        'words',
        'narrow get_mapped_transcript to a window',
      )}`;
    }
    case 'discover_caption_styles': {
      // The template IDS are the whole deliverable: `set_track_caption_style` rejects an
      // id that is not in the catalog, so a truncated list is a list the run cannot use.
      // previewJson cut it mid-entry after ~18 of 51, and the style actually applied to
      // the project was past the cut — the run could neither name what it had nor pick
      // something different, and stalled without making an edit.
      const templates = (Array.isArray(obj.templates) ? obj.templates : []) as Record<
        string,
        unknown
      >[];
      const fonts = (Array.isArray(obj.fonts) ? obj.fonts : []) as Record<string, unknown>[];
      if (templates.length === 0)
        return `no caption templates match (${String(obj.matched ?? 0)} in catalog)`;
      const head = `${String(obj.returned ?? templates.length)} of ${String(
        obj.matched ?? templates.length,
      )} matching templates, ${fonts.length} bundled fonts`;
      const byCategory = new Map<string, string[]>();
      for (const t of templates) {
        const category = String(t.category ?? 'other');
        const ids = byCategory.get(category) ?? [];
        ids.push(String(t.templateId));
        byCategory.set(category, ids);
      }
      const catalog = [...byCategory.entries()].map(
        ([category, ids]) => `${category}: ${ids.join(', ')}`,
      );
      const fontList = `fonts: ${fonts.map((f) => String(f.family)).join(', ')}`;
      return [head, ...catalog, fontList].join('\n');
    }
    case 'load_skill': {
      // ADR 0057 §6: load_skill returns the FULL skill — the body IS the deliverable,
      // and the model asked for it precisely because it does not already know it. The
      // default JSON preview below truncated a ~3 KB playbook to 1200 JSON-ESCAPED
      // chars (about a third, cut mid-sentence), so the model never received the craft
      // instructions it requested; it then re-called load_skill turn after turn trying
      // to get them, burning the run's no-progress budget until the Conductor stopped
      // it with zero edits applied. Bodies are already bounded where it is correct to
      // bound them — at parse time, by MAX_SKILL_BODY_CHARS — so passing one through
      // whole is budgeted, not unbounded. Rendered as prose (not JSON) so the markdown
      // reads as the playbook it is rather than an escaped blob.
      if (typeof obj.body !== 'string') {
        // The unknown-skill shape ({ error, available }). Rendered as a sentence rather
        // than escaped JSON: its first line also becomes the run's FACT about this call
        // (`distil`), and a fact cut off mid-way through a JSON array of skill names is
        // not a conclusion the next turn can act on.
        if (typeof obj.error === 'string') {
          const available = Array.isArray(obj.available)
            ? obj.available.filter((n): n is string => typeof n === 'string')
            : [];
          return `${obj.error}${available.length > 0 ? ` Available: ${available.join(', ')}.` : ''}`;
        }
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      }
      // A string `body` means this is a parsed Skill, so `name`/`description` are
      // present by SkillSchema — no defensive branching needed for them here.
      return `${String(obj.name)} — ${String(obj.description)}\n\n${obj.body}`;
    }
    case 'verify_captions':
      return verificationDigest(obj, 'cue') ?? previewJson(value, ANALYSIS_PREVIEW_MAX);
    case 'verify_transitions':
      return verificationDigest(obj, 'transition') ?? previewJson(value, ANALYSIS_PREVIEW_MAX);
    case 'list_edit_boundaries': {
      // The cut list is what caption and transition placement is authored against: a
      // transition can only go at one of these, and a cue may not bridge one. It had no
      // digest, so a 45-cut sequence (~12.8 KB) reached the run as four escaped records
      // and a bare `…`, and its durable fact was the first 180 characters of that.
      if (!Array.isArray(value)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const boundaries = value as Record<string, unknown>[];
      if (boundaries.length === 0) return 'no cuts — the sequence is one continuous clip per track';
      return `${boundaries.length} cut${boundaries.length === 1 ? '' : 's'}:\n${boundedRecords(
        boundaries,
        (b) =>
          `${round3(Number(b.at))}s ${String(b.trackId)} ${String(b.fromClipId)} → ${String(
            b.toClipId,
          )} (max transition ${round2(Number(b.maxTransitionSeconds))}s)`,
        'cuts',
      )}`;
    }
    case 'analyze_silence': {
      // An empty `ranges` really does mean "ran and found nothing"; an ABSENT one means
      // this is not a silence response, and reporting silence about it would be a lie.
      if (!Array.isArray(obj.ranges)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const ranges = obj.ranges as Record<string, unknown>[];
      if (ranges.length === 0) {
        return typeof obj.reason === 'string' && obj.reason !== ''
          ? `no silence detected — ${obj.reason}`
          : 'no silent gaps found in the audio';
      }
      const total = ranges.reduce((sum, r) => sum + Number(r.duration ?? 0), 0);
      return `${ranges.length} silent gap${ranges.length === 1 ? '' : 's'}, ${round2(
        total,
      )}s total, in ${String(obj.assetId ?? '?')}:\n${boundedRecords(
        ranges,
        (r) =>
          `${round3(Number(r.start))}–${round3(Number(r.end))}s (${round2(Number(r.duration))}s)`,
        'gaps',
        'raise minSilenceSeconds to see only the long ones',
      )}`;
    }
    case 'detect_scenes': {
      if (!Array.isArray(obj.cuts)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const cuts = obj.cuts as Record<string, unknown>[];
      if (cuts.length === 0) return `no scene cuts detected in ${String(obj.assetId ?? '?')}`;
      return `${cuts.length} scene cut${cuts.length === 1 ? '' : 's'} in ${String(
        obj.assetId ?? '?',
      )}:\n${boundedRecords(
        cuts,
        (c) => `${round3(Number(c.time))}s`,
        'cuts',
        'raise threshold to see only the strong ones',
      )}`;
    }
    case 'discover_effects':
      return (
        catalogDigest(obj, 'effects', 'effectId', 'effects') ??
        previewJson(value, ANALYSIS_PREVIEW_MAX)
      );
    case 'discover_transitions':
      return (
        catalogDigest(obj, 'transitions', 'kind', 'transitions') ??
        previewJson(value, ANALYSIS_PREVIEW_MAX)
      );
    default:
      // Reads whose payload is a handful of scalars, or prose the model asked for
      // verbatim: a (generously) bounded JSON preview is honest for those. The set is
      // asserted explicitly in `orchestrator.test.ts` — "every read tool either has a
      // digest or is on the list of reads that do not need one" — so a new read tool
      // cannot land here by accident the way ten of them already had.
      return previewJson(value, ANALYSIS_PREVIEW_MAX);
  }
}

/** Compact `key: value` rendering of a call's args for the tool card (U4). */
function summarizeArgs(args: Record<string, unknown>, max = 80): string {
  const line = Object.entries(args)
    .map(([key, value]) => `${key}: ${previewJson(value, 24)}`)
    .join(', ');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Hand the run's applied, validated work to the user when the perceptual gate did
 * not clear it.
 *
 * Every one of these exits used to `return` with the staged diffs still in hand,
 * which destroyed them: a run that had planned, called tools, proposed, validated
 * and applied real edits ended as a bare warning and a Retry button, with no way
 * to see or keep what it had done. The gate's job is to stop an edit being
 * presented as *checked* — not to delete it.
 *
 * So the edits are released marked `unverified`, which the diff contract already
 * defines as "a human-review proposal that must never enter an auto-commit path".
 * That is the same gate the unreachable-reviewer path uses, and it is the correct
 * one here too: what differs between "could not check" and "checked, and this
 * looks wrong" is how much the user is told, not whether the work survives. The
 * caller passes the concrete finding so the warning says which it is.
 *
 * Cancellation stays fail-closed and never reaches here: the user withdrew the
 * question, so surfacing an answer to it would be wrong.
 */
/**
 * Where in the programme a finding should send the user.
 *
 * The earliest start among the clips the edit touched: a review talks about the change, and
 * the change begins there. Undefined when the edit touched no clip (a track-level mute, say)
 * — better to offer no jump than to send someone to 0:00 and let them conclude the finding
 * is about the opening.
 */
function earliestTouchedSecond(project: Project, region: TouchedRegion): number | undefined {
  let earliest: number | undefined;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (!region.clipIds.has(clip.id)) continue;
      if (earliest === undefined || clip.start < earliest) earliest = clip.start;
    }
  }
  return earliest;
}

export class Orchestrator {
  private readonly executor: HostToolExecutor | undefined;
  /** P7.3 dev/debug affordance — see {@link OrchestratorOptions.recordEffects}. */
  private readonly recordEffects: boolean;
  private readonly onRecording: ((recording: RunRecording) => void) | undefined;
  private readonly effectObserver: EffectRuntimeObserver | undefined;

  public constructor(
    private readonly provider: AiProvider,
    options: OrchestratorOptions = {},
  ) {
    this.executor = options.executor;
    this.recordEffects = options.recordEffects ?? false;
    this.onRecording = options.onRecording;
    this.effectObserver = options.effectObserver;
  }

  /**
   * Build the {@link EffectRuntime} for one run, wrapped
   * in {@link createRecordingEffectRuntime} when `recordEffects` is on (P7.3). `finish` must
   * be called once the run settles (on every terminal path) so a recording run always hands
   * its `RunRecording` to `onRecording` — plain (non-recording) runs get a no-op `finish`.
   */
  private createRunRuntime(structuredExecutor?: StructuredEffectExecutor): {
    runtime: EffectRuntime;
    finish: () => void;
  } {
    const base = createEffectRuntime({
      provider: this.provider,
      ...(this.effectObserver === undefined ? {} : { observer: this.effectObserver }),
      ...(this.executor ? { executor: this.executor } : {}),
      ...(structuredExecutor ? { structuredExecutor } : {}),
    });
    if (!this.recordEffects) return { runtime: base, finish: () => {} };
    const recorder = createRecordingEffectRuntime(base);
    let finished = false;
    return {
      runtime: recorder.runtime,
      // Every caller's normal-completion and settle-on-throw paths are mutually
      // exclusive for one run, so `finish` is never actually called twice; kept
      // idempotent defensively.
      /* v8 ignore start */
      finish: () => {
        if (finished) return;
        finished = true;
        this.onRecording?.(recorder.takeRecording());
      },
      /* v8 ignore stop */
    };
  }

  /** Adapt live browser or durable desktop controls to typed user-wait effects. */
  private controlEffectExecutor(controls: AgentRunControls): StructuredEffectExecutor | undefined {
    if (!controls.planApproval && !controls.askUser) return undefined;
    return {
      run: async (effect, signal) => {
        /* v8 ignore start -- this executor is only ever wired as the `user_wait`
           handler; render/verification/persistence effects
           have their own dedicated handling. Kept exhaustive against the wider
           StructuredRuntimeEffect union so a future effect kind routed here is a
           runtime error, not a silent no-op. */
        if (effect.kind !== 'user_wait') {
          throw new Error(`Control executor cannot run effect "${effect.kind}".`);
        }
        /* v8 ignore stop */
        if (effect.gateKind === 'plan_approval') {
          /* v8 ignore start -- the kernel only issues a plan_approval gate when
             `controls.planApproval` is wired and always with a string[] payload. */
          if (!controls.planApproval || !Array.isArray(effect.payload)) {
            throw new Error('Plan approval effect has no matching control or valid steps.');
          }
          /* v8 ignore stop */
          const steps = effect.payload.filter((step): step is string => typeof step === 'string');
          return waitWithSignal(controls.planApproval.requestApproval(steps), signal);
        }
        // Falling through both gateKind checks below (never entering either block) means
        // `effect.gateKind === 'patch_review'` — defined in the protocol (run-contracts.ts)
        // ahead of the patch-review UI that will issue it, so no caller produces it yet.
        // v8 attributes the untaken branch to the "question" block's closing brace; kept
        // exhaustive (with the terminal throw) so wiring that UI without updating this
        // executor is a runtime error, not a silent hang.
        /* v8 ignore start */
        if (effect.gateKind === 'question') {
          if (!controls.askUser || typeof effect.payload !== 'object' || !effect.payload) {
            throw new Error('Question effect has no matching control or valid payload.');
          }
          const payload = effect.payload as { question?: unknown; options?: unknown };
          if (typeof payload.question !== 'string') {
            throw new Error('Question effect requires a question.');
          }
          const options = Array.isArray(payload.options)
            ? payload.options.flatMap(parseAskOption)
            : undefined;
          return waitWithSignal(
            controls.askUser.requestAnswer(effect.gateId, payload.question, options),
            signal,
          );
        }
        throw new Error(`Unsupported user-wait gate "${effect.gateKind}".`);
        /* v8 ignore stop */
      },
    };
  }

  /** Complete one model request through the caller's run runtime. */
  private async completeModel(
    request: AiCompletionRequest,
    signal: AbortSignal | undefined,
    effectRuntime: EffectRuntime,
    tier: ModelTier = 'mid',
  ): Promise<AiResponse> {
    const result = await effectRuntime.run({ kind: 'model', request, tier }, signal);
    /* v8 ignore start -- a `{ kind: 'model' }` request always settles a `{ kind: 'model' }`
       result (see effect-runtime.ts's runModel); kept as a defensive type-narrowing guard. */
    if (result.kind !== 'model') {
      throw new Error('Model effect returned an unexpected result.');
    }
    /* v8 ignore stop */
    return result.response;
  }

  private toolContext(input: ContextInput): ToolContext {
    return {
      project: input.project,
      ...(input.projectRevision === undefined ? {} : { projectRevision: input.projectRevision }),
      ...(input.selection ? { selection: input.selection } : {}),
      ...(input.interaction ? { interaction: input.interaction } : {}),
      // ADR 0057: hand the load_skill tool its lookup map. Bundled skills are the
      // default; ContextInput.skills overrides for tests/host configuration.
      skills: skillsByName(input.skills ?? BUNDLED_SKILLS),
    };
  }

  /**
   * Agent-path input normalization (ADR 0057): default the skills manifest to the
   * SDK's bundled skills so every agent run advertises them with zero host wiring.
   * Chat/edit modes stay manifest-free unless the caller opts in via
   * {@link ContextInput.skills}.
   */
  private withSkills(input: ContextInput): ContextInput {
    return input.skills ? input : { ...input, skills: BUNDLED_SKILLS };
  }

  /**
   * Turn one mutating tool call into operations. Read/action calls return [] so
   * a model that inspects state mid-edit doesn't break the flow. Throws a
   * {@link ToolInvocationError} for unknown/unavailable tools or invalid args.
   * Delegates to the shared {@link operationsForCall} (`tool-dispatch.ts`, P3.2) —
   * the live planner path's `propose_edit` task uses the exact same logic.
   */
  private operationsFor(call: ToolCall, ctx: ToolContext): AnyOperation[] {
    return operationsForCall(call, ctx);
  }

  /** Build + validate + diff a patch from a set of operations. */
  private assemble(input: ContextInput, operations: AnyOperation[], reason: string): EditResult {
    return assembleEdit(input.project, operations, reason);
  }

  /**
   * Build the Critic options for an agent/review pass from the run input + options.
   * Shared by {@link agent}, {@link streamAgent}, and {@link review} so the self-check
   * behaves identically on every surface. `producedChanges` is omitted (not `false`)
   * when unknown so the standalone review keeps its current semantics.
   */
  private critiqueOptions(
    input: ContextInput,
    options: AgentOptions,
    producedChanges?: boolean,
  ): CritiqueOptions {
    const durationTargetSeconds =
      options.durationTargetSeconds ?? explicitDurationTargetSeconds(input.userPrompt);
    // The conditions the request stated in checkable terms (see `acceptance.ts`). The same
    // reading is recorded on the run's objective, so the criterion the ledger reports against
    // and the check that settles it can never be two different things.
    const { minShotCount, coverage } = checkableAcceptance(input.userPrompt, durationTargetSeconds);
    return {
      userPrompt: input.userPrompt,
      ...(producedChanges !== undefined ? { producedChanges } : {}),
      ...(durationTargetSeconds !== undefined ? { durationTargetSeconds } : {}),
      ...(minShotCount !== undefined ? { minShotCount } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      ...(options.targetPlatform !== undefined ? { targetPlatform: options.targetPlatform } : {}),
      ...(options.render !== undefined ? { render: options.render } : {}),
    };
  }

  /** Q&A over transcript/timeline; no mutation (PRD §7.1, §8.2). */
  public async chat(input: ContextInput): Promise<AiResponse> {
    return this.provider.complete({ messages: buildContext(input) });
  }

  /** Structured plan; no mutation, no render. */
  public async plan(input: ContextInput): Promise<AiResponse> {
    const messages = [
      ...buildContext(input),
      { role: 'user' as const, content: PLAN_MODE_INSTRUCTION },
    ];
    // A plan turn forbids tool calls, so advertising tool schemas is pure token waste
    // (~541 tok of read-tool descriptors) AND contradictory prompting that can nudge a
    // weaker model into emitting a tool call anyway. Send no tools.
    return this.provider.complete({ messages });
  }

  /** Cmd+K small reviewable edit → returns a validated, diffable patch (PRD §7.2). */
  public async edit(input: ContextInput): Promise<EditResult> {
    const response = await this.provider.complete({
      messages: buildContext(input),
      tools: toolDescriptors((t) => t.mutates),
    });
    const ctx = this.toolContext(input);
    const operations = (response.toolCalls ?? []).flatMap((call) => this.operationsFor(call, ctx));
    const reason = response.text || 'AI edit';
    return this.assemble(input, operations, reason);
  }

  /**
   * Propose {@link EDIT_VARIATION_COUNT} independent candidate takes on the SAME `edit`-mode
   * request (H1.5 / AGENT-NATIVE-COMPLETION-PLAN.md P13.1 — "variations / A-B compare").
   *
   * Each candidate is produced by its OWN real `provider.complete()` call — sampled at a
   * different `temperature`, reusing the provider abstraction's existing knob rather than
   * inventing new sampling machinery — and turned into a patch through the exact same
   * `assemble()`/`assembleEdit()` path {@link edit} uses for a single proposal (never a
   * parallel proposal pipeline). A candidate that calls no tool, or whose tool calls all
   * fail to resolve to operations, contributes no variant — a run only ever returns real,
   * reviewable candidates, never a fabricated empty one.
   *
   * Non-streaming by design (unlike {@link streamEdit}'s live token deltas): a provider's
   * `stream()` transport has no way to carry real token `usage` on its terminal chunk — only
   * `complete()`'s {@link AiResponse.usage} does (providers/types.ts) — and this method's
   * entire point is an HONEST combined cost across every candidate (never just the first),
   * so every candidate call goes through `complete()`. `cost` is `{tokens: 0, usd: 0}` when no
   * candidate's response reported real usage (e.g. every provider stays honest per P7.1 — no
   * provider ever fabricates a token count when it can't read one off its own response).
   */
  public async editVariations(
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<{
    readonly variants: readonly EditResult[];
    readonly cost: { tokens: number; usd: number };
  }> {
    const messages = buildContext(input);
    const tools = toolDescriptors((t) => t.mutates);
    const ctx = this.toolContext(input);
    const variants: EditResult[] = [];
    let tokens = 0;
    let usd = 0;
    for (const temperature of VARIATION_TEMPERATURES.slice(0, EDIT_VARIATION_COUNT)) {
      const response = await this.provider.complete(
        { messages, tools, ...(temperature !== undefined ? { temperature } : {}) },
        signal,
      );
      if (response.usage) {
        const inputTok = response.usage.inputTokens ?? 0;
        const outputTok = response.usage.outputTokens ?? 0;
        tokens += inputTok + outputTok;
        usd += estimateUsd(VARIATION_PRICING_TIER, { input: inputTok, output: outputTok });
      }
      const operations: AnyOperation[] = [];
      for (const call of response.toolCalls ?? []) {
        try {
          operations.push(...this.operationsFor(call, ctx));
        } catch {
          // A malformed call drops only THIS candidate's operations from that call — it
          // never discards the run (mirrors streamEdit's per-call recovery below).
        }
      }
      // Nothing reviewable from this candidate (no tool call, or every call rejected) —
      // contribute no variant rather than a fabricated empty diff.
      if (operations.length === 0) continue;
      variants.push(this.assemble(input, operations, response.text || 'AI edit'));
    }
    return { variants, cost: { tokens, usd } };
  }

  /** Next-best-edit suggestions: each tool call becomes its own small patch (PRD §7.5). */
  public async autocomplete(input: ContextInput): Promise<EditResult[]> {
    const response = await this.provider.complete({
      messages: buildContext(input),
      tools: toolDescriptors((t) => t.mutates),
    });
    const ctx = this.toolContext(input);
    const reason = response.text || 'Suggested edit';
    return (response.toolCalls ?? [])
      .map((call) => this.operationsFor(call, ctx))
      .filter((ops) => ops.length > 0)
      .map((ops) => this.assemble(input, ops, reason));
  }

  // -------------------------------------------------------------------------
  // Agent mode (PRD §7.4) — multi-step autonomous edit + self-check
  // -------------------------------------------------------------------------

  /**
   * The tools a turn advertises, scoped by route (E5,
   * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md).
   *
   * - `'agent'` (the default — every existing caller): the full editing surface,
   *   identical to {@link toolDescriptors}.
   * - `'question'`: the read-only Q&A surface — `read`/`analysis`/`ask` kinds only, via
   *   the K6.2 scope seam ({@link selectTools} under {@link QUESTION_ROUTE_PERMISSIONS}).
   *   A question turn cannot apply ops, so a mutating or rendering descriptor in its
   *   prompt is pure token cost plus an invitation to promise an edit it cannot make.
   *   As of E5.5 the question route (`streamChat`) really sends this surface and
   *   executes its calls — including `ask_user` (P12), which pauses on the run's
   *   AskUser gate exactly as in agent mode. Out-of-scope calls are refused there.
   * - `'action-recovery'`: a one-turn mutate/ask surface — plus `recall_evidence` —
   *   after the prior turn requested only memo-served information. This makes duplicate
   *   suppression an executable constraint rather than another ignored prompt warning.
   *   The recall exception is load-bearing: the turn's whole premise is that the run
   *   already HAS what it needs, which is false if it cannot reach it.
   *
   * `stage` narrows any of the above further (ADR 0075 §3.6). Once the run is executing
   * against a locked plan, analysis and guidance descriptors are withheld: the evidence
   * those tools would gather is already stored, so the way to check a detail is
   * `recall_evidence`. Inspection stays available, because writing a patch legitimately
   * needs the CURRENT arrangement — ids and positions the last cut may have moved.
   * Instruction alone was already tried here and lost: the contract told the model to
   * inspect once and commit, throughout a run that spent eight turns not doing that.
   *
   * The registry itself is untouched either way: the MCP surface builds straight from
   * `TOOL_REGISTRY`. Public so hosts and tests can inspect the exact advertised surface
   * per route.
   */
  /**
   * Can this run's model read an image?
   *
   * The same predicate {@link agentTools} filters `vision` descriptors with and
   * `agentModeInstruction` gates its get_frame paragraph on — exposed so context that is
   * assembled OUTSIDE the orchestrator can agree with it. `summarizeVisualStatus` is the
   * case: it advises what to reach for when content search is unavailable, and advising a
   * sightless run to look at a frame contradicts the tool list the same turn carries.
   */
  public canSeeFrames(): boolean {
    return supportsVision(this.provider.name, this.provider.modelId);
  }

  public agentTools(
    scope: 'agent' | 'question' | 'action-recovery' = 'agent',
    stage?: RunStage,
  ): ReturnType<typeof toolDescriptors> {
    const questionScope =
      scope === 'question'
        ? new Set(selectTools({ permissions: [...QUESTION_ROUTE_PERMISSIONS] }).map((t) => t.name))
        : undefined;
    // A tool whose entire output is a picture is worse than useless to a model that
    // cannot see one: the frame is billed as input tokens and the answer is a confident
    // description of an image the model never received. Withhold the descriptor entirely
    // rather than let it be called and fail (see `supportsVision`).
    const sighted = supportsVision(this.provider.name, this.provider.modelId);
    return toolDescriptors((tool) => {
      // Lifecycle work the orchestrator owns is never model-selectable. `tool-scope.ts`
      // declares this and `autonomous-tool-contract.ts` throws over it, but the filter lived
      // only in `selectTools` — so the ONE surface with a live editor in front of it offered
      // `index_media` as an ordinary call, and a model could start a paced, billable indexing
      // job inside a run whose budget assumed it could not.
      if ((IMPLICIT_ONLY_TOOL_NAMES as readonly string[]).includes(tool.name)) return false;
      if (!sighted && tool.capabilities?.includes('vision')) return false;
      // `recall_evidence` survives the recovery turn. Everything else read-shaped is
      // withheld there on purpose — the run has gathered enough and must act — but this
      // one returns what it ALREADY gathered, costs no engine work, and cannot change
      // under it. Withholding it made the turn unsurvivable: the instruction says to
      // recall rather than re-read, so the model looked for the tool, found it missing,
      // and built forty-six clips on asset durations it inferred from clip-id suffixes
      // because the media bin it had read twice was no longer reachable.
      if (scope === 'action-recovery') {
        return tool.kind === 'mutate' || tool.kind === 'ask' || tool.name === 'recall_evidence';
      }
      if (questionScope !== undefined && !questionScope.has(tool.name)) return false;
      return stage === undefined || stageAllowsRole(stage, toolRole(tool.name, tool.mutates));
    });
  }

  /**
   * Per-run memo for {@link agentStableInstruction} (E3.2,
   * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md). Keyed by the run's skill ledger —
   * a per-run object, so entries can never leak across runs — and revalidated on the
   * ledger's size (it only ever grows) plus the plan's identity (drafted once per run).
   */
  private readonly stableInstructionMemo = new WeakMap<
    ReadonlyMap<string, string>,
    { size: number; plan: readonly string[] | undefined; text: string }
  >();

  /**
   * The RUN-STABLE head of an agent turn's trailing instruction message (E3.2): the
   * agent contract + the committed plan + the pinned skill playbooks. Assembled once
   * per run (memoized on the run's skill ledger) and reused byte-identically by every
   * turn AND the repair pass, so the provider's prompt-cache prefix survives across
   * turns; it re-derives only when a skill is pinned or the plan is drafted. The
   * turn-varying suffix (steering + action log) is appended by {@link agentMessages},
   * strictly AFTER this head — never interleaved into it.
   */
  private agentStableInstruction(
    loadedSkills: ReadonlyMap<string, string>,
    plan: readonly string[] | undefined,
  ): string {
    const hit = this.stableInstructionMemo.get(loadedSkills);
    if (hit && hit.size === loadedSkills.size && hit.plan === plan) return hit.text;
    // The contract is STATIC — no escalating "you must edit now" nudge. The model decides
    // when it is ready to edit; the harness's job is to make that decision cheap and
    // honest, not to override it. Redundant reads are suppressed at the tool layer (a
    // repeat read is served from the run memo, marked non-novel), and a run that stops
    // making progress converges on its own (see the Conductor's STALL_CONFIRM_TURNS) — so
    // there is nothing left for a prompt hack to force. The vision protocol is always in
    // the contract, consistent with the tools the same run advertises (`agentTools`); a
    // run that cannot complete it fails those calls gracefully at execution time.
    const instruction = agentModeInstruction({
      canSeeFrames: supportsVision(this.provider.name, this.provider.modelId),
    });
    // ADR 0057: playbooks loaded this run are pinned (never compacted away) so the
    // model keeps the craft instructions it already paid a turn to fetch.
    const text = `${instruction}${agentPlanBlock(plan)}${agentSkillsBlock([...loadedSkills.values()])}`;
    this.stableInstructionMemo.set(loadedSkills, { size: loadedSkills.size, plan, text });
    return text;
  }

  /** Build the per-turn context: working-state context + agent instruction + action log. */
  private agentMessages(
    input: ContextInput,
    working: Project,
    log: readonly string[],
    /**
     * The run's loaded playbooks (ADR 0057), pinned into this turn. Required — and
     * ordered before the optional args for that reason: every agent path (both loops
     * and the repair pass) owns a run-scoped ledger and threads it here.
     */
    loadedSkills: ReadonlyMap<string, string>,
    plan?: readonly string[],
    steeringMessage?: string,
    actionRecovery = false,
    /**
     * The run's task memory (ADR 0075). When present, its briefing becomes the model's
     * memory of the run and the action log drops to a short prose tail; when absent
     * (the repair pass, the legacy loop) behavior is exactly as before.
     *
     * Named `taskMemory` rather than `working` because `working` already means the
     * PROJECT working copy throughout this file — two different things one turn holds
     * at once, and confusing them would be a silent, expensive bug.
     */
    taskMemory?: RunWorkingState,
    /**
     * Frames the PREVIOUS turn rendered with `get_frame`, attached to this request as
     * real image content. Only the last turn's frames — a run that inspects its work
     * several times must not re-send every picture it has ever looked at, which is how a
     * vision-capable run would silently eat its own context window.
     */
    frames?: readonly AiImage[],
  ): AiMessage[] {
    const base = buildContext({ ...input, project: working });
    // E3.2 (prompt-prefix cache stability), corrected. The head (contract + plan + pinned
    // skills) is byte-identical across a run — but it used to be emitted AFTER
    // `buildContext`'s project block, which re-renders the timeline summary from the
    // MUTATING working copy. So every applied patch changed the prefix ahead of the head
    // and re-billed all of it, up to eight pinned playbooks included. The memo below was
    // real work buying nothing.
    //
    // The head therefore now sits in its own message directly after the system + history
    // prefix, flagged `cacheBoundary` so the Anthropic provider can put a breakpoint at
    // its end. Everything genuinely turn-varying — the project snapshot, the request, the
    // briefing, steering, the action log — follows it in the final message.
    const stableHead = this.agentStableInstruction(loadedSkills, plan);
    // `buildContext` returns [system, ...history, project+request] — always at least two
    // messages, and the last is always the project block, so the split is total.
    const volatileContext = base[base.length - 1] as AiMessage;
    const stablePrefix = base.slice(0, -1);
    // Bound the fed-back log so a long run's prompt stays bounded (R2 B4); fold in mid-run
    // steering (P11.4) — a queued message the editor typed while this run was already in
    // flight, applied at THIS turn boundary (never mid-step — the message was popped from
    // the queue right before this call, in `runTurn`'s handler).
    const history = agentActionsBlock(compactAgentLog(log));
    const steeringBlock = agentSteeringBlock(steeringMessage);
    const recoveryBlock = agentActionRecoveryBlock(actionRecovery);
    // The structured briefing (ADR 0075 §3.3) is the run's MEMORY; the action log that
    // follows it is only continuity of prose. That ordering matters: the log is a rolling
    // window whose payloads age out, so anything the run must not forget has to live in
    // the briefing, which is bounded by construction rather than by truncation.
    const briefing = taskMemory ? buildStateBriefing(taskMemory) : '';
    const turnMessage: AiMessage = {
      role: 'user',
      content: `${volatileContext.content}${briefing}${steeringBlock}${recoveryBlock}\n\n${history}${framesBlock(frames)}`,
      // Deliberately on the LAST message: it is the only one that varies per turn, so an
      // image attached here can never invalidate the cached prefix above it.
      ...(frames && frames.length > 0 ? { images: frames } : {}),
    };
    return [
      ...stablePrefix,
      { role: 'user', content: stableHead, cacheBoundary: true },
      turnMessage,
    ];
  }

  /**
   * Run one tool call inside the agent loop. Unlike {@link edit}, a problem here is
   * *recovered* (logged and fed back to the model) rather than thrown, so one bad
   * call never aborts the whole run. Returns the mutating operations (possibly empty)
   * plus three human-readable views:
   * - `note`: the model-facing log line (bounded — reads carry a truncated preview so
   *   the prompt stays small, R2 B4).
   * - `summary`: the SHORT one-liner shown on the tool card in the chat.
   * - `data`: the FULL, untruncated result (a read's returned object / a failure's full
   *   reason), surfaced in the tool's "View details" popup so the user sees everything.
   *
   * A mutating call is validated HERE, against the caller's working copy — not only
   * at turn end. An invalid call fails its own card with the validator's reason (so
   * the UI never shows a checkmark for an edit that will not land) and contributes no
   * ops; a valid call returns `project`, the working copy with its ops applied, which
   * the caller threads into the next call so every call in a turn is checked against
   * the timeline as it will actually exist.
   */
  private async runAgentCall(
    call: ToolCall,
    ctx: ToolContext,
    // Non-optional: this private method has exactly 3 callers (below), all of which
    // always compute + pass real project names and a `HostCallContext` — never a
    // names-less or host-less call.
    names: ProjectNames,
    host: HostCallContext,
  ): Promise<AgentCallOutcome> {
    orchestratorLog.action('tool call', { tool: call.name, args: call.arguments });
    const registered = getTool(call.name);
    const desc = describeToolCall(call, names);
    if (!registered) {
      const note = `Refused unknown tool "${call.name}"`;
      orchestratorLog.warn('tool call refused — unknown', { tool: call.name });
      return { ops: [], note, summary: note, status: 'failed' };
    }
    if (!registered.available) {
      const note = `Skipped "${call.name}" — not available yet`;
      return { ops: [], note, summary: note, status: 'warning' };
    }
    // The mutate path (`operationsFor` → `operationsForCall`, tool-dispatch.ts) already
    // wraps every builder through `withToolInputContract`. This branch handles the
    // ask/action/analysis/read kinds directly, so it needs the same wrapping — otherwise
    // the relational/semantic assertions in tool-input-contract.ts (window ordering,
    // map_time's mutually-exclusive time domains, …) silently never run on this path,
    // even though the provider-facing schema (toolDescriptors) advertises them.
    const tool = withToolInputContract(registered);
    // P12: a question for the human. It resolves from the UI, never the engine — see
    // `ToolKind`. The caller emits the `ask` event before we block here (only the
    // event-streaming path can), so a surface without one degrades honestly below.
    if (tool.kind === 'ask') {
      const args = sanitizeToolArgs(tool, call.arguments);
      let parsed: { question: string; options?: readonly AskUserOption[] };
      try {
        parsed = tool.parse(args) as typeof parsed;
      } catch (cause) {
        const note = `Invalid arguments for "${call.name}": ${describeArgValidationError(cause)}`;
        return { ops: [], note, summary: note, status: 'failed', data: note };
      }
      if (!host.askUser) {
        // No one is listening — the non-streaming paths (the legacy loop, the repair
        // pass) have no UI to ask through. Say so plainly and tell the model to decide
        // for itself and disclose the assumption. NEVER fabricate an answer: an invented
        // "the editor said yes" is the worst possible result of asking.
        const note =
          'Could not ask the editor — this run has no way to reach them. Do not ask ' +
          'again. Use your best judgement, and say plainly in your summary what you ' +
          `assumed. (You asked: "${parsed.question}")`;
        return { ops: [], note, summary: 'No one available to answer', status: 'warning' };
      }
      const answerResult = await host.effectRuntime.run(
        {
          kind: 'user_wait',
          control: {
            effectId: call.id,
            taskId: `question:${call.id}`,
            idempotencyKey: `user_wait:question:${call.id}`,
            resourceClass: 'user',
            timeoutMs: USER_WAIT_TIMEOUT_MS,
            retryClass: 'never',
            sideEffectClass: 'idempotent',
          },
          gateKind: 'question',
          gateId: call.id,
          payload: {
            question: parsed.question,
            ...(parsed.options
              ? {
                  options: parsed.options.map((option) => ({
                    label: option.label,
                    ...(option.description ? { description: option.description } : {}),
                  })),
                }
              : {}),
          },
        },
        host.signal,
      );
      /* v8 ignore start -- a `{ kind: 'user_wait', gateKind: 'question' }` request always
         settles a matching structured outcome (see effect-runtime.ts's runStructured);
         kept as a defensive type-narrowing guard. */
      if (
        answerResult.kind !== 'structured' ||
        answerResult.effectKind !== 'user_wait' ||
        typeof answerResult.outcome !== 'object' ||
        !answerResult.outcome
      ) {
        throw new Error(`Question effect "${call.id}" returned an unexpected result.`);
      }
      /* v8 ignore stop */
      const answer = answerResult.outcome as { readonly kind?: unknown; readonly answer?: unknown };
      /* v8 ignore start -- the question gate's control executor (controlEffectExecutor)
         only ever settles `{ kind: 'cancelled' }` or `{ kind: 'answered', answer: string }`. */
      if (
        answer.kind !== 'cancelled' &&
        !(answer.kind === 'answered' && typeof answer.answer === 'string')
      ) {
        throw new Error(`Question effect "${call.id}" returned an invalid answer.`);
      }
      /* v8 ignore stop */
      if (answer.kind === 'cancelled') {
        // The editor dismissed the question instead of answering — that is a stop, and
        // `cancelled` is the status the turn loop already treats as one.
        return {
          ops: [],
          note: `The editor dismissed the question "${parsed.question}" and stopped the run.`,
          summary: 'Question dismissed',
          status: 'cancelled',
        };
      }
      /* v8 ignore start -- TS-narrowing guard only: the check above already proved
         `answer.kind === 'answered' && typeof answer.answer === 'string'` once
         `cancelled` is excluded. */
      if (typeof answer.answer !== 'string') {
        throw new Error(`Question effect "${call.id}" returned an invalid answer.`);
      }
      /* v8 ignore stop */
      const answerText = answer.answer;
      // The editor just told the run something only they knew. Record it durably, or the
      // next run asks again — or worse, proceeds on its own guess: in the captured session
      // the editor chose the vertical framing in answer to this very question, and the
      // following run rebuilt the montage with no crop at all.
      host.rememberDecision?.({
        title: `The editor answered: ${parsed.question}`,
        body: `They said: ${answerText}. Follow this on later turns unless they change it.`,
      });
      return {
        ops: [],
        // The answer IS the result: it lands in the action log, so the next turn plans
        // from what the editor actually said.
        note:
          `Asked the editor: "${parsed.question}" → they answered: ` +
          `"${answerText}". Follow this answer.`,
        summary: answerText,
        status: 'completed',
        data: { question: parsed.question, answer: answerText },
      };
    }
    if (tool.kind === 'action' || tool.kind === 'analysis') {
      // The orchestrator never runs ffmpeg (render-vs-preview rule): render/export
      // actions AND the ffmpeg-backed analysis tools execute on the host/engine
      // sidecar via the injected executor, and the loop AWAITS the real result.
      // Args are schema-validated here first so a malformed call fails fast
      // without a host round-trip.
      const args = sanitizeToolArgs(tool, call.arguments);
      try {
        tool.parse(args);
      } catch (cause) {
        const note = `Invalid arguments for "${call.name}": ${describeArgValidationError(cause)}`;
        return { ops: [], note, summary: note, status: 'failed', data: note };
      }
      const result = await host.effectRuntime.run(
        {
          kind: 'host_tool',
          call: { ...call, arguments: args as Record<string, unknown> },
          project: ctx.project,
          analysisBudget: host.analysisBudget,
        },
        host.signal,
      );
      /* v8 ignore start -- a `{ kind: 'host_tool' }` request always settles a
         `{ kind: 'host_tool' }` result (see effect-runtime.ts's runHostTool); kept as a
         defensive type-narrowing guard. */
      if (result.kind !== 'host_tool') {
        throw new Error(`Host effect "${call.name}" returned an unexpected result.`);
      }
      /* v8 ignore stop */
      const outcome: HostToolOutcome = result.outcome;
      const runtimeCached = result.cached;
      // Keep the beat grid for the rest of the run. A later re-analysis at a different
      // sensitivity replaces it: the grid the model is cutting to is the one it last saw.
      if (call.name === 'detect_beats' && outcome.status === 'completed' && host.beatEvidence) {
        host.beatEvidence.current = outcome.data;
        // The run's own editorial declaration, not an analysis parameter: whether it intends
        // every interior cut to sit exactly on an onset. Sticky for the run once set, because
        // a later re-analysis at a different sensitivity does not change the intent.
        if ((call.arguments as { hardSync?: unknown }).hardSync === true) {
          host.beatEvidence.hardSync = true;
        }
      }
      const colorEvidence =
        call.name === 'measure_color' &&
        outcome.status === 'completed' &&
        outcome.data !== undefined
          ? host.evidence?.put({
              key: callMemoKey(call),
              source: call.name,
              descriptor: desc,
              data: outcome.data,
            })
          : undefined;
      // `transcribe` is a host-backed mutation: the model supplies only asset identity,
      // the trusted executor supplies the timestamps, and the orchestrator turns those
      // validated words into the same reversible project operation as manual
      // transcription. An empty/malformed host payload never clears existing words.
      if (call.name === 'transcribe' && outcome.status === 'completed') {
        const record = (outcome.data ?? {}) as Record<string, unknown>;
        const parsedWords = TranscriptWordSchema.array().safeParse(record.words);
        if (!parsedWords.success || parsedWords.data.length === 0) {
          const note =
            'Rejected "transcribe" — the speech-to-text provider returned no valid timed words; the existing transcript was preserved.';
          return { ops: [], note, summary: note, status: 'failed', data: outcome.data };
        }
        const ops: AnyOperation[] = [{ type: 'set_transcript', words: parsedWords.data }];
        const probe = assembleEdit(ctx.project, ops, 'Transcribe media', 'agent');
        /* v8 ignore start -- set_transcript is a whole-array replace with no timeline
           references to check (see validator.ts), so a schema-valid word array can
           never fail validation; kept defensive, not reachable. */
        if (!probe.validation.valid) {
          const problems = probe.validation.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => issue.message)
            .join('; ');
          const note = `Rejected "transcribe" — ${problems}`;
          return { ops: [], note, summary: note, status: 'failed', data: problems };
        }
        /* v8 ignore stop */
        // The transcript itself was just rewritten, so transcript-derived evidence is
        // genuinely stale — the one case where source-material knowledge does not survive.
        host.evidence?.invalidate(ops.map((op) => op.type));
        return {
          ops,
          note: outcome.summary,
          summary: outcome.summary,
          status: 'completed',
          project: applyProjectPatch(ctx.project, probe.patch),
          data: outcome.data,
        };
      }
      // A cached replay reports the call itself (`desc`), not the original outcome's
      // summary text — the summary can be data-derived ("No silent ranges") and would
      // otherwise read as a freshly fabricated result rather than a served-from-cache one.
      const base = runtimeCached ? desc : outcome.summary;
      // A CACHED REPLAY RE-ATTACHES ITS PICTURE. The memo key for an image-bearing read
      // carries the timeline revision (`idempotencyKeyFor`'s `project_revision` scope), so a
      // hit is proof the timeline has not moved since the frame was rendered — the stored
      // picture IS the current one, and the "a frame is only worth looking at as the
      // timeline is now" objection cannot apply to a hit by construction.
      //
      // Dropping it was the more expensive mistake. Frames ride ONE request and are then
      // stripped from the transcript, so from the turn after a look the model has no image
      // and no way to get one: the replay told it "you were shown this, answer from what you
      // saw" about a picture that had already left its context, and said asking again was
      // futile. In the captured run that produced a confident, wrong diagnosis of the
      // framing — the model reasoned about a frame it could not see — and two turns of
      // edits chasing it. Re-attaching costs one image; being blind cost the run.
      const data = outcome.data;
      // Built from `data`, NOT `outcome.data`: this preview is what the model actually
      // reads (the payload is digested into the note), so a rewrite that skipped it would
      // fix the card and leave the model with the same false claim.
      const preview = data !== undefined ? ` → ${summarizeReadResult(call.name, data)}` : '';
      return {
        ops: [],
        note: `${base}${runtimeCached ? ' (cached)' : ''}${preview}${colorEvidence ? ` [${colorEvidence.id}]` : ''}`,
        summary: `${base}${runtimeCached ? ' (cached)' : ''}`,
        status: outcome.status,
        ...(runtimeCached ? { fromCache: true } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(outcome.images && outcome.images.length > 0 ? { images: outcome.images } : {}),
      };
    }
    if (tool.kind === 'read' && tool.read) {
      try {
        // `recall_evidence` reads the RUN's evidence store, which lives on the host
        // context rather than the ToolContext, so it is answered here instead of through
        // the registry body. This is the retrieval half of the fix: without it, a payload
        // the model has seen once is gone the moment compaction trims the log, and the
        // only way back to it is to re-run the read.
        if (call.name === 'recall_evidence') {
          const args = sanitizeToolArgs(tool, call.arguments) as {
            evidenceId: string;
            query?: string;
            offset?: number;
          };
          if (!host.evidence) {
            const note = `${desc} → this run keeps no evidence store, so nothing can be recalled; work from what your context already shows.`;
            return { ops: [], note, summary: desc, status: 'warning', data: note };
          }
          const recalled = host.evidence.recall(args.evidenceId, args.query, args.offset);
          if (recalled === undefined) {
            const known = host.evidence
              .entries()
              .map((e) => e.id)
              .join(', ');
            const note = `${desc} → no such handle "${args.evidenceId}"${
              known ? `. You have: ${known}` : ' — you have not read anything yet this run'
            }.`;
            return { ops: [], note, summary: desc, status: 'warning', data: note };
          }
          // A recall is explicitly NOT novel: it returns what the run already knew, so it
          // must never look like progress to the reducer.
          return {
            ops: [],
            note: `${desc} → ${recalled}`,
            summary: desc,
            status: 'completed',
            fromCache: true,
            data: recalled,
          };
        }
        const value = tool.read(sanitizeToolArgs(tool, call.arguments), ctx);
        // ADR 0057: a loaded playbook is PINNED into the run's context by
        // `agentMessages`, so it must NOT also ride in this turn's log note — the note
        // lives in a rolling last-N-steps window (compactAgentLog), which would both
        // duplicate several KB per turn AND silently age the body out mid-run. Record
        // it once here; answer a repeat load by pointing at the pinned copy.
        const skill = value as { name?: unknown; body?: unknown };
        if (
          call.name === 'load_skill' &&
          typeof skill.name === 'string' &&
          typeof skill.body === 'string'
        ) {
          const alreadyLoaded = host.loadedSkills.has(skill.name);
          // Budget bound (see MAX_PINNED_SKILLS): refuse the pin honestly and tell the
          // model to work with what it already has, rather than growing every later
          // turn's prompt without limit. Never a silent truncation of the body.
          if (!alreadyLoaded && host.loadedSkills.size >= MAX_PINNED_SKILLS) {
            const note = `${desc} → not loaded: you already have ${host.loadedSkills.size} playbooks in the Skills section of your context, which is the limit. Work with those and make the edit now.`;
            return { ops: [], note, summary: note, status: 'warning', data: value };
          }
          if (!alreadyLoaded) {
            host.loadedSkills.set(skill.name, summarizeReadResult(call.name, value));
          }
          return {
            ops: [],
            note: `${desc} → ${
              alreadyLoaded
                ? 'already loaded earlier this run — its playbook is already in the Skills section of your context; follow it now rather than loading it again.'
                : 'loaded — its full playbook is now in the Skills section of your context.'
            }`,
            summary: desc,
            // Naming the playbook is the whole fact: a briefing that says "Reading the
            // pacing playbook → Reading the pacing playbook" does not tell the next turn
            // which craft instructions it is already holding.
            finding: `${skill.name} playbook loaded — its instructions are pinned in your context`,
            status: 'completed',
            data: value,
          };
        }
        // Read memoization (see HostCallContext.evidence): a read is a pure function of
        // the working copy, which changes only when an edit lands. A repeat read on
        // unchanged state is answered from the store and marked non-novel, so re-reading
        // costs nothing and counts as no progress.
        //
        // The hit RETURNS THE DATA. It used to answer "this is already in your context;
        // act on it rather than reading it again" and route the payload to the UI popup —
        // while compaction had cleared that payload from the context two turns earlier
        // with "re-read if needed". The model was invited to re-read and then refused the
        // words, and its only escape was to vary the window, which is precisely the
        // research spin ADR 0074 observed. A memo that withholds is not a memo.
        const readKey = callMemoKey(call);
        const memoized = host.evidence?.lookup(readKey);
        if (memoized) {
          return {
            ops: [],
            note: `${desc} → ${host.evidence!.preview(memoized)} [${memoized.id}, unchanged since you last read it]`,
            summary: memoized.descriptor,
            status: 'completed',
            fromCache: true,
            data: memoized.data,
          };
        }
        const stored = host.evidence?.put({
          key: readKey,
          source: call.name,
          descriptor: desc,
          data: value,
        });
        // Card shows the short action label; the model log keeps an id-preserving digest
        // (so it never has to invent asset/clip ids) plus the evidence handle that makes
        // the full payload retrievable for the rest of the run; the popup gets the full
        // object (`data`).
        const preview = summarizeReadResult(call.name, value);
        const note = stored ? `${desc} → ${preview} [${stored.id}]` : `${desc} → ${preview}`;
        return {
          ops: [],
          note,
          summary: desc,
          // The card wants the label; the run's memory wants the conclusion.
          finding: preview,
          status: 'completed',
          data: value,
        };
      } catch (cause) {
        const note = `Invalid arguments for "${call.name}": ${describeArgValidationError(cause)}`;
        return { ops: [], note, summary: note, status: 'failed', data: note };
      }
    }
    try {
      const ops = this.operationsFor(
        call,
        host.evidence ? { ...ctx, evidence: host.evidence } : ctx,
      );
      if (ops.length === 0) {
        // A mutating tool can legitimately have nothing to do — e.g. manage_assets
        // when the bin is already organized. Say so plainly instead of implying an
        // edit happened: the user sees the call made no change, and the agent loop
        // feeds this note back so the model moves on to the real edit rather than
        // repeating the no-op or halting on it.
        const note = `${desc} — nothing to change`;
        return { ops, note, summary: note, status: 'warning' };
      }
      // Wipe guard (agent continuity): a delete that clears a whole multi-clip
      // track of pre-run work is the "start over" failure loop, not an edit —
      // reject it with the corrective note before it ever reaches the validator.
      const wipeVerdict = detectTimelineWipe(ops, ctx.project, host.wipeGuard);
      if (wipeVerdict) {
        const note = `Rejected "${call.name}" — ${wipeVerdict}`;
        orchestratorLog.warn('tool call rejected — wipe guard', {
          tool: call.name,
          args: call.arguments,
        });
        return {
          ops: [],
          note,
          summary: `${desc} — rejected: would wipe existing work`,
          status: 'failed',
          data: wipeVerdict,
          rejectedOpCount: ops.length,
        };
      }
      // Validate against the working copy NOW, not at turn end: an invalid call
      // (overlapping clips, unknown ids, …) fails its own card with the validator's
      // reason — which also reaches the model via the log so it can fix the cause —
      // instead of showing a checkmark and having the whole turn rejected later.
      const probe = assembleEdit(ctx.project, ops, 'validation probe', 'agent');
      if (!probe.validation.valid) {
        const problems = probe.validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ');
        const note = `Rejected "${call.name}" — ${problems}`;
        orchestratorLog.warn('tool call rejected — validator', { tool: call.name, problems });
        return {
          ops: [],
          note,
          summary: `${desc} — rejected: ${problems}`,
          status: 'failed',
          data: problems,
          rejectedOpCount: ops.length,
        };
      }
      const note = summarizeOperations(ops, names, call);
      orchestratorLog.action('tool produced ops', { tool: call.name, opCount: ops.length, note });
      // Invalidate what this patch actually changed — the ARRANGEMENT — and nothing more
      // (§3.7). This used to be a blanket `clear()`, which threw away the transcript and
      // the footage map every time a cut landed, forcing the run to buy its own
      // reconnaissance again. A ripple delete cannot change the words that were spoken.
      host.evidence?.invalidate(ops.map((op) => op.type));
      return {
        ops,
        note,
        summary: note,
        status: 'completed',
        project: applyProjectPatch(ctx.project, probe.patch),
      };
    } catch (error) {
      // Unknown/unavailable/read/action are handled above, so the only thing
      // operationsFor can throw here is a ToolInvocationError for invalid args.
      const reason = (error as ToolInvocationError).message;
      const note = `Rejected "${call.name}": ${reason}`;
      orchestratorLog.warn('tool call rejected — invalid args', { tool: call.name, reason });
      return { ops: [], note, summary: note, status: 'failed', data: reason };
    }
  }

  /**
   * Draft an up-front numbered plan (R3 C4) with a read-only planning turn — the model
   * commits to steps before acting, improving legibility and giving the repair pass a
   * target. Returns `[]` on an empty/toolless response (the loop still works without it).
   * The run's abort signal is threaded through so Stop cancels this call too — it is a
   * plain `complete()`, not a stream, and used to keep running after abort.
   */
  private async generateAgentPlan(
    input: ContextInput,
    signal: AbortSignal | undefined,
    effectRuntime: EffectRuntime,
  ): Promise<{ message: string; steps: string[] }> {
    const messages: AiMessage[] = [
      ...buildContext(input),
      { role: 'user', content: AGENT_PLAN_DRAFT_INSTRUCTION },
    ];
    // No tools on a plan turn: the model must not call one here, so their schemas are
    // wasted tokens and contradict the instruction (see plan()).
    const response = await this.completeModel({ messages }, signal, effectRuntime);
    // Split the response: the numbered list seeds the todo ledger, the prose (intro /
    // question) is surfaced to chat by the caller — never as fake checklist rows (U2).
    return parseAgentPlan(response.text || '');
  }

  /**
   * One bounded Critic-driven repair pass (R3 C3). If the run left *fixable* findings
   * (see {@link FIXABLE_CHECKS}), ask the model to fix ONLY those with the smallest
   * edits, run that single turn through the same validate→apply gate, and return the
   * (possibly advanced) working project + a repair step. Never auto-applies; exactly
   * one pass. Returns `null` when there is nothing fixable or the model declined.
   */
  private async attemptRepair(args: {
    input: ContextInput;
    working: Project;
    log: readonly string[];
    report: CritiqueReport;
    stepIndex: number;
    appliedPatchIds: Set<string>;
    /** This run's beat payload, so a repair is held to the grid like any other turn. */
    rawBeats?: unknown;
    /** The run's hard-sync declaration, so a repair inherits the same policy. */
    beatHardSync?: boolean;
    maxOpsPerTurn: number;
    /** The run's abort signal, so Stop cancels the repair `complete()` call too. */
    signal?: AbortSignal;
    /** The run's effect boundary, shared so repair I/O remains observable and deduplicated. */
    effectRuntime: EffectRuntime;
    /**
     * The run's skill ledger (ADR 0057), shared so the repair turn both KEEPS the
     * playbooks the run already loaded (they stay pinned in its context) and does not
     * re-fetch them. Non-optional for the same reason as `analysisBudget` above: both
     * callers always thread the run's ledger — never a ledger-less repair pass.
     */
    loadedSkills: Map<string, string>;
    // Non-optional: both callers (below) always thread the run's up-front
    // `createAnalysisBudget()` result — never a budget-less repair pass.
    /** The run's analysis budget (B5.4), so a repair pass's analysis is capped too. */
    analysisBudget: AnalysisBudget;
    /**
     * Reports the repair call's real usage (C1), if the provider reported any. Optional
     * so {@link agent} — the legacy non-streaming method, which does not track run cost —
     * can keep calling this unchanged; {@link agentRun}'s `runVerify` handler passes one
     * to fold the repair pass's spend into the streaming run's cost accumulator.
     */
    onUsage?: (
      usage: { readonly inputTokens?: number; readonly outputTokens?: number } | undefined,
    ) => void;
    /**
     * The run's task memory (ADR 0075), so the repair turn is briefed with everything the
     * run established rather than being handed a bare instruction. A repair is the last
     * turn of the SAME run; withholding what that run learned is how a fix ends up
     * re-deriving the context it is fixing against.
     */
    taskMemory?: RunWorkingState;
  }): Promise<{ step: AgentStep; working: Project; ops: AnyOperation[] } | null> {
    const fixable = args.report.checks.filter(
      (c) => c.status === 'fail' && FIXABLE_CHECKS.has(c.id),
    );
    if (fixable.length === 0) return null;

    const instruction = repairPassInstruction(fixable.map((c) => `${c.label}: ${c.detail}`));
    const messages = [
      ...this.agentMessages(
        args.input,
        args.working,
        args.log,
        args.loadedSkills,
        undefined,
        undefined,
        false,
        args.taskMemory,
      ),
      { role: 'user' as const, content: instruction },
    ];
    const response = await this.completeModel(
      { messages, tools: this.agentTools() },
      args.signal,
      args.effectRuntime,
      'large',
    );
    // Reported UNCONDITIONALLY, `undefined` usage included: the call happened, and the
    // run's accumulator counts calls separately from tokens so a provider that priced
    // nothing still shows up as spend of unknown size rather than as no spend.
    args.onUsage?.(response.usage);
    const calls = response.toolCalls ?? [];
    if (calls.length === 0) return null;

    // Thread the repair turn's speculative working copy call-to-call (see executeToolCalls).
    let ctx = this.toolContext({ ...args.input, project: args.working });
    let names = projectNames(args.working);
    const turnOps: AnyOperation[] = [];
    const notes: string[] = [];
    for (const call of calls) {
      const { ops, note, project } = await this.runAgentCall(call, ctx, names, {
        ...(args.signal ? { signal: args.signal } : {}),
        effectRuntime: args.effectRuntime,
        loadedSkills: args.loadedSkills,
        // Every caller of `attemptRepair` threads the run's `analysisBudget` (created
        // once, up front, and always truthy) straight through — see `HostCallContext`.
        analysisBudget: args.analysisBudget,
      });
      turnOps.push(...ops);
      notes.push(note);
      if (project) {
        ctx = { ...ctx, project };
        names = projectNames(project);
      }
    }
    if (turnOps.length === 0) {
      // Per-call validation rejected every proposed repair op — record the honest
      // non-applied attempt (with the validator's reasons) instead of dropping it;
      // a repair turn that proposed nothing at all stays a silent no-op.
      const rejections = notes.filter((n) => n.startsWith('Rejected'));
      if (rejections.length === 0) return null;
      return {
        step: {
          index: args.stepIndex,
          rationale: response.text || 'Repair pass',
          toolCalls: calls.map((c) => c.name),
          applied: false,
          note: `Repair pass: ${notes.join('; ')}`,
        },
        working: args.working,
        ops: [],
      };
    }
    // Respect the per-turn blast-radius bound even during repair.
    if (turnOps.length > args.maxOpsPerTurn) return null;

    const step = this.applyAgentTurn({
      index: args.stepIndex,
      rationale: response.text || 'Repair pass',
      toolCalls: calls.map((c) => c.name),
      notes,
      turnOps,
      working: args.working,
      appliedPatchIds: args.appliedPatchIds,
      rawBeats: args.rawBeats,
      beatHardSync: args.beatHardSync === true,
    });
    const record: AgentStep = { ...step.record, note: `Repair pass: ${step.record.note}` };
    return step.applied
      ? { step: record, working: step.working, ops: turnOps }
      : { step: record, working: args.working, ops: [] };
  }

  /**
   * Multi-step autonomous edit (PRD §7.4). The model plans and calls tools; each
   * turn's mutating tool calls become one validated, reversible patch applied to a
   * working copy. The loop stops when the model stops calling tools, stops making
   * progress (a repeated or no-op edit), or hits the step cap. After the run, one
   * bounded Critic-driven repair pass (R3 C3) may fix remaining findings. The returned
   * run is reviewable and NOT applied to the user's project — the human approves it.
   */
  public async agent(input: ContextInput, options: AgentOptions = {}): Promise<AgentRun> {
    const { runtime, finish } = this.createRunRuntime();
    try {
      return await this.agentWithRuntime(input, options, runtime);
    } finally {
      finish();
    }
  }

  private async agentWithRuntime(
    input: ContextInput,
    options: AgentOptions,
    effectRuntime: EffectRuntime,
  ): Promise<AgentRun> {
    input = this.withSkills(input);
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
    const maxOpsPerTurn = options.maxOpsPerTurn ?? DEFAULT_MAX_OPS_PER_TURN;
    const maxOpsPerRun = options.maxOpsPerRun ?? DEFAULT_MAX_OPS_PER_RUN;
    const tools = this.agentTools();
    const steps: AgentStep[] = [];
    const log: string[] = [];
    const cumulativeOps: AnyOperation[] = [];
    const appliedPatchIds = new Set<string>();
    const noProgressSignatures = new Set<string>();
    // Convergence streak — consecutive turns that made no progress. Parity mirror of the
    // Conductor's `stallStreak` (conductor.ts onTurnResult): the sole behavioral stop.
    // No recon budget, no edit nudge — the model decides when to edit; the harness only
    // stops the run once it can prove no further progress is being made.
    let stallStreak = 0;
    // E4 parity mirror of the Conductor's diminishing-returns stop (token delta).
    const diminishingTurns = options.diminishingReturns?.turns ?? DIMINISHING_RETURNS_TURNS;
    const diminishingMinOutputTokens =
      options.diminishingReturns?.minOutputTokens ?? DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS;
    let recentOutputDeltas: number[] = [];
    const seenCallKeys = new Set<string>();
    // Per-run evidence store (see `HostCallContext.evidence`): a repeat read on an
    // unchanged working copy is served from here, marked non-novel, so it never looks
    // like progress — and, unlike the memo it replaces, it serves the DATA back.
    const evidence = new EvidenceStore();
    const beatEvidence: { current?: unknown; hardSync?: boolean } = {};
    // ADR 0057: per-run skill ledger — see the streaming loop's identical comment.
    const loadedSkills = new Map<string, string>();
    // Per-run analysis budget (B5.4): caps frames/ffmpeg-seconds/transcription across
    // the whole run so a spinning loop hits an honest ceiling, not the compute wall.
    const analysisBudget = createAnalysisBudget(options.analysisCaps);
    // Agent continuity: same wipe guard as the streaming loop (parity — both control
    // paths must reject a destructive "start over" identically).
    const wipeGuard = wipeGuardFor(input.userPrompt, input.project);
    let working: Project = input.project;

    // R3 C4: optionally draft an up-front plan the loop then follows. Only the actionable
    // steps thread into the loop context; the prose (if any) is a chat surface, not a step.
    const plan = options.planFirst
      ? (await this.generateAgentPlan(input, undefined, effectRuntime)).steps
      : undefined;
    // W3.4 (parity with the Conductor's `onDraftPlanResult`): a plan the run cannot
    // execute is a promise we break, so the budget widens to fit the plan just drafted —
    // never shrinks. This is a resource rail, not a behavioral bound.
    const stepBudget = plan?.length
      ? Math.max(maxSteps, plan.length + PLAN_STEP_HEADROOM)
      : maxSteps;

    /**
     * Frames the previous turn rendered, for THIS request. Same one-shot contract as the
     * streaming loop's `pendingFrames` (see its note); both control paths must show the
     * model the same thing or the parity harness diverges.
     */
    let pendingFrames: readonly AiImage[] = [];
    for (let index = 1; index <= stepBudget; index += 1) {
      const response = await this.completeModel(
        {
          messages: this.agentMessages(
            input,
            working,
            log,
            loadedSkills,
            plan,
            undefined,
            false,
            undefined,
            pendingFrames,
          ),
          tools,
        },
        undefined,
        effectRuntime,
      );
      // Sent — do not attach them again (see `pendingFrames`).
      pendingFrames = [];
      const rationale = response.text || '';
      const calls = response.toolCalls ?? [];

      if (calls.length === 0) {
        // No tool calls — the model considers the goal met.
        log.push(`Step ${index}: ${rationale || 'finished — no further edits.'}`);
        steps.push({
          index,
          rationale,
          toolCalls: [],
          applied: false,
          note: 'No tool calls — agent finished.',
        });
        break;
      }

      // Thread the turn's speculative working copy call-to-call (see executeToolCalls).
      let ctx = this.toolContext({ ...input, project: working });
      let names = projectNames(working);
      const turnOps: AnyOperation[] = [];
      const notes: string[] = [];
      const callFacts: TurnCallFact[] = [];
      const turnFrames: AiImage[] = [];
      for (const call of calls) {
        const { ops, note, project, status, fromCache, images } = await this.runAgentCall(
          call,
          ctx,
          names,
          {
            effectRuntime,
            evidence,
            beatEvidence,
            loadedSkills,
            analysisBudget,
            ...(wipeGuard ? { wipeGuard } : {}),
          },
        );
        turnOps.push(...ops);
        notes.push(note);
        if (images) turnFrames.push(...images);
        // Parity with the streaming loop's `executeToolCalls` (K1.2): both control paths
        // must judge progress identically, or the parity harness diverges.
        callFacts.push({
          key: callNoveltyKey(call),
          status,
          fromCache: fromCache === true,
          role: toolRole(call.name, getTool(call.name)?.mutates === true),
        });
        if (project) {
          ctx = { ...ctx, project };
          names = projectNames(project);
        }
      }

      pendingFrames = turnFrames;

      // Blast-radius bound (R3 C1): a single runaway turn that tries to make an
      // implausible number of edits is rejected wholesale with a diagnostic, not
      // applied — the human can still re-prompt with a narrower goal.
      if (turnOps.length > maxOpsPerTurn) {
        const note = `Turn rejected: ${turnOps.length} operations exceeds the per-turn cap of ${maxOpsPerTurn}.`;
        steps.push({ index, rationale, toolCalls: calls.map((c) => c.name), applied: false, note });
        log.push(`Step ${index}: ${note}`);
        break;
      }

      const step = this.applyAgentTurn({
        index,
        rationale,
        toolCalls: calls.map((c) => c.name),
        notes,
        turnOps,
        working,
        appliedPatchIds,
        rawBeats: beatEvidence.current,
        beatHardSync: beatEvidence.hardSync === true,
      });
      steps.push(step.record);
      log.push(`Step ${index}: ${rationale ? `${rationale} — ` : ''}${step.record.note}`);

      if (step.applied) {
        working = step.working;
        cumulativeOps.push(...turnOps);
        // A real edit landed — the run is progressing, so the convergence streak resets,
        // and so does the diminishing-returns delta window (E4 parity with the reducer).
        stallStreak = 0;
        recentOutputDeltas = [];
        // Blast-radius bound (R3 C1): stop once the run has accumulated its op budget,
        // even if the model would keep going — the combined patch is still reviewable.
        if (cumulativeOps.length >= maxOpsPerRun) {
          log.push(
            `Step ${index}: reached the per-run cap of ${maxOpsPerRun} operations — stopping.`,
          );
          break;
        }
        continue;
      }
      // A turn that landed nothing — validator-rejected ops, a repeated edit, a no-op
      // organize, or pure inspection — is NOT a dead end: the reason is already in the
      // log the model reads next turn. Judge progress exactly as the streaming Conductor
      // does (conductor.ts onTurnResult): a turn progressed if it attempted an edit (a
      // rejected op is a bounded retry) or learned something new; re-reading what the run
      // already has is neither. Two provable non-progress turns in a row — or an exact
      // verbatim repeat — mean the run has converged and stops.
      const attemptedEdit = turnOps.length > 0;
      const progressed = attemptedEdit || turnLearnedSomethingNew(callFacts, [...seenCallKeys]);
      for (const fact of callFacts) seenCallKeys.add(fact.key);
      stallStreak = progressed ? 0 : stallStreak + 1;
      // E4 parity mirror of the Conductor's diminishing-returns window (conductor.ts
      // onTurnResult): a zero-edit turn extends the low-delta window with its reported
      // output tokens; a turn with no reported usage resets it (no delta, no proof).
      const outputDelta = response.usage?.outputTokens;
      recentOutputDeltas =
        outputDelta === undefined
          ? []
          : [...recentOutputDeltas, outputDelta].slice(-diminishingTurns);
      const signature = turnSignature(calls);
      if (noProgressSignatures.has(signature) || stallStreak >= STALL_CONFIRM_TURNS) {
        break;
      }
      // E4.2 (parity with the reducer): enough consecutive tiny, zero-edit turns mean
      // the run has converged — honestly finished, not spinning — so stop it here.
      if (
        recentOutputDeltas.length >= diminishingTurns &&
        recentOutputDeltas.every((d) => d < diminishingMinOutputTokens)
      ) {
        log.push(
          `Step ${index}: converged — the last ${diminishingTurns} turns each produced under ${diminishingMinOutputTokens} output tokens with no applied edits; stopping.`,
        );
        break;
      }
      noProgressSignatures.add(signature);
    }

    let report = critique(working, this.critiqueOptions(input, options, cumulativeOps.length > 0));

    // R3 C3: one bounded Critic-driven repair pass if fixable findings remain.
    if ((options.autoRepair ?? true) && !report.ok) {
      const repair = await this.attemptRepair({
        input,
        working,
        log,
        report,
        stepIndex: steps.length + 1,
        appliedPatchIds,
        rawBeats: beatEvidence.current,
        maxOpsPerTurn,
        effectRuntime,
        loadedSkills,
        analysisBudget,
      });
      if (repair) {
        steps.push(repair.step);
        log.push(`Repair: ${repair.step.note}`);
        if (repair.ops.length > 0) {
          working = repair.working;
          cumulativeOps.push(...repair.ops);
          // re-check after the repair (changes now applied)
          report = critique(
            working,
            this.critiqueOptions(input, options, cumulativeOps.length > 0),
          );
        }
      }
    }

    const result = assembleEdit(
      input.project,
      cumulativeOps,
      input.userPrompt || 'Agent edit',
      'agent',
    );

    return {
      goal: input.userPrompt,
      ...(plan ? { plan } : {}),
      steps,
      result,
      critique: report,
      log,
    };
  }

  /**
   * Assemble one turn's operations into a validated patch and decide whether it
   * advances the working timeline. A turn advances only when its patch is valid and
   * its content is novel (a repeated patch id means the model is going in circles).
   */
  private applyAgentTurn(args: {
    index: number;
    rationale: string;
    toolCalls: string[];
    notes: string[];
    turnOps: AnyOperation[];
    working: Project;
    appliedPatchIds: Set<string>;
    /**
     * This run's raw `detect_beats` payload, when it gathered one. Passed per call rather
     * than held on the Orchestrator, which serves concurrent runs (ADR 0126's note on this
     * exact wiring point).
     */
    rawBeats?: unknown;
    /**
     * Whether the run DECLARED hard sync (`detect_beats({ hardSync: true })`). Without it an
     * off-grid interior cut is reported to the model, not rejected — see
     * `kernel/beat-grid/beat-alignment.ts`.
     */
    beatHardSync?: boolean;
  }): {
    record: AgentStep;
    applied: boolean;
    /** The turn landed nothing because the timeline already matched it (see below). */
    satisfied?: boolean;
    /**
     * WHY the turn was rejected, with nothing else in it.
     *
     * The record's `note` is the model-facing log line, and every tool call in the turn
     * contributes to it — reads included. Reporting THAT to the editor as the reason a
     * change did not validate printed a media-bin JSON dump under "Skipped: 8 proposed
     * changes did not validate", with the actual reason at the end of it. The user-facing
     * line is built from this field instead.
     */
    rejection?: string;
    /**
     * Interior cuts left deliberately off the beat grid, as a measurement to report. Only
     * set when the run did NOT declare hard sync — see `kernel/beat-grid/beat-alignment.ts`.
     */
    offGrid?: string;
    working: Project;
    edit?: EditResult;
  } {
    const { index, rationale, toolCalls, notes, working, appliedPatchIds } = args;
    // Every tool call contributes exactly one note, so a turn that reached here
    // (calls.length > 0) always has a non-empty baseNote.
    const baseNote = notes.join('; ');

    if (args.turnOps.length === 0) {
      return {
        record: { index, rationale, toolCalls, applied: false, note: baseNote },
        applied: false,
        working,
      };
    }

    // THE BEAT GRID (ADR 0126's open follow-up; `kernel/beat-grid/beat-alignment.ts`).
    //
    // This is NOT a beat-sync mode and there is no flag that turns it on. The gate is
    // evidence the AGENT chose to gather: the rule engages only when this run actually
    // called `detect_beats`. A run that never asked about the music is untouched, and no
    // conditional anywhere decides that a request "is a beat-sync request" — the model
    // decides that by electing the tool, and the runtime then guarantees the mechanical
    // accuracy the model cannot deliver by arithmetic. The roadmap's governing split:
    // the runtime controls execution and safety, the model controls editorial strategy.
    //
    // The module handles its own exemptions (audio/caption boundaries, the sequence's
    // outer edges) and snaps interior near-misses rather than rejecting them, so a cut two
    // frames off a real onset becomes frame-accurate sync instead of a wasted repair turn.
    // A cut too far to snap is REPORTED unless the run declared hard sync: quantising every
    // cut is a style, not a correctness property, and holding a run to it uninvited rewrote
    // the rhythm a captured brief had asked for in so many words.
    const beatAligned = alignTurnToBeatGrid(
      working,
      args.turnOps,
      args.rawBeats,
      args.beatHardSync === true,
    );
    if (!beatAligned.ok) {
      return {
        record: {
          index,
          rationale,
          toolCalls,
          applied: false,
          note: `${baseNote}; rejected by the beat grid: ${beatAligned.error}`,
        },
        applied: false,
        rejection: `rejected by the beat grid: ${beatAligned.error}`,
        working,
      };
    }
    const turnOps = beatAligned.operations;
    // The measurement rides with the turn's note, which is what the model reads next turn.
    const beatNote = beatAligned.offGrid ? `${baseNote}; ${beatAligned.offGrid}` : baseNote;

    const edit = assembleEdit(working, turnOps, rationale || 'Agent step', 'agent');
    /* v8 ignore start -- defense in depth: every op in `turnOps` already passed its own
     * per-call probe (`runAgentCall`'s `assembleEdit(ctx.project, ops, …)`) against the
     * exact speculative state this whole-turn recombination replays against, so
     * `edit.validation` can only fail here if that invariant is broken by future code
     * (e.g. a new call site that pushes into `turnOps` without probing first). */
    if (!edit.validation.valid) {
      const problems = edit.validation.issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.message)
        .join('; ');
      return {
        record: {
          index,
          rationale,
          toolCalls,
          patch: edit.patch,
          applied: false,
          note: `${baseNote}; rejected by validator: ${problems}`,
        },
        applied: false,
        rejection: `rejected by the validator: ${problems}`,
        working,
      };
    }
    /* v8 ignore stop */
    // The patch id is a hash of the operations, so an identical id means this turn
    // recomputed an edit the run already applied — the timeline already says what the turn
    // was asking it to say. That is a NO-OP, and the distinction from a rejection matters
    // more than it looks: the reducer files a landed-nothing turn as a `failed` operation,
    // which the state briefing renders under "FAILED — fix the cause, do not retry
    // unchanged". In the captured run that told the model its caption emphasis had failed
    // twenty-four times, when in fact it had succeeded and was sitting on the timeline. The
    // model dutifully looked for a cause to fix, found none, and tried again. `satisfied`
    // carries the truth through to the reducer so the run is told it is DONE, not broken.
    if (appliedPatchIds.has(edit.patch.patchId)) {
      return {
        record: {
          index,
          rationale,
          toolCalls,
          patch: edit.patch,
          applied: false,
          note: `${beatNote}; already in place — this exact change is already on the timeline`,
        },
        applied: false,
        satisfied: true,
        working,
      };
    }

    appliedPatchIds.add(edit.patch.patchId);
    // Apply at project scope so a turn may organize the bin (add_asset /
    // manage_assets) and edit the timeline in the same run.
    const nextWorking: Project = applyProjectPatch(working, edit.patch);
    return {
      record: { index, rationale, toolCalls, patch: edit.patch, applied: true, note: beatNote },
      applied: true,
      ...(beatAligned.offGrid ? { offGrid: beatAligned.offGrid } : {}),
      working: nextWorking,
      edit,
    };
  }

  // -------------------------------------------------------------------------
  // Review mode (PRD §8.6) — the deterministic Critic over the current project
  // -------------------------------------------------------------------------

  /**
   * Run the Critic over the project as-is and return a human-readable review plus
   * the structured report. This is deterministic and needs no model call; pass a
   * render-validation result in {@link AgentOptions.render} to include the
   * black-frame / audio-clipping checks.
   */
  public async review(input: ContextInput, options: AgentOptions = {}): Promise<ReviewResult> {
    const report = critique(input.project, this.critiqueOptions(input, options));
    return { text: formatReport(report), report };
  }

  // -------------------------------------------------------------------------
  // Streaming modes (Phase 11 M1, ADR 0033) — emit AiEvents, honor AbortSignal
  // -------------------------------------------------------------------------

  /**
   * Drain a provider stream, accumulating text and tool calls, routing each text
   * chunk to the requested {@link StreamSink}:
   * - `assistant`: yield a live message delta (chat/plan/edit token stream; agent
   *   turn segments).
   * - `silent`: accumulate without emitting.
   *
   * Returns the final text, the collected tool calls, and whether the signal aborted.
   */
  /**
   * The context manifest for one outgoing request (ADR 0080).
   *
   * Built from the payload the provider will actually receive, so tool schemas and the
   * agent loop's self-assembled messages are counted rather than silently omitted. When
   * the caller supplies the assembler's tier account, that richer breakdown replaces the
   * payload-derived one and compaction becomes reportable.
   *
   * @param request - The exact request about to be sent.
   * @param sink - The turn's assistant sink; its id makes the manifest's `requestId`
   *   stable and unique per step, so two manifests can be diffed without ambiguity.
   * @param modelCall - Window, reservation, and any richer context the caller has.
   */
  private manifestFor(
    request: AiCompletionRequest,
    sink: StreamSink,
    modelCall: ModelCallContext,
  ): ContextManifest {
    const capabilities = capabilitiesFor(this.provider.name, this.provider.modelId);
    return buildRequestManifest({
      /* v8 ignore next -- no caller currently constructs a `{ kind: 'silent' }` sink; the union member exists for a future silent-stream caller. */
      requestId: sink.kind === 'assistant' ? sink.id : 'silent',
      provider: this.provider.name,
      ...(this.provider.modelId ? { model: this.provider.modelId } : {}),
      contextWindow: modelCall.contextWindow,
      windowSource: modelCall.windowSource ?? capabilities.source,
      /* v8 ignore next -- unreachable: every streamAssistant caller supplies reservedOutputTokens via reservedOutputFor(), which always returns a number, so the capabilities fallback never runs today. */
      reservedOutputTokens: modelCall.reservedOutputTokens ?? capabilities.maxOutputTokens,
      request,
      ...(modelCall.assembled ? { assembled: modelCall.assembled } : {}),
      ...(modelCall.memory ? { memory: modelCall.memory } : {}),
    });
  }

  private async *streamAssistant(
    emit: TurnEmitter,
    request: AiCompletionRequest,
    signal: AbortSignal | undefined,
    sink: StreamSink,
    effectRuntime?: EffectRuntime,
    // Defaults to the SELECTED model's window, not a global constant: a caller that
    // omits `modelCall` still reports occupancy against the room it actually has.
    modelCall: ModelCallContext = {
      tier: 'mid',
      contextWindow: capabilitiesFor(this.provider.name, this.provider.modelId).contextWindow,
    },
  ): AsyncGenerator<
    AiEvent,
    { text: string; calls: ToolCall[]; aborted: boolean; usage?: Usage; truncated?: boolean }
  > {
    let text = '';
    // The narration boundary (kernel/narration.ts). Assistant text reaches the UI as live
    // deltas, so this has to sit on the delta path rather than on the settled string: a
    // filter that only ran at the end would let "I'll continue from the interpret stage."
    // render and then snap away. `text` accumulates what the filter LET THROUGH, so the
    // string the editor read, the string stored as the patch reason, and the string the
    // reducer signatures the turn by are all the same string — there is no second, dirtier
    // copy of the message anywhere downstream.
    const narration = createNarrationFilter();
    const calls: ToolCall[] = [];
    // Real usage this call reported (C1), if any — a caller (e.g. the agent loop's
    // `runTurn`) folds this into the run's cost accumulator. Never fabricated: stays
    // `undefined` when no `usage` chunk arrives (see `providerChunks`).
    let usage: Usage | undefined;
    // The provider's own "I stopped because I ran out of room" (see `ProviderChunk`'s
    // `done.truncated`). Never inferred from the prose.
    let truncated = false;
    // Built once, just before the call, and reused when the provider settles.
    let manifest: ContextManifest | undefined;
    const captureReasoning = sink.kind === 'assistant' && sink.captureReasoning === true;
    // Per-step scoping key (agent steps); undefined ⇒ scoped to this call's segment below.
    // Every current caller passes a `{ kind: 'assistant' }` sink; the `silent` variant
    // has no constructor anywhere today, kept for a future caller.
    /* v8 ignore start */
    const explicitKey = sink.kind === 'assistant' ? sink.reasoningKey : undefined;
    /* v8 ignore stop */
    // ONE REASONING NODE PER MODEL CALL — the invariant that keeps a turn's thinking
    // blocks distinct, ordered, and interleaved with the tool cards between them.
    //
    // A model call is exactly the unit that produces one contiguous block of thinking, so
    // the node is scoped to the assistant SEGMENT this call streams into (segment ids are
    // already unique per call — `seg-2`, `seg-final`, …), not to the turn. Scoping it to
    // the turn is what made the question route's tool loop overwrite its own thinking:
    // think → call tools → think again all landed on `${turnId}:reasoning`, so the second
    // block replaced the first *in place*, above the tool cards it actually came after,
    // and the earlier rationale was simply lost. Deriving the scope here rather than
    // trusting each caller to pass a unique key means a future multi-call route cannot
    // reintroduce the bug by forgetting one.
    //
    // The turn's primary segment stays UNKEYED so single-call routes (edit, plan, the
    // first chat turn) keep their exact `${turnId}:reasoning` id — event ids are persisted
    // and compared for parity (K1.2), so only the calls that would have collided move.
    /* v8 ignore next -- `silent` sinks never capture reasoning; see above. */
    const segment = sink.kind === 'assistant' ? sink.id : emit.assistantId;
    const segmentKey = segment.startsWith(`${emit.assistantId}:`)
      ? segment.slice(emit.assistantId.length + 1)
      : undefined;
    const reasoningKey = explicitKey ?? segmentKey;
    // Per-step reasoning (agent, explicitly keyed) opens its shimmer EAGERLY so every step
    // shows its own "Thinking…" → "Thought for Ns" (U3) in order, even when the model
    // streams no reasoning tokens. A segment-scoped node (chat/edit) stays LAZY so a call
    // with no model thinking shows no empty row — which is why eagerness follows the
    // EXPLICIT key, not the derived one.
    const perStepReasoning = captureReasoning && explicitKey !== undefined;
    // Reasoning is opt-in ON THE WIRE: without this the model still thinks, but returns
    // none of it, and the step's row settles as an unopenable "Thought for Ns" — the row
    // was never the bug, the unasked-for thinking was. Asked for only on the calls whose
    // thinking is displayed (never the classifier/critic calls, which have nowhere to
    // show it), and degraded by the provider when a model refuses the parameter.
    const modelRequest: AiCompletionRequest = captureReasoning
      ? { ...request, reasoningEffort: request.reasoningEffort ?? 'medium' }
      : request;
    let reasoning = '';
    let reasoningOpened = false;
    // Settle the reasoning row (stops the "Thinking…" shimmer) — on normal end and on an
    // abort mid-thought alike, so a cancelled turn never leaves it spinning. Empty
    // reasoning settles to `[]` so it renders the compact "Thought for Ns" line, not a
    // blank accordion.
    const settleReasoning = (): AiEvent | undefined =>
      reasoningOpened
        ? emit.reasoning(reasoning ? [reasoning] : [], true, reasoningKey)
        : undefined;
    if (perStepReasoning) {
      reasoningOpened = true;
      yield emit.reasoning([], false, reasoningKey);
    }
    // Settle exactly once. The `finally` guarantees it even when the provider throws
    // mid-stream (or the consumer stops early), so a per-step shimmer is never left
    // spinning after a failed run — the settle event is delivered before the throw
    // propagates to `streamAgent`'s catch/`settle`.
    let settled = false;
    try {
      // The pre-send account (ADR 0080): every section, its cost, what compaction
      // removed, and the durable memory that outlives this request — so a change in the
      // number always arrives with its cause attached.
      manifest = this.manifestFor(request, sink, modelCall);
      yield emit.contextUsage({
        usedTokens: manifest.usage.estimatedInputTokensBeforeSend,
        contextWindow: manifest.usage.modelContextLimit,
        estimated: true,
        manifest,
      });
      const chunks =
        effectRuntime?.streamModel?.(
          { kind: 'model_stream', request: modelRequest, tier: modelCall.tier },
          signal,
        ) ?? providerChunks(this.provider, modelRequest, signal);
      for await (const chunk of chunks) {
        if (signal?.aborted) {
          settled = true;
          // A cancelled turn still owns whatever the narration filter was holding: it is a
          // half-written sentence about the edit, not chatter (chatter was already dropped
          // the moment its terminator arrived), and swallowing it would make a cancelled
          // reply read as if the model said nothing at all.
          const tail = narration.flush();
          if (tail !== '') {
            text += tail;
            if (sink.kind === 'assistant') yield emit.delta(sink.id, tail);
          }
          const settle = settleReasoning();
          if (settle) yield settle;
          return { text, calls, aborted: true, ...(usage ? { usage } : {}) };
        }
        if (chunk.type === 'text-delta') {
          const surfaced = narration.push(chunk.text);
          if (surfaced !== '') {
            text += surfaced;
            if (sink.kind === 'assistant') {
              yield emit.delta(sink.id, surfaced);
            }
          }
        } else if (chunk.type === 'reasoning-delta') {
          if (captureReasoning) {
            reasoning += chunk.text;
            if (!reasoningOpened) {
              reasoningOpened = true;
              // Open with an empty line; the delta below extends it (mirrors assistant).
              yield emit.reasoning([''], false, reasoningKey);
            }
            yield emit.reasoningDelta(chunk.text, reasoningKey);
          }
        } else if (chunk.type === 'tool-call') {
          calls.push(chunk.call);
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        } else if (chunk.type === 'done') {
          // The text is already accumulated from the deltas; what only 'done' carries is
          // whether the provider cut the reply off.
          truncated = chunk.truncated === true;
        }
      }
      settled = true;
      // Release the tail the filter never got a terminator for (a message that ends without
      // punctuation). `flush` still refuses it when it is unmistakable run chatter.
      const tail = narration.flush();
      if (tail !== '') {
        text += tail;
        if (sink.kind === 'assistant') yield emit.delta(sink.id, tail);
      }
      const settle = settleReasoning();
      if (settle) yield settle;
      // Replace the estimate with what the provider actually charged, keeping the
      // pre-send figure on the manifest so the heuristic's drift stays measurable.
      if (usage?.inputTokens !== undefined && manifest) {
        const settled = withProviderUsage(manifest, usage);
        yield emit.contextUsage({
          usedTokens: usage.inputTokens,
          contextWindow: settled.usage.modelContextLimit,
          estimated: false,
          manifest: settled,
        });
      }
      return {
        text,
        calls,
        aborted: signal?.aborted ?? false,
        ...(usage ? { usage } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    } finally {
      if (!settled) {
        const settle = settleReasoning();
        if (settle) yield settle;
      }
    }
  }

  /**
   * Run one turn's tool calls through the host executor (Phase T mechanics),
   * emitting each card's `running`→terminal transition plus its result, and
   * collecting the operations/notes/statuses the caller's decision logic acts on.
   *
   * Extracted from the agent loop (K1.2, plan/AI-ORCHESTRATION-REDESIGN.md) so the
   * legacy `streamAgent` loop AND the new Conductor `run_turn` handler execute a
   * turn's tools identically — the "extract & share" strangler step that keeps the
   * two control paths from diverging. Pure mechanics: no stop/continue decisions,
   * no plan-ledger updates (those stay with the caller). Stops early — but never
   * fabricates a result — the moment a call comes back `cancelled`.
   */
  private async *executeToolCalls(
    emit: TurnEmitter,
    calls: readonly ToolCall[],
    ctx: ToolContext,
    names: ProjectNames,
    effectRuntime: EffectRuntime,
    /** The run's evidence store (see `HostCallContext.evidence`) — memo + retrieval. */
    evidence: EvidenceStore,
    /** The run's skill ledger (ADR 0057), so a playbook is loaded once per run. */
    loadedSkills: Map<string, string>,
    /** Answers the model's questions (P12); absent ⇒ `ask_user` degrades honestly. */
    askUser: AskUser | undefined,
    signal: AbortSignal | undefined,
    now: () => number,
    // Non-optional: both agent and tool-using question loops always thread the run's
    // up-front `createAnalysisBudget()` result — never a budget-less call.
    analysisBudget: AnalysisBudget,
    /** The run's wipe guard (agent continuity); absent ⇒ deletes run unguarded. */
    wipeGuard?: WipeGuardContext,
    /** Enforce an exceptional route-scoped descriptor set at execution time. */
    allowedToolNames?: ReadonlySet<string>,
    /**
     * The run's beat-payload box (see `HostCallContext.beatEvidence`). Absent on routes
     * that never edit — the question route can call `detect_beats` to answer a question,
     * but has no turn to hold to a grid.
     */
    beatEvidence?: { current?: unknown; hardSync?: boolean },
    /** Durable note sink for what the editor tells the run (see `rememberDecision`). */
    rememberDecision?: (note: { readonly title: string; readonly body: string }) => void,
  ): AsyncGenerator<
    AiEvent,
    {
      turnOps: AnyOperation[];
      notes: string[];
      turnStatuses: ToolStatus[];
      rejectedOpCount: number;
      rejectionNotes: string[];
      /** Per-call progress facts the reducer folds (see `TurnCallFact`). */
      callFacts: TurnCallFact[];
      /**
       * Images this turn's tool calls produced (`get_frame`), for the next request to
       * attach as real image content. Empty on every turn that did not look at a frame.
       */
      frames: AiImage[];
    }
  > {
    const turnOps: AnyOperation[] = [];
    const notes: string[] = [];
    const turnStatuses: ToolStatus[] = [];
    /** Frames this turn's `get_frame` calls rendered, for the NEXT request's images. */
    const frames: AiImage[] = [];
    const callFacts: TurnCallFact[] = [];
    // Per-call validator rejections (ops proposed but refused) — the honest
    // empty-run notice is built from these when the whole run lands nothing.
    let rejectedOpCount = 0;
    const rejectionNotes: string[] = [];
    // The turn's speculative working copy: each validated mutating call advances it,
    // so the NEXT call is validated against the timeline as it will actually exist
    // (a second overlay landing on an occupied range fails ITS card immediately, and
    // a later call may reference clips an earlier call in the same turn created).
    let turnCtx = ctx;
    let turnNames = names;
    const hostContext: HostCallContext = {
      ...(signal ? { signal } : {}),
      effectRuntime,
      evidence,
      ...(beatEvidence ? { beatEvidence } : {}),
      loadedSkills,
      ...(askUser ? { askUser } : {}),
      ...(rememberDecision ? { rememberDecision } : {}),
      // `analysisBudget` is created once up front (always truthy) and threaded
      // through every turn of this loop — see `HostCallContext.analysisBudget`.
      analysisBudget,
      ...(wipeGuard ? { wipeGuard } : {}),
    };
    // The card shows the human title plus a compact args line (U4) so the
    // user can see WHAT the call was asked to do without opening details.
    const cardExtraFor = (call: ToolCall): { title: string; argsSummary?: string } => {
      const argsLine = summarizeArgs(call.arguments);
      return {
        title: describeToolCall(call, turnNames),
        ...(argsLine ? { argsSummary: argsLine } : {}),
      };
    };

    // E1 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md): partition the turn into
    // batches — runs of consecutive concurrency-safe calls (read/analysis kinds, see
    // `concurrencySafe`) dispatch together against a bounded pool so their sidecar
    // round-trips overlap; every other call stays a strictly serial singleton, because
    // mutations thread the speculative working copy call-to-call (the correctness
    // backbone — see the `turnCtx` comment above).
    const batches = partitionConcurrencyBatches(
      calls,
      (call) => {
        if (allowedToolNames && !allowedToolNames.has(call.name)) return false;
        const tool = getTool(call.name);
        if (!tool || !tool.available) return false;
        return concurrencySafe(tool, sanitizeToolArgs(tool, call.arguments));
      },
      // Duplicate calls never share a batch: the later one lands in a later batch, so
      // the memo (`evidence`/Effect Runtime) still answers it and marks it non-novel —
      // exactly the serial semantics the spin guard's callFacts depend on.
      callNoveltyKey,
    );
    // `process` always exists under the test runner; the typeof guard is for browser
    // bundles (same defensive stance as providers/index.ts#readEnv).
    const poolSize = resolveToolConcurrency(
      /* v8 ignore next */
      typeof process !== 'undefined' ? process.env[TOOL_CONCURRENCY_ENV] : undefined,
    );

    let stopped = false;
    for (const batch of batches) {
      // This batch's settled calls, ALWAYS in original call order (mapBounded returns
      // input order, never completion order). `announced` = the `running` card was
      // already emitted live (serial path); a concurrent call's events are all deferred
      // to the fold below instead, so the observable event sequence is byte-identical
      // to serial execution (golden-tested) — concurrency changes wall-clock only.
      let settled: {
        call: ToolCall;
        outcome: AgentCallOutcome;
        runtimeMs: number;
        announced: boolean;
      }[];
      if (batch.concurrent && batch.calls.length > 1) {
        settled = await mapBounded([...batch.calls], poolSize, async (call) => {
          const started = now();
          const outcome = await this.runAgentCall(call, turnCtx, turnNames, hostContext);
          return { call, outcome, runtimeMs: now() - started, announced: false };
        });
      } else {
        // Serial singleton — the classic live flow.
        const call = batch.calls[0] as ToolCall;
        yield emit.toolCall(call.id, call.name, 'running', cardExtraFor(call));
        // P12: surface the model's question BEFORE blocking on it — the card is already
        // `running`, and this is what gives the host something to render and answer. Only
        // this streaming path can do it, which is why `runAgentCall` degrades honestly for
        // the paths that cannot. A malformed ask emits nothing and fails its own card in
        // `runAgentCall` instead of rendering a prompt built from junk. (An `ask` is never
        // concurrency-safe, so it always takes this branch.)
        const inScope = allowedToolNames === undefined || allowedToolNames.has(call.name);
        const asked = inScope ? askQuestionFor(call) : undefined;
        if (asked) yield emit.ask(call.id, asked.question, asked.options);
        const started = now();
        // AWAITED host execution (Phase T): the card stays `running` for as long
        // as the analysis/action actually takes, and the returned data reaches
        // the model's next turn via the log note. Abort mid-call settles the
        // card as `cancelled`, never a checkmark.
        const outcome: AgentCallOutcome = inScope
          ? await this.runAgentCall(call, turnCtx, turnNames, hostContext)
          : {
              ops: [],
              note:
                `Refused redundant "${call.name}" during action recovery — ` +
                'its result is already in this run. Use a mutation tool or ask_user.',
              summary: `Skipped redundant ${call.name} call`,
              status: 'failed',
            };
        settled = [{ call, outcome, runtimeMs: now() - started, announced: true }];
      }

      // Fold the batch in original call order (reference pattern #2): results, notes,
      // callFacts, emitted events, and the stop-on-cancelled point are exactly what
      // serial execution produces for the same outcomes.
      for (const { call, outcome, runtimeMs, announced } of settled) {
        const cardExtra = cardExtraFor(call);
        if (!announced) {
          /* v8 ignore start -- E1.3 assertion: a concurrency-safe call must never produce
             ops or advance the working copy — every read/analysis outcome returns neither
             by construction (`runAgentCall`), so this only fires for a misregistered tool
             kind. Fail loud in dev; in prod, log and fold the outcome in original call
             order below (deterministic — exactly what serial execution would have done). */
          if (outcome.ops.length > 0 || outcome.project) {
            const message =
              `Concurrency-safe call "${call.name}" unexpectedly returned ` +
              `${outcome.ops.length} ops — misregistered tool kind?`;
            orchestratorLog.error(message, { tool: call.name });
            if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
              throw new Error(message);
            }
          }
          /* v8 ignore stop */
          yield emit.toolCall(call.id, call.name, 'running', cardExtra);
        }
        yield emit.toolCall(call.id, call.name, outcome.status, {
          runtimeMs,
          ...cardExtra,
        });
        // Card gets the SHORT summary; the popup gets the FULL result (`data`).
        yield emit.toolResult(call.id, {
          summary: outcome.summary,
          ...(outcome.data !== undefined ? { result: outcome.data } : {}),
        });
        // NOTE: `timeline_action` cards are emitted only AFTER the turn's ops pass
        // the validator and are applied (by the caller) — not here. Emitting them
        // per-op at call time claimed "Trimmed clip …" for edits the validator later
        // rejected (e.g. a trim that overlaps its neighbour), so a run could show a
        // wall of "Trimmed clip" rows yet produce an EMPTY combined diff with nothing
        // to apply. Actions now reflect what actually landed.
        turnOps.push(...outcome.ops);
        notes.push(outcome.note);
        turnStatuses.push(outcome.status);
        // Frames ride their own channel to the next request as real image content; the
        // action log gets only the FACTS about them (see `AgentCallOutcome.images`).
        if (outcome.images) frames.push(...outcome.images);
        // The three facts the reducer needs to tell reconnaissance from spinning. They are
        // only knowable HERE — the novelty key, the settled status, and whether the memo
        // served the call — so they travel with the turn instead of being recomputed.
        {
          // What this call means for the task stage (ADR 0075). Derived from the registry
          // rather than the model's description of what it was doing.
          const role = toolRole(call.name, getTool(call.name)?.mutates === true);
          // Distil WHILE THE PAYLOAD IS FRESH — the one moment the old design threw it
          // away instead of concluding anything from it.
          const distilled = distil({
            toolName: call.name,
            role,
            descriptor: describeToolCall(call, turnNames),
            summary: outcome.finding ?? outcome.summary,
            scope: evidenceScopeFor(call.name),
            status: outcome.status,
            fromCache: outcome.fromCache === true,
            ...(evidence.lookup(callMemoKey(call))
              ? { evidenceId: evidence.lookup(callMemoKey(call))!.id }
              : {}),
          });
          callFacts.push({
            key: callNoveltyKey(call),
            status: outcome.status,
            fromCache: outcome.fromCache === true,
            role,
            ...(distilled ? { distilled } : {}),
          });
        }
        if (outcome.rejectedOpCount) {
          rejectedOpCount += outcome.rejectedOpCount;
          rejectionNotes.push(outcome.note);
        }
        if (outcome.project) {
          turnCtx = { ...turnCtx, project: outcome.project };
          turnNames = projectNames(outcome.project);
        }
        // The user stopped the run while this call was in flight — don't start
        // the turn's remaining calls; the caller settles the turn as cancelled.
        // (E1.4: mid-batch abort folds this call as `cancelled` — never a checkmark —
        // and skips every remaining call and batch, matching the serial semantics.)
        if (outcome.status === 'cancelled') {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    return { turnOps, notes, turnStatuses, rejectedOpCount, rejectionNotes, callFacts, frames };
  }

  /**
   * Classify one command with a single small model call (ADR 0055). Never throws: an
   * unparseable reply, an unavailable provider, or an abort all degrade to the safe
   * {@link FALLBACK_CLASSIFICATION} (`edit`) so a routing hiccup runs the agent rather
   * than crashing the turn.
   */
  private async classifyCommand(
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<{
    classification: CommandClassification;
    /** The classifier call's real usage (C1), if the provider reported any. */
    usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
    readonly contextTokens: number;
    readonly contextEstimated: boolean;
    /** The classifier request's own context account (ADR 0080). */
    readonly manifest: ContextManifest;
  }> {
    const header = projectHeaderOf(input.project, input.targetPlatform);
    const messages = buildClassifierMessages({
      userText: input.userPrompt,
      header,
      ...(input.selection ? { selection: input.selection } : {}),
      hasSelection: input.selection !== undefined,
    });
    orchestratorLog.action('classifyCommand → request', {
      provider: this.provider.name,
      userTextChars: input.userPrompt.length,
    });
    const estimatedInput = messages.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    );
    // Classification is a small, self-contained call with no assembled tiers behind it,
    // so its manifest is payload-derived: honest about being coarse, but every figure
    // real. It is what makes the "thinking" phase's occupancy explainable too.
    const capabilities = capabilitiesFor(this.provider.name, this.provider.modelId);
    const manifest = buildRequestManifest({
      requestId: 'classify',
      provider: this.provider.name,
      ...(this.provider.modelId ? { model: this.provider.modelId } : {}),
      contextWindow: contextWindowFor(input, this.provider),
      windowSource: capabilities.source,
      reservedOutputTokens: reservedOutputFor(input, this.provider),
      request: { messages },
    });
    try {
      const response = await this.provider.complete({ messages }, signal);
      const classification = parseClassification(response.text) ?? FALLBACK_CLASSIFICATION;
      orchestratorLog.action('classifyCommand ← response', {
        provider: this.provider.name,
        route: classification.route,
        usage: response.usage,
      });
      return {
        classification,
        contextTokens: response.usage?.inputTokens ?? estimatedInput,
        contextEstimated: response.usage?.inputTokens === undefined,
        manifest: response.usage ? withProviderUsage(manifest, response.usage) : manifest,
        ...(response.usage ? { usage: response.usage } : {}),
      };
    } catch (error) {
      orchestratorLog.warn('classifyCommand failed — defaulting to edit', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        classification: FALLBACK_CLASSIFICATION,
        contextTokens: estimatedInput,
        contextEstimated: true,
        manifest,
      };
    }
  }

  /**
   * The intelligent, model-routed entry point (ADR 0055). One classification call reads the
   * *whole* command and picks the honest path — a greeting gets a direct reply (no
   * planning), a read-only question gets an answer (which may include LOOKING at frames),
   * an analysis-dependent edit gets the bounded planner, and everything else
   * (novel/creative/multi-step edits) runs the agent. This is what fixes the two keyword-
   * router failure modes documented in {@link ./kernel/command-classifier.ts}: greedy
   * template hijack and "hi" → full planning.
   *
   * Each non-chitchat route delegates to the SAME sub-stream the explicit modes use, so the
   * downstream behavior (events, self-check, cost) is identical — only the *decision* is now
   * model-made instead of keyword-made.
   */
  public async *streamAuto(
    input: ContextInput,
    options: StreamOptions,
    autoOptions: {
      readonly agentOptions?: AgentOptions;
      readonly controls?: AgentRunControls;
      readonly onLifecycleEvent?: (event: EditorRunStageEvent) => void;
      readonly temporalEvidence?: TemporalEvidenceAcquirer;
      readonly visionReview?: VisionRunReviewControls;
    } = {},
  ): AsyncGenerator<AiEvent> {
    const emit = createTurnEmitter(options);
    // A transient "thinking" while we classify — never an editing/planning status, so a
    // chitchat/question turn never trips the sidebar's "nothing changed" editing notice.
    yield emit.status('thinking');
    const {
      classification,
      usage: classifierUsage,
      contextTokens,
      contextEstimated,
      manifest: classifierManifest,
    } = await this.classifyCommand(input, options.signal);
    yield emit.contextUsage({
      usedTokens: contextTokens,
      contextWindow: classifierManifest.usage.modelContextLimit,
      estimated: contextEstimated,
      manifest: classifierManifest,
    });
    if (options.signal?.aborted) {
      yield emit.status('cancelled');
      return;
    }
    orchestratorLog.action('streamAuto classified', {
      route: classification.route,
      conversationId: options.conversationId,
    });
    const sharedEditorControls: EditorRunControls = {
      ...(autoOptions.onLifecycleEvent === undefined
        ? {}
        : { onLifecycleEvent: autoOptions.onLifecycleEvent }),
      ...(autoOptions.temporalEvidence === undefined
        ? {}
        : { temporalEvidence: autoOptions.temporalEvidence }),
      ...(autoOptions.visionReview === undefined ? {} : { visionReview: autoOptions.visionReview }),
    };
    switch (classification.route) {
      case 'chitchat':
        yield emit.assistant(emit.assistantId, classification.reply ?? DEFAULT_CHITCHAT_REPLY);
        yield emit.status('completed');
        return;
      case 'question':
        // E5.5: the question route asks through the same gate as agent mode — thread
        // the run's controls so `ask_user` can pause on a real answer instead of
        // degrading to "no one available".
        yield* this.streamChat(input, options, {
          ...(autoOptions.controls ? { controls: autoOptions.controls } : {}),
        });
        return;
      case 'edit':
        // Mark the turn as editing up front so an edit that ultimately applies nothing
        // still gets the sidebar's honest "nothing changed" notice — independent of which
        // statuses the delegated agent loop happens to emit (runOutcome.foldTurnEvent).
        yield emit.status('editing');
        // C1: the classifier call that routed here already spent real tokens — seed the
        // agent run's cost accumulator with it so the single terminal `usage` event this
        // run emits is the run's TRUE combined cost, not just the agent loop's own calls.
        yield* this.streamEditorRun(
          input,
          options,
          {
            route: 'agent',
            agentOptions: autoOptions.agentOptions ?? {},
            initialCost: { ...costFromUsage(classifierUsage, 'small'), modelCalls: 1 },
          },
          {
            ...sharedEditorControls,
            agent: autoOptions.controls ?? {},
          },
        );
        return;
    }
  }

  /**
   * Streaming Q&A (PRD §7.1): status → assistant deltas → terminal message.
   *
   * E5.5 (plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md): the question route now has
   * REAL tool use under its E5 scope — `read`/`analysis`/`ask` kinds only (see
   * {@link agentTools}). A Q&A turn can look things up and, crucially, put a question
   * back to the editor (`ask_user`, P12): the ask event pauses the stream on the run's
   * {@link AskUser} gate and the answer feeds the next turn, exactly as in agent mode.
   * Without `chatOptions.controls.askUser` an ask degrades honestly (`runAgentCall`).
   * Mutating/render calls are refused with an honest failed card — a question turn has
   * no apply step, so executing one would edit nothing and claim otherwise.
   */
  public async *streamChat(
    input: ContextInput,
    options: StreamOptions,
    chatOptions: { readonly controls?: AgentRunControls } = {},
  ): AsyncGenerator<AiEvent> {
    const emit = createTurnEmitter(options);
    yield emit.status('thinking');
    const assembled = assembleContext(input);
    yield* trimNotices(emit, assembled.trimmed);
    const tools = this.agentTools('question');
    const inScopeNames = new Set(tools.map((t) => t.name));
    // The rolling conversation this route owns: context + the route contract (what makes
    // ask_user the ONLY channel for questions — without it the model's chat prior wins
    // and it writes the question as unclickable markdown), then per-turn assistant text +
    // tool results (role 'tool'; providers without native tool messages fold it to user).
    const messages: AiMessage[] = [
      ...assembled.messages,
      {
        role: 'user',
        content: questionModeInstruction({
          canSeeFrames: supportsVision(this.provider.name, this.provider.modelId),
        }),
      },
    ];
    const ctx = this.toolContext(input);
    const names = projectNames(input.project);
    /** Where the last turn's frame images sit in `messages`, so they can be dropped. */
    let frameMessageIndex: number | undefined;
    // Per-run read memo/budget — same roles as the agent loop's, scoped to this turn.
    const evidence = new EvidenceStore();
    const loadedSkills = new Map<string, string>();
    const analysisBudget = createAnalysisBudget();
    const { runtime: effectRuntime, finish: finishEffects } = this.createRunRuntime(
      this.controlEffectExecutor(chatOptions.controls ?? {}),
    );
    try {
      for (let turn = 1; turn < QUESTION_ROUTE_TOOL_TURNS; turn += 1) {
        const segmentId = turn === 1 ? emit.assistantId : `${emit.assistantId}:seg-${turn}`;
        const result = yield* this.streamAssistant(
          emit,
          { messages, tools },
          options.signal,
          {
            kind: 'assistant',
            id: segmentId,
            captureReasoning: true,
          },
          effectRuntime,
          {
            tier: 'mid',
            contextWindow: contextWindowFor(input, this.provider),
            reservedOutputTokens: reservedOutputFor(input, this.provider),
            assembled,
          },
        );
        if (result.aborted) {
          yield emit.status('cancelled');
          return;
        }
        if (result.calls.length === 0) {
          yield emit.assistant(segmentId, result.text);
          yield emit.status('completed');
          return;
        }
        // The turn called tools: settle its text segment (if any), run the calls, and
        // thread the results into the next turn's messages.
        if (result.text.trim()) yield emit.assistant(segmentId, result.text.trim());
        const notes: string[] = [];
        /** Frames this turn's `get_frame` calls rendered, for the NEXT request's images. */
        let frames: readonly AiImage[] = [];
        const inScope: ToolCall[] = [];
        for (const call of result.calls) {
          if (inScopeNames.has(call.name)) {
            inScope.push(call);
            continue;
          }
          // Out-of-scope (mutating/render/unknown) — refuse with an honest failed card,
          // never a checkmark for an edit this route cannot apply.
          const note =
            `Refused "${call.name}" — a question turn can read, analyse, and ask, but ` +
            'never edit or render. Answer from what you know, or tell the editor what ' +
            'to ask for so an editing run can do it.';
          yield emit.toolCall(call.id, call.name, 'running', { title: call.name });
          yield emit.toolCall(call.id, call.name, 'failed', { title: call.name });
          yield emit.toolResult(call.id, { summary: note });
          notes.push(note);
        }
        if (inScope.length > 0) {
          // `awaiting_answer` when an ask is among them — the honest "paused on a person".
          yield emit.status(statusForToolCalls(inScope));
          const executed = yield* this.executeToolCalls(
            emit,
            inScope,
            ctx,
            names,
            effectRuntime,
            evidence,
            loadedSkills,
            chatOptions.controls?.askUser,
            options.signal,
            Date.now,
            analysisBudget,
            // A question turn can `ask_user` too, and an answer given there is just as
            // worth keeping as one given mid-edit.
            undefined,
            undefined,
            undefined,
            chatOptions.controls?.rememberDecision,
          );
          notes.push(...executed.notes);
          if (executed.turnStatuses.includes('cancelled')) {
            yield emit.status('cancelled');
            return;
          }
          frames = executed.frames;
        }
        messages.push(
          { role: 'assistant', content: result.text.trim() || '(requested tool calls)' },
          { role: 'tool', content: notes.join('\n') },
        );
        // The frames this turn rendered ride their own message to the NEXT request as
        // real image content — the same channel agent mode uses (`agentMessages`), for
        // the same reason. `get_frame`'s tool note says the frame "is attached as an
        // image"; without this push that claim was false on every Q&A turn, so the model
        // either refused to answer a question about footage it was told it could see, or
        // described a picture it never received. Images ride a `user` message because
        // that is the only role every wire format in `message-content.ts` accepts them
        // on, and the text carries `framesBlock` so several frames stay distinguishable.
        //
        // Attached ONCE, exactly as in agent mode: this route's `messages` is a growing
        // transcript, so an image left on it is re-sent — and re-billed — on every later
        // turn, and a stale picture of a moment the run has since asked about again sits
        // next to the current one with nothing telling them apart. The previous turn's
        // frame message is therefore stripped back to its words before the new one lands.
        //
        // The strip is unconditional, not paired with a new attachment: a turn that adds
        // no frame (it asked something else, or the run memo answered a repeat) must
        // still not leave the previous turn's picture hanging in the transcript, or the
        // model keeps answering about a moment it looked at two turns ago.
        if (frameMessageIndex !== undefined) {
          messages[frameMessageIndex] = {
            role: 'user',
            content: `${messages[frameMessageIndex]!.content}\n(Those images were attached to an earlier turn and are no longer shown.)`,
          };
          frameMessageIndex = undefined;
        }
        if (frames.length > 0) {
          frameMessageIndex = messages.length;
          messages.push({
            role: 'user',
            content: framesBlock(frames).trimStart(),
            images: frames,
          });
        }
        yield emit.status('thinking');
      }
      // Tool budget spent: one last call WITHOUT tools, so the model MUST answer — the
      // route always terminates in a real assistant message, never a dangling tool call.
      const finalId = `${emit.assistantId}:seg-final`;
      const final = yield* this.streamAssistant(
        emit,
        { messages },
        options.signal,
        { kind: 'assistant', id: finalId, captureReasoning: true },
        effectRuntime,
        {
          tier: 'mid',
          contextWindow: contextWindowFor(input, this.provider),
          reservedOutputTokens: reservedOutputFor(input, this.provider),
          assembled,
        },
      );
      if (final.aborted) {
        yield emit.status('cancelled');
        return;
      }
      yield emit.assistant(finalId, final.text);
      yield emit.status('completed');
    } finally {
      finishEffects();
    }
  }

  /** Streaming plan (PRD §7.3): a read-only, no-mutation, numbered edit plan. */
  public async *streamPlan(input: ContextInput, options: StreamOptions): AsyncGenerator<AiEvent> {
    const emit = createTurnEmitter(options);
    yield emit.status('planning');
    yield emit.reasoning(['Drafting an edit plan'], false);
    const assembled = assembleContext(input);
    yield* trimNotices(emit, assembled.trimmed);
    const messages = [
      ...assembled.messages,
      { role: 'user' as const, content: PLAN_MODE_INSTRUCTION },
    ];
    // No tools on a plan turn: the model must not call one, so their schemas are wasted
    // tokens and contradict the "plan only" instruction (see plan()).
    const result = yield* this.streamAssistant(
      emit,
      { messages },
      options.signal,
      { kind: 'assistant', id: emit.assistantId },
      undefined,
      {
        tier: 'mid',
        contextWindow: contextWindowFor(input, this.provider),
        reservedOutputTokens: reservedOutputFor(input, this.provider),
        assembled,
      },
    );
    yield emit.reasoning(['Drafting an edit plan'], true);
    if (result.aborted) {
      yield emit.status('cancelled');
      return;
    }
    yield emit.assistant(emit.assistantId, result.text);
    yield emit.status('completed');
  }

  /**
   * Streaming Cmd+K edit (PRD §7.2): assistant deltas → timeline-action cards →
   * a terminal {@link DiffEvent} wrapping the validated {@link EditResult}. The
   * validated-patch path is unchanged; nothing auto-applies (invariant 5).
   *
   * `editOptions.variations` (H1.5/P13.1, opt-in) runs {@link editVariations} instead —
   * see {@link streamEditVariations} for why that path is non-streaming and how its cost
   * is surfaced. Omitted/`false` is the exact, unchanged single-proposal behavior below.
   */
  /**
   * Single execution adapter for every timeline-mutating route.
   *
   * During migration this delegates to the proven route drivers byte-for-byte. Hosts
   * call this boundary so lifecycle, policy, and durable execution can converge without
   * browser/desktop dispatch forks or a flag day rewrite of the route internals.
   */
  public async *streamEditorRun(
    input: ContextInput,
    options: StreamOptions,
    request: EditorRunRequest,
    controls: EditorRunControls = {},
  ): AsyncGenerator<AiEvent> {
    const projector = controls.onLifecycleEvent
      ? new EditorRunLifecycleProjector({
          runId: options.runId ?? options.turnId,
          route: request.route,
          now: options.now ?? Date.now,
          emit: controls.onLifecycleEvent,
        })
      : undefined;
    let workingProject = input.project;
    const acquireTemporalEvidence = controls.temporalEvidence;
    const visionReview = controls.visionReview;
    const reviewRequested = acquireTemporalEvidence !== undefined || visionReview !== undefined;
    // Review is a READER (see `review-findings.ts`). It never proposes a patch, so the turn
    // loop remains the run's only writer and no turn ever waits on the review of the turn
    // before it. That is what lets an edit reach the timeline the moment it validates,
    // instead of after a multi-minute render batch.
    const findings = new ReviewFindingQueue(
      resolveReviewConcurrency(
        typeof process !== 'undefined' ? process.env[REVIEW_CONCURRENCY_ENV] : undefined,
      ),
    );
    // Findings reach the agent through the SAME queue a human's mid-run steering uses:
    // `runTurn` pops it at the top of every turn and folds it into that turn's context. A
    // finding is precisely that kind of next-boundary interjection, so it needs no channel
    // of its own. One is created when the host wired none, so the repair path exists on
    // every route rather than only the ones with a steering-capable UI attached.
    const steering = controls.agent?.steering ?? createSteeringQueue();
    const effectiveControls: EditorRunControls = reviewRequested
      ? { ...controls, agent: { ...(controls.agent ?? {}), steering } }
      : controls;
    const evidenceBase = (): { conversationId: string; turnId: string; ts: number } => ({
      conversationId: options.conversationId,
      turnId: options.turnId,
      ts: (options.now ?? Date.now)(),
    });
    const findingEvent = (finding: ReviewFinding, resolved: boolean): AiEvent => ({
      ...evidenceBase(),
      // Keyed by the finding, so a later `resolved` update REPLACES its card rather than
      // adding a second one claiming the same defect twice (the view reducer upserts by id).
      id: `${options.turnId}:finding:${finding.id}`,
      type: 'review_finding',
      turnIndex: finding.turnIndex,
      detail: finding.detail,
      resolved,
      lineage: finding.lineage,
      ...(finding.planStepId === undefined ? {} : { planStepId: finding.planStepId }),
      ...(finding.atSeconds === undefined ? {} : { atSeconds: finding.atSeconds }),
    });
    const publishFindings = function* (
      live: readonly ReviewFinding[],
      resolved: readonly ReviewFinding[],
    ): Generator<AiEvent> {
      for (const finding of resolved) yield findingEvent(finding, true);
      for (const finding of live) yield findingEvent(finding, false);
    };
    /**
     * Hand fresh findings to the agent — once per defect class.
     *
     * A finding whose class has already had its attempt is NOT re-pushed: it stays on the
     * user's screen as an open finding, but it no longer buys a turn. Unbounded re-steering
     * is what turned one unfixable defect (a black frame at every cut, caused by the
     * transition model rather than by any proposal) into a run that spent its whole budget
     * being told to fix it. The cap lives in `review-findings.ts`.
     */
    const steerFindings = (live: readonly ReviewFinding[]): readonly ReviewFinding[] => {
      if (live.length === 0) return [];
      const { steer, exhausted } = findings.admitForSteering(live);
      if (steer.length > 0) {
        steering.push(
          [
            REVIEW_STEERING_PREAMBLE,
            'Fix only these, then carry on with the request:',
            ...steer.map((finding, index) => `${String(index + 1)}. ${finding.detail}`),
          ].join('\n'),
        );
        findings.markDelivered(steer);
      }
      return exhausted;
    };
    try {
      // Fallback ordinal for routes whose diffs carry no `turnIndex` (the single-proposal
      // the `edit` route emits one `scope:'run'` diff). Findings still need a
      // monotonic key to compare against later edits.
      let turnOrdinal = 0;
      for await (const event of this.legacyEditorRun(input, options, request, effectiveControls)) {
        if (event.type === 'diff' && event.edit.validation.valid && event.edit.diff) {
          const before = event.scope === 'turn' ? workingProject : input.project;
          workingProject = applyProjectPatch(before, event.edit.patch);
          const turnIndex = event.turnIndex ?? turnOrdinal;
          turnOrdinal = turnIndex + 1;
          // Recorded for EVERY committed edit, reviewed or not: this is what later decides
          // whether an older finding still describes the live timeline.
          findings.recordTurn(turnIndex, touchedRegionOf(event.edit.diff));
          if (reviewRequested) {
            // A STARTER, not a started promise: the queue admits reviews under a
            // concurrency bound and declines outright any whose region a later turn has
            // already rewritten, so it must control when (and whether) the sidecar work
            // begins. Starting it here would restore the unbounded fan-out this queue
            // exists to prevent (see `ReviewFindingQueue`).
            const reviewed = workingProject;
            findings.track(turnIndex, (reviewSignal) => {
              // Either the user cancelling the run or the queue retiring a superseded
              // review must stop the render; whichever fires first wins.
              const combined = combineSignals(options.signal, reviewSignal);
              return this.reviewTurn({
                before,
                after: reviewed,
                edit: event.edit,
                turnIndex,
                ...(event.planStepId === undefined ? {} : { planStepId: event.planStepId }),
                ...(acquireTemporalEvidence === undefined
                  ? {}
                  : { temporal: acquireTemporalEvidence }),
                ...(visionReview === undefined ? {} : { vision: visionReview }),
                signal: combined.signal,
              }).finally(() => {
                combined.dispose();
              });
            });
          }
          // The edit goes out BEFORE any review is consulted. This ordering is the whole
          // point of the change and must not be reversed for convenience.
          projector?.observe(event);
          yield event;
          if (reviewRequested) {
            const settled = await findings.drainSettled();
            const repaired = findings.takeResolved();
            const exhausted = steerFindings(settled);
            yield* publishFindings(settled, repaired);
            // Say it out loud the moment the run stops retrying, rather than letting the
            // editor watch the same finding reappear and assume something is still working
            // on it. Named per defect, not per frame.
            for (const finding of exhausted) {
              yield {
                ...evidenceBase(),
                id: `${options.turnId}:finding-unfixed:${finding.id}`,
                type: 'warning',
                text: `The review still reports this after a correction attempt, so the run is not retrying it again: ${finding.detail} It is likely a render or transition-model defect rather than something this edit can fix.`,
              };
            }
          }
          continue;
        }
        if (event.type === 'status' && isTerminalStatus(event.status) && reviewRequested) {
          // The single place this run waits, and it is after the user already has every
          // edit. A finding that lands here is too late to steer — the agent has stopped —
          // so it surfaces unresolved for the user to act on. Reporting it is the honest
          // account; dropping it because the run is "done" would hide a real defect.
          const remaining = await findings.drainAll();
          const repaired = findings.takeResolved();
          yield* publishFindings(remaining, repaired);
          // The completion summary was already written from the DETERMINISTIC self-check, so
          // a run could tell the editor "all checks passed" while its own perceptual review
          // was still holding an unresolved defect. Amend the account here: the edits did
          // land and are valid, and this is what the review found about them.
          if (remaining.length > 0) {
            const notice: AiEvent = {
              ...evidenceBase(),
              id: `${options.turnId}:review-unresolved`,
              type: 'warning',
              text: `The perceptual review finished with ${String(remaining.length)} unresolved finding${remaining.length === 1 ? '' : 's'}. Your edits are applied and validated, but they are not perceptually clean: ${remaining.map((finding) => finding.detail).join(' ')}`,
            };
            projector?.observe(notice);
            yield notice;
          }
          // An unreachable reviewer is not a verdict about the edit, so it neither fails the
          // run nor lets it claim the work was checked. Say plainly which of the two happened.
          const failures = findings.reviewFailures;
          for (const [index, failure] of failures.entries()) {
            const notice: AiEvent = {
              ...evidenceBase(),
              id: `${options.turnId}:review-unavailable:${String(index)}`,
              type: 'warning',
              text: `Review could not run: ${failure} Your edits are applied and validated, but were not perceptually checked.`,
            };
            projector?.observe(notice);
            yield notice;
          }
        }
        projector?.observe(event);
        yield event;
      }
      projector?.finishWithoutTerminal('Legacy editor route ended without a terminal status.');
    } catch (error) {
      projector?.finishWithoutTerminal(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async acquireVisionRunReview(
    workingProject: Project,
    latestEdit: EditResult,
    controls: VisionRunReviewControls,
    signal?: AbortSignal,
  ): Promise<{
    readonly report: Awaited<ReturnType<typeof reviewVisionObjectives>>;
    readonly passed: boolean;
    /**
     * Whether the reviewer actually reached an adverse verdict, as opposed to
     * never having run.
     *
     * `passed === false` alone conflates two very different things: "I looked and
     * this is wrong" (`fail`) and "I could not look" (`unverified` — no reviewer
     * configured, no identity lineage, cancelled, or cloud review without
     * media-egress consent). They must not be treated alike: a refusal to run is
     * not evidence about the edit, and a privacy refusal in particular must never
     * be softened into a quality opinion.
     */
    readonly judged: boolean;
    readonly detail: string;
    readonly lineage: readonly string[];
  } | null> {
    const requests = planVisionObjectivesForEdit({ project: workingProject, edit: latestEdit });
    if (requests.length === 0) return null;
    const report = await reviewVisionObjectives({
      requests,
      projectRevision: workingProject.timeline.revision ?? 0,
      acquire: (request) => controls.acquire(workingProject, request, signal),
      judge: controls.judge,
      reviewer: controls.reviewer,
      ...(controls.mediaEgressConsent === undefined
        ? {}
        : { mediaEgressConsent: controls.mediaEgressConsent }),
      ...(signal === undefined ? {} : { signal }),
    });
    const passed = critique(workingProject, { vision: report }).checks.some(
      (check) => check.id === 'vision_review' && check.status === 'pass',
    );
    const unresolved = report.checks.filter((check) => check.status !== 'pass');
    const detail = unresolved
      .map((check) => `${check.requestId}: ${check.reason}`)
      .join(' ')
      .slice(0, 1000);
    return {
      report,
      passed,
      judged: report.checks.some((check) => check.status === 'fail'),
      detail: detail || `${report.checks.length} semantic objective(s) confirmed.`,
      lineage: [
        `vision:revision=${report.projectRevision}`,
        `vision:transport=${controls.reviewer.transport}`,
        `vision:provider=${controls.reviewer.provider}`,
        `vision:model=${controls.reviewer.model}`,
        `vision:prompt=${controls.reviewer.promptVersion}`,
        ...(controls.reviewer.packVersion === undefined
          ? []
          : [`vision:pack=${controls.reviewer.packVersion}`]),
        ...(controls.mediaEgressConsent === undefined
          ? []
          : [`vision:consent=${controls.mediaEgressConsent.consentId}`]),
        `vision:decision=${passed ? 'pass' : 'fail'}`,
        ...report.checks.map((check) => `vision:request=${check.requestId}:${check.status}`),
        ...report.checks.flatMap((check) =>
          check.frames.map((frame) => `vision:frame=${check.requestId}:${frame}`),
        ),
      ],
    };
  }

  private async acquireTemporalRunReview(
    originalProject: Project,
    workingProject: Project,
    latestEdit: EditResult,
    acquire: TemporalEvidenceAcquirer,
    signal?: AbortSignal,
  ): Promise<{
    readonly report: TemporalReviewReport;
    readonly passed: boolean;
    readonly repairable: boolean;
    readonly detail: string;
    readonly lineage: readonly string[];
  } | null> {
    const durationFrames = Math.max(
      1,
      Math.ceil(timelineDuration(workingProject.timeline) * workingProject.fps),
    );
    const requests = planTemporalEvidenceForEdit({
      projectRevision: workingProject.timeline.revision ?? 0,
      edit: {
        ...latestEdit,
        diff: {
          before: originalProject.timeline,
          after: workingProject.timeline,
          summary: latestEdit.diff?.summary ?? [],
        },
      },
      sequenceFps: workingProject.fps,
      durationFrames,
    });
    if (requests.length === 0) return null;
    const acquisition = await acquire(workingProject, requests, signal);
    const report = reviewTemporalEvidence(requests, acquisition.results);
    const passed = critique(workingProject, { temporal: report }).checks.some(
      (check) => check.id === 'temporal_evidence' && check.status === 'pass',
    );
    const failing = report.checks.filter((check) => check.status !== 'pass');
    const detail = failing
      .map((check) => `${check.requestId}: ${check.issues.join(' ')}`)
      .join(' ')
      .slice(0, 1000);
    return {
      report,
      passed,
      repairable: failing.length > 0 && failing.every((check) => check.status === 'fail'),
      detail,
      lineage: [
        `temporal:revision=${report.projectRevision}`,
        `temporal:render-settings=${acquisition.renderSettings.identity}`,
        `temporal:decision=${passed ? 'pass' : 'fail'}`,
        ...report.evidenceRequestIds.map((requestId) => `temporal:request=${requestId}`),
      ],
    };
  }

  /**
   * Review one already-applied edit and report what is wrong with it, if anything.
   *
   * This is the read-only half of the old perceptual gate. It runs the same acquirers and
   * the same {@link critique} checks, and differs in exactly one respect: it cannot write.
   * Where the gate used to call back into {@link streamEdit} for a bounded repair — making
   * the run's second writer, and forcing every turn to wait for the review of the turn
   * before it — this returns findings. The agent repairs them in an ordinary turn.
   *
   * Never throws for an edit-quality reason. A rejection here means the REVIEWER failed, and
   * {@link ReviewFindingQueue} records that as a failure rather than a verdict, because an
   * unreachable reviewer says nothing at all about the edit.
   */
  private async reviewTurn(args: {
    readonly before: Project;
    readonly after: Project;
    readonly edit: EditResult;
    readonly turnIndex: number;
    readonly planStepId?: string;
    readonly temporal?: TemporalEvidenceAcquirer;
    readonly vision?: VisionRunReviewControls;
    readonly signal?: AbortSignal;
  }): Promise<readonly ReviewFinding[]> {
    const region = touchedRegionOf(args.edit.diff);
    const scope: ReviewFindingScope = {
      projectRevision: args.after.timeline.revision ?? 0,
      patchId: args.edit.patch.patchId,
      trackIds: region.trackIds,
      clipIds: region.clipIds,
    };
    const atSeconds = earliestTouchedSecond(args.after, region);
    const found: ReviewFinding[] = [];
    const base = {
      turnIndex: args.turnIndex,
      scope,
      ...(args.planStepId === undefined ? {} : { planStepId: args.planStepId }),
      ...(atSeconds === undefined ? {} : { atSeconds }),
    };

    if (args.temporal) {
      const review = await this.acquireTemporalRunReview(
        args.before,
        args.after,
        args.edit,
        args.temporal,
        args.signal,
      );
      if (review && !review.passed) {
        found.push({
          ...base,
          id: `temporal:${args.edit.patch.patchId}`,
          detail: review.detail || 'Temporal review could not confirm this edit.',
          lineage: review.lineage,
        });
      }
    }

    if (args.vision) {
      const vision = await this.acquireVisionRunReview(
        args.after,
        args.edit,
        args.vision,
        args.signal,
      );
      // `judged` separates "I looked and this is wrong" from "I could not look" — a cloud
      // reviewer without media-egress consent refuses rather than disapproves, and softening
      // that privacy refusal into a quality opinion would quietly reverse the user's default
      // (ADR 0120).
      if (vision && !vision.passed && vision.judged) {
        found.push({
          ...base,
          id: `vision:${args.edit.patch.patchId}`,
          detail: vision.detail,
          lineage: vision.lineage,
        });
      }
    }

    return found;
  }

  private legacyEditorRun(
    input: ContextInput,
    options: StreamOptions,
    request: EditorRunRequest,
    controls: EditorRunControls,
  ): AsyncGenerator<AiEvent> {
    switch (request.route) {
      case 'edit':
        return this.streamEdit(input, options, request.variations ? { variations: true } : {});
      case 'agent':
        return this.streamAgent(
          input,
          options,
          request.agentOptions ?? {},
          controls.agent ?? {},
          request.initialCost ?? { tokens: 0, usd: 0, modelCalls: 0 },
        );
    }
  }

  public async *streamEdit(
    input: ContextInput,
    options: StreamOptions,
    editOptions: { readonly variations?: boolean } = {},
  ): AsyncGenerator<AiEvent> {
    if (editOptions.variations) {
      yield* this.streamEditVariations(input, options);
      return;
    }
    const emit = createTurnEmitter(options);
    yield emit.status('editing');
    const assembled = assembleContext(input);
    yield* trimNotices(emit, assembled.trimmed);
    const result = yield* this.streamAssistant(
      emit,
      { messages: assembled.messages, tools: toolDescriptors((t) => t.mutates) },
      options.signal,
      { kind: 'assistant', id: emit.assistantId, captureReasoning: true },
      undefined,
      {
        tier: 'mid',
        contextWindow: contextWindowFor(input, this.provider),
        reservedOutputTokens: reservedOutputFor(input, this.provider),
        assembled,
      },
    );
    if (result.aborted) {
      yield emit.status('cancelled');
      return;
    }
    const reason = result.text || 'AI edit';
    yield emit.assistant(emit.assistantId, reason);

    const ctx = this.toolContext(input);
    // Recover per call: one malformed tool call must not discard the other,
    // valid calls of the same edit. Each failure is surfaced as a warning; the
    // run only fails when EVERY call was rejected (there is no edit to review).
    const operations: AnyOperation[] = [];
    const callErrors: string[] = [];
    for (const call of result.calls) {
      try {
        operations.push(...this.operationsFor(call, ctx));
      } catch (error) {
        callErrors.push((error as ToolInvocationError).message);
      }
    }
    for (const message of callErrors) yield emit.warning(message);
    if (result.calls.length > 0 && operations.length === 0 && callErrors.length > 0) {
      yield emit.error(callErrors.join('; '), { retryable: true });
      yield emit.status('failed');
      return;
    }
    const names = projectNames(input.project);
    for (const op of operations) {
      const described = describeOperation(op, names);
      yield emit.timelineAction(described.action, described.detail, described.refs);
    }
    yield emit.diff(this.assemble(input, operations, reason));
    yield emit.status('completed');
  }

  /**
   * The opt-in variations run behind `streamEdit(..., { variations: true })` (H1.5/P13.1).
   *
   * Non-streaming under the hood ({@link editVariations} uses `provider.complete()`, not
   * live token deltas) because a `stream()` transport has no channel for real token usage
   * on its terminal chunk, and this feature's entire point is an HONEST combined cost
   * across every real candidate call — never just the first one (P7.1/P7.2 cost-honesty).
   * The turn still reads as one coherent run: a status, the FIRST candidate's rationale +
   * timeline-action cards (a preview of what "Take A" contains), a single `diff` event
   * carrying every candidate in `variants`, a `usage` event with the REAL combined cost,
   * then `completed` — so the existing per-turn cost chip (`AiSidebar`'s `signals.cost`
   * fold) picks it up with no separate UI plumbing.
   */
  private async *streamEditVariations(
    input: ContextInput,
    options: StreamOptions,
  ): AsyncGenerator<AiEvent> {
    const emit = createTurnEmitter(options);
    yield emit.status('editing');
    const assembled = assembleContext(input);
    yield* trimNotices(emit, assembled.trimmed);
    const { variants, cost } = await this.editVariations(input, options.signal);
    if (options.signal?.aborted) {
      yield emit.status('cancelled');
      return;
    }
    if (variants.length === 0) {
      yield emit.assistant(emit.assistantId, 'No alternative edits could be proposed.');
      yield emit.status('failed');
      return;
    }
    const primary = variants[0]!;
    yield emit.assistant(emit.assistantId, primary.text);
    const names = projectNames(input.project);
    for (const op of primary.patch.operations) {
      const described = describeOperation(op, names);
      yield emit.timelineAction(described.action, described.detail, described.refs);
    }
    yield emit.diff(primary, variants.length > 1 ? variants : undefined);
    yield emit.usage(cost);
    yield emit.status('completed');
  }

  /**
   * Streaming agent run (PRD §7.4): the multi-step tool-calling agent, emitting live
   * `reasoning`/`plan`/`tool_call`/`tool_result`/`timeline_action` events and a terminal
   * combined {@link DiffEvent}. As of K1.3 this is a thin driver over the Conductor
   * kernel: it compiles the run into a {@link Command} + execution handlers
   * ({@link agentRun}) and drives them through {@link runAgentGraph}, which owns the run
   * state machine (budget caps, spin guard, checkpoint/resume, verify + repair). The
   * public signature and `AsyncGenerator<AiEvent>` surface are unchanged — a drop-in.
   *
   * The Conductor's `finalize` handler settles the run (diff + report + reasoning +
   * status) on every normal or cancelled exit; the `try/catch` here reproduces the old
   * loop's error path: a provider call that throws mid-run (or an abort racing a
   * non-streaming `complete()`) is settled by {@link agentRun}'s `settle` — a retryable
   * error card + the partial diff, or a plain `cancelled`, then the terminal status. The
   * validated-patch gate is unchanged; nothing auto-applies.
   *
   * `initialCost` (C1) seeds the run's cost accumulator — {@link streamAuto} passes the
   * ADR 0055 classifier call's real usage here so this run's single terminal `usage`
   * event is the whole turn's true combined cost, not just the agent loop's own calls.
   * Every other caller omits it (defaults to zero), unaffected.
   */
  public async *streamAgent(
    input: ContextInput,
    options: StreamOptions,
    agentOptions: AgentOptions = {},
    controls: AgentRunControls = {},
    initialCost: RunCostSeed = { tokens: 0, usd: 0, modelCalls: 0 },
  ): AsyncGenerator<AiEvent> {
    orchestratorLog.action('streamAgent start', {
      provider: this.provider.name,
      prompt: input.userPrompt?.slice(0, 200),
      planFirst: agentOptions.planFirst ?? false,
      requirePlanApproval: agentOptions.requirePlanApproval ?? false,
      conversationId: options.conversationId,
    });
    const { command, handlers, settle } = this.agentRun(
      input,
      options,
      agentOptions,
      controls,
      initialCost,
    );
    try {
      yield* runAgentGraph(command, handlers, options.signal);
      orchestratorLog.action('streamAgent finished', { conversationId: options.conversationId });
    } catch (error) {
      orchestratorLog.error('streamAgent threw — settling partial run', { error: String(error) });
      yield* settle(error);
    }
  }

  /**
   * Compile one agent run into the Conductor {@link Command}, its execution handlers,
   * and a throw-settling generator (K1.2/K1.3, plan/AI-ORCHESTRATION-REDESIGN.md §7).
   *
   * Each handler seeds its emitter at the reducer's current `state.seq` and returns the
   * advanced `endSeq`, so the split control/execution event stream stays byte-identical
   * to the old single-emitter loop. They reuse the SAME turn mechanics —
   * {@link generateAgentPlan}, {@link streamAssistant}, {@link executeToolCalls},
   * {@link applyAgentTurn}, {@link attemptRepair}, {@link critique}, `assembleEdit` —
   * so the run's control flow cannot diverge from how a turn actually executes. The
   * run's mutable execution state (working copy, log, reasoning, applied ops, memos)
   * lives in this closure; the reducer owns the run's decision state.
   *
   * `settle` reproduces the old loop's `catch`/`finally`: when a provider call throws
   * (or an abort races a non-streaming call), the terminal diff + reasoning + status
   * are emitted from the closure's partial state, seeded at `seqAtThrow()` (the seq the
   * throwing handler had reached) so ids stay byte-identical to the old loop.
   *
   * {@link streamAgent} drives this via {@link runAgentGraph}; {@link agentConductorHandlers}
   * exposes just the handlers for the parity harness.
   */
  private agentRun(
    input: ContextInput,
    options: StreamOptions,
    agentOptions: AgentOptions,
    controls: AgentRunControls = {},
    initialCost: RunCostSeed = { tokens: 0, usd: 0, modelCalls: 0 },
  ): {
    command: Command;
    handlers: ConductorHandlers;
    settle: (error: unknown) => AsyncGenerator<AiEvent>;
  } {
    // `async function*` handlers below carry their own `this`; capture the instance so
    // they can reuse the orchestrator's shared turn mechanics without `.bind` (which
    // would erase their contextual parameter types).
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- generator handlers need the instance
    const self = this;
    // ADR 0057: agent runs advertise the bundled skills manifest by default.
    input = this.withSkills(input);
    const now = options.now ?? Date.now;
    const signal = options.signal;
    const maxOpsPerTurn = agentOptions.maxOpsPerTurn ?? DEFAULT_MAX_OPS_PER_TURN;
    const { runtime: effectRuntime, finish: finishEffects } = this.createRunRuntime(
      this.controlEffectExecutor(controls),
    );
    // Per-run evidence store (see `HostCallContext.evidence`): a repeat read on an
    // unchanged working copy is served from here and marked non-novel, so re-reading is
    // never mistaken for progress. Cleared inside `runAgentCall` when an edit lands.
    const evidence = new EvidenceStore();
    const beatEvidence: { current?: unknown; hardSync?: boolean } = {};
    // ADR 0057: per-run skill ledger — shared across the run's turns AND its repair
    // pass, so a playbook is fetched once and stays pinned in context for the rest of
    // the run (see `HostCallContext.loadedSkills` / `agentSkillsBlock`).
    const loadedSkills = new Map<string, string>();
    // Per-run analysis budget (B5.4) — same role as the non-streaming loop's; shared
    // across the run's turns AND its repair pass so the ceiling is truly per-run.
    const analysisBudget = createAnalysisBudget(agentOptions.analysisCaps);
    // Agent continuity: snapshot the run-start timeline so a mid-run delete that
    // would clear a whole track of this pre-run work is rejected (see wipe-guard.ts).
    // Undefined when the user's own prompt asked for a reset — then wiping IS the goal.
    const wipeGuard = wipeGuardFor(input.userPrompt, input.project);
    const appliedPatchIds = new Set<string>();
    const log: string[] = [];
    let plan: readonly string[] | undefined;
    let working: Project = input.project;
    // Mirror of the reducer's cumulative applied ops; feeds the completion report and
    // keeps the closure's view of "what landed" in lockstep with the reducer.
    const cumulativeOps: AnyOperation[] = [];
    // C1: the run's real, priced cost — accumulated across the classifier call (seeded
    // via `initialCost`), each turn's `streamAssistant` call (`runTurn`), and the Critic
    // repair pass (`runVerify`/`attemptRepair`'s `onUsage`). Mirrors `editVariations`'s
    // plain-number accumulator (no `CostLedger` needed — the agent loop's direct
    // provider calls have no per-call tier to fold by). Emitted once, in `finalize`/
    // `settle`, alongside the terminal diff.
    let usageTokens = initialCost.tokens;
    let usageUsd = initialCost.usd;
    /**
     * Did any call this run return real evidence about what is IN the footage?
     *
     * The completion report says so when a montage was assembled without any (see
     * `UNEVIDENCED_SHOT_CAVEAT_THRESHOLD`) — the captured run chose nine source spans out of
     * 575 seconds with nothing read about the content, and told the editor its choices came
     * from a footage map it had never asked for.
     */
    let sawContentEvidence = false;
    /**
     * The last applying turn's off-grid measurement, for the completion account.
     *
     * A cut a few frames off the beat is ordinary editing, not a failure — but the editor
     * should still be told, in the same breath as the edits themselves, rather than finding
     * out by watching it.
     */
    let offGridNote: string | undefined;
    /**
     * Frames the LAST turn rendered, waiting to be shown to the model on the next one.
     *
     * WHY only the last turn's, and why they are cleared once sent: a frame is only
     * evidence about the timeline AS IT WAS when it was taken. Keeping every frame a run
     * has ever grabbed would (a) re-bill each of them on every subsequent turn and (b)
     * put stale pictures of a timeline the run has since edited next to the current one,
     * with nothing distinguishing them.
     */
    let pendingFrames: readonly AiImage[] = [];
    // How many model calls this run actually made — incremented at every call site
    // REGARDLESS of whether the provider reported usage for it. This is what lets the
    // sidebar tell a deterministic recipe (0 calls, honestly free) apart from a run
    // whose provider returned no usage report (calls > 0, cost unknown, and emphatically
    // not "no AI needed"). See `UsageEvent.modelCalls`.
    /* v8 ignore next -- unreachable today: every caller either omits `initialCost` entirely (the default already sets `modelCalls: 0`) or passes it with `modelCalls` explicitly stamped (see `streamAuto`'s edit route), so the `?? 0` never actually fires. */
    let modelCalls = initialCost.modelCalls ?? 0;
    // The emitter of the handler currently executing; `settle` reads its seq so a mid-run
    // throw continues the run's one-off id sequence exactly where it stopped. Seeded with a
    // zero-seq emitter so the reader is total even before the first handler runs — a throw
    // only originates inside a handler that has already swapped in its own emitter, so this
    // seed is unreachable in practice and matches the old loop's seq-0 fallback.
    let activeEmit = createTurnEmitter(options, 0);
    const seqAtThrow = (): number => activeEmit.seq();

    // One run id for the whole streamed run (plan B5.3), stamped on every per-turn diff
    // (ADR 0056) + the repair diff so a host can collapse the burst into a SINGLE
    // review/undo step. Derived from the run's stable turn id (deterministic — golden
    // snapshots stay stable across runs) rather than a clock/random value.
    const analysisRunId = `run:${options.turnId}`;

    /** A turn result with the fixed fields the reducer ignores for early exits. */
    const turnBase = (
      stepIndex: number,
      endSeq: number,
      over: Partial<AgentTurnResult>,
    ): AgentTurnResult => ({
      kind: 'agent_turn',
      stepIndex,
      aborted: false,
      done: false,
      anyToolCancelled: false,
      anyToolFailed: false,
      turnOpCount: 0,
      rejectedOpCount: 0,
      rejectionNotes: [],
      applied: false,
      appliedOps: [],
      describedActions: [],
      signature: '',
      callFacts: [],
      note: '',
      planSteps: [],
      planStepIndex: 0,
      intent: '',
      log: [...log],
      endSeq,
      ...over,
    });

    const handlers: ConductorHandlers = {
      // R3 C4: draft the up-front plan (a read-only model call). The reducer seeds the
      // ledger + emits `plan`/`status('thinking')`; here we emit `status('planning')`
      // and thread the labels into every turn's context.
      draftPlan: async function* (
        _effect: DraftPlanEffect,
        state: ConductorState,
      ): AsyncGenerator<AiEvent, ConductorResult> {
        const emit = createTurnEmitter(state.turnRef, state.seq);
        activeEmit = emit;
        yield emit.status('planning');
        const drafted = await self.generateAgentPlan(input, signal, effectRuntime);
        orchestratorLog.action('agent plan drafted', {
          steps: drafted.steps,
          hasProse: Boolean(drafted.message),
        });
        plan = drafted.steps;
        // The plan's prose (intro line / a clarifying question) is a CHAT message, not a
        // todo row (U2): surface it as its own assistant segment so the checklist stays
        // clean. The numbered steps flow on to the reducer as the ledger labels.
        if (drafted.message) yield emit.assistant(`${emit.assistantId}:plan-note`, drafted.message);
        return { kind: 'draft_plan', labels: [...drafted.steps], endSeq: emit.seq() };
      },

      // R3 C2: rebuild the working copy from the checkpoint's ops so the loop continues
      // from the interruption point; fall back to a fresh run with an honest notice if
      // those ops no longer validate against the (changed) project.
      resume: async function* (
        _effect: ResumeEffect,
        state: ConductorState,
      ): AsyncGenerator<AiEvent, ConductorResult> {
        const emit = createTurnEmitter(state.turnRef, state.seq);
        activeEmit = emit;
        // onCommand only emits `resume` when a resume checkpoint with ops is present.
        const checkpoint = agentOptions.resume!;
        const replay = assembleEdit(
          input.project,
          [...checkpoint.ops],
          input.userPrompt || 'Resume',
          'agent',
        );
        if (replay.validation.valid) {
          working = applyProjectPatch(input.project, replay.patch);
          cumulativeOps.push(...checkpoint.ops);
          appliedPatchIds.add(replay.patch.patchId);
          log.push(...checkpoint.log);
          // A settled, informational reasoning block keyed to its own node so it doesn't
          // collide with the per-step thinking blocks (no per-run reasoning node anymore).
          yield emit.reasoning(
            [
              `Resuming from step ${checkpoint.stepsCompleted} — kept ${checkpoint.ops.length} edit${checkpoint.ops.length === 1 ? '' : 's'}`,
            ],
            true,
            'resume',
          );
          return {
            kind: 'resume',
            ok: true,
            ops: [...checkpoint.ops],
            log: [...log],
            stepsCompleted: checkpoint.stepsCompleted,
            endSeq: emit.seq(),
          };
        }
        yield emit.warning(
          'Could not resume the previous run (the project changed) — pausing for reconciliation.',
        );
        return {
          kind: 'resume',
          ok: false,
          ops: [],
          log: [],
          stepsCompleted: 0,
          endSeq: emit.seq(),
        };
      },

      // P11.3: pause the run and await the creator's approve/cancel decision on a
      // high-blast-radius drafted plan. `controls.planApproval` is the live,
      // non-serialisable resolver a host wires (see `run-controls.ts`); when the
      // reducer gated the plan but no resolver was wired (a bug elsewhere, or a
      // non-UI caller like a test/parity harness), default to `approved` rather than
      // hanging the run forever — never a silent deadlock.
      awaitApproval: async function* (
        effect: AwaitApprovalEffect,
        state: ConductorState,
      ): AsyncGenerator<AiEvent, ConductorResult> {
        const emit = createTurnEmitter(state.turnRef, state.seq);
        activeEmit = emit;
        if (!controls.planApproval) {
          // The reducer gated this plan but no host resolver was wired — degrade
          // honestly and loudly rather than hang the run forever on an unresolvable
          // Promise (never a silent deadlock).
          yield emit.warning(
            'Plan approval was required but no approval handler was wired — continuing automatically.',
          );
          return { kind: 'approval', decision: 'approved', endSeq: emit.seq() };
        }
        const approval = await effectRuntime.run(
          {
            kind: 'user_wait',
            control: {
              effectId: `${options.turnId}:plan-approval`,
              taskId: `${options.turnId}:plan`,
              idempotencyKey: `user_wait:plan:${options.turnId}`,
              resourceClass: 'user',
              timeoutMs: USER_WAIT_TIMEOUT_MS,
              retryClass: 'never',
              sideEffectClass: 'idempotent',
            },
            gateKind: 'plan_approval',
            gateId: `${options.turnId}:plan-approval`,
            payload: effect.planSteps.map((step) => step.label),
          },
          signal,
        );
        /* v8 ignore start -- a `{ kind: 'user_wait', gateKind: 'plan_approval' }` request
           always settles a matching structured outcome (see effect-runtime.ts's
           runStructured); kept as a defensive type-narrowing guard. */
        if (
          approval.kind !== 'structured' ||
          approval.effectKind !== 'user_wait' ||
          (approval.outcome !== 'approved' && approval.outcome !== 'cancelled')
        ) {
          throw new Error('Plan approval effect returned an unexpected decision.');
        }
        /* v8 ignore stop */
        const decision = approval.outcome;
        return { kind: 'approval', decision, endSeq: emit.seq() };
      },

      // One agent turn: stream the model into its own segment, run the turn's tools,
      // flip the ledger step to `running`, assemble+validate the patch. The reducer
      // emits the terminal plan/timeline events + decides stop/continue.
      runTurn: async function* (
        effect: RunTurnEffect,
        state: ConductorState,
      ): AsyncGenerator<AiEvent, ConductorResult> {
        const emit = createTurnEmitter(state.turnRef, state.seq);
        activeEmit = emit;
        const index = effect.stepIndex;

        // Top-of-loop cancellation (streamAgent's `if (signal.aborted) break`).
        if (signal?.aborted) return turnBase(index, emit.seq(), { aborted: true });

        // P11.4 mid-run steering: pop any message the editor queued while this run was
        // in flight and fold it into THIS turn's context — a queued, next-boundary
        // interjection (not an instant mid-step redirect; see `run-controls.ts`).
        const steeringMessage = controls.steering?.take();
        if (steeringMessage) {
          log.push(`Steering: "${steeringMessage}"`);
          // An editor's own words are echoed back verbatim — that IS the receipt, and the
          // steering input clears its "queued" note off this exact text. The review's
          // instruction is not the editor's words: it is an internal prompt carrying request
          // ids and raw measurements, and echoing it printed
          // "edit_audio_0: Audio peak 0.08913551514039704 dBFS exceeds -0.1 dBFS" on screen
          // as product copy. The findings already have their own cards, so this says only
          // that the run is acting on them.
          yield emit.notification(
            steeringMessage.startsWith(REVIEW_STEERING_PREAMBLE)
              ? 'Acting on what the review found in the edits so far.'
              : `Steering applied: "${steeringMessage}"`,
          );
        }

        const names = projectNames(working);
        const segmentId = `${emit.assistantId}:seg-${index}`;
        // Pre-request invariants (ADR 0080). A turn that goes out with no objective or
        // no next action leaves the model nothing to continue from, so it re-explores the
        // whole project — the behaviour that reads as "the agent forgot everything".
        // Repair what state already implies; say so plainly when it cannot be repaired,
        // rather than letting the model compensate by starting over.
        /* v8 ignore next -- RunTurnEffect.working is optional on the type (additive, for the legacy loop and older fixtures per its own doc comment), but every REAL run_turn effect dispatched here comes from conductor.ts#runTurnEffect, which always sets working unconditionally — the undefined side is not reachable through the live gateway/conductor path today. */
        const invariants = effect.working ? ensureContextInvariants(effect.working) : undefined;
        if (invariants && invariants.unrecovered.length > 0) {
          yield emit.warning(describeUnrecovered(invariants.unrecovered));
          // Integrity loss is an execution barrier. Do not call the model and do not
          // expose mutating tools while the durable ledger cannot authorize this turn.
          return turnBase(index, emit.seq(), {
            done: true,
            note: 'Run paused because its objective or committed plan could not be recovered.',
          });
        }
        /* v8 ignore next -- see the guard above: `effect.working` is always defined on the live path, so `invariants` is always defined too once we reach here, and the `?? effect.working` fallback never runs. */
        const taskMemory = invariants?.state ?? effect.working;
        // C2: the turn's assistant text is about to stream, before its tool calls (if
        // any) are even known — `generating` is the specific, honest status for that
        // phase (vs. the generic `editing` the caller set for the whole run).
        yield emit.status('generating');
        /** One attempt at this turn's model call. Re-callable — see the retry below. */
        const streamOnce = (attempt: number) =>
          self.streamAssistant(
            emit,
            {
              messages: self.agentMessages(
                input,
                working,
                log,
                loadedSkills,
                plan,
                steeringMessage,
                effect.actionRecovery,
                taskMemory,
                pendingFrames,
              ),
              // Stage-scoped surface (ADR 0075 §3.6): action recovery still wins when it
              // fires, but an executing run is closed to fresh reconnaissance regardless.
              tools: effect.actionRecovery
                ? self.agentTools('action-recovery')
                : self.agentTools('agent', effect.stage),
            },
            signal,
            // Per-step thinking (U3, redesign §12): each step captures the model's
            // reasoning into its OWN node `${turnId}:reasoning:${index}`, so an agent run's
            // thinking blocks stay distinct, ordered, and interleaved with that step's tool
            // cards — never a single per-run accordion that later steps overwrite. A retry
            // gets its own segment id so it cannot overwrite the attempt it replaces.
            {
              kind: 'assistant',
              id: attempt === 0 ? segmentId : `${segmentId}:retry-${String(attempt)}`,
              captureReasoning: true,
              reasoningKey: index,
            },
            effectRuntime,
            {
              tier: 'mid',
              contextWindow: contextWindowFor(input, self.provider),
              reservedOutputTokens: reservedOutputFor(input, self.provider),
              // The run's durable memory rides with the request so the composer can say
              // "memory intact" while the prompt itself shrinks between turns.
              /* v8 ignore next -- taskMemory is always defined on the live path (see the effect.working guard above), so the empty-object fallback never runs. */
              ...(taskMemory ? { memory: memoryStatusFrom(taskMemory) } : {}),
            },
          );
        let turn = yield* streamOnce(0);
        modelCalls += 1;
        // A DROPPED OR CUT-OFF STEP IS NOT AN ANSWER, so retry it here rather than let the
        // run end on it. `ResilientProvider` cannot help: it retries a stream only before
        // the first chunk, and both failures arrive after a 200 — an empty completion, or a
        // reply that stops mid-clause with no tool call. In the captured run the second one
        // ended a three-and-a-half-minute turn on the words "Rebuilding the 30 seconds as a
        // 23-shot", and the first failed a whole run the UI had labelled retryable.
        let unusable = unusableTurnReason(turn, state.cumulativeOps.length, effect.stage);
        for (
          let attempt = 1;
          unusable !== undefined && !turn.aborted && attempt <= MAX_UNUSABLE_TURN_RETRIES;
          attempt += 1
        ) {
          log.push(`Step ${index}: ${unusable} model response — retrying (attempt ${attempt}).`);
          // The attempt being replaced was still billed, so fold its usage in before it is
          // overwritten; the surviving attempt is folded in by the block below, once.
          if (turn.usage) {
            const supersededCost = costFromUsage(turn.usage);
            usageTokens += supersededCost.tokens;
            usageUsd += supersededCost.usd;
          }
          turn = yield* streamOnce(attempt);
          modelCalls += 1;
          unusable = unusableTurnReason(turn, state.cumulativeOps.length, effect.stage);
        }
        // The frames went out with that request; they must not ride the next turn's too
        // (see `pendingFrames`). Cleared after the retry loop rather than before it, so a
        // retried attempt still carries evidence the failed attempt never got to use, and
        // an aborted request does not silently discard it either.
        pendingFrames = [];
        // C1: fold this turn's real model-call usage into the run's cost accumulator.
        if (turn.usage) {
          const cost = costFromUsage(turn.usage);
          usageTokens += cost.tokens;
          usageUsd += cost.usd;
        }
        if (unusable === 'truncated' && !turn.aborted) {
          // Publishing the fragment would make a cut-off sentence the run's last word.
          yield emit.warning(
            'The model ran out of output room mid-reply and asked for no tool call, on every attempt. Nothing was applied. Retry, or ask for a smaller step.',
          );
          return turnBase(index, emit.seq(), {
            done: true,
            note: 'The model response was truncated before it proposed anything.',
          });
        }
        if (turn.aborted) return turnBase(index, emit.seq(), { aborted: true });

        if (turn.calls.length === 0) {
          // A turn with NEITHER prose NOR a tool call is not a finished run — it is a turn
          // that never happened. The provider had nothing to report (a gateway that fails
          // after 200 headers, a truncated stream, a model that returned an empty
          // completion), and reading that silence as "the model has nothing to add" is how
          // an upstream outage used to reach the creator as "Done — no further edits." on a
          // timeline nothing had touched. Say what actually happened instead: honour work
          // earlier turns already landed, and fail loudly when there is none.
          if (!turn.text.trim()) {
            // The bounded retry above has already been spent, so this is the provider
            // failing repeatedly rather than a single dropped request.
            const detail =
              'The model returned an empty response — no answer and no tool call, on every ' +
              'attempt. This is usually the provider dropping the request (overloaded or ' +
              'rate-limited).';
            if (state.cumulativeOps.length > 0) {
              log.push(`Step ${index}: empty model response — keeping the edits already applied.`);
              yield emit.warning(`${detail} The edits from earlier steps are kept.`);
              return turnBase(index, emit.seq(), { done: true, note: detail });
            }
            log.push(`Step ${index}: empty model response — nothing to apply.`);
            throw new ProviderError(detail, 'server');
          }
          log.push(`Step ${index}: ${turn.text}`);
          yield emit.assistant(segmentId, turn.text);
          return turnBase(index, emit.seq(), { done: true });
        }

        const intent = turn.calls.map((c) => describeToolCall(c, names)).join(', ');
        if (turn.text.trim()) yield emit.assistant(segmentId, turn.text.trim());

        const ctx = self.toolContext({ ...input, project: working });
        // U2: turns map positionally onto the seeded ledger; past it — or with none —
        // each turn appends its own derived step.
        const stepIdx = index - 1 < effect.ledgerLength ? index - 1 : effect.planSteps.length;
        const seeded = effect.planSteps[stepIdx];
        const running: PlanStep = seeded
          ? { ...seeded, status: 'running', detail: intent }
          : { id: `step-${index}`, label: intent, status: 'running' };
        const planSteps: PlanStep[] = seeded
          ? effect.planSteps.map((s, i) => (i === stepIdx ? running : s))
          : [...effect.planSteps, running];
        // Only render a checklist when a plan was actually drafted up front. Unplanned
        // agent runs keep `planSteps` in reducer state (below, for status/threshold logic)
        // but emit NO plan node — otherwise the ledger grows one pinned row per step for
        // the whole run. The step's own reasoning + tool cards are the visible activity.
        if (effect.ledgerLength > 0) yield emit.plan([...planSteps]);

        // C2: the turn's calls are now known — announce the specific, honest status for
        // what they're about to do before running them (never per-call, just once here).
        yield emit.status(statusForToolCalls(turn.calls));
        const signature = turnSignature(turn.calls);
        /* v8 ignore next 5 -- taskMemory is always defined on the live path (see the effect.working guard above), so the `undefined` side never runs. */
        const decisionId = taskMemory
          ? taskMemory.plan.decisionIds[Math.min(stepIdx, taskMemory.plan.decisionIds.length - 1)]
          : undefined;
        /* v8 ignore next 4 -- unreachable on the live path: by the time any run_turn effect fires, `commitExecutionPlan` has already run (immediately in onCommand for a plain run, or in onDraftPlanResult before the first turn for planFirst), so `plan.id`/decisionId are always set here; the `null` fallback guards a total function, not a live case today. */
        const idempotencyPrefix =
          taskMemory?.plan.id && decisionId
            ? `${taskMemory.runId}:${taskMemory.plan.id}:${decisionId}:${signature}:`
            : null;
        if (
          taskMemory &&
          idempotencyPrefix &&
          taskMemory.operations.some(
            (operation) =>
              operation.status === 'succeeded' &&
              operation.idempotencyKey.startsWith(idempotencyPrefix),
          )
        ) {
          yield emit.notification('Skipped an already committed operation during retry recovery.');
          return turnBase(index, emit.seq(), {
            done: true,
            note: 'Idempotency hit: this planned operation already succeeded.',
          });
        }
        const { turnOps, notes, turnStatuses, rejectedOpCount, rejectionNotes, callFacts, frames } =
          yield* self.executeToolCalls(
            emit,
            turn.calls,
            ctx,
            names,
            effectRuntime,
            evidence,
            loadedSkills,
            controls.askUser,
            signal,
            now,
            analysisBudget,
            wipeGuard,
            effect.actionRecovery
              ? new Set(self.agentTools('action-recovery').map((tool) => tool.name))
              : undefined,
            beatEvidence,
            controls.rememberDecision,
          );
        if (callFacts.some(isContentEvidenceFact)) sawContentEvidence = true;
        // Hand this turn's frames to the NEXT request (see `pendingFrames`).
        pendingFrames = frames;
        const anyToolFailed = turnStatuses.includes('failed');
        const common = {
          planSteps,
          planStepIndex: stepIdx,
          intent,
          // The turn's own prose, so the reducer can tell whether four differently-worded
          // turns were the same turn (ADR 0075 §3.5).
          rationale: turn.text,
          signature,
          callFacts,
          rejectedOpCount,
          rejectionNotes,
          // E4.1: the turn's real reported usage, so the reducer can measure the
          // output-token delta this turn actually produced (diminishing-returns stop).
          ...(turn.usage ? { usage: turn.usage } : {}),
        };

        // Stop mid-turn: the interrupted turn is not applied; its step says why.
        if (turnStatuses.includes('cancelled')) {
          log.push(`Step ${index}: stopped by user mid-turn.`);
          return turnBase(index, emit.seq(), {
            ...common,
            anyToolCancelled: true,
            anyToolFailed,
            turnOpCount: turnOps.length,
          });
        }

        // Blast-radius bound: the reducer emits the `failed` step + warning.
        if (turnOps.length > maxOpsPerTurn) {
          return turnBase(index, emit.seq(), {
            ...common,
            anyToolFailed,
            turnOpCount: turnOps.length,
          });
        }

        const applied = self.applyAgentTurn({
          index,
          rationale: turn.text,
          toolCalls: turn.calls.map((c) => c.name),
          notes,
          turnOps,
          working,
          appliedPatchIds,
          rawBeats: beatEvidence.current,
          beatHardSync: beatEvidence.hardSync === true,
        });
        if (applied.offGrid) offGridNote = applied.offGrid;
        log.push(`Step ${index}: ${applied.record.note}`);
        const describedActions: DescribedAction[] = [];
        if (applied.applied) {
          working = applied.working;
          cumulativeOps.push(...turnOps);
          for (const op of turnOps) {
            const d = describeOperation(op, names);
            describedActions.push({ action: d.action, detail: d.detail, refs: d.refs });
          }
          // Per-turn diff (ADR 0056): surface each validated turn's patch the moment it
          // lands so the host commits it mid-run instead of waiting for the whole run.
          // The finalize/settle paths emit NO combined diff — these turn-scoped diffs are
          // the run's only applyable output.
          if (applied.edit) {
            // The step this edit IS the outcome of, so a host can render it as that step's
            // own result rather than a second card restating what the step already says.
            // Taken from the ledger rather than rebuilt from the index, so the two cannot
            // drift apart.
            //
            // Only when a plan was actually DRAFTED. An unplanned run still carries
            // `planSteps` internally for status tracking but never renders a checklist
            // (see conductor.ts's `ledgerLength > 0`), so stamping one here would point the
            // host at a step that does not exist on screen and the receipt would vanish.
            const planStepId = plan && plan.length > 0 ? planSteps[stepIdx]?.id : undefined;
            yield emit.diff(applied.edit, undefined, {
              scope: 'turn',
              turnIndex: index,
              runId: analysisRunId,
              ...(planStepId === undefined ? {} : { planStepId }),
            });
          }
        }
        return turnBase(index, emit.seq(), {
          ...common,
          anyToolFailed,
          turnOpCount: turnOps.length,
          applied: applied.applied,
          appliedOps: applied.applied ? [...turnOps] : [],
          describedActions,
          note: applied.record.note,
          ...(applied.rejection === undefined ? {} : { rejection: applied.rejection }),
          ...(applied.satisfied === true ? { satisfied: true } : {}),
        });
      },

      // Self-check + one bounded repair pass (R3 C3). Repair's applied ops surface as
      // action cards + a notice + their own turn-scoped diff here (ADR 0056); the
      // reducer emits the Self-check notices from the returned (post-repair) report.
      runVerify: async function* (
        _effect: RunVerifyEffect,
        state: ConductorState,
      ): AsyncGenerator<AiEvent, ConductorResult> {
        const emit = createTurnEmitter(state.turnRef, state.seq);
        activeEmit = emit;
        let report = critique(
          working,
          self.critiqueOptions(input, agentOptions, state.cumulativeOps.length > 0),
        );
        const repairOps: AnyOperation[] = [];
        if ((agentOptions.autoRepair ?? true) && !report.ok) {
          const repair = await self.attemptRepair({
            input,
            working,
            log,
            report,
            stepIndex: state.planSteps.length + 1,
            appliedPatchIds,
            rawBeats: beatEvidence.current,
            beatHardSync: beatEvidence.hardSync === true,
            maxOpsPerTurn,
            effectRuntime,
            loadedSkills,
            analysisBudget,
            // A repair is the last turn of the SAME run, so it is briefed with what that
            // run established rather than fixing against context it has to re-derive.
            taskMemory: state.working,
            ...(signal ? { signal } : {}),
            // C1: fold the repair pass's real model-call usage into the run's cost
            // accumulator (the same closure `runTurn` above folds each turn's into).
            onUsage: (usage) => {
              modelCalls += 1;
              const cost = costFromUsage(usage, 'large');
              usageTokens += cost.tokens;
              usageUsd += cost.usd;
            },
          });
          if (repair && repair.ops.length > 0) {
            // Assemble the repair patch against the PRE-repair working project — that is
            // the timeline state its ops were validated against inside attemptRepair.
            const repairEdit = assembleEdit(working, [...repair.ops], 'Repair pass', 'agent');
            working = repair.working;
            repairOps.push(...repair.ops);
            cumulativeOps.push(...repair.ops);
            const names = projectNames(working);
            for (const op of repair.ops) {
              const d = describeOperation(op, names);
              yield emit.timelineAction(d.action, d.detail, d.refs);
            }
            // The repair pass is one more applied turn (ADR 0056) — surface its patch
            // like any other turn so auto mode applies it and manual mode can review it.
            yield emit.diff(repairEdit, undefined, {
              scope: 'turn',
              turnIndex: state.planSteps.length + 1,
              runId: analysisRunId,
            });
            yield emit.notification(`Repair pass: ${repair.step.note}`);
            report = critique(working, self.critiqueOptions(input, agentOptions, true));
          }
        }
        const failedChecks = report.checks
          .filter((c) => c.status === 'fail')
          .map((c) => ({ label: c.label, detail: c.detail }));
        return {
          kind: 'verify',
          ok: report.ok,
          summary: report.summary,
          failedChecks,
          repairOps,
          endSeq: emit.seq(),
        };
      },

      // Terminal artefacts: the completion report (when the run landed edits and wasn't
      // cancelled), then the settled reasoning + status. NO combined diff here — every
      // applied turn already emitted its own `scope:'turn'` diff (ADR 0056); a combined
      // finalize diff would double-apply in hosts that consume per-turn diffs.
      finalize: async function* (
        effect: FinalizeEffect,
        state: ConductorState,
      ): AsyncGenerator<AiEvent, void> {
        const emit = createTurnEmitter(state.turnRef, state.seq);
        // C1: the run's real, combined cost (classifier + every turn + any repair pass) —
        // emitted once at the terminal boundary, mirroring `streamRecipe`/
        // the single terminal `emit.usage(...)` contract every route shares.
        yield emit.usage({ tokens: usageTokens, usd: usageUsd, modelCalls });
        if (!effect.cancelled && !effect.failed && effect.ops.length > 0) {
          yield emit.assistant(
            emit.assistantId,
            agentCompletionReport({
              ops: effect.ops,
              names: projectNames(working),
              steps: Math.max(effect.appliedTurns, 1),
              rejectedOpCount: effect.rejectedOpCount,
              rejectionReasons: effect.rejectionReasons,
              contentEvidence: sawContentEvidence,
              ...(offGridNote ? { offGrid: offGridNote } : {}),
            }),
          );
        }
        // No run-level reasoning settle here: each step settled its OWN reasoning node
        // (per-step ids), so there is no shared per-run node left spinning.
        yield emit.status(effect.cancelled ? 'cancelled' : effect.failed ? 'failed' : 'completed');
        finishEffects();
      },
    };

    // `agentOptions` is always an object here (streamAgent defaults it to `{}`), and
    // `onCommand` reads `command.agentOptions ?? {}`, so passing `{}` ≡ omitting it.
    const command: Command = {
      kind: 'submit_turn',
      mode: 'agent',
      input,
      stream: options,
      agentOptions,
    };

    // Reproduce the old loop's catch/finally: a provider call threw mid-run. An abort
    // that raced a non-streaming call (the up-front plan / repair `complete()`) is the
    // user's cancellation, not a failure — no error card, terminal `cancelled`. Any
    // other throw surfaces a retryable error card and settles `failed`. Partial work is
    // already represented by the per-turn diffs emitted before the throw (ADR 0056) —
    // no trailing combined diff. Seeded at `seqAtThrow()` so ids continue the sequence.
    const settle = async function* (error: unknown): AsyncGenerator<AiEvent> {
      const emit = createTurnEmitter(options, seqAtThrow());
      const aborted = options.signal?.aborted ?? false;
      if (!aborted) {
        yield emit.error(
          error instanceof Error ? error.message : 'The agent run failed unexpectedly.',
          { retryable: true },
        );
      }
      // C1: a run that threw mid-flight can still have spent real tokens (the classifier,
      // completed turns, a repair call) — settle honestly with whatever cost accrued
      // before the throw, same as `finalize`'s normal-exit emission.
      yield emit.usage({ tokens: usageTokens, usd: usageUsd, modelCalls });
      // Per-step reasoning nodes each settled themselves (streamAssistant's abort-safe
      // settle) — no shared per-run node to close here.
      yield emit.status(aborted ? 'cancelled' : 'failed');
      finishEffects();
    };

    return { command, handlers, settle };
  }

  /**
   * The Conductor execution handlers for one agent run — the parity harness's seam
   * onto {@link agentRun}. {@link streamAgent} itself uses `agentRun` directly so it
   * also gets the run's {@link Command} and the throw-settling generator.
   */
  public agentConductorHandlers(
    input: ContextInput,
    options: StreamOptions,
    agentOptions: AgentOptions = {},
  ): ConductorHandlers {
    return this.agentRun(input, options, agentOptions).handlers;
  }
}

/** Markdown completion report closing an agent run that applied edits (U3). Exported for tests. */
export function agentCompletionReport(args: {
  ops: readonly AnyOperation[];
  names?: ReturnType<typeof projectNames>;
  steps: number;
  rejectedOpCount: number;
  rejectionReasons: readonly string[];
  /**
   * Whether any call this run made returned real evidence about what is IN the footage
   * (see `CONTENT_EVIDENCE_TOOLS`). Absent ⇒ treated as evidence gathered, so callers that
   * do not track it are unchanged.
   */
  contentEvidence?: boolean;
  /**
   * Interior cuts the run left deliberately off the detected beat grid, as measured. Present
   * only when the run analyzed beats and did not declare hard sync.
   */
  offGrid?: string;
}): string {
  const maxLines = 10;
  // Collapse lines that render identically. Eight successive restyles of one caption track
  // describe ONE outcome to the person reviewing it — the last one is what they will see —
  // and printing the same sentence eight times reads as a malfunction rather than a receipt.
  // Only the RENDERED line is compared, so two edits that differ in any way the editor can
  // see still get their own row; this hides repetition, never distinct work.
  const counts = new Map<string, number>();
  for (const op of args.ops) {
    const line = operationLine(op, args.names);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const distinct = [...counts.entries()];
  const lines = distinct
    .slice(0, maxLines)
    .map(([line, count]) => `- ${line}${count > 1 ? ` (×${count})` : ''}`);
  const more = distinct.length - maxLines;
  if (more > 0) lines.push(`- …and ${more} more`);
  const head = `**Applied ${args.ops.length} edit${args.ops.length === 1 ? '' : 's'}** in ${args.steps} step${args.steps === 1 ? '' : 's'} — review the proposed change below.`;
  const skipped =
    args.rejectedOpCount > 0
      ? `\n\n**Skipped:** ${args.rejectedOpCount} proposed change${args.rejectedOpCount === 1 ? '' : 's'} did not validate (${args.rejectionReasons.join('; ')}).`
      : '';
  // An honest receipt for a montage chosen blind. The captured run picked nine spans out of
  // 575 seconds having read nothing about the content, and told the editor the choices came
  // from a footage map it never asked for. The edit still stands — the editor may well have
  // wanted exactly this — but they should know what it was based on.
  const placedShots = args.ops.filter((op) => op.type === 'add_clip').length;
  const unevidenced =
    args.contentEvidence === false && placedShots >= UNEVIDENCED_SHOT_CAVEAT_THRESHOLD
      ? `\n\nHeads up: these ${String(placedShots)} shots were chosen from timings alone — nothing was read about what is actually in the footage. Ask for a footage map, or for specific moments, if you want the selection grounded in content.`
      : '';
  // Reported, never apologised for: the cut stands, and the editor gets the number.
  const offGrid = args.offGrid === undefined ? '' : `\n\n${args.offGrid}`;
  return `${head}\n\n${lines.join('\n')}${skipped}${unevidenced}${offGrid}`;
}

/** Render a {@link CritiqueReport} as a compact human-readable block. */
function formatReport(report: CritiqueReport): string {
  const lines = report.checks.map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`);
  return [report.summary, ...lines].join('\n');
}
