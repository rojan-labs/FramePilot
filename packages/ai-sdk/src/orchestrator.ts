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
import {
  DEFAULT_SILENCE_CUT,
  SilenceRangesPayloadSchema,
  noCutsNote,
  silenceCutOps,
} from './silence-cut.js';
import {
  type AnyOperation,
  type ValidationIssue,
  applyProjectPatch,
  projectChanged,
} from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import {
  DEFAULT_DUCK_DB,
  MusicAssetPayloadSchema,
  buildAddMusicOps,
  musicDuckEmptyTrackNote,
  musicDuckRefusalKey,
  musicDuckSidechainIssue,
} from './music-placement.js';
import { StockAssetPayloadSchema, stockOpsFromPayload } from './stock-placement.js';
import {
  AUTOMATIC_TRACKING_TOOL_NAME,
  AutomaticTrackingMeasurementSchema,
  automaticTrackingOpsFromMeasurement,
} from './domain-tools/automatic-tracking.js';
import { clipCandidates } from './domain-tools/clip-candidates.js';
import { tracksCoveredByPictureInFront } from './domain-tools/picture-layers.js';
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
import {
  asksForPreview,
  asksForRenderedFile,
  asksToRememberPreference,
  checkableAcceptance,
  explicitCutawayCount,
} from './acceptance.js';
import { referenceDirectives, shotLengthTolerance } from './references/directives.js';
import { type EditResult, assembleEdit, describeValidationIssue } from './assemble.js';
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
  explicitDurationTarget,
  repairTrailingSoundOverrun,
  standingAgainstAcceptance,
  timelineDuration,
  reconcileInheritedFailures,
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
  type ToolDomain,
  SKILL_DOMAINS,
  domainMembers,
  toolDomain,
  toolIsAdvertised,
} from './tool-domains.js';
import {
  AGENT_MAX_OPS_PER_RUN,
  AGENT_MAX_OPS_PER_TURN,
  DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
  DIMINISHING_RETURNS_TURNS,
  PLAN_STEP_HEADROOM,
  STALL_CONFIRM_TURNS,
  maxWallMsFor,
  type RepairOutcome,
  type TurnCallFact,
  turnLearnedSomethingNew,
} from './kernel/conductor.js';
import { type AnalysisBudget, createAnalysisBudget } from './kernel/cost/analysis-caps.js';
import { estimateUsd } from './kernel/cost/cost-meter.js';
import { EDIT_LOOK_TOOL_NAMES, stageAllowsTool, toolRole } from './kernel/stage-policy.js';
import { classifyTool, isCatalogueSearch } from './tool-classification.js';
import { deriveObjectiveText } from './kernel/continuation.js';
import { catalogueSearchRefusal, shouldWithholdCatalogueSearch } from './kernel/loop-detector.js';
import { buildStateBriefing, distil } from './kernel/briefing.js';
import { createNarrationFilter } from './kernel/narration.js';
import { withResolvedAssetId } from './catalogue-asset-id.js';
import { describeUnrecovered, ensureContextInvariants } from './kernel/context/invariants.js';
import { EvidenceStore, evidenceScopeFor } from './kernel/evidence-store.js';
import { hostRefusalFor, type HostPatchRefusal } from './kernel/commit-ledger.js';
import { recordHostRefusal } from './kernel/working-state.js';
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
  type TemporalEvidenceRequest,
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
  agentVerifyFixBlock,
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
  toolSchemaCost,
  withProviderUsage,
} from './kernel/context/manifest.js';
import { ProviderError } from './reliability/types.js';
import type { ContextBudget, ContextTier, Usage } from './reliability/types.js';
import { plainRunFailure } from './reliability/plain-failure.js';
import {
  unavailableToolNote,
  unknownToolNote,
  unusableHostPayload,
} from './reliability/refusal-notes.js';
import type { AgentRunControls, AskUser, AskUserOption } from './run-controls.js';
import { createSteeringQueue } from './run-controls.js';
import { combineSignals } from './reliability/signals.js';
import { createRunDeadline } from './reliability/deadline.js';
import { neverSucceededTools } from './reliability/unfinished-work.js';
import type { NeverSucceededTool, ToolAttempt } from './reliability/unfinished-work.js';
import type { TimerApi } from './reliability/timeout.js';
import {
  MODEL_WAIT_HEARTBEAT_MS,
  modelWaitLabel,
  withWaitHeartbeat,
} from './reliability/wait-heartbeat.js';
import {
  REVIEW_CONCURRENCY_ENV,
  REVIEW_STEERING_PREAMBLE,
  ReviewFindingQueue,
  describeFindings,
  resolveReviewConcurrency,
  touchedRegionOf,
  type ReviewFinding,
  type ReviewFindingScope,
  type TouchedRegion,
} from './review-findings.js';
import { BUNDLED_SKILLS, skillsByName } from './skills.js';
import { rebaseEditorInteractionContext } from './editor-context/interaction-context.js';
import { MAX_IDENTITY_KEY_CHARS, boundedKeySegment } from './stable-key.js';
import type { ToolContext } from './tool-context.js';
import { stockCutawayCapRefusal } from './domain-tools/timeline.js';
import {
  ToolInvocationError,
  describeArgValidationError,
  operationsForCall,
  sanitizeToolArgs,
} from './tool-dispatch.js';
import { type HostToolExecutor, type HostToolOutcome } from './tool-executor.js';
import type { RefusalCause } from './tool-refusal.js';
import { withToolInputContract } from './tool-input-contract.js';
import { toolContract } from './tool-contract.js';
import { concurrencySafe, getTool, toolDescriptors } from './tool-registry.js';
import { recordToolRun } from './run-log.js';
import { IMPLICIT_ONLY_TOOL_NAMES, QUESTION_ROUTE_PERMISSIONS, selectTools } from './tool-scope.js';

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
   * Whether {@link reservedOutputTokens} is a cap someone actually CHOSE — a caller's
   * `budget.maxOutputTokens` — rather than the figure derived from the model's
   * capabilities. See {@link outputRoomFor}: a derived figure for a model we do not
   * recognise is a guess, and a guess must not go on the wire as a hard limit.
   */
  readonly explicitOutputCap?: boolean;
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
 * The `maxTokens` to put on the wire for one model call, or `undefined` to send none.
 *
 * ## Why an assumed ceiling must NOT be sent
 *
 * `maxOutputTokens` does two different jobs, and the conservative-floor rule is right for
 * one of them and actively harmful for the other:
 *
 * - **Reserving room in the context budget.** Under-promising is safe: the prompt is
 *   trimmed a little early and the request succeeds.
 * - **The `max_tokens` we put on the wire.** Under-promising is not safe at all. It does
 *   not make the request safer; it *cuts the model off mid-reply*.
 *
 * For a model the catalog does not carry, `capabilitiesFor` returns the provider's floor
 * and says so via `source: 'provider_default'` — "we do not know this model". Sending that
 * guess as a hard cap asserts a limit nobody measured.
 *
 * Run `e8cb2636` is what that costs. `openrouter/auto` is not in the catalog, so every
 * request went out with `max_tokens: 8192` — and three consecutive steps came back having
 * spent **exactly 8,192** output tokens. Two recovered on their retry; the third did not,
 * and the run stopped with the stock footage it had just downloaded still sitting in the
 * bin, unplaced. The model was never near its own limit. It was near ours.
 *
 * So a derived figure for an unrecognised model is omitted, and the provider applies the
 * model's real maximum: `@langchain/openai` sends no `max_tokens` when it is not given one,
 * and `@langchain/anthropic` — whose API requires the field — fills in its own per-model
 * default. A cap a caller actually CHOSE is always sent, and a recognised model's ceiling
 * is a measured number, so both still go on the wire.
 *
 * The reservation is unchanged: the budget still holds the conservative figure back, which
 * is the half of this that was always right. Exported for tests.
 */
export function outputRoomFor(
  provider: AiProvider | undefined,
  modelCall: { readonly reservedOutputTokens?: number; readonly explicitOutputCap?: boolean },
): number | undefined {
  const capability = capabilitiesFor(provider?.name, provider?.modelId);
  const assumed = capability.source === 'provider_default' && modelCall.explicitOutputCap !== true;
  if (assumed) return undefined;
  const reserved = modelCall.reservedOutputTokens ?? capability.maxOutputTokens;
  return Math.max(1, Math.min(reserved, capability.maxOutputTokens));
}

/**
 * Headroom kept for the estimator's own drift. Same value the default budget has always
 * used; named here because it now applies to every model rather than only to the one
 * hardcoded 190K window.
 */
const BUDGET_HEADROOM_TOKENS = 2000;

/**
 * Resolve the budget the trimmer decides against for THIS request (context-management
 * P1.2).
 *
 * Two bugs, one fix. Until this existed, no production caller ever set `budget`: every
 * request in the app trimmed against `DEFAULT_CONTEXT_BUDGET`'s 183,904 tokens whatever
 * model was selected — 159,328 more room than `ollama/qwen2.5-coder` has, and 799,136
 * less than Gemini's. `contextWindowFor` already resolved the real window, but only for
 * the manifest the UI reads, never for the trimmer that acts on it. And the assembler
 * cannot see the tool schemas, the mode instruction or the pinned playbooks the caller
 * attaches afterwards, which on a planning turn is the larger part of the prompt.
 *
 * An explicitly supplied budget still wins, in whole: a caller that constrains the prompt
 * has said what it means, and `contextWindowFor`'s precedence rule is the same one.
 *
 * @param input - The request being assembled.
 * @param provider - The provider/model actually selected.
 * @param reservedPromptTokens - Fixed cost this route pays outside `assembleContext`.
 */
/**
 * Which surface a turn advertises.
 *
 * `commit-only` is `agent` minus the catalogue searches — the scope a run enters once it
 * holds sourcing candidates it has not spent. See `Orchestrator.agentTools` for why it
 * withholds so little, and {@link shouldWithholdCatalogueSearch} for when it engages.
 */
export type AgentToolScope = 'agent' | 'question' | 'action-recovery' | 'commit-only';

export function resolveContextBudget(
  input: ContextInput,
  provider: AiProvider | undefined,
  reservedPromptTokens: number,
): ContextBudget {
  const capabilities = capabilitiesFor(provider?.name, provider?.modelId);
  return {
    contextWindow: input.budget?.contextWindow ?? capabilities.contextWindow,
    maxOutputTokens: input.budget?.maxOutputTokens ?? capabilities.maxOutputTokens,
    headroom: input.budget?.headroom ?? BUDGET_HEADROOM_TOKENS,
    reservedPromptTokens: input.budget?.reservedPromptTokens ?? reservedPromptTokens,
  };
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

/**
 * Blast-radius bounds for one agent run (R3 C1).
 *
 * Both are imported, not declared. This file used to hold its own smaller `maxOpsPerTurn`
 * (100) and enforce it in the streaming path, while `kernel/conductor.ts` held 200 and
 * reported it — so a 101-to-200-operation turn was dropped by the enforcing half and never
 * seen by the reporting half. See {@link AGENT_MAX_OPS_PER_TURN} for what that cost.
 */
const DEFAULT_MAX_OPS_PER_TURN = AGENT_MAX_OPS_PER_TURN;
const DEFAULT_MAX_OPS_PER_RUN = AGENT_MAX_OPS_PER_RUN;
const USER_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/** How many recent step notes the agent context keeps verbatim before digesting (B4). */
/** The default when no executor declares anything unroutable: nothing is withheld. */
const EMPTY_TOOL_NAMES: ReadonlySet<string> = new Set();
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
 * Picture clips this run has actually put on the timeline.
 *
 * `add_clip` specifically, not "any applied operation": the captured run applied
 * seventeen operations — thirteen assets into the bin, three layers, one music clip — and
 * had nothing to show. Counting those as commitment would release the commit-only latch on
 * exactly the act it exists to distinguish from an edit.
 */
function placementCount(ops: readonly AnyOperation[]): number {
  return ops.filter((op) => op.type === 'add_clip').length;
}

/** Evidence handles this run banked from a catalogue search. */
function bankedSearchCount(working: RunWorkingState | undefined): number {
  return (working?.evidence ?? []).filter((handle) => isCatalogueSearch(handle.source)).length;
}

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
/**
 * The message appended to a retry after a cut-off reply. Exported for tests.
 *
 * WHY a message and not a silent retry: the model has no way to know its last reply was
 * truncated — from its side the conversation simply continues — so an identical retry
 * produces an identical, identically cut-off reply. Telling it, and asking for smaller
 * steps, is what turns the second attempt into a different one.
 */
export function truncationRetryHint(dropped: readonly string[] = []): string {
  const base =
    'Your previous reply was cut off before any tool call completed, so nothing was ' +
    'applied. Do the same work in smaller pieces: make at most four tool calls now, ' +
    'with short arguments, and continue with the rest on the next turn.';
  if (dropped.length === 0) return base;
  // Naming the tools is what makes the second attempt DIFFERENT. Without it the model
  // has no way to know which of its asks never arrived — the conversation, from its side,
  // simply continues — so it repeats the same batch and it is cut at the same place.
  const names = [...new Set(dropped)].join(', ');
  return (
    `${base} The arguments for ${names} arrived incomplete and were discarded, so ` +
    'nothing from that call ran. Re-issue it on its own, with the shortest arguments ' +
    'that still do the job.'
  );
}

/**
 * What to tell the creator when a step came back with no answer and no tool call.
 *
 * Two very different causes wear the same empty completion, and only one of them is the
 * provider's fault:
 *
 * - the request was dropped after a 200 — an overloaded or rate-limited gateway;
 * - the model spent its ENTIRE output budget on reasoning and had nothing left to say
 *   with. A reasoning model behind a conservative output cap does this readily, and the
 *   billing proves it: the turn is charged for the whole reservation.
 *
 * The captured run was the second, charged 8,192 output tokens against an 8,192-token
 * reservation, and was told the provider was overloaded — an explanation that pointed the
 * creator at the one thing they could not have changed. The fix for that run is a bigger
 * output reservation or a smaller step, and the message now says so.
 *
 * `usage` absent ⇒ nothing was reported, so the cause is unknowable and the message stays
 * the general one. Exported for tests.
 */
export function emptyResponseDetail(
  usage: Usage | undefined,
  /** The `max_tokens` this request actually carried, or `undefined` when it carried none. */
  sentOutputCap: number | undefined,
): string {
  const spent = usage?.outputTokens ?? 0;
  if (sentOutputCap !== undefined && spent > 0 && spent >= sentOutputCap) {
    return (
      `The model used its entire output allowance (${spent} tokens) without producing an ` +
      'answer or a tool call, on every attempt — a reasoning model can spend the whole ' +
      'budget thinking. Ask for a smaller step, or raise the output limit for this model.'
    );
  }
  return (
    'The model returned an empty response — no answer and no tool call, on every ' +
    'attempt. This is usually the provider dropping the request (overloaded or ' +
    'rate-limited).'
  );
}

export function unusableTurnReason(
  turn: {
    readonly text: string;
    readonly calls: readonly unknown[];
    readonly truncated?: boolean;
    readonly droppedToolCalls?: readonly string[];
  },
  appliedOpsSoFar: number,
  stage: RunStage | undefined,
): 'empty' | 'truncated' | undefined {
  if (turn.calls.length > 0) return undefined;
  const dropped = (turn.droppedToolCalls ?? []).length > 0;
  // WHAT WE KNOW ABOUT WHY IT STOPPED COMES FIRST. Reading the empty case first — as this
  // did — labels a reply the provider explicitly cut off at its token ceiling as a dropped
  // request, and the two are retried differently: `empty` replays the turn verbatim, which
  // for a model that has just spent its whole output budget produces the identical empty
  // reply. In the captured run both attempts billed 8,192 output tokens and returned
  // nothing, and the run failed telling the creator the gateway was overloaded.
  if (turn.truncated === true || dropped) {
    // A turn that ASKED for tools and lost every one of them to a cut-off stream was still
    // asking: the run has more to do whatever it has already applied. That misreading is
    // what ended the captured run's first turn as "completed" on a sentence that stopped
    // mid-word, with the motion work it had promised one line earlier never attempted.
    if (dropped) return 'truncated';
    // Cut off with nothing said and nothing asked. There is no answer here to keep.
    if (turn.text.trim() === '') return 'truncated';
    // A truncated reply after work has landed is survivable — the run keeps the edits and
    // the reducer settles it — and a run already at verify/complete may finish on prose.
    if (appliedOpsSoFar > 0) return undefined;
    if (stage === 'verify' || stage === 'complete') return undefined;
    return 'truncated';
  }
  return turn.text.trim() === '' ? 'empty' : undefined;
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

/**
 * The same clearing, for an entry whose payload IS still held in the evidence store.
 *
 * "Re-read if needed" is only actionable when re-reading is free. For a metered provider
 * search (`search_stock`, `search_music`) it means another billable request against a
 * catalogue whose ordering is not stable — and a captured run, having lost every candidate
 * `remoteId` to this marker, invented an asset path rather than re-query. Naming the handle
 * inline turns the marker from an apology into an instruction the model can follow in one
 * call, without correlating the log against the briefing's citations.
 */
export const clearedWithHandle = (handle: string): string =>
  `[old result cleared — call recall_evidence("${handle}") to see it again]`;

/** A trailing evidence citation on a log note (`… → payload [ev_3]`). */
const NOTE_EVIDENCE_HANDLE = /\s\[(ev_\d+)\]$/;

/**
 * Estimated log size (tokens) above which the payload-clearing tier engages (E2.2).
 *
 * The FLOOR, not the budget. Kept as the value a caller gets when it can measure nothing —
 * a small-window model, the repair pass, the legacy loop — so those paths behave exactly as
 * they did. When remaining capacity IS known, {@link findingsBudgetTokens} spends a share
 * of it instead.
 *
 * The number was set in isolation and is indefensible next to what shares the message with
 * it. In captured run `e36235cc` the tool definitions were 16,962 tokens of a 21,942-token
 * request, against 128,000 of window at 33% peak use — so the model was handed ~17x more
 * context about tools it COULD call than about what it had already found. A stock
 * `remoteId` exists nowhere but a search payload, payloads survive
 * {@link AGENT_LOG_PAYLOAD_FRESH} turns, and placing a clip needs one — so the run recalled
 * 62 times, each recall its own model call. The recall loop was mandated by this constant,
 * not chosen by the model.
 */
export const AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000;

/**
 * Share of measured remaining capacity the agent log may occupy before payloads are cleared.
 *
 * Deliberately a fraction of what is left AFTER the trimmer has reserved the tool set, the
 * stable head and the grounding slice — not a fraction of the window — so growing any of
 * those shrinks the log rather than overflowing the request.
 */
const FINDINGS_CAPACITY_SHARE = 0.35;

/**
 * Ceiling on the findings budget regardless of capacity.
 *
 * A 1M-token window should not put a megabyte of stale search payloads in front of the
 * model; past a point more candidates stop being more useful and start burying the request.
 */
const FINDINGS_BUDGET_CEILING_TOKENS = 24_000;

/**
 * How many tokens of tool-result payload this turn may carry.
 *
 * @param remainingCapacityTokens - Room left after the assembler's reservations, or
 *   `undefined` when the caller cannot measure it (then the floor applies unchanged).
 * @returns A budget at least {@link AGENT_LOG_CLEAR_THRESHOLD_TOKENS} and at most
 *   {@link FINDINGS_BUDGET_CEILING_TOKENS}.
 */
export function findingsBudgetTokens(remainingCapacityTokens: number | undefined): number {
  if (remainingCapacityTokens === undefined || !Number.isFinite(remainingCapacityTokens)) {
    return AGENT_LOG_CLEAR_THRESHOLD_TOKENS;
  }
  const share = Math.floor(Math.max(0, remainingCapacityTokens) * FINDINGS_CAPACITY_SHARE);
  return Math.min(
    FINDINGS_BUDGET_CEILING_TOKENS,
    Math.max(AGENT_LOG_CLEAR_THRESHOLD_TOKENS, share),
  );
}

/** The most recent log entries whose payloads are never cleared (E2.2's "last N turns"). */
export const AGENT_LOG_PAYLOAD_FRESH = 2;

/** Payloads shorter than this are kept — clearing them saves nothing worth a re-read. */
const MIN_CLEARABLE_PAYLOAD_CHARS = 160;

/** The ` → payload` marker and the `'; '` note joiner that bounds a payload's end. */
const NOTE_PAYLOAD_MARKER = ' → ';
const NOTE_JOINER = '; ';

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
  // Indexed scanning, not a `(.*?)(?=; |$)` regex: that shape is polynomial on
  // adversarial-length payloads (untrusted tool output), and a fixed marker/joiner
  // pair is all this ever needed to find the same boundaries.
  let result = '';
  let cursor = 0;
  for (;;) {
    const markerAt = entry.indexOf(NOTE_PAYLOAD_MARKER, cursor);
    if (markerAt === -1) {
      result += entry.slice(cursor);
      return result;
    }
    const payloadStart = markerAt + NOTE_PAYLOAD_MARKER.length;
    const joinerAt = entry.indexOf(NOTE_JOINER, payloadStart);
    const payloadEnd = joinerAt === -1 ? entry.length : joinerAt;
    const payload = entry.slice(payloadStart, payloadEnd);
    result += entry.slice(cursor, markerAt);
    if (payload.startsWith('they answered:') || payload.length < MIN_CLEARABLE_PAYLOAD_CHARS) {
      result += NOTE_PAYLOAD_MARKER + payload;
    } else {
      // The payload goes; its HANDLE stays. Clearing the citation along with the content is
      // what left the model holding an offer to "re-read" with no address to read from.
      const cited = NOTE_EVIDENCE_HANDLE.exec(payload);
      result += ` → ${cited?.[1] ? clearedWithHandle(cited[1]) : CLEARED_RESULT_MARKER}`;
    }
    cursor = payloadEnd;
  }
}

/**
 * Bound the agent action log fed back each turn (R2 B4 + E2). Two tiers, cheapest
 * first, and BOTH now decide against the same budget:
 *
 * 1. **Micro-compaction (E2.2)** — when the estimated log size exceeds `budgetTokens`,
 *    the re-derivable read/analysis payloads of every entry except the freshest
 *    {@link AGENT_LOG_PAYLOAD_FRESH} are cleared in place (see {@link clearNotePayloads})
 *    — the model keeps the full call history but stops paying for stale data it can
 *    re-read for free via the run memo. Token estimation is the shared chars/4 heuristic
 *    ({@link estimateTokens}, E2.3).
 * 2. **Rolling window (R2 B4)** — oldest entries collapse into one deterministic digest
 *    line, but ONLY while the log still does not fit. `recent` is the floor this will not
 *    trim below, not a ceiling it always trims to.
 *
 * That second sentence is the change. The window used to be a hard count of six entries
 * applied regardless of budget, which is a bound in the wrong unit: it controls tokens by
 * counting turns. Measured on a realistic ten-turn log — two tool notes a turn, modest
 * payloads — it discarded the first four turns while occupying 11% of the 24,000-token
 * budget computed for it one line above. What it discarded, in captured run `35746d4c`,
 * was the transcript read from turn 3; the run re-read the same transcript at turn 9, and
 * re-browsed the same caption styles it had already browsed. Every one of those was a
 * whole model call at ~20k tokens of input, spent to recover something the run had
 * already paid for and thrown away with room to spare.
 *
 * Growth stays bounded, and by the thing that actually costs: `budgetTokens` is at most
 * {@link FINDINGS_BUDGET_CEILING_TOKENS}, so a hundred-turn run's log is capped in tokens
 * rather than in turns.
 *
 * Pure.
 */
export function compactAgentLog(
  log: readonly string[],
  recent: number = AGENT_LOG_RECENT,
  budgetTokens: number = AGENT_LOG_CLEAR_THRESHOLD_TOKENS,
): string[] {
  const overBudget = (entries: readonly string[]): boolean =>
    estimateTokens(entries.join('\n')) > budgetTokens;
  const cleared = overBudget(log)
    ? log.map((entry, i) =>
        i < log.length - AGENT_LOG_PAYLOAD_FRESH ? clearNotePayloads(entry) : entry,
      )
    : [...log];
  // Drop from the oldest end only for as long as the log does not fit. `recent` is the
  // floor: below it the run has too little of its own history to act on, and dropping
  // further would trade a prompt it can afford for a turn spent re-deriving.
  let keep = cleared.length;
  while (keep > recent && overBudget(cleared.slice(cleared.length - keep))) keep -= 1;
  if (keep >= cleared.length) return cleared;
  const omitted = cleared.length - keep;
  return [
    `(… ${omitted} earlier step${omitted === 1 ? '' : 's'} summarized for brevity)`,
    ...cleared.slice(-keep),
  ];
}

/**
 * Critic checks an agent CAN plausibly fix by editing the timeline, so a repair pass
 * targets only these (R3 C3). Render-gated checks (black frames) are excluded — the
 * agent can't fix pixels without a preview render (honestly gated, not stubbed).
 */
/**
 * Checks the repair pass is allowed to act on — and, by construction, the checks whose
 * detail text names a tool that can actually fix them.
 *
 * A check the agent cannot act on trains it to ignore the critic, so membership here is a
 * claim: *an existing tool addresses this, and the finding says which*. Phase 4 adds the
 * two editorial checks where that claim is unambiguous:
 *
 * - `word_severed` → the boundary moves to the nearest word edge (`trim_clip` /
 *   `split_clip`, aimed at a `startFrame` from `get_mapped_transcript`). A cut inside a
 *   word is not a matter of taste.
 * - `transition_fit` → re-issue `add_transition` at the length the boundary can carry. The
 *   engine silently shortens an over-long ramp, so what the run described to the editor is
 *   not what the timeline has; that is a factual mismatch, not a preference.
 *
 * The other four editorial checks are deliberately absent, each for its own reason:
 * `jump_cut` and `dead_air` ship as `warn` until they have been observed correct on real
 * runs (the phase's own risk rule — `warn` informs the model, `fail` triggers repair);
 * `audio_slam`'s repair is `professional_edit` j_cut/l_cut, which needs a live editor
 * selection a repair pass does not have; and `shot_rhythm` is diagnostic by design —
 * "fixing" it would produce random re-trimming that satisfies a variance metric and looks
 * worse.
 */
const FIXABLE_CHECKS = new Set<string>([
  'duration_target',
  'request_match',
  'audio_clipping',
  'word_severed',
  'transition_fit',
  // Run `fc10301a` shipped a timeline whose last 23.7 of 47.8 seconds were black, and the
  // repair pass never looked at it: the set covered the checks that were cheap to wire,
  // not the ones that describe what the viewer sees. `picture_coverage` is the most
  // user-visible failure the Critic can report and its trailing-hole case has a
  // deterministic fix (`repairTrailingSoundOverrun`), which runs before the model is
  // asked. `reframe_coverage` is a mix of reframed and unreframed picture — the model
  // knows which clips are missing a crop because the detail text names them.
  'picture_coverage',
  'reframe_coverage',
]);

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
/**
 * The sentence `caption_the_edit` owes the run about how its cues will LOOK, or `''`.
 *
 * The tool writes cue text and cue timing. It does not touch the track's design, and its
 * note — one line per operation — never mentioned the omission, so a run had no way to
 * tell a styled caption track from an unstyled one except by reading the track back.
 *
 * Run `e8cb2636` did not read it back. It captioned the edit, told the editor the cues
 * were "already styled to a boxed template", and moved on. Nothing was styled; the claim
 * was invented out of the silence. That is the same shape as every other honesty fix in
 * this file: the fact existed at the moment the note was written and was not put in it.
 *
 * Said only when there is something to say. A track that already carries a style gets no
 * sentence, because there is nothing left to do about it.
 *
 * Exported for tests.
 */
/**
 * The caveat that rides with an automatic reframe, so "Reframed clip" is never read as
 * "the subject is in frame".
 *
 * `add_clip`/`add_clips` crop a landscape source to a portrait frame on the run's behalf
 * (`domain-tools/timeline.ts#autoReframeCrop`), and the picture placer cover-crops a
 * leaking layer the same way. Both are CENTRED guesses with no subject evidence, and the
 * placement doc promises the crop is "announced, not hidden". It was announced as
 * "Reframed clip <id>" — thirteen times in run `cc907070`, against a brief that said
 * "reframed so the action stays inside the crop, not just centre-cut" — and nothing told
 * the model the crop was exactly the centre cut the editor had ruled out.
 *
 * @param toolName - The call that produced the operations.
 * @param ops - The operations it produced, after normalisation.
 * @returns The caveat sentence, or `''` when no automatic crop was written.
 */
export function autoReframeNote(toolName: string, ops: readonly AnyOperation[]): string {
  if (toolName !== 'add_clip' && toolName !== 'add_clips') return '';
  const crops = ops.filter((op) => op.type === 'set_clip_crop').length;
  if (crops === 0) return '';
  return (
    ` — ${String(crops)} clip${crops === 1 ? '' : 's'} auto-reframed with a CENTRED crop, a ` +
    'guess made with no subject evidence. If the action sits off-centre, set_clip_crop with ' +
    'a rect that follows it (get_frame or track_object shows where it is), and say which ' +
    'you did.'
  );
}

export function captionStyleNote(project: Project, trackId: unknown): string {
  if (typeof trackId !== 'string') return '';
  const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined || track.captionStyle !== undefined) return '';
  return (
    ' These cues carry no track style yet, so they render in the plain default look — ' +
    'set_track_caption_style is what gives them a design, and auto_emphasize_captions ' +
    'is what makes individual words pop.'
  );
}

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
 * A stable, bounded signature of a turn's tool calls (names, arguments, and — for a call
 * whose answer depends on the timeline — the revision it was asked at), used to detect a
 * *spinning* agent: a turn that made no progress and repeats a signature we have already
 * seen make no progress means the model is stuck, so the run should stop. A novel
 * no-progress turn is allowed to continue (e.g. a no-op "organize" when the bin is
 * already tidy, or a first failed call the model can now retry from the surfaced error).
 *
 * Long turns keep a readable head and carry a digest of the whole thing, so two turns
 * that differ only past the cut-off still compare as different.
 *
 * ## Why the revision is part of the signature
 *
 * It was not, and the omission terminated a healthy run. `get_timeline` + `list_assets`
 * with no arguments is the same STRING whether the timeline holds nothing or holds
 * thirty-four clips, so a montage that reads the arrangement between batches — which it
 * must, because applying a patch invalidates its timeline evidence — collides with itself
 * on its second batch and is stopped as a spin. Run `fc10301a` was killed exactly there,
 * with eleven of thirty steps unspent, on a read that had returned an entirely different
 * timeline from the one banked four turns earlier (revision 71 → 75).
 *
 * Only a timeline-dependent QUESTION carries the revision, and the distinction is the
 * whole rule:
 *
 * - A read or inspection is a question, and its answer changes when the timeline does.
 *   Asking it again after the run has landed more work is new work, so the run's applied-
 *   work counter belongs in its identity. Deliberately that counter and not
 *   `project.timeline.revision`: the latter bumps only when an operation changes the
 *   source↔sequence mapping, so a grade or a gain change would leave two genuinely
 *   different `get_clips` answers sharing one signature — the very collision this is for.
 * - A `load_skill` or a `detect_beats` answers the same at every revision, so stamping one
 *   would defeat the guard for the run it was built for — the model asking one unchanging
 *   question forever.
 * - A MUTATION is an intent, not a question. Re-proposing the same edit turn after turn is
 *   repeating yourself whether or not earlier ones landed, and stamping the revision would
 *   make an applying-but-runaway agent look novel every turn. A rejected edit does not move
 *   the revision, so the exact-repeat guard still catches the re-proposed bad edit it was
 *   written for; and an edit that DOES land is credited by `progressedMeaningfully`, which
 *   is where "this turn achieved something" belongs.
 */
function turnSignature(calls: readonly ToolCall[], revision: number): string {
  const full = calls
    .map((c) => {
      const { role, scope } = classifyTool(c.name, getTool(c.name)?.kind);
      const asksTheTimeline = scope === 'timeline_dependent' && role !== 'mutation';
      const at = asksTheTimeline ? `@${String(revision)}` : '';
      return `${c.name}${at}:${JSON.stringify(c.arguments)}`;
    })
    .join('|');
  return boundedKeySegment(full, SIGNATURE_PREFIX_CHARS);
}

/**
 * Read arguments that select a WINDOW into an otherwise fixed body of data, rather than
 * naming a different subject. Dropped from a read's {@link callNoveltyKey} — see there
 * for why — but never from its {@link callMemoKey}.
 */
const WINDOW_ARG_KEYS = new Set(['start', 'end']);

/**
 * Analysis arguments that TUNE a call without changing the question it asks: how many
 * results to return, how sensitive the detector is, which slice of an asset to look at,
 * whether to bypass a cache. Dropped from an unasseted analysis call's
 * {@link callNoveltyKey} for exactly the reason `sensitivity` is dropped from an asseted
 * one — asking the same question with a bigger `limit` is the same question.
 *
 * `timeRange` rides here rather than in {@link WINDOW_ARG_KEYS} so the read branch keeps
 * the key it has always produced; the two sets are read by different branches on purpose.
 */
const ANALYSIS_TUNING_ARG_KEYS = new Set([
  'limit',
  'k',
  'sensitivity',
  'threshold',
  'minDuration',
  'refresh',
  'wait',
  'start',
  'end',
  'timeRange',
]);

/**
 * The identity-bearing arguments of a call, rendered as a stable, order-independent
 * string. `drop` names the arguments that do not confer identity.
 */
function identifyingArgs(call: ToolCall, drop: ReadonlySet<string>): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  return Object.keys(args)
    .filter((k) => !drop.has(k))
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join(',');
}

/**
 * The **memo key** for one call: what {@link HostCallContext.evidence} stores a read's
 * result under. Always the FULL arguments, because the memo serves real data back to the
 * model and a coarser key would answer `get_transcript{start:60,end:180}` with the words
 * from `{start:0,end:60}`. Correctness first: novelty accounting is allowed to be
 * approximate, cached data never is.
 */
/**
 * Identity of a call for the redundant-call memo. Exported for tests.
 *
 * `get_frame` is keyed by WHAT it looks at, not how large the picture is: the mission
 * montage ledger shows the model rendering the same six timestamps at 640 px and again at
 * 480 px (11 renders, ~50 s) because the second batch had a different `maxDimension` and so
 * a different memo key. A smaller re-render of a frame the run already holds is redundant
 * by any editorial standard; the stored evidence is recalled instead.
 */
export function callMemoKey(call: ToolCall): string {
  if (call.name === 'get_frame' && call.arguments && typeof call.arguments === 'object') {
    const { maxDimension: _size, ...rest } = call.arguments as Record<string, unknown>;
    return `${call.name}:${JSON.stringify(rest)}`;
  }
  // `hardSync` is stripped before `detect_beats` parses (ADR 0174); a call that still
  // carries it asks the same question as one that does not, and re-running the engine
  // for it (6–10s of ffmpeg in run `cc907070`) buys nothing.
  if (call.name === 'detect_beats' && call.arguments && typeof call.arguments === 'object') {
    const { hardSync: _retired, ...rest } = call.arguments as Record<string, unknown>;
    return `${call.name}:${JSON.stringify(rest)}`;
  }
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/**
 * The one-phrase answer a VERIFICATION read gives, for its card. `undefined` for every
 * other read, whose card is correctly just the action it performed.
 *
 * These tools exist to answer a yes/no question, and the answer is the reason the run
 * called them. Leaving it out of the card makes a passing check and a failing one
 * indistinguishable at a glance — see the call site.
 */
function readVerdict(toolName: string, value: unknown): string | undefined {
  if (toolName !== 'verify_captions' && toolName !== 'verify_transitions') return undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  const result = value as {
    readonly ok?: unknown;
    readonly issues?: unknown;
    readonly cueCount?: unknown;
    readonly speechCoverage?: unknown;
    readonly transitionCount?: unknown;
    readonly boundaryCount?: unknown;
  };
  if (result.ok !== true && result.ok !== false) return undefined;
  const issues = Array.isArray(result.issues) ? result.issues.length : 0;
  if (result.ok === false) {
    return issues === 1 ? '1 problem' : `${String(issues)} problems`;
  }
  if (toolName === 'verify_captions' && typeof result.cueCount === 'number') {
    return `in sync, ${String(result.cueCount)} cue(s)`;
  }
  if (toolName === 'verify_transitions' && typeof result.transitionCount === 'number') {
    return `all good, ${String(result.transitionCount)} transition(s)`;
  }
  return 'all good';
}

/**
 * The byte-identity of a MUTATING call, with argument order normalised away.
 *
 * {@link callMemoKey} stringifies the arguments as they arrived, so `{clipId, gainDb}`
 * and `{gainDb, clipId}` are two keys for one call. That is harmless for a read memo and
 * useless here: run `137d8fd0` sent `adjust_audio` with the same clip and the same −12 dB
 * fifteen times in one order and ten times in the other, and a key that cannot see through
 * the ordering cannot see that they are the same instruction.
 *
 * Only the top level is sorted — a nested params object's order is the model's own and
 * has never varied in a captured run, and recursing would cost more than it buys.
 */
function appliedCallKey(call: ToolCall): string {
  const args = call.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return `${call.name}:${JSON.stringify(args)}`;
  }
  const record = args as Record<string, unknown>;
  const sorted = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as const);
  return `${call.name}:${JSON.stringify(Object.fromEntries(sorted))}`;
}

/**
 * The **novelty key** for one call: what the reducer uses to decide whether this call
 * could have taught the model anything it did not already have (see `TurnCallFact`).
 * Deliberately coarser than both {@link turnSignature} and {@link callMemoKey}: it
 * answers "is this a new question?", not "is this the same bytes?".
 *
 * Coarser for **analysis** tools that name an asset — keyed by `name + assetId`,
 * dropping the tuning arguments. That is the precise fix for the spin the no-progress
 * guard exists to catch: `detect_beats` on the same track at sensitivity 1.5, then 3.5,
 * then 2 is the same question asked three ways, and re-analysing the same media cannot
 * reveal something new about it. Analysing a DIFFERENT asset is genuinely new, and
 * keying on the asset keeps it so.
 *
 * An analysis that names NO asset is keyed by its identity-bearing arguments instead
 * (`query`, `kind`, `orientation`, …) minus {@link ANALYSIS_TUNING_ARG_KEYS}. The
 * premise above — "re-analysing the same media cannot reveal something new" — has no
 * media to stand on for a catalogue search, and reading it as `name:*` meant every
 * search a run ever made was the same question. The body names the run that killed.
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
    // An asseted analysis keys on the asset alone — see the doc above: re-running
    // `detect_beats` on the same track at a new sensitivity is one question asked twice.
    if (typeof assetId === 'string') return `${call.name}:${assetId}`;
    // An analysis with NO asset is a different animal, and collapsing it to `name:*` was
    // a real, run-ending bug. `search_music` / `search_stock` / `search_media` /
    // `search_visual` / `find_similar` are `analysis`-kind but take no `assetId`: their
    // whole identity is the `query`. Every search a run made therefore shared one key,
    // so the SECOND search of a run — however different its query, however many new
    // tracks or clips it returned — was scored "learned nothing new". A captured run
    // (`f1d5285e`) searched music four times with four queries, was credited with
    // nothing for three of them, hit `STALL_CONFIRM_TURNS` on turn four and terminated
    // having applied no edit. A request that needs many searches (80–120 stock clips for
    // a montage) could not survive its own second turn.
    //
    // So key on what the call actually asks — the query, the media kind, the orientation
    // — minus the tuning arguments that do not change the question
    // ({@link ANALYSIS_TUNING_ARG_KEYS}). The spin this branch exists to catch is
    // untouched: a re-run of the SAME query still produces the same key, and an
    // argument-free analysis (`map_footage` over the whole project) still collapses to
    // one key exactly as before.
    return `${call.name}:${identifyingArgs(call, ANALYSIS_TUNING_ARG_KEYS)}`;
  }
  if (tool?.kind === 'read') {
    return `${call.name}:${identifyingArgs(call, WINDOW_ARG_KEYS)}`;
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
  /**
   * Eval affordance (goal.md Phase 0, `scripts/mission-baseline.mjs --replay`): build each
   * run's {@link EffectRuntime} from a recording instead of the live provider/executor —
   * `createReplayEffectRuntime(recording)` — so a golden case can be re-scored with zero
   * model or host calls. A factory, because a replay runtime holds a cursor and each run
   * needs a fresh one. Composes with `recordEffects`. Never set by a product host.
   */
  readonly replayRuntime?: () => EffectRuntime;
  /** Awaited durable audit observer for every fine-grained runtime effect. */
  readonly effectObserver?: EffectRuntimeObserver;
  /**
   * Per-{@link ModelTier} provider overrides (goal.md Workstream E): the cheap, mechanical
   * calls need not run on the model the editing turns need. Today exactly one call is
   * stamped `tier: 'small'` — the ADR 0055 route classifier — so a host that sets
   * `FRAMEPILOT_TIER_SMALL_*` pays small-model prices for routing and nothing else.
   *
   * Opt-in and normally absent: hosts build it from `resolveTierProviderConfigs`, which
   * returns no entries unless those variables are set. With it absent every call runs on
   * the constructor's provider, exactly as before.
   *
   * `replayRuntime` bypasses this by design — a replayed run makes no provider calls at
   * all, so which provider WOULD have served a tier is not a question it can answer.
   */
  readonly tierProviders?: Partial<Record<ModelTier, AiProvider>>;
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
   * Every MUTATING call this run has already applied, by byte-identity
   * ({@link appliedCallKey}).
   *
   * A per-run mutable ledger rather than a field on the Orchestrator, which serves
   * concurrent runs and must not hold it.
   *
   * WHY it exists: a repeat of an applied edit is not caught by anything else. The turn
   * loop's `appliedPatchIds` compares PATCHES, and a re-placement lands on a different
   * lane so its patch id differs; `seenFailureKeys` only remembers refusals. Run
   * `137d8fd0` therefore applied **66 mutating calls that were byte-identical repeats of
   * an edit it had already made** — the same −12 dB on the same clip fifteen times, the
   * same transition nine times, the same colour grade four times, `add_track "captions"`
   * four times. The user's timeline came out with nineteen video layers for a
   * sixty-second edit, the same stock clip on three of them, and the music bed and the
   * title card each placed twice.
   */
  readonly appliedCalls?: Set<string>;
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
   * Per-run ledger of the tool domains this run has pinned (progressive disclosure —
   * see `tool-domains.ts`). Only the core set is advertised up front; `load_tools` adds
   * a domain here and it stays for the rest of the run, exactly as a loaded skill does.
   * Non-optional for the same reason as {@link loadedSkills}: every `HostCallContext`
   * this file constructs threads the run's ledger.
   */
  readonly loadedToolDomains: Set<ToolDomain>;
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
  /**
   * This `failed` outcome came from the run's DETERMINISTIC refusal path — schema
   * validation of the arguments, or the per-call validator probe — so the same call
   * against the same arrangement is refused with the same sentence every time.
   *
   * The discriminator has to exist, and it has to be opt-in. `status: 'failed'` alone is
   * shared by around twenty return sites in this file, most of them HOST outcomes: a
   * sidecar restart, a download timeout, a provider 5xx. Those are transient, and
   * remembering one as proof that a tool cannot work would be a worse bug than the retry
   * loop the memory exists to stop. So a failure is transient unless the branch that
   * produced it says otherwise here.
   *
   * A HOST outcome says otherwise the only way it can — by declaring a
   * {@link HostToolOutcome.refusalCause}, which the host-tool branch converts into this
   * flag. That is a policy verdict the host read off the project (ADR 0140's picture rule,
   * checked before the download), not work that failed, and it is the whole of the
   * exception: an undeclared host `failed` is still transient however often it repeats.
   *
   * Consumed by `executeToolCalls` to build `TurnCallFact.failureKey`; absent ⇒ nothing
   * about this failure is remembered for the rest of the run.
   */
  deterministicFailure?: boolean;
  /**
   * The call was WITHHELD — by the stage, the recovery turn, the candidate bank, or the
   * pin cap — rather than answered. Its note is a policy sentence, not a finding, and
   * `distil` must not file it under "ESTABLISHED — do not gather again": run `cc907070`
   * carried "search_stock withheld — place what this run already found" and "detect_beats
   * held back — this turn is for acting" into its next session as facts about the footage.
   */
  withheld?: boolean;
  /**
   * The call landed nothing because the timeline **already said what it asked for** —
   * distinct from landing nothing because something went wrong. See the no-change branch
   * in `runAgentCall`, and {@link applyAgentTurn}'s use of it: a turn that is satisfied
   * did not fail, and filing it as failed is the lie that had run `35746d4c` told twenty-
   * four times that its captions had failed while they sat on the timeline.
   */
  satisfied?: boolean;
  /**
   * This call put a question to the editor. See {@link applyAgentTurn}: a turn that asks
   * does not apply its own edits, because every operation in it was composed by the same
   * model response that asked, and therefore before any answer existed.
   */
  askedQuestion?: boolean;
  /**
   * Which RULE refused this call, when a policy refusal named one
   * (`tool-refusal.ts#RefusalCause`). `deterministicFailureKey` keys run memory on this
   * in preference to the sentence, because a refusal sentence is written to be acted on
   * and therefore varies with the placement: run `369e8c82` was refused ADR 0140's
   * picture-over-picture rule four times and banked four keys. Absent ⇒ the failure is
   * remembered by its text, exactly as before.
   *
   * Set from the thrown {@link ToolInvocationError} on the in-process path, and from
   * {@link HostToolOutcome.refusalCause} when a HOST declared one — one vocabulary, so a
   * rule refused before a download and the same rule refused after it are one key.
   */
  refusalCause?: RefusalCause;
  /**
   * The text {@link deterministicFailureKey} should key on, when it must differ from the
   * sentence the model reads.
   *
   * A refusal's sentence carries the REMEDY, and a good remedy names things that vary
   * with the project — the tracks that would have worked, the ids that do exist. Keying on
   * it then makes the same refusal of the same argument look new every time the project
   * moves. `add_music`'s empty-duck refusal is the captured case: appending the candidate
   * track list (a strictly better refusal) meant placing a clip on an UNRELATED track gave
   * the identical rule a fresh key, so the repeat guard could not fire.
   *
   * Absent ⇒ `data` is the identity, exactly as before. Same separation as
   * `conductor.ts`'s `rejectionKey` beside its `rejection`: guards key on this, humans
   * read the sentence.
   */
  failureKeyText?: string;
  /** The working copy advanced by this call's validated ops (mutating calls only). */
  project?: Project;
  /**
   * How many proposed ops this call lost (drives the empty-run notice AND the ledger).
   *
   * Non-zero is the ONLY route a call that landed nothing has into the run's durable
   * account of itself: the conductor reads it as `lostOpsPerCall` and files the turn as a
   * `failed` operation whose reason is {@link AgentCallOutcome.note}. Absent ⇒ the run
   * reports as though the call never tried.
   *
   * The unit is operations where operations were built (`ops.length`, the validator
   * probes and the generic mutate path), and one where the call was refused before it
   * built any — one refused call being one thing the run could not do.
   */
  rejectedOpCount?: number;
  /**
   * How many of this call's applied ops are DERIVED fan-out rather than model-composed
   * choices, and so do not count against the blast-radius bounds. See
   * `ToolSpec.derivedFanOut`. Absent ⇒ zero.
   */
  derivedOpCount?: number;
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

/**
 * `{ derivedOpCount }` when this tool's fan-out is the project's, not the model's.
 *
 * One helper because the op-producing returns come in two shapes — the generic
 * `operationsFor` path and the host-backed branches (`transcribe`, `remove_silences`,
 * `add_music`, `add_stock`) — and the first version of this stamped only the generic one.
 * `remove_silences` is where that mattered: it emits one ripple_delete per measured
 * silence, ~250 on a twenty-minute interview, so the bound meant to stop a runaway model
 * was again a ceiling on recording length. See `ToolSpec.derivedFanOut`.
 */
const derivedOps = (name: string, ops: readonly unknown[]): { derivedOpCount?: number } =>
  getTool(name)?.derivedFanOut === true ? { derivedOpCount: ops.length } : {};

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
 * The same cap for WORD-level transcript reads, which are a different scale of record.
 *
 * 300 is the right bound for ids: a library of 300 assets is a large library, and a run
 * that needs the 301st can filter. A transcript is not like that. The north-star case
 * (`.agents/rules/product-discipline.mdc` §1) is a 5–15 minute recording, which is
 * 750–2,250 words, and the whole point of Phase 1 is that the model chooses its hook from
 * the WHOLE recording rather than from its first 40%. Capping at 300 would have swapped a
 * 25-word keyhole for a 300-word one.
 *
 * 2,000 covers the north-star case in full at roughly 20k tokens — real money, but money
 * spent on the one thing the model cannot reason without, and only when it explicitly asks
 * for the transcript. Past that the tail says how many words were dropped and how to read
 * them, and the tool description already tells the model to read a long recording in
 * windows.
 */
const WORD_DIGEST_MAX_ITEMS = 2000;

/**
 * Visual evidence is much denser than an id listing: each packet can carry a scene
 * caption plus overlapping dialogue. Keep a useful time-ordered/ranked window, then
 * drop whole packets with an explicit tail rather than cutting JSON mid-caption.
 */
const VISUAL_DIGEST_MAX_PACKETS = 24;

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;
const round2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * The arrangement in one line, computed from a project rather than read back from a tool.
 *
 * This is the sentence `get_timeline` would have produced, and it exists so a run that
 * just applied a patch does not have to spend a turn asking what it did. The revision
 * bump correctly invalidates every timeline fact the run held (a cut moves the ids the
 * next patch is written against) — but the run authored that cut and is handed the
 * resulting project, so the knowledge is already in hand and only the bookkeeping said
 * otherwise. Run `fc10301a` alternated apply / re-read for its entire second half.
 *
 * Deliberately the same shape as `get_timeline_summary`'s digest — sequence length, track
 * and clip counts, then a row per track with its span — so a run that reads the tool and a
 * run that reads this fact hold the timeline in the same terms.
 *
 * A video track nothing placed on could be SEEN on says so on its own row. Run `369e8c82`
 * read `b_roll [video] empty; v_main [video] 1 clips 0–49.77s` every turn and took the
 * invitation four times, because the narration on `v_main` covers the whole sequence and
 * `b_roll` sits behind it. Under ADR 0169 the placement is no longer refused — `add_clip`
 * lifts a full-frame shot onto a new front layer — but the row still has to say so, because
 * this line is what the run PLANS from and a lane that shows nothing must not read as one
 * that does.
 *
 * Bounded by construction: one row per track, and a project has few of those.
 */
export function arrangementLine(project: Project): string {
  const tracks = project.timeline.tracks;
  const clipCount = tracks.reduce((total, track) => total + track.clips.length, 0);
  const end = tracks.reduce(
    (max, track) => track.clips.reduce((m, clip) => Math.max(m, clip.end), max),
    0,
  );
  const blocked = tracksCoveredByPictureInFront(project);
  const rows = tracks
    .map((track) => {
      // Same words `get_timeline_summary`'s `hiddenBehindPicture` flag stands for, so the
      // constraint the run reads here and the answer it gets from the tool are one rule.
      const noRoom = blocked.has(track.id)
        ? ` — hidden behind picture 0–${round2(end)}s (a full-frame clip added here lands on a new front layer)`
        : '';
      // The mix role is part of the arrangement: it is what `professional_audio` ducks
      // by, and a run that cannot see it re-labels the same track every turn.
      const kind = track.role === undefined ? track.type : `${track.type} role:${track.role}`;
      if (track.clips.length === 0) return `${track.id} [${kind}] empty${noRoom}`;
      const first = track.clips.reduce((m, c) => Math.min(m, c.start), Infinity);
      const last = track.clips.reduce((m, c) => Math.max(m, c.end), 0);
      return `${track.id} [${kind}] ${String(track.clips.length)} clips ${round2(first)}–${round2(last)}s${noRoom}`;
    })
    .join('; ');
  return `Timeline now: sequence ${round2(end)}s, ${String(tracks.length)} tracks, ${String(clipCount)} clips — ${rows}`;
}
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
  limit: number = READ_DIGEST_MAX_ITEMS,
): string {
  if (items.length === 0) return `no ${noun}`;
  const lines = items.slice(0, limit).map(render);
  if (items.length > limit) {
    const omitted = items.length - limit;
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
  if (entries.length === 0) {
    // With a query, say what was asked, how big the catalogue is, and that another word
    // will not conjure the effect — the run in `cc907070` tried seven for "sharpen".
    if (typeof obj.query === 'string' && typeof obj.total === 'number') {
      const categories = Array.isArray(obj.categories)
        ? (obj.categories as Record<string, unknown>[])
            .map((c) => String(c.id ?? ''))
            .filter((id) => id !== '')
        : [];
      return (
        `no ${noun} match "${obj.query}" — none of the ${String(obj.total)} ${noun} in this ` +
        `build is one, and another wording will not find it${
          categories.length > 0 ? ` (categories: ${categories.join(', ')})` : ''
        }. Browse a category or the whole catalogue if a different effect would do; ` +
        'otherwise tell the editor this build has no such effect.'
      );
    }
    return `no ${noun} match (${String(obj.matched ?? 0)} in catalog)`;
  }
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
        const flags = [
          t.role !== undefined && `role:${t.role}`,
          t.locked && 'locked',
          t.hidden && 'hidden',
          t.muted && 'muted',
        ]
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

/**
 * Provider record fields the model can never act on, dropped before a result is STORED as
 * evidence.
 *
 * The digest arms for `search_stock`/`search_music` say it outright — "provider URLs never
 * reach it at all" — and on the search path that is true. It stopped being true the moment
 * the run reopened the same result: `recall_evidence` renders the stored payload, and the
 * stored payload was the provider's whole record. A three-clip recall came back as ~900
 * tokens of licence links, creator profile URLs, and a `variants` array of six renditions
 * for every item.
 *
 * None of it is reachable. `add_stock` and `add_music` take a `remoteId` and nothing else
 * — the host picks the rendition from the project's own height (`ai/stock-host.ts`) — so a
 * variant id is not a choice the model gets to make, and a licence URL is not a page it
 * can open. What it needs to choose a shot and place it survives: the id, the title, the
 * length, the shape, the creator, and whether a credit is owed.
 *
 * Run `2131d2c5` spent 546,932 tokens and 63 recalls on this, and downloaded nothing.
 */
const UNACTIONABLE_PROVIDER_FIELDS: ReadonlySet<string> = new Set([
  'variants',
  'licenseUrl',
  'sourceUrl',
  'creatorUrl',
  'attribution',
  'hasPreview',
]);

/** The record lists a sourcing payload is a list OF, by the key each tool returns them under. */
const SOURCING_RECORD_KEY: Record<string, string> = {
  search_stock: 'items',
  search_music: 'tracks',
};

/**
 * What a result should look like in the evidence store — not necessarily what the provider
 * returned.
 *
 * Identity for every tool but the two catalogue searches, whose records carry a large tail
 * of fields no tool accepts (see {@link UNACTIONABLE_PROVIDER_FIELDS}). Projecting at
 * STORE time rather than at recall time keeps `EvidenceStore`'s record filtering and
 * paging working exactly as they do — it is still an object with an array-valued property,
 * just without the dead weight — and it means the run's memory holds what the run can use.
 */
export function evidencePayload(toolName: string, value: unknown): unknown {
  const recordKey = SOURCING_RECORD_KEY[toolName];
  if (recordKey === undefined || typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  const records = obj[recordKey];
  if (!Array.isArray(records)) return value;
  return {
    ...obj,
    [recordKey]: records.map((record) =>
      typeof record === 'object' && record !== null
        ? Object.fromEntries(
            Object.entries(record as Record<string, unknown>).filter(
              ([field]) => !UNACTIONABLE_PROVIDER_FIELDS.has(field),
            ),
          )
        : record,
    ),
  };
}

/**
 * A `## <assetId> (<path>)` heading in the brain's media-bin summary.
 *
 * Anchored to the line start so an id containing "## " (there are none, but the pattern
 * should not depend on that) cannot open a section from the middle of a body line.
 */
const BIN_SUMMARY_HEADING = /^## (\S+) \(([^)]*)\)$/;

/**
 * The brain's media-bin summary, reconciled against the bin the project ACTUALLY has.
 *
 * ## Why the memory has to be filtered before the model reads it
 *
 * `binSummary` is the project brain's record of every asset it has ever analysed. The
 * brain accumulates; the bin does not. Remove a track, re-import a recording, and the
 * summary still describes what used to be there — and `session_context` handed that to the
 * model as present-tense fact about the project.
 *
 * Run `e8cb2636` is what it costs. The summary listed
 * `music_openverse_63510d28_…` from an earlier session; `list_assets`, called twice in the
 * same run, returned one asset and no music at all. The agent reasonably placed the track
 * it had been told the project held, and `add_clip` came back "Unknown asset
 * 'music_openverse_63510d28_…'". The bed never landed, and the run's closing summary
 * carried the failure to the creator as a change that "did not land".
 *
 * The same summary named the recording as `ISOM_Batch1_Assignment1.mp4` when the bin held
 * `ISOM_Batch1_Assignment1_2.mp4` under that id — the user had re-imported it. So the path
 * is refreshed from the live asset too: a memory is allowed to be old, and is not allowed
 * to be wrong about what is on disk right now.
 *
 * Analysis for assets still in the bin is kept untouched — that is the whole value of the
 * memory, and none of it is invalidated by an unrelated asset leaving.
 *
 * Exported for tests.
 */
export function reconcileBinSummary(
  summary: string,
  assets: readonly { readonly id: string; readonly path: string }[],
): string {
  const byId = new Map(assets.map((asset) => [asset.id, asset.path]));
  const lines = summary.split('\n');
  const kept: string[] = [];
  let dropped = 0;
  // `undefined` until the first heading: everything before it is the file's own header,
  // which belongs to no asset and is always kept.
  let keepingSection: boolean | undefined;
  for (const line of lines) {
    const heading = BIN_SUMMARY_HEADING.exec(line);
    if (heading) {
      const [, assetId] = heading as unknown as [string, string, string];
      const path = byId.get(assetId);
      keepingSection = path !== undefined;
      if (!keepingSection) {
        dropped += 1;
        continue;
      }
      kept.push(`## ${assetId} (${path})`);
      continue;
    }
    if (keepingSection === false) continue;
    kept.push(line);
  }
  if (dropped === 0) return summary;
  // Trailing blank lines left behind by a dropped section would otherwise accumulate.
  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === '') kept.pop();
  const noun = dropped === 1 ? 'asset is' : 'assets are';
  return (
    `${kept.join('\n')}\n\n_${dropped} analysed ${noun} no longer in this project's bin and ` +
    'have been left out of this summary; call list_assets for what the bin holds now._\n'
  );
}

export function summarizeReadResult(
  toolName: string,
  value: unknown,
  /** The project's live media bin, when the caller has it (see {@link reconcileBinSummary}). */
  assets: readonly { readonly id: string; readonly path: string }[] = [],
): string {
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
      // A FAILED call's `data` is a string, not a payload — the engine-unreachable
      // instruction, say. Digesting it as "no visual evidence" threw away the one
      // sentence telling the model what to do next. An absent `packets` key on a real
      // OBJECT payload still reports no evidence, as it always has.
      if (typeof value !== 'object' || value === null)
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      return visualEvidenceDigest(obj);
    case 'search_music': {
      // A JSON blob of track rows, cut mid-string, is exactly what the model
      // cannot act on: it needs the `remoteId` to pass to `add_music` and the
      // credit flag to say something true about the licence afterwards. Both
      // survive here; the URLs and licence links never reach the model at all.
      const tracks = (obj.tracks ?? []) as Array<Record<string, unknown>>;
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return 'no tracks matched — try a broader mood word';
      }
      const lines = tracks.map((track) => {
        const seconds = typeof track.durationSeconds === 'number' ? track.durationSeconds : 0;
        const length = `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
        const credit =
          track.attributionRequired === true
            ? `credit ${typeof track.creator === 'string' ? track.creator : 'required'}`
            : 'no credit';
        return `${String(track.remoteId)} · ${String(track.title)} · ${length} · ${String(track.license)} (${credit})`;
      });
      return `${tracks.length} track${tracks.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
    }
    case 'add_music': {
      // What the run needs on its next turn: the track is down, where it went,
      // and whether it owes a credit. The full provenance record lives in the
      // project; repeating it here would be tokens spent on a licence URL the
      // model never opens.
      const asset = (obj.asset ?? {}) as Record<string, unknown>;
      const source = (asset.source ?? {}) as Record<string, unknown>;
      const seconds = typeof asset.durationSeconds === 'number' ? asset.durationSeconds : 0;
      const credit =
        source.attributionRequired === true
          ? `requires crediting ${typeof source.creator === 'string' ? source.creator : 'the creator'} (saved with the project)`
          : 'no credit required';
      return `added ${String(asset.path ?? 'track')} · ${seconds.toFixed(1)}s · ${String(source.license ?? 'unknown licence')} · ${credit}`;
    }
    case 'search_stock': {
      // The model needs the `remoteId` to pass to `add_stock`, the kind (they
      // are separate catalogues), and enough shape to judge whether a shot fits
      // the frame. Provider URLs never reach it at all.
      const items = (obj.items ?? []) as Array<Record<string, unknown>>;
      if (!Array.isArray(items) || items.length === 0) {
        return 'nothing matched — try a broader subject word';
      }
      const lines = items.map((item) => {
        const seconds = typeof item.durationSeconds === 'number' ? item.durationSeconds : null;
        const length =
          seconds === null
            ? 'still'
            : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
        const shape =
          typeof item.width === 'number' && typeof item.height === 'number'
            ? `${item.width}×${item.height}`
            : 'unknown size';
        const by = typeof item.creator === 'string' ? ` · by ${item.creator}` : '';
        return `${String(item.remoteId)} · ${String(item.title)} · ${length} · ${shape}${by}`;
      });
      // Carried through because it changes what the run should do next: a run
      // with 40 requests left should stop browsing and commit.
      const left =
        typeof obj.requestsLeftThisMonth === 'number'
          ? `\n(${obj.requestsLeftThisMonth} provider requests left this month)`
          : '';
      // Said here because run `137d8fd0` did not know it: it built `stock_pexels_<id>`
      // asset ids from these rows and asked to describe them before downloading anything.
      const notYetAssets =
        '\nThese are catalogue entries, not project assets: add_stock one and use the asset ' +
        'id it returns before describe_footage or detect_beats can read it.';
      return `${items.length} result${items.length === 1 ? '' : 's'}:\n${lines.join('\n')}${left}${notYetAssets}`;
    }
    case 'add_stock': {
      // What the run needs on its next turn: the file is down, where it went,
      // and where it is going. The full provenance record lives in the project;
      // repeating it here would spend tokens on a licence URL nobody opens.
      //
      // "downloaded", never "added": this digests the HOST's payload, which is
      // proof of a download and nothing more. The placement is authored by the
      // `add_stock` arm above and reported in its own note, so a payload that
      // reaches this digest by another route must not claim a timeline change.
      const asset = (obj.asset ?? {}) as Record<string, unknown>;
      const source = (asset.source ?? {}) as Record<string, unknown>;
      const seconds = typeof asset.durationSeconds === 'number' ? asset.durationSeconds : null;
      const length = seconds === null ? 'still' : `${seconds.toFixed(1)}s`;
      const at = typeof obj.atSeconds === 'number' ? ` at ${obj.atSeconds.toFixed(1)}s` : '';
      const by = typeof source.creator === 'string' ? ` · by ${source.creator}` : '';
      return `downloaded ${String(asset.path ?? 'file')} · ${length}${at} · ${String(
        source.license ?? 'unknown licence',
      )}${by}`;
    }
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
        .map(([label, key]) => {
          const body = typeof obj[key] === 'string' ? obj[key].trim() : '';
          // The bin summary is the one section that makes claims the project can
          // contradict, so it is the one section reconciled against it.
          return [label, key === 'binSummary' ? reconcileBinSummary(body, assets).trim() : body];
        })
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
      // P3.2: the two POINTED shapes now answer in frames, and they used to reach the
      // model as a JSON preview — the one call whose entire job is "do not do this
      // arithmetic yourself" was handing back something the model had to parse.
      if (Array.isArray(obj.hits)) {
        const hits = obj.hits as Record<string, unknown>[];
        if (hits.length === 0) {
          return 'that moment of footage is not in the sequence — it was cut, or it is outside the clip';
        }
        return `${hits.length} place${hits.length === 1 ? '' : 's'} in the sequence (${String(
          obj.fps ?? '?',
        )}fps):\n${boundedRecords(
          hits,
          (hit) =>
            `frame ${String(hit.sequenceFrame ?? '?')} (${round3(Number(hit.sequenceTime))}s) in ${String(hit.clipId)} on ${String(hit.trackId)}`,
          'places',
        )}`;
      }
      if (typeof obj.sequenceFrame === 'number') {
        const at = (obj.at ?? null) as Record<string, unknown> | null;
        const where =
          at === null
            ? 'nothing is playing there — a gap, or past the end of the sequence'
            : `${String(at.clipId)} on ${String(at.trackId)}, source time ${round3(Number(at.sourceTime))}s of ${String(at.assetId)}`;
        return `frame ${String(obj.sequenceFrame)} at ${String(obj.fps ?? '?')}fps: ${where}`;
      }
      const spans = clipRecords(obj, 'spans');
      if (!spans) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const duration = typeof obj.duration === 'number' ? round2(obj.duration) : '?';
      return `timeline map, ${spans.length} clip${
        spans.length === 1 ? '' : 's'
      }, sequence duration ${duration}s, ${String(obj.fps ?? '?')}fps, revision ${String(
        obj.revision ?? '?',
      )}:\n${boundedRecords(
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
      // A FAILED call's `data` is a string, not a payload: "no beats detected" would
      // bury the reason the call failed. An object with no beats is still no beats.
      if (typeof value !== 'object' || value === null)
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const beats = (Array.isArray(obj.beats) ? obj.beats : []) as Record<string, unknown>[];
      const timeOf = (b: Record<string, unknown>): number | undefined =>
        typeof b?.time === 'number' && Number.isFinite(b.time) ? b.time : undefined;
      const allTimes = beats.map(timeOf).filter((t): t is number => t !== undefined);
      if (allTimes.length === 0) return 'no beats detected';
      // An onset detector answers "something happened here", and music routinely puts
      // loud events off the beat — so the digest leads with the onsets the engine marked
      // as sitting on the tempo grid, which are the ones a cut "on the beat" wants. Every
      // onset is still there when nothing is marked (an older sidecar, a track with no
      // derivable tempo). The runtime does not hold cuts to any of these: where a cut
      // lands is the model's editorial call (ADR 0174), so the numbers have to be exact
      // and complete rather than sliced.
      const onGrid = beats
        .filter((b) => b?.on_grid === true)
        .map(timeOf)
        .filter((t): t is number => t !== undefined);
      const times = onGrid.length > 0 ? onGrid : allTimes;
      const bpm = typeof obj.bpm === 'number' ? ` · ~${Math.round(obj.bpm)} BPM` : '';
      const first = times[0] as number;
      const last = times[times.length - 1] as number;
      // Detector onsets are observations, not a mathematically uniform tempo grid.
      // Average BPM cannot reconstruct swing, drift, syncopation, or onset jitter — and
      // those exact timestamps are the edit contract. Times-only encoding is compact
      // enough to preserve the complete result while dropping per-beat strength fields.
      const exactGrid = times.map(round3).join(', ');
      const span = `from ${round3(first)}s to ${round3(last)}s`;
      const head =
        onGrid.length > 0
          ? `${onGrid.length} beat onsets on the tempo grid (of ${allTimes.length} detected)${bpm}`
          : `${times.length} exact beat onsets${bpm}`;
      return (
        `${head}, ${span}, in the music's own seconds — once the bed is on the timeline, ` +
        `map_time converts them; cutting on them is your call, nothing enforces it:\n${exactGrid}`
      );
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
          `${String(t.id)} [${String(t.type)}${typeof t.role === 'string' ? ` role:${t.role}` : ''}] ${String(t.clipCount ?? 0)} clips${
            typeof t.firstClipStart === 'number' && typeof t.lastClipEnd === 'number'
              ? ` ${round2(t.firstClipStart)}–${round2(t.lastClipEnd)}s`
              : ''
            // The same words `arrangementLine` uses for the same fact, per its doc comment:
            // the tool and the arrangement fact must describe the timeline identically, or
            // a run that read one plans against a constraint the other never mentioned.
          }${
            t.hiddenBehindPicture === true
              ? ` — hidden behind picture 0–${duration} (a full-frame clip added here lands on a new front layer)`
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
      const head = `${words.length} mapped words${dropped}${runPart}, ${String(
        obj.fps ?? '?',
      )}fps, revision ${String(obj.revision ?? '?')}`;
      // Sequence times only: the source times are in the payload for anyone who recalls
      // it, but a cue is authored against the sequence and doubling the numbers here
      // halves how many words fit.
      // P3.2: frames alongside seconds. A trim aimed at a word boundary has to be aimed
      // at a FRAME, and asking the model to derive one from a float is asking it to do the
      // arithmetic this tool exists to do for it.
      // The seconds shown are the EDIT POINTS (`startSeconds`/`endSeconds`), which are the
      // frames above expressed in seconds — not the raw measured word times. Publishing
      // both invited the run to read the frame and then pass the float, which
      // `quantizePatch` rounded back across the word edge; three turns of the session-6
      // run went that way. Whichever number the model copies now, it names the same frame.
      // The measurement is still in the payload for a recall.
      return `${head}:\n${boundedRecords(
        words,
        (w) =>
          `f${String(w.startFrame ?? '?')}–${String(w.endFrame ?? '?')} ` +
          `(${round3(Number(w.startSeconds ?? w.start))}–${round3(Number(w.endSeconds ?? w.end))}s) ` +
          `${String(w.word)}`,
        'words',
        'narrow get_mapped_transcript to a window',
        WORD_DIGEST_MAX_ITEMS,
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
    case 'load_tools': {
      // The names, not the JSON. What the model needs from this call is which tools it
      // may now reach; the default preview would render that as an escaped object.
      const loaded = Array.isArray(obj.loaded) ? obj.loaded.map(String) : [];
      const names = Array.isArray(obj.tools) ? obj.tools.map(String) : [];
      return `${loaded.join(', ')} loaded — now available: ${names.join(', ')}`;
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
        // P3.2: the frame leads, because that is the unit the cut actually has. A
        // professional editor does not think in 12.3874s; they think frame 371.
        (b) =>
          `frame ${String(b.frame ?? '?')} (${round3(Number(b.at))}s) ${String(b.trackId)} ` +
          `${String(b.fromClipId)} → ${String(b.toClipId)} (max transition ${String(
            b.maxTransitionFrames ?? '?',
          )} frames / ${round2(Number(b.maxTransitionSeconds))}s)`,
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
      // The level is the whole meaning of the count. Without it a run on wind-only audio
      // reported "silences catalogued" to an editor who had asked whether there was any
      // REAL silence and said they doubted it (run `137d8fd0`, 728 measured under the
      // default floor). Say what was measured, and that it is a level and not a verdict.
      const level =
        typeof obj.noiseFloorDb === 'number'
          ? ` under ${String(obj.noiseFloorDb)} dB — a level, not a judgement: on audio with ` +
            `no speech, quiet ambience reads as silence; listen, or lower noiseFloorDb, before ` +
            `calling it dead air —`
          : '';
      return `${ranges.length} silent gap${ranges.length === 1 ? '' : 's'}${level || ','} ${round2(
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
    case 'detect_subjects': {
      // Detections are evidence the model reasons over (who is on screen, when),
      // so the digest names counts and frame coverage instead of slicing raw JSON.
      // The per-frame boxes remain available in the card's details popup.
      const total = typeof obj.totalDetections === 'number' ? obj.totalDetections : 0;
      if (total === 0) return 'no subjects detected — an honest empty result, not a guess';
      const byLabel = (obj.byLabel ?? {}) as Record<string, number>;
      const labelPart =
        Object.entries(byLabel)
          .map(([label, count]) => `${count} ${label}`)
          .join(', ') || `${total} detections`;
      const frames = typeof obj.framesWithDetections === 'number' ? obj.framesWithDetections : 0;
      return `${labelPart} across ${frames} frame${frames === 1 ? '' : 's'} in ${String(
        obj.clipId ?? '?',
      )}`;
    }
    case 'get_transcript': {
      // The load-bearing one. `previewJson` handed back a 1200-CHARACTER slice of the raw
      // word JSON — about 25 words of a 1,500-word recording, cut mid-record, with no count
      // and no instruction to narrow. A run asked to find the strongest hook could only ever
      // find it in the first thirty seconds, because that was the only material it had.
      // Words, not JSON: SOURCE times (the tool's whole warning) and the word itself.
      const words = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
      if (!Array.isArray(value)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      if (words.length === 0)
        return 'no transcript words — this project has no transcript yet (run transcribe first)';
      const first = Number(words[0]?.start ?? 0);
      const last = Number(words[words.length - 1]?.end ?? 0);
      // SOURCE is stated in the head because the source/sequence distinction is exactly what
      // the tool description warns about, and this line becomes the run's durable fact
      // (`briefing.ts#distil` keeps the first line) — a fact that does not say which clock
      // it is on is a fact the next turn can misread onto the timeline.
      return `${words.length} transcript words in SOURCE time (the original recording, not the edited timeline), ${round3(first)}–${round3(last)}s:\n${boundedRecords(
        words,
        (w) => `${round3(Number(w.start))}–${round3(Number(w.end))}s ${String(w.word)}`,
        'words',
        'narrow get_transcript to a start/end window',
        WORD_DIGEST_MAX_ITEMS,
      )}`;
    }
    case 'map_footage': {
      // Chapters and highlights are the story shape the run plans against, and the head line
      // becomes its durable fact — so the chapter count and the mapped span ride there.
      const chapters = (Array.isArray(obj.chapters) ? obj.chapters : []) as Record<
        string,
        unknown
      >[];
      const highlights = (Array.isArray(obj.highlights) ? obj.highlights : []) as Record<
        string,
        unknown
      >[];
      // An ABSENT chapters array is a payload of a different shape, not an empty map — the
      // house rule for every digest here.
      if (!Array.isArray(obj.chapters)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const durationSec = typeof obj.durationSec === 'number' ? obj.durationSec : 0;
      const backend = typeof obj.backend === 'string' ? ` via ${obj.backend}` : '';
      const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
      if (chapters.length === 0 && highlights.length === 0) {
        return reason !== ''
          ? `no footage map: ${reason}`
          : 'no footage map — this footage has no chapters or highlights yet';
      }
      const overview = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const head =
        `${chapters.length} chapter${chapters.length === 1 ? '' : 's'} and ` +
        `${highlights.length} highlight${highlights.length === 1 ? '' : 's'} over ` +
        `${round2(durationSec)}s of footage${backend}`;
      const span = (record: Record<string, unknown>): string =>
        `${round2(Number(record.t0))}–${round2(Number(record.t1))}s`;
      const lines: string[] = [head];
      if (overview !== '') lines.push(`summary: ${overview}`);
      if (chapters.length > 0) {
        lines.push(
          boundedRecords(
            chapters,
            (c) => {
              const title = String(c.title ?? 'untitled');
              const detail = typeof c.summary === 'string' ? ` — ${c.summary.trim()}` : '';
              return `chapter ${span(c)} ${title}${detail}`;
            },
            'chapters',
            'pass an assetId to map one asset at a time',
          ),
        );
      }
      if (highlights.length > 0) {
        lines.push(
          boundedRecords(
            highlights,
            (h) => {
              const score = typeof h.score === 'number' ? ` (salience ${round2(h.score)})` : '';
              return `highlight ${span(h)} ${String(h.label ?? 'unlabelled')}${score}`;
            },
            'highlights',
            'pass an assetId to map one asset at a time',
          ),
        );
      }
      return lines.join('\n');
    }
    case 'read_edit_signals': {
      // Measured spans the run acts on in the same turn: 11 of 60 survived the JSON slice.
      // Whole records, in the time order the tool promises.
      if (!Array.isArray(value)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const signals = value as Record<string, unknown>[];
      if (signals.length === 0)
        return 'no edit signals — nothing measurable was supplied or found in this stretch';
      return `${signals.length} edit signal${signals.length === 1 ? '' : 's'} in time order:\n${boundedRecords(
        signals,
        (s) =>
          `${String(s.kind)} ${round2(Number(s.t0))}–${round2(Number(s.t1))}s ${String(
            s.observation,
          )} (${String(s.from)})`,
        'signals',
        'supply fewer signals, or narrow the ones you pass in',
      )}`;
    }
    case 'transcribe': {
      // An acknowledgement whose payload happens to carry every word. Repeating the words
      // here would bill the whole transcript twice in one run — once as the acknowledgement
      // and again on the get_transcript the model makes anyway — so the digest states what
      // landed and names the call that returns it. A declared omission with an address,
      // never a silent one.
      if (!Array.isArray(obj.words)) return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const words = obj.words as Record<string, unknown>[];
      if (words.length === 0)
        return 'transcribed no words — this asset carries no recognizable speech';
      const first = Number(words[0]?.start ?? 0);
      const last = Number(words[words.length - 1]?.end ?? 0);
      return (
        `transcribed ${words.length} timed words, ${round3(first)}–${round3(last)}s of source ` +
        `audio${typeof obj.assetId === 'string' ? ` in ${obj.assetId}` : ''}; the words are on ` +
        'the project now — read them with get_transcript (the full list is not repeated here)'
      );
    }
    case 'get_frame': {
      // The picture rides as an image part on this turn; the digest is the FACTS about it,
      // because that is what the text-only action log keeps once the image is gone.
      if (typeof obj.timeSeconds !== 'number') return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const size =
        typeof obj.width === 'number' && typeof obj.height === 'number' && obj.width > 0
          ? ` ${obj.width}×${obj.height}`
          : '';
      const duration =
        typeof obj.durationSeconds === 'number'
          ? ` of a ${round2(obj.durationSeconds)}s timeline`
          : '';
      // A clamped frame is a different moment than the one asked about. Saying so is the
      // difference between "the end looks wrong" and reasoning about the wrong frame.
      const clamped =
        obj.clamped === true && typeof obj.requestedTimeSeconds === 'number'
          ? ` — CLAMPED from the ${round2(obj.requestedTimeSeconds)}s you asked for, which is outside the timeline`
          : '';
      return `frame at ${round2(obj.timeSeconds)}s${duration},${size} attached to this turn as an image${clamped}`;
    }
    case 'index_media': {
      // A progress record, not a record list — but previewJson still cut it, and "how far
      // did indexing get" is precisely the number that decides whether search_visual is
      // worth calling yet.
      if (typeof obj.total !== 'number' && typeof obj.indexed !== 'number')
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const indexed = typeof obj.indexed === 'number' ? obj.indexed : 0;
      const total = typeof obj.total === 'number' ? obj.total : 0;
      const cursor = typeof obj.cursor === 'number' ? obj.cursor : total;
      const reason = typeof obj.reason === 'string' && obj.reason !== '' ? ` — ${obj.reason}` : '';
      const remaining =
        cursor < total
          ? `; ${total - cursor} asset${total - cursor === 1 ? '' : 's'} still to go, call index_media again to continue`
          : '';
      return `indexed ${indexed} span${indexed === 1 ? '' : 's'} across ${cursor}/${total} asset${total === 1 ? '' : 's'}${remaining}${reason}`;
    }
    case 'measure_color': {
      // The numbers are deliberately NOT rendered. `measure_color`'s contract is that the
      // model passes the revision-bound HANDLE to professional_color match_reference and
      // never copies the measurements — printing a hundred percentile readings into the log
      // is an invitation to do exactly the thing the tool description forbids, at the cost of
      // the channel coverage that actually decides whether a match can run.
      if (!Array.isArray(obj.samples) || typeof obj.clipId !== 'string')
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const samples = obj.samples as Record<string, unknown>[];
      const channels = [...new Set(samples.map((s) => String(s.channel)))];
      const startFrame = typeof obj.startFrame === 'number' ? obj.startFrame : 0;
      const endFrame = typeof obj.endFrame === 'number' ? obj.endFrame : 0;
      const occluded =
        obj.occlusionFree === true
          ? 'no other visible layer contaminated the sample'
          : 'ANOTHER VISIBLE LAYER CONTAMINATED THE SAMPLE — this reading is not a clean measurement of the shot';
      return (
        `measured ${String(obj.clipId)} over frames ${startFrame}–${endFrame} at revision ` +
        `${String(obj.projectRevision ?? '?')}: ${channels.length} channel${channels.length === 1 ? '' : 's'} ` +
        `(${channels.join(', ')}) across ${samples.length} reading${samples.length === 1 ? '' : 's'}; ${occluded}. ` +
        'The distributions themselves are held as evidence and deliberately not printed — pass ' +
        'this measurement handle to professional_color match_reference; never retype the numbers.'
      );
    }
    case 'get_selected_range': {
      // Two numbers — but "null" previewed as a bare `null` reads as a failed read rather
      // than as the user having selected nothing, and the two lead to opposite plans.
      if (value === null || value === undefined)
        return 'nothing is selected — the user has not marked a range, so any edit is on the whole timeline unless you say otherwise';
      if (typeof obj.start !== 'number' || typeof obj.end !== 'number')
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      return `selection ${round3(obj.start)}–${round3(obj.end)}s (${round2(obj.end - obj.start)}s) in timeline time`;
    }
    case 'track_subject_automatically': {
      // Per-frame geometry, one record per frame: previewJson cut it after a handful of
      // sample rows, which is both useless and misleading. The samples are applied to the
      // mask by the tracked patch — the model never reasons over the coordinates — so the
      // digest reports the measurement and says plainly that the samples are not shown.
      const samples = (Array.isArray(obj.samples) ? obj.samples : []) as Record<string, unknown>[];
      const plan = (obj.plan ?? {}) as Record<string, unknown>;
      if (!Array.isArray(obj.samples) || typeof plan.clipId !== 'string')
        return previewJson(value, ANALYSIS_PREVIEW_MAX);
      const fps = typeof plan.fps === 'number' && plan.fps > 0 ? plan.fps : 0;
      const startSeconds = typeof plan.startSeconds === 'number' ? plan.startSeconds : 0;
      const span =
        fps > 0
          ? `${round2(startSeconds)}–${round2(startSeconds + samples.length / fps)}s`
          : `from ${round2(startSeconds)}s`;
      const engine = typeof obj.engine === 'string' ? obj.engine : 'unknown engine';
      const backend = typeof obj.backend === 'string' ? ` (${obj.backend})` : '';
      return (
        `tracked ${samples.length} frame${samples.length === 1 ? '' : 's'} of ${String(plan.clipId)} ` +
        `mask ${String(plan.maskEffectId ?? '?')} over ${span} with ${engine}${backend}. ` +
        'The per-frame positions are applied to the mask by the tracked patch and are not ' +
        'listed here; you never supply or edit them yourself.'
      );
    }
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
/**
 * The frame an evidence request is about, whatever kind it is.
 *
 * A frame request carries `atFrame`; the windowed kinds (range, audio, loudness, motion,
 * comparison) carry `startFrame`. Probed rather than switched on `kind` so a new request
 * shape that carries either is located without a second place to update.
 */
export function requestFrame(request: TemporalEvidenceRequest): number | undefined {
  const record = request as unknown as Record<string, unknown>;
  for (const key of ['atFrame', 'startFrame']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Where the earliest FAILING piece of temporal evidence sits, in seconds.
 *
 * `ReviewFinding.atSeconds` is documented as "where in the programme it sits, for a jump
 * affordance", and it was filled with {@link earliestTouchedSecond} — the start of the
 * earliest clip the reviewed TURN touched, stamped identically on every finding that turn
 * produced. That is where the edit was, not where the defect is.
 *
 * Run `25e06a6f` reported `Program ending is black (frame 1493)` — 49.767s of a 49.8s
 * programme — twice, at `0s` and at `0.067s`, because the turns that triggered those
 * reviews had touched a clip starting at zero. An editor following the jump lands at the
 * top of the timeline to look at a defect in its final frame.
 *
 * The failing request knows its own frame, so the finding is placed from that, earliest
 * first when several failed. A review that fails with no frame anywhere (a whole-programme
 * check) still falls back to the turn's location, which is better than nothing.
 */
export function failingReviewSecond(
  requests: readonly TemporalEvidenceRequest[],
  failing: readonly { readonly requestId: string }[],
  fps: number,
): number | undefined {
  if (!(Number.isFinite(fps) && fps > 0)) return undefined;
  const frameById = new Map(requests.map((request) => [request.requestId, requestFrame(request)]));
  const frames = failing
    .map((check) => frameById.get(check.requestId))
    .filter((frame): frame is number => frame !== undefined);
  return frames.length === 0 ? undefined : Math.min(...frames) / fps;
}

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

/**
 * The silence this run actually measured, with the handle it is filed under (P4.3).
 *
 * The dead-air check can always answer from the mapped transcript, so this is a sharpening
 * rather than a dependency — but a finding that cites `ev_7` is one the editor (and the
 * next turn) can go and read, where a bare number is one they have to take on trust. That
 * is the same standard `clearedWithHandle` established: a marker with no address is an
 * apology, not an instruction.
 *
 * Only `analyze_silence` payloads are read, and only their `ranges`. A store scan that
 * guessed at shapes would be a second, undeclared contract with every analysis tool.
 */
function measuredSilences(evidence: EvidenceStore): Pick<CritiqueOptions, 'silences'> {
  for (const entry of [...evidence.entries()].reverse()) {
    if (entry.source !== 'analyze_silence') continue;
    const data = (entry.data ?? {}) as Record<string, unknown>;
    if (!Array.isArray(data.ranges)) continue;
    const ranges = (data.ranges as Record<string, unknown>[])
      .filter((r) => typeof r.start === 'number' && typeof r.end === 'number')
      .map((r) => ({ start: r.start as number, end: r.end as number }));
    return { silences: { ranges, handle: entry.id } };
  }
  return {};
}

/**
 * The clip ids a rejected patch was withholding.
 *
 * `editor-core` rejects a bad clip reference with `Clip not found: <id>` and stops there —
 * correctly, since it must not import the AI layer, and it already names the clip and the
 * operation. But the model reads only this note, and "not found" alone leaves it re-issuing
 * the same id or spending a turn on `get_clips`. This is the same repair `dca15af` made for
 * tracks, applied where validation issues become the model's note: append the real ids once,
 * for the first unknown clip in the batch (a batch tool usually mistyped one id, and eight
 * copies of the timeline listing would cost more than the rejection itself).
 *
 * Matched on the message rather than on `missing_reference`: the same `Clip not found: <id>`
 * reaches here as `unsupported_operation` when the semantic contract replay is what rejected
 * it, and the reader cannot tell — or care — which gate caught the typo.
 *
 * @param project - The working copy the operations were validated against.
 * @param issues - The error-severity issues, in the order they are reported.
 * @returns The candidates line, or `''` when no issue names an unknown clip.
 */
function unknownClipHelp(project: Project, issues: readonly ValidationIssue[]): string {
  for (const issue of issues) {
    const named = /Clip not found: ([^\s,;]+)/.exec(issue.message);
    if (named) return clipCandidates(project, named[1]!);
  }
  return '';
}

export class Orchestrator {
  private readonly executor: HostToolExecutor | undefined;
  /** P7.3 dev/debug affordance — see {@link OrchestratorOptions.recordEffects}. */
  private readonly recordEffects: boolean;
  private readonly onRecording: ((recording: RunRecording) => void) | undefined;
  private readonly replayRuntime: (() => EffectRuntime) | undefined;
  private readonly effectObserver: EffectRuntimeObserver | undefined;
  /** See {@link OrchestratorOptions.tierProviders}. Empty unless the host opted in. */
  private readonly tierProviders: Partial<Record<ModelTier, AiProvider>>;

  public constructor(
    private readonly provider: AiProvider,
    options: OrchestratorOptions = {},
  ) {
    this.executor = options.executor;
    this.recordEffects = options.recordEffects ?? false;
    this.onRecording = options.onRecording;
    this.replayRuntime = options.replayRuntime;
    this.effectObserver = options.effectObserver;
    this.tierProviders = options.tierProviders ?? {};
  }

  /**
   * The provider serving one {@link ModelTier}: its configured override, else the
   * host-selected provider. The direct-call twin of the effect runtime's own tier lookup,
   * for the one model call that does not go through a run runtime (the classifier).
   */
  private providerForTier(tier: ModelTier): AiProvider {
    return this.tierProviders[tier] ?? this.provider;
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
    const base = this.replayRuntime
      ? this.replayRuntime()
      : createEffectRuntime({
          provider: this.provider,
          ...(Object.keys(this.tierProviders).length === 0
            ? {}
            : { tierProviders: this.tierProviders }),
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
    // The cutaway cap the brief states, so the placement tools can hold the run to it
    // (`domain-tools/timeline.ts`). Read here, once, from the same reader the Critic uses.
    const cap = explicitCutawayCount(deriveObjectiveText(input.userPrompt, input.history));
    return {
      project: input.project,
      ...(cap === undefined ? {} : { stockCutawayCap: cap }),
      ...(input.projectRevision === undefined ? {} : { projectRevision: input.projectRevision }),
      // The turn number is the conversation's own clock: the user's messages so far
      // plus the one being answered. Derived rather than plumbed, so every caller
      // that passes history gets dated memory writes without changing its call.
      turn: (input.history ?? []).filter((m) => m.role === 'user').length + 1,
      ...(input.selection ? { selection: input.selection } : {}),
      // Re-stamped, not passed through. The snapshot is captured once when the turn
      // starts, and in agent mode the agent's own first edit would otherwise make every
      // selection-authored tool refuse `stale_context` for the rest of the run — see
      // `rebaseEditorInteractionContext`. A selection whose clips have moved is still
      // refused; only an intact one is carried forward.
      ...(input.interaction
        ? {
            interaction: rebaseEditorInteractionContext(
              input.interaction,
              input.project,
              input.projectRevision,
            ),
          }
        : {}),
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
    /**
     * The run's evidence store (P4.3). The critic is another consumer of the run's
     * context, and it used to get a THINNER view than the planner did: a run that could
     * see the whole transcript while planning saw only the timeline while reviewing, and
     * would approve cuts it would have rejected. Optional because the standalone `review`
     * route has no run behind it — an absent store means "nothing was gathered", which is
     * different from "nothing was found" and is reported as such by the checks.
     */
    evidence?: EvidenceStore,
  ): CritiqueOptions {
    // What the run is actually being asked for, not what was typed last. "continue from
    // here" carries no duration, no shot count and no coverage — deriving acceptance from
    // it discarded the 50-clip brief it was nudging, so a continuation's self-check had
    // nothing left to settle. `deriveObjectiveText` already owns this resolution for the
    // run's objective; the Critic reads the same answer so criterion and check cannot be
    // about two different requests.
    const objectiveText = deriveObjectiveText(input.userPrompt, input.history);
    // A request that stated a RANGE ("20–35 seconds") also stated its own tolerance; using
    // the 2s default over the range's midpoint would fail a 34-second cut the brief allowed.
    const stated = explicitDurationTarget(objectiveText);
    const durationTargetSeconds = options.durationTargetSeconds ?? stated?.seconds;
    const durationToleranceSeconds =
      options.durationTargetSeconds === undefined ? stated?.toleranceSeconds : undefined;
    // The conditions the request stated in checkable terms (see `acceptance.ts`). The same
    // reading is recorded on the run's objective, so the criterion the ledger reports against
    // and the check that settles it can never be two different things.
    const { minShotCount, coverage, maxStockCutaways } = checkableAcceptance(
      objectiveText,
      durationTargetSeconds,
    );
    // The measured half of "make it feel like this" (P3.4). The reference's numbers reach
    // the Critic WITHOUT passing through the model: a run cannot forget, round or re-derive
    // a target it never had to restate, and the check the run is graded by and the target
    // the plan was given are one reading of one analysis.
    const directives = referenceDirectives(input.references ?? []);
    const medianShotTargetSeconds = directives.medianShotSeconds;
    const medianShotToleranceSeconds = shotLengthTolerance(directives);
    const medianShotSource = directives.applied.find((c) => c.line.startsWith('Pacing:'));
    return {
      userPrompt: input.userPrompt,
      // The resolved request, so `checkShotCount` can tell "no count was asked for" apart
      // from "a count was asked for and the reader missed it" (see `acceptance.ts`).
      request: objectiveText,
      ...(producedChanges !== undefined ? { producedChanges } : {}),
      ...(durationTargetSeconds !== undefined ? { durationTargetSeconds } : {}),
      ...(durationToleranceSeconds !== undefined ? { durationToleranceSeconds } : {}),
      ...(minShotCount !== undefined ? { minShotCount } : {}),
      ...(maxStockCutaways !== undefined ? { maxStockCutaways } : {}),
      ...(medianShotTargetSeconds !== undefined ? { medianShotTargetSeconds } : {}),
      ...(medianShotToleranceSeconds !== undefined ? { medianShotToleranceSeconds } : {}),
      ...(medianShotSource !== undefined
        ? { medianShotSource: `${medianShotSource.profileId}: ${medianShotSource.line}` }
        : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      ...(options.targetPlatform !== undefined ? { targetPlatform: options.targetPlatform } : {}),
      ...(options.render !== undefined ? { render: options.render } : {}),
      ...(evidence ? measuredSilences(evidence) : {}),
    };
  }

  /** Q&A over transcript/timeline; no mutation (PRD §7.1, §8.2). */
  public async chat(input: ContextInput): Promise<AiResponse> {
    // No tools on this route, so nothing is attached after assembly — but the WINDOW is
    // still the selected model's rather than a hardcoded 190K.
    return this.provider.complete({ messages: buildContext(this.budgeted(input, 0)) });
  }

  /** Structured plan; no mutation, no render. */
  public async plan(input: ContextInput): Promise<AiResponse> {
    const messages = [
      ...buildContext(this.budgeted(input, estimateTokens(PLAN_MODE_INSTRUCTION))),
      { role: 'user' as const, content: PLAN_MODE_INSTRUCTION },
    ];
    // A plan turn forbids tool calls, so advertising tool schemas is pure token waste
    // (~541 tok of read-tool descriptors) AND contradictory prompting that can nudge a
    // weaker model into emitting a tool call anyway. Send no tools.
    return this.provider.complete({ messages });
  }

  /** Cmd+K small reviewable edit → returns a validated, diffable patch (PRD §7.2). */
  public async edit(input: ContextInput): Promise<EditResult> {
    const editTools = toolDescriptors((t) => t.mutates);
    const response = await this.provider.complete({
      messages: buildContext(this.budgeted(input, toolSchemaCost(editTools))),
      tools: editTools,
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
    const tools = toolDescriptors((t) => t.mutates);
    const messages = buildContext(this.budgeted(input, toolSchemaCost(tools)));
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
    const suggestTools = toolDescriptors((t) => t.mutates);
    const response = await this.provider.complete({
      messages: buildContext(this.budgeted(input, toolSchemaCost(suggestTools))),
      tools: suggestTools,
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
   * - `'action-recovery'`: a one-turn mutate/ask surface — plus `recall_evidence` and the
   *   `sourcing` role (ADR 0147) — after the prior turn requested only memo-served
   *   information. This makes duplicate suppression an executable constraint
   *   rather than another ignored prompt warning. Both exceptions are load-bearing: the
   *   turn's whole premise is that the run already HAS what it needs, which is false if
   *   it cannot reach it (recall), and false again if the material it needs was never on
   *   this machine to begin with (sourcing).
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
    scope: AgentToolScope = 'agent',
    stage?: RunStage,
    /**
     * Tool domains this run has pinned (progressive disclosure — `tool-domains.ts`).
     * Absent means "advertise everything", which is what the budget reservation and the
     * MCP-facing callers want; a live agent turn always passes the run's ledger.
     */
    loadedDomains?: ReadonlySet<ToolDomain>,
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
    // What this HOST cannot fulfil is not offered. Statically known, declared by the
    // executor (`HostToolExecutor.unroutableTools`), and the reason is upstream of every
    // guard: a tool the model can see, it will call. Run 6 of 2026-09-05 called
    // `render_preview` eight times on a surface with no route for it, and paid the two
    // render descriptors' schema on every one of its 308 requests besides.
    const unroutable = this.executor?.unroutableTools?.() ?? EMPTY_TOOL_NAMES;
    return toolDescriptors((tool) => {
      if (unroutable.has(tool.name)) return false;
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
        // `effectClass`, not `kind`. The registry kind of `add_stock`/`add_music` is
        // `analysis` — they are reached through a search — but each one downloads a file
        // and places a clip through a reversible patch, which `tool-contract.ts` has
        // always declared. Filtering on `kind` here refused the one call that could put
        // picture into an empty project, and told the model it was "redundant": run
        // `e30c1fe9` asked for exactly one clip it had already found, was refused, and
        // built a reel with no footage in it. A recovery turn demands an ACTION; these
        // are actions.
        //
        // `sourcing` rides alongside, which completes the same correction one step
        // earlier. Admitting `add_stock` while withholding `search_stock` is a whole
        // surface only for a run that has already searched. A run on an EMPTY project has
        // nothing to add BY `remoteId`, and the only thing that mints a `remoteId` is the
        // search it was just refused — so run `f1d5285e` was told to stop looking and make
        // the edit, could reach nothing but `recall_evidence`, and was ended by the memo
        // hit that answer counts as. The guard produced the outcome it exists to prevent
        // (ADR 0147, amending ADR 0143).
        //
        // Reconnaissance over material the project ALREADY holds — the transcript, the
        // footage map, silence, scenes — stays withheld, which is what the turn is for.
        // And `state.actionRecoveryPending` is set for the whole recovery turn, so one
        // that spends this allowance without acting falls straight through to the
        // convergence guard rather than earning another.
        //
        // A look at the run's OWN edit is not reconnaissance either
        // (`EDIT_LOOK_TOOL_NAMES`): run `cc907070` was asked for a preview, called
        // `render_preview` on a recovery turn, and was told the turn was for acting.
        const effect = toolContract(tool).effectClass;
        return (
          effect === 'mutation' ||
          tool.kind === 'ask' ||
          tool.name === 'recall_evidence' ||
          EDIT_LOOK_TOOL_NAMES.has(tool.name) ||
          toolRole(tool.name, tool.mutates) === 'sourcing'
        );
      }
      // A run holding unspent candidates may not fetch more (05/02). Withholding is
      // narrow on purpose, and every exclusion below is a deadlock this would otherwise
      // cause:
      //
      // - `recall_evidence` is NEVER withheld. The agent log keeps payloads for two turns
      //   (`AGENT_LOG_PAYLOAD_FRESH`) and a stock `remoteId` exists nowhere else, so
      //   refusing a recall does not force commitment — it removes the only route to the
      //   argument `add_stock` takes, which is the ADR 0143 failure ADR 0147 reversed.
      // - Inspection stays open. A run whose downloads all failed, or whose placement is
      //   refused for want of a free span, has to be able to read the timeline and say so.
      // - Only the CATALOGUE SEARCHES go. They are what mints more candidates, and more
      //   candidates is precisely what the run does not need.
      //
      // The scope is entered only when a search has already banked results (so an empty
      // project can always search) and released by the first successful placement.
      if (scope === 'commit-only' && isCatalogueSearch(tool.name)) return false;
      if (questionScope !== undefined && !questionScope.has(tool.name)) return false;
      // Progressive disclosure. The core set plus whatever this run has asked for; see
      // `tool-domains.ts` for the measurement that made this necessary. Applied last so
      // every narrowing above still holds — a domain being loaded never re-admits a tool
      // the stage, the recovery turn, or the commit-only scope has withheld.
      if (loadedDomains !== undefined && !toolIsAdvertised(tool.name, loadedDomains)) return false;
      return stage === undefined || stageAllowsTool(stage, tool.name, tool.mutates);
    });
  }

  /**
   * The same request, with the budget the trimmer will actually decide against
   * (context-management P1.2). Every route resolves it this way, so switching model in
   * Settings moves the room the trimmer uses and not only the number the composer shows.
   *
   * @param reservedPromptTokens - What this route attaches AFTER assembly: its tool
   *   schemas, its mode instruction, its pinned playbooks. Zero is honest for a route
   *   that attaches none of them.
   */
  private budgeted(input: ContextInput, reservedPromptTokens: number): ContextInput {
    return { ...input, budget: resolveContextBudget(input, this.provider, reservedPromptTokens) };
  }

  /**
   * The cost of the WIDEST tool set an agent run can advertise.
   *
   * Widest, not per-stage, on purpose: the stage policy narrows the set mid-run (F5), and
   * a budget that shrank and grew with it would let a turn fit under a reservation the
   * NEXT turn exceeds. Reserving the maximum means the room the trimmer works with is
   * stable for the whole run, which is also what P5.3 makes literally true. Memoized —
   * the set is a pure function of this orchestrator's provider and model.
   */
  private agentToolCostMemo: number | undefined;
  private agentToolCost(): number {
    this.agentToolCostMemo ??= toolSchemaCost(this.agentTools());
    return this.agentToolCostMemo;
  }

  /**
   * Per-run memo for {@link agentStableInstruction} (E3.2,
   * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md). Keyed by the run's skill ledger —
   * a per-run object, so entries can never leak across runs — and revalidated on the
   * ledger's size (it only ever grows) plus the plan's identity (drafted once per run).
   */
  private readonly stableInstructionMemo = new WeakMap<
    ReadonlyMap<string, string>,
    {
      size: number;
      plan: readonly string[] | undefined;
      text: string;
      /** The same head, as manifest rows — see `agentStableInstructionSections`. */
      sections: readonly AssembledSection[];
    }
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
    const planBlock = agentPlanBlock(plan);
    const skillsBlock = agentSkillsBlock([...loadedSkills.values()]);
    const text = `${instruction}${planBlock}${skillsBlock}`;
    const skillCount = loadedSkills.size;
    this.stableInstructionMemo.set(loadedSkills, {
      size: loadedSkills.size,
      plan,
      text,
      // Sized once, here, where the parts already exist — the head is ~32k tokens on a
      // run with playbooks pinned, and re-estimating it every turn to fill in a report
      // would be the report costing more than the thing it reports on.
      sections: [
        {
          tier: 'system' as const,
          label: 'agent contract',
          tokenEstimate: estimateTokens(instruction),
          included: true,
        },
        {
          tier: 'system' as const,
          label: 'committed plan',
          tokenEstimate: estimateTokens(planBlock),
          included: true,
        },
        {
          tier: 'skills' as const,
          // The COUNT is in the label because it is the number that explains the size,
          // and because a reader comparing two manifests wants to see it change.
          label:
            skillCount === 1 ? 'pinned playbook (1)' : `pinned playbooks (${String(skillCount)})`,
          tokenEstimate: estimateTokens(skillsBlock),
          included: true,
        },
      ].filter((section) => section.tokenEstimate > 0),
    });
    return text;
  }

  /**
   * The stable head, as manifest sections — so the biggest block in every agent request
   * is attributed instead of bucketed.
   *
   * ## WHY
   *
   * `assembleContext` does not build this block, so it never appeared in the tier account,
   * and `withRemainder` swept it into one row called "additional request content" —
   * reported, because `sectionTypeFor` maps an unlabelled `prompt` tier to `system`, as a
   * **system** section. In run `137d8fd0` that row was **32,338 tokens: 57% of every
   * request**, and the manifest's whole promise (ADR 0080: "a change in the number always
   * arrives with its cause attached") failed for the single largest number in the run.
   * It is not the system contract — that is 135 tokens. It is eight pinned playbooks.
   *
   * The budget already subtracts this block (`agentTurnRequest` passes
   * `estimateTokens(stableHead)`), so nothing about what is SENT changes here. Only the
   * account does, and only so the next person to ask why a run costs what it costs can
   * see the answer rather than a bucket.
   *
   * Read from the same memo that built the head, so this costs nothing per turn.
   */
  private agentStableInstructionSections(
    loadedSkills: ReadonlyMap<string, string>,
    plan: readonly string[] | undefined,
  ): readonly AssembledSection[] {
    this.agentStableInstruction(loadedSkills, plan);
    return this.stableInstructionMemo.get(loadedSkills)?.sections ?? [];
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
    /**
     * The run's options, so the turn's WHERE YOU STAND block is measured against the same
     * acceptance reading the final self-check will use (GAP-014). Defaulted rather than
     * required: the repair pass and the legacy loop pass none, and an empty reading yields
     * an empty block rather than a wrong one.
     */
    agentOptions: AgentOptions = {},
  ): {
    readonly messages: AiMessage[];
    /**
     * The TIER account `assembleContext` produced, carried out so the request manifest can
     * name what the project view actually held (GAP-020).
     *
     * It used to be discarded. The agent folds every tier into one turn-varying message,
     * and `buildRequestManifest` falls back to a per-MESSAGE account when it is given no
     * assembled sections — so every manifest in an agent run read `system contract`,
     * `user turn 1`, `user turn 2`, `user request`, `tool definitions` and nothing else.
     * Whether the footage map, the media bin, the timeline summary or the transcript slice
     * were in the prompt was unanswerable from the run's own record, and a trimmed tier
     * left no trace at all: compaction is invisible in a payload-derived account, which is
     * the one thing this field exists to carry.
     *
     * Run `fc10301a` claimed to have "absorbed all the photo descriptions from the footage
     * map" on a turn where no footage map existed. Nothing in 41 manifests could falsify
     * it.
     */
    readonly assembled: {
      readonly sections: readonly AssembledSection[];
      readonly droppedTokenEstimate: number;
    };
  } {
    const stableHead = this.agentStableInstruction(loadedSkills, plan);
    // P1.2: the agent turn's budget subtracts what `buildContext` does not assemble — the
    // widest tool set the run can advertise, plus this run's stable head (the agent
    // contract, the committed plan, and every playbook pinned so far). Pinned skills are
    // up to 6,728 tokens on their own, and they arrive mid-run, so a budget that ignored
    // them shrank the room after the trimmer had already decided.
    const assembled = assembleContext({
      ...this.budgeted(input, this.agentToolCost() + estimateTokens(stableHead)),
      project: working,
    });
    const base = assembled.messages;
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
    // `assembleContext` returns [system, ...history, project+request] — always at least
    // two messages, and the last is always the project block, so the split is total.
    const stablePrefix = base.slice(0, -1);
    // P1.3, second half. Growing the grounding slice put ~9,000 more tokens into the
    // prompt, and with the whole project block in this turn-varying message the cacheable
    // prefix share fell from 85% to 45% — coverage bought with cache, which is not a
    // trade the phase is allowed to make.
    //
    // Only the TIMELINE summary actually varies per turn: it is rendered from the
    // mutating working copy. The transcript, the footage map, the memory tiers and the
    // skills manifest are fixed for the run, so they belong ABOVE the cache boundary with
    // the stable head rather than below it. `AssembledContext.split` draws that line;
    // `messages` is unchanged, so every non-agent route keeps the prompt it had.
    const { stable: stableContext, volatile: volatileContext } = assembled.split;
    // Bound the fed-back log so a long run's prompt stays bounded (R2 B4); fold in mid-run
    // steering (P11.4) — a queued message the editor typed while this run was already in
    // flight, applied at THIS turn boundary (never mid-step — the message was popped from
    // the queue right before this call, in `runTurn`'s handler).
    // The findings budget scales with what this request actually left free (05). A fixed
    // 1,000 tokens next to a 16,962-token tool block, in a request using 17% of its window,
    // is what forced the captured run to re-fetch its own search results 62 times.
    //
    // Measured the same way the manifest measures it — window − output − headroom − what is
    // already assembled — so the log can only grow into room that genuinely exists. A model
    // with a small window therefore keeps today's behaviour by arithmetic rather than by a
    // special case.
    const budget = resolveContextBudget(
      input,
      this.provider,
      this.agentToolCost() + estimateTokens(stableHead),
    );
    const assembledTokens = assembled.sections
      .filter((section) => section.included)
      .reduce((sum, section) => sum + section.tokenEstimate, 0);
    const remainingCapacity =
      budget.contextWindow -
      budget.maxOutputTokens -
      budget.headroom -
      (budget.reservedPromptTokens ?? 0) -
      assembledTokens;
    const history = agentActionsBlock(
      compactAgentLog(log, AGENT_LOG_RECENT, findingsBudgetTokens(remainingCapacity)),
    );
    const steeringBlock = agentSteeringBlock(steeringMessage);
    const recoveryBlock = agentActionRecoveryBlock(actionRecovery);
    // P4.3: a run in the `repair` stage is on a bounded verification fix turn.
    const fixBlock = agentVerifyFixBlock(taskMemory?.stage === 'repair');
    // The structured briefing (ADR 0075 §3.3) is the run's MEMORY; the action log that
    // follows it is only continuity of prose. That ordering matters: the log is a rolling
    // window whose payloads age out, so anything the run must not forget has to live in
    // the briefing, which is bounded by construction rather than by truncation.
    // WHERE YOU STAND (GAP-014): the whole-cut conditions measured against the working
    // copy as it is now. Pure and render-free — the same checks the final self-check runs,
    // consulted while the run can still act on them. A health finding the starting project
    // already had is left out (`input.project` is the "before"): it is not the run's to fix,
    // and stated in flight it read as an order — see `standingAgainstAcceptance`.
    const briefing = taskMemory
      ? buildStateBriefing(
          taskMemory,
          standingAgainstAcceptance(
            working,
            this.critiqueOptions(input, agentOptions, true),
            input.project,
          ),
        )
      : '';
    const turnMessage: AiMessage = {
      role: 'user',
      content: `${volatileContext}${briefing}${steeringBlock}${recoveryBlock}${fixBlock}\n\n${history}${framesBlock(frames)}`,
      // Deliberately on the LAST message: it is the only one that varies per turn, so an
      // image attached here can never invalidate the cached prefix above it.
      ...(frames && frames.length > 0 ? { images: frames } : {}),
    };
    return {
      messages: [
        ...stablePrefix,
        { role: 'user', content: stableContext },
        { role: 'user', content: stableHead, cacheBoundary: true },
        turnMessage,
      ],
      assembled: {
        // The stable head is not assembled by `assembleContext`, so it has to be added
        // here or `withRemainder` buckets it — see `agentStableInstructionSections`.
        sections: [
          ...assembled.sections,
          ...this.agentStableInstructionSections(loadedSkills, plan),
        ],
        droppedTokenEstimate: assembled.droppedTokenEstimate,
      },
    };
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
      // One verdict, one sentence: the concurrent path below (`withheldCallOutcome`) meets
      // the same invented name and used to answer it in better words than this one, which
      // said only that the call was refused — not that the name does not exist, and not to
      // stop sending it.
      const note = unknownToolNote(call.name);
      orchestratorLog.warn('tool call refused — unknown', { tool: call.name });
      // BANKED. A name the registry has never heard of will not appear in it on the next
      // turn, so this is the most deterministic failure a run can have — and without both
      // `data` and the flag, `deterministicFailureKey` produced no key and the model could
      // invent the same non-existent tool every single turn. That is the exact loop
      // `withheldCallOutcome`'s unknown-tool branch was written to end.
      return {
        ops: [],
        note,
        // The card keeps the short verdict; the note carries the instruction. Same split
        // as `withheldCallOutcome`'s unknown-tool branch, which this now shares words with.
        summary: `Refused unknown tool "${call.name}"`,
        status: 'failed',
        data: note,
        deterministicFailure: true,
      };
    }
    if (!registered.available) {
      // "not available yet" invited the next turn to try again; `available` is a
      // build-time constant, so the answer never changes within a run (goal.md C, run
      // `369e8c82`). The producer says that and closes the call off.
      const note = unavailableToolNote(call.name);
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
        const note = `Invalid arguments for "${call.name}": ${describeArgValidationError(cause, call.name, call.arguments)}`;
        return {
          ops: [],
          note,
          summary: note,
          status: 'failed',
          data: note,
          deterministicFailure: true,
        };
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
        return {
          ops: [],
          note,
          summary: 'No one available to answer',
          status: 'warning',
          askedQuestion: true,
        };
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
          askedQuestion: true,
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
        askedQuestion: true,
      };
    }
    if (tool.kind === 'action' || tool.kind === 'analysis') {
      // The orchestrator never runs ffmpeg (render-vs-preview rule): render/export
      // actions AND the ffmpeg-backed analysis tools execute on the host/engine
      // sidecar via the injected executor, and the loop AWAITS the real result.
      // Args are schema-validated here first so a malformed call fails fast
      // without a host round-trip.
      // A catalogue id the run was handed is resolved to the bin asset our own code
      // derived from it, BEFORE the host is asked. See `catalogue-asset-id.ts`: the
      // transformation is ours, so reversing it is exact, and an ambiguous id falls
      // through untouched to the existing "known asset ids" error.
      const args = withResolvedAssetId(
        call.name,
        sanitizeToolArgs(tool, call.arguments) as Record<string, unknown>,
        ctx.project.assets,
      );
      // Asset existence is decided HERE, not by the host's 404: it is a function of the
      // project and the argument alone, so it can be keyed and remembered, and it gives the
      // same answer the withheld path gives — see `unknownAssetRefusal`.
      const namedAsset = (args as { assetId?: unknown }).assetId;
      if (
        typeof namedAsset === 'string' &&
        namedAsset.trim() !== '' &&
        !ctx.project.assets.some((asset) => asset.id === namedAsset)
      ) {
        return unknownAssetRefusal(call.name, namedAsset, ctx.project);
      }
      try {
        tool.parse(args);
      } catch (cause) {
        const note = `Invalid arguments for "${call.name}": ${describeArgValidationError(cause, call.name, call.arguments)}`;
        return {
          ops: [],
          note,
          summary: note,
          status: 'failed',
          data: note,
          deterministicFailure: true,
        };
      }
      const result = await host.effectRuntime.run(
        {
          kind: 'host_tool',
          call: { ...call, arguments: args as Record<string, unknown> },
          project: ctx.project,
          ...(ctx.interaction === undefined ? {} : { interaction: ctx.interaction }),
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
      // EVERY host-tool payload is stored, not just `measure_color`'s.
      //
      // The read path (below) has always stored its results and handed the model a handle,
      // which is what makes `compactAgentLog`'s "[old result cleared — recall …]" marker an
      // honest offer. The HOST path stored nothing but a colour measurement, so the same
      // marker was a lie for every sidecar and provider result the run had seen: cleared
      // from the prompt after two turns, absent from the store, and citable by no fact
      // (`distil` below attaches an `evidenceId` only when `evidence.lookup` finds one —
      // which is why every fact in the captured run carried `evidenceIds: []`).
      //
      // For `search_stock`/`search_music` that gap is not merely wasteful, it is
      // unrecoverable: "re-read if needed" means another METERED provider request whose
      // ordering is not stable, and the short-TTL cache misses on any rewording. A captured
      // run reached the edit with no candidate left in context and invented an asset path
      // rather than re-query — twice, in two independent attempts.
      //
      // Storing is safe for the whole group by construction: `EvidenceStore.put` derives
      // invalidation from `tool-classification.ts`, which is explicit and parity-tested for
      // every registered tool, so a timeline-dependent result is still evicted by the next
      // applied patch exactly as before. This changes what is RECOVERABLE, never what is
      // considered current.
      const hostEvidence =
        outcome.status === 'completed' && outcome.data !== undefined
          ? host.evidence?.put({
              key: callMemoKey(call),
              source: call.name,
              descriptor: desc,
              data: evidencePayload(call.name, outcome.data),
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
          // Shared with the desktop's `hostTranscribe` override, which returns its own
          // failed outcome and never reaches this branch — two copies of this sentence
          // meant the fix for one was invisible on the product's primary surface.
          const note = unusableHostPayload('transcribe');
          return { ops: [], note, summary: note, status: 'failed', data: outcome.data };
        }
        const ops: AnyOperation[] = [{ type: 'set_transcript', words: parsedWords.data }];
        const probe = assembleEdit(ctx.project, ops, 'Transcribe media', 'agent');
        /* v8 ignore start -- set_transcript is a whole-array replace with no timeline
           references to check (see validator.ts), so a schema-valid word array can
           never fail validation; kept defensive, not reachable. */
        if (!probe.validation.valid) {
          return hostBackedValidatorRejection('transcribe', probe.validation.issues, ops);
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
          ...derivedOps(call.name, ops),
          project: applyProjectPatch(ctx.project, probe.patch),
          data: outcome.data,
        };
      }
      // `add_music` is a host-backed mutation, exactly like `transcribe`: the host
      // downloads and materializes the file, and the orchestrator turns what came
      // back into the SAME reversible operations the Sounds panel builds by hand.
      // The host never edits the timeline (AGENTS.md invariant 5).
      if (call.name === 'remove_silences' && outcome.status === 'completed') {
        // The measurement came back; the cuts are arithmetic (plan/system-mission P4.1).
        const parsed = SilenceRangesPayloadSchema.safeParse(outcome.data);
        if (!parsed.success) {
          const note = unusableHostPayload('remove_silences');
          return { ops: [], note, summary: note, status: 'failed', data: outcome.data };
        }
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const options = {
          minSilenceSeconds:
            typeof args.minSilenceSeconds === 'number'
              ? args.minSilenceSeconds
              : DEFAULT_SILENCE_CUT.minSilenceSeconds,
          keepSeconds:
            typeof args.keepSeconds === 'number'
              ? args.keepSeconds
              : DEFAULT_SILENCE_CUT.keepSeconds,
          ...(typeof args.trackId === 'string' ? { trackId: args.trackId } : {}),
        };
        const { ops, cuts, removedSeconds } = silenceCutOps(ctx.project, parsed.data, options);
        if (ops.length === 0) {
          // An empty cut list is NEVER evidence that the recording is tight — `ranges` is
          // filtered inside ffmpeg, so it is empty by construction whenever the threshold
          // overshoots. `noCutsNote` says what was actually measured; `warning` (not
          // `completed`) keeps what lands in run memory as "not measurable at this
          // threshold", never "no dead air".
          const note = noCutsNote(parsed.data, options);
          orchestratorLog.debug('remove_silences produced no cuts', {
            assetId: parsed.data.assetId,
            minSilenceSeconds: options.minSilenceSeconds,
            rangesAtThreshold: parsed.data.ranges.length,
            measuredCount: parsed.data.measuredCount ?? null,
            longestSeconds: parsed.data.longestSeconds ?? null,
          });
          return { ops: [], note, summary: note, status: 'warning', data: outcome.data };
        }
        const probe = assembleEdit(ctx.project, ops, 'Remove dead air', 'agent');
        if (!probe.validation.valid) {
          return hostBackedValidatorRejection('remove_silences', probe.validation.issues, ops);
        }
        const summary = `Removed ${String(cuts.length)} silence(s), ${removedSeconds.toFixed(1)}s in total`;
        return {
          ops,
          note: `${summary}. Breath of ${String(options.keepSeconds)}s kept on each side; the timeline is ${removedSeconds.toFixed(1)}s shorter.`,
          summary,
          status: 'completed',
          ...derivedOps(call.name, ops),
          project: applyProjectPatch(ctx.project, probe.patch),
          data: outcome.data,
        };
      }
      if (call.name === 'add_music' && outcome.status === 'completed') {
        const parsed = MusicAssetPayloadSchema.safeParse(outcome.data);
        if (!parsed.success) {
          // Fail closed. A download that produced nothing placeable must not be
          // reported as a completed edit on an unchanged timeline (ADR 0083).
          const note = unusableHostPayload('add_music');
          return { ops: [], note, summary: note, status: 'failed', data: outcome.data };
        }
        const { asset, atSeconds, duckUnderTrackId } = parsed.data;
        // A duck at a track that does not exist (or has no clips) would validate
        // cleanly and then render as NO duck — the bed plays full level while the
        // model reports it dropped under the voice. Fail with the specific
        // sentence instead of letting that through.
        const duckIssue = musicDuckSidechainIssue(ctx.project, duckUnderTrackId);
        const duckKey = musicDuckRefusalKey(ctx.project, duckUnderTrackId);
        if (duckIssue !== null) {
          const note = `Rejected "add_music" — ${duckIssue}`;
          // IN-PROCESS, despite arriving after a completed paid download — the same reading
          // the post-download stock refusal below gets, for the same reasons. The download
          // SUCCEEDED (this branch runs only under `status === 'completed'`); what refuses
          // is `musicDuckSidechainIssue` reading the orchestrator's own working copy, an
          // `editor-core` predicate over the track list with the same verdict every time.
          // A policy decision reached by a different route, not host work, so the call
          // site's "host work is never keyed" invariant is untouched: a download timeout or
          // a provider 5xx still settles as a plain host `failed` and still gets no key.
          //
          // Keyed on the TEXT, not on a new `RefusalCause`, and the difference from run
          // `369e8c82`'s picture rule is the whole argument. There the sentence varied with
          // the asset and the timestamps — incidental detail around one unchanging rule, so
          // four attempts banked four keys and matched none. Here the only thing that varies
          // is the `duckUnderTrackId` the sentence names, which is the argument the refusal
          // is asking the model to CORRECT. Two attempts with the same bad id are the loop
          // and share a key; two attempts with different bad ids are two genuinely different
          // corrections, and each deserves its own answer naming its own id. A rule-shaped
          // cause would collapse them and quote back a sentence about a track the model is
          // no longer asking for. A cause invented on speculation is vocabulary with no
          // captured loop behind it.
          //
          // `data` carries the SENTENCE, not the raw host payload: a key promises
          // `repeatedFailureOutcome` something to quote back, and an object yields no key
          // at all (`deterministicFailureKey` requires a non-empty string).
          //
          // `rejectedOpCount: 1` files it through the ledger's existing route so the remedy
          // — "pass the id of the dialogue track", "omit duckUnderTrackId" — reaches the
          // briefing's "FAILED — fix the cause" section instead of ageing out of the context
          // window with the tool result. One, not `ops.length`: the refusal is reached
          // before `buildAddMusicOps` runs, so no operations were ever built to count.
          return {
            ops: [],
            note,
            summary: note,
            status: 'failed',
            data: duckIssue,
            deterministicFailure: true,
            // The sentence names the tracks that WOULD work, and that list grows as the
            // run places clips — so the sentence cannot be the identity any more.
            ...(duckKey === null ? {} : { failureKeyText: duckKey }),
            rejectedOpCount: 1,
          };
        }
        // Already in the bin. Deterministic asset ids make a re-add land as a
        // `duplicate_asset` validation error whose text ("Asset id already
        // exists: music_openverse_ov_1") reads to the model as a bug rather than
        // as an answer. Said plainly here, before an edit is even assembled.
        if (ctx.project.assets.some((existing) => existing.id === asset.id)) {
          // "Place it from the bin" is the Sounds panel's instruction — true for a human
          // looking at a bin, and a dead end for the caller here, which has no hands and
          // no panel. Captured run `369e8c82` read it and gave up on the call. Name the
          // tool and hand over the id it needs, the same way `localMusicAssetRefusal`
          // already answers the sibling "that is a local id" case.
          const note =
            `That track is already in your media bin as asset "${asset.id}" — it was not ` +
            `downloaded again. Place it with add_clip on an audio track (assetId ` +
            `"${asset.id}"), or search for a different track.`;
          return { ops: [], note, summary: note, status: 'warning', data: note };
        }
        const ops = buildAddMusicOps(ctx.project.timeline, asset, atSeconds, duckUnderTrackId);
        const probe = assembleEdit(ctx.project, ops, 'Add background music', 'agent');
        if (!probe.validation.valid) {
          return hostBackedValidatorRejection('add_music', probe.validation.issues, ops);
        }
        // Tell the model about the credit rather than leaving it a surprise for the
        // user at publish time: it can then mention it in its own summary.
        const creditNote = asset.source.attributionRequired
          ? ` This track requires crediting ${asset.source.creator ?? 'its creator'} — the credit is saved with the project and appears under Export → Credits.`
          : ' This track needs no credit.';
        // Say what was actually authored, so the model never narrates a duck that
        // did not happen.
        const emptyTarget = musicDuckEmptyTrackNote(ctx.project, duckUnderTrackId);
        const duckNote =
          duckUnderTrackId === undefined
            ? ''
            : ` The bed ducks ${String(DEFAULT_DUCK_DB)} dB under "${duckUnderTrackId}".` +
              (emptyTarget === null ? '' : ` ${emptyTarget}`);
        return {
          ops,
          note: `${outcome.summary}${creditNote}${duckNote}`,
          summary: outcome.summary,
          status: 'completed',
          project: applyProjectPatch(ctx.project, probe.patch),
          data: outcome.data,
        };
      }
      // `add_stock` is the picture twin of `add_music`: the host downloaded the
      // rendition and materialized the file, and the orchestrator turns what came
      // back into the SAME reversible operations the Stock panel builds by hand
      // (`buildAddStockOps`, shared in editor-core). The host never edits the
      // timeline (AGENTS.md invariant 5).
      if (call.name === 'add_stock' && outcome.status === 'completed') {
        const parsed = StockAssetPayloadSchema.safeParse(outcome.data);
        if (!parsed.success) {
          // Fail closed. A download that produced nothing placeable must not be
          // reported as a completed edit on an unchanged timeline (ADR 0083) —
          // quota and disk were spent either way, and saying "added" about a
          // timeline that did not move is the one outcome the user cannot see.
          const note = unusableHostPayload('add_stock');
          return { ops: [], note, summary: note, status: 'failed', data: outcome.data };
        }
        const { asset: stockAsset } = parsed.data;
        // Same as `add_music`: a deterministic id means a re-add would surface a
        // raw `duplicate_asset` message instead of an answer.
        if (ctx.project.assets.some((existing) => existing.id === stockAsset.id)) {
          // Same dead end as `add_music`'s, and the same fix: this path's own success note
          // three branches down already tells the model "place it with add_clip", so the
          // refusal must not send it looking for a bin it cannot touch.
          const note =
            `That clip is already in your media bin as asset "${stockAsset.id}" — it was ` +
            `not downloaded again. Place it with add_clip (assetId "${stockAsset.id}"), ` +
            `or search for a different one.`;
          return { ops: [], note, summary: note, status: 'warning', data: note };
        }
        // The brief's cutaway cap, before a download becomes a placement (the download
        // itself is fine: it lands in the bin, where the editor can still choose it).
        const capNote =
          parsed.data.atSeconds === undefined ? null : stockCutawayCapRefusal(ctx, stockAsset.id);
        if (capNote !== null) {
          const note = `Refused "add_stock": ${capNote}`;
          return {
            ops: [],
            note,
            summary: note,
            status: 'failed',
            data: capNote,
            deterministicFailure: true,
            rejectedOpCount: 1,
          };
        }
        const placement = stockOpsFromPayload(ctx.project, parsed.data);
        if (!placement.ok) {
          const note = `Rejected "add_stock" — ${placement.reason}`;
          // BANKED — and this sits on the IN-PROCESS side of the metered line, despite
          // arriving after a paid download.
          //
          // The download SUCCEEDED: this branch runs only under `status === 'completed'`.
          // What refuses here is `stockOpsFromPayload` reading the orchestrator's own
          // working copy through `editor-core`'s occupancy predicate — ADR 0140's
          // picture-over-picture rule, unchanged for `add_stock`, which picks the track
          // itself and so cannot be handed a front layer the way `add_clip` now is
          // (ADR 0169). Same inputs, same verdict every time. It is a policy decision
          // reached by a different route, not a host failure, so the call-site invariant
          // ("host work never reaches this test") still holds: a download timeout, a
          // provider 5xx, or `stock-host.ts`'s pre-download refusal all settle as a plain
          // host `failed` and still get no key.
          //
          // Un-keyed, this was the run `369e8c82` loop with a bill attached. The sentence
          // names the requested span AND the free moment, so 4.5s → 4.2s → 4.2s read as
          // three unrelated failures; each repeat spends another download. Keying is the
          // strictly cheaper side: the key is computed only once the call has SETTLED, so
          // it cannot stop the second download, but it ends the loop before the third.
          // A CORRECTED placement is never touched — a free span (or an omitted
          // `atSeconds`, which is bin-only) does not fail, so it has no key to match.
          //
          // `data` carries the SENTENCE, not the structured `refusal` record: a key
          // promises `repeatedFailureOutcome` a sentence to quote back, and the record had
          // no reader — the model reads `note`, the card's popup reads this.
          return {
            ops: [],
            note,
            summary: note,
            status: 'failed',
            data: placement.reason,
            deterministicFailure: true,
            // The same trace the HOST-side refusal of this rule now files (see the host
            // tail). Without it, one rule refused before the download left a `failed`
            // ledger row carrying its remedy and the same rule refused after it left
            // nothing — and run `369e8c82`'s lesson is that a remedy living only in a tool
            // result ages out of the window with it. One, not `ops.length`: the refusal is
            // reached before any operation is built.
            rejectedOpCount: 1,
            // `StockPlacementRefusal.kind === 'picture_occupied'` is this module's name for
            // ADR 0140; the RULE is the one `add_clip` names, so run memory must call it
            // the same thing. Keys stay per-tool (`add_stock:…` vs `add_clip:…`), so
            // sharing the cause never blocks one tool on the other's refusal.
            refusalCause: 'picture_over_picture',
          };
        }
        const ops = [...placement.operations];
        const probe = assembleEdit(ctx.project, ops, 'Add stock media', 'agent');
        if (!probe.validation.valid) {
          return hostBackedValidatorRejection('add_stock', probe.validation.issues, ops);
        }
        // Same reasoning as `add_music`: tell the model about the credit now, so
        // it can mention it, rather than leaving it a surprise at publish time.
        const creditNote = stockAsset.source.attributionRequired
          ? ` This clip requires crediting ${stockAsset.source.creator ?? 'its creator'} — the credit is saved with the project and appears under Export → Credits.`
          : ' This clip needs no credit.';
        // Never "Placed at 0.0s" for a bin-only download: the model narrates from this note,
        // and a position it can see on the timeline is the one thing it must not invent.
        const whereNote =
          placement.start === undefined
            ? ' It is in your media bin, not on the timeline yet — place it with add_clip.'
            : ` Placed at ${placement.start.toFixed(1)}s.`;
        return {
          ops,
          note: `${outcome.summary}${whereNote}${creditNote}`,
          summary: outcome.summary,
          status: 'completed',
          project: applyProjectPatch(ctx.project, probe.patch),
          data: outcome.data,
        };
      }
      // `track_subject_automatically` is the pack-worker twin of `transcribe`:
      // a trusted host executor measured the media in an isolated Capability
      // Pack worker, and the orchestrator turns that validated measurement into
      // the same reversible `track_object` patch as the manual path. A missing
      // plan, unknown engine, or unusable track never becomes a fabricated edit.
      if (call.name === AUTOMATIC_TRACKING_TOOL_NAME && outcome.status === 'completed') {
        const parsedMeasurement = AutomaticTrackingMeasurementSchema.safeParse(outcome.data);
        if (!parsedMeasurement.success) {
          // The constant, not `call.name`: the producer throws on a tool it has no
          // sentence for, and this branch is already gated on that exact name.
          const note = unusableHostPayload(AUTOMATIC_TRACKING_TOOL_NAME);
          return { ops: [], note, summary: note, status: 'failed', data: outcome.data };
        }
        try {
          const ops = automaticTrackingOpsFromMeasurement(parsedMeasurement.data, ctx);
          const probe = assembleEdit(ctx.project, ops, 'Track subject automatically', 'agent');
          if (!probe.validation.valid) {
            return hostBackedValidatorRejection(call.name, probe.validation.issues, ops);
          }
          return {
            ops,
            note: outcome.summary,
            summary: outcome.summary,
            status: 'completed',
            project: applyProjectPatch(ctx.project, probe.patch),
            data: outcome.data,
          };
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          const note = `Rejected "${call.name}" — ${reason}`;
          // KEYED, on the same argument as the probe above and for a stricter reason than
          // the probe has. Everything this `try` can throw is a pure verdict over the
          // working copy: `compileTrackingCommand`'s eleven rejection codes (`missing_mask`,
          // `locked_track`, `unusable_track`, …) read the timeline and the compiled samples,
          // and `validateProfessionalOperationBatch` runs the validator and the
          // apply/invert round-trip. Same measurement, same project, same sentence, every
          // time — so without a key this refusal could be re-earned every turn for the
          // length of the run, and each repeat re-runs an isolated pack worker over the
          // media, which is the most expensive loop any of these branches can spin.
          //
          // The guard cannot pre-empt that worker even so: a key is read off a SETTLED
          // outcome (see the repeat gate in `executeToolCalls`), so the measurement is
          // always made and only the prose of a call that already failed is replaced. And a
          // re-measure that produces a usable track never fails, so it never has a key to
          // match — a corrected mask is never refused for an earlier one's verdict.
          //
          // `rejectedOpCount: 1`, not a count of operations, and the difference from the
          // probe above is the point: the throw comes out of the op BUILDER, so no
          // operation was ever built to count. One refused call is one thing the run could
          // not do — the same reading `b7f1fd3` gave the refusal paths. Without it a run
          // whose only work was a refused track reported "reviewed the footage but never
          // made a change", and the compiler's remedy ("draw a rectangle mask on the clip
          // first", "the track is too unreliable") aged out of the context window with the
          // tool result, exactly as run `369e8c82`'s did.
          return {
            ops: [],
            note,
            summary: note,
            status: 'failed',
            data: reason,
            deterministicFailure: true,
            rejectedOpCount: 1,
          };
        }
      }
      // A cached replay reports the call itself (`desc`), not the original outcome's
      // summary text — the summary can be data-derived ("No silent ranges") and would
      // otherwise read as a freshly fabricated result rather than a served-from-cache one.
      const base = runtimeCached ? desc : outcome.summary;
      // A CACHED REPLAY RE-ATTACHES ITS PICTURE, and the freshness of that picture is now
      // the CONTRACT's problem, not this line's.
      //
      // This used to argue that a hit proves the picture is current, because the memo key
      // carries `timeline.revision`. It does not: the revision tracks the source↔sequence
      // MAPPING and stands still through every picture-only edit (grade, effect, keyframe,
      // punch-in, mask), so the memo happily replayed a pre-grade frame at the call made to
      // check the grade. `get_frame` and `measure_color` therefore declare
      // `cacheScope: 'none'` (tool-contract.ts) and never reach this branch at all.
      //
      // What survives here are the reads whose contract genuinely permits a replay. For
      // those the re-attach is still right, and dropping it was the more expensive mistake.
      // Frames ride ONE request and are then
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
      const preview =
        data !== undefined ? ` → ${summarizeReadResult(call.name, data, ctx.project.assets)}` : '';
      // THE ONE HOST FAILURE THE RUN IS ALLOWED TO REMEMBER — the one that says so itself.
      //
      // The call site of `deterministicFailureKey` states that host work is never keyed,
      // and that stays true of every host failure that merely HAPPENED: a sidecar restart,
      // a download timeout, a provider 5xx, an unresolvable id, a missing key. Keying one
      // of those would refuse, for the rest of the run, work the next attempt would have
      // completed. The exception is narrow and opt-in: a host that declares a
      // `refusalCause` is asserting the outcome is a POLICY verdict it reached from the
      // project it was handed — `stock-host.ts` answering ADR 0140's picture-over-picture
      // rule before spending the download, through the same `editor-core` predicate
      // `add_clip` uses. Undeclared, that refusal was the last unbounded arm of run
      // `369e8c82`'s loop, and on desktop it is the arm a b-roll request reaches FIRST.
      //
      // `deterministicFailure` as well as the cause, because the key function gates on the
      // flag BEFORE it ever looks at the cause — a cause alone would be inert — and because
      // the flag is documented as the single opt-in discriminator every `failed` branch
      // answers for itself. The host has now answered it.
      //
      // `data` carries the SENTENCE, for the same reason the post-download refusal's does:
      // a key promises `repeatedFailureOutcome` something to quote back, and a host refusal
      // usually returns no `data` at all. Set AFTER the `data` spread and after `note` is
      // built, so the model's note keeps reading as the refusal itself rather than gaining
      // a `→ …` echo of its own sentence.
      const declaredRefusal =
        outcome.status === 'failed' && outcome.refusalCause !== undefined
          ? outcome.refusalCause
          : undefined;
      return {
        ops: [],
        note: `${base}${runtimeCached ? ' (cached)' : ''}${preview}${hostEvidence ? ` [${hostEvidence.id}]` : ''}`,
        summary: `${base}${runtimeCached ? ' (cached)' : ''}`,
        status: outcome.status,
        ...(runtimeCached ? { fromCache: true } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(outcome.images && outcome.images.length > 0 ? { images: outcome.images } : {}),
        ...(declaredRefusal === undefined
          ? {}
          : {
              deterministicFailure: true,
              refusalCause: declaredRefusal,
              data: typeof data === 'string' && data.trim() !== '' ? data : outcome.summary,
              // THE REMEDY HAS TO OUTLIVE THE TOOL RESULT, and a bounded loop alone does
              // not give it that. `28a5322` stopped the declared refusal repeating; it left
              // the model able to lose the remedy to compaction anyway and be told only
              // that something is forbidden, never what to do instead. Run `369e8c82`'s
              // briefing never once carried the picture-over-picture rule for exactly that
              // reason: only a landed patch's `describedActions` reach `recordOperation`,
              // so a refusal's sentence lived in a tool result and aged out with it.
              //
              // This is the route the in-process refusals already take — the per-call
              // rejection tally the conductor reads as `lostOpsPerCall`, which files the
              // turn as a `failed` operation whose `failureReason` is this note. No
              // parallel ledger, and the host side now leaves the same trace as the branch
              // that refuses the same rule after the download.
              //
              // One, not a count of operations: the host refused before the orchestrator
              // built any. The count is what the empty-run notice tallies, and one refused
              // call is one thing the run could not do.
              rejectedOpCount: 1,
            }),
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
            // A HANDLE THE RUN THREW AWAY IS NOT A HANDLE THAT NEVER EXISTED. The store
            // invalidates a reading when an applied patch makes it untrue, and until now
            // that left the same "no such handle" a made-up id gets — so the model, which
            // was holding a real reference, went and re-ran reconnaissance instead of the
            // one tool that would refresh it. 27 of run `137d8fd0`'s recalls landed here.
            const expired = host.evidence.expiredHandle(args.evidenceId);
            const note =
              expired === undefined
                ? `${desc} → no such handle "${args.evidenceId}"${
                    known ? `. You have: ${known}` : ' — you have not read anything yet this run'
                  }.`
                : `${desc} → "${args.evidenceId}" (${expired.descriptor}) went stale when the ` +
                  `timeline changed, so it is no longer true of this project. Run ` +
                  `${expired.source} again for the current reading.${
                    known ? ` Still current: ${known}.` : ''
                  }`;
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
        // THE TOOL BOUNDARY GETS ITS OWN CATCH, and it is the only thing under it.
        //
        // Everything after this line — the `load_skill` bookkeeping, the evidence
        // lookup/put, `evidencePayload`, `summarizeReadResult` — is orchestrator plumbing
        // that used to sit under the same catch as this call. So a `TypeError` in a
        // summarizer was reported to the model as `Invalid arguments for "get_transcript"`,
        // a cause it could do nothing about, and `deterministicFailure: true` banked it into
        // `seenFailureKeys`: the read was then refused for the REST OF THE RUN with
        // "Retrying it cannot succeed." A transient defect of OURS became permanent
        // capability loss, attributed to the model. The outer catch answers for the plumbing
        // now — retryably, and unbanked.
        let value: unknown;
        try {
          value = tool.read(sanitizeToolArgs(tool, call.arguments), ctx);
        } catch (cause) {
          // A refusal from the registered, contracted tool boundary IS the model's to fix —
          // a bad window, an unknown id, the wrong kind of clip — so it keeps the argument
          // wording and stays banked, exactly as it was.
          const note = `Invalid arguments for "${call.name}": ${describeArgValidationError(cause, call.name, call.arguments)}`;
          return {
            ops: [],
            note,
            summary: note,
            status: 'failed',
            data: note,
            deterministicFailure: true,
          };
        }
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
            return { ops: [], note, summary: note, status: 'warning', data: value, withheld: true };
          }
          if (!alreadyLoaded) {
            host.loadedSkills.set(skill.name, summarizeReadResult(call.name, value));
          }
          // A playbook and the tools it tells the run to use arrive together. Loading the
          // caption playbook and then discovering the caption tools are not advertised is
          // a round trip the run should never have to spend, and the pairing is a fact
          // about the skill, not a judgement the model has to make (see `SKILL_DOMAINS`).
          for (const domain of SKILL_DOMAINS[skill.name] ?? []) host.loadedToolDomains.add(domain);
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
        // Progressive disclosure (`tool-domains.ts`): the pin lives here, with the run's
        // ledger, for the same reason `load_skill`'s does — the tool itself is a pure
        // function of its arguments and the orchestrator owns run-scoped state.
        //
        // Deliberately NOT memoized below. A repeat `load_tools` is cheap, idempotent, and
        // its answer is the list of names now reachable; routing it through the read memo
        // would answer "unchanged since you last read it" to a call whose entire purpose is
        // to change what the next request advertises.
        if (call.name === 'load_tools') {
          const loaded = (value as { loaded?: readonly string[] }).loaded ?? [];
          const fresh = loaded.filter(
            (domain) => !host.loadedToolDomains.has(domain as ToolDomain),
          );
          for (const domain of loaded) host.loadedToolDomains.add(domain as ToolDomain);
          const names = loaded.flatMap((domain) =>
            domainMembers(domain as Exclude<ToolDomain, 'core'>),
          );
          const note =
            fresh.length > 0
              ? `${desc} → loaded ${fresh.join(', ')} — these tools are available from your next turn: ${names.join(', ')}.`
              : `${desc} → already loaded earlier this run; these tools are already available to you: ${names.join(', ')}. Use them now rather than loading again.`;
          return {
            ops: [],
            note,
            summary: desc,
            finding: `tools loaded: ${loaded.join(', ')}`,
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
          data: evidencePayload(call.name, value),
        });
        // Card shows the short action label; the model log keeps an id-preserving digest
        // (so it never has to invent asset/clip ids) plus the evidence handle that makes
        // the full payload retrievable for the rest of the run; the popup gets the full
        // object (`data`).
        const preview = summarizeReadResult(call.name, value, ctx.project.assets);
        const note = stored ? `${desc} → ${preview} [${stored.id}]` : `${desc} → ${preview}`;
        // A CHECK'S CARD HAS TO CARRY ITS VERDICT. Every other read's card is right to be
        // the action label — "Reading the timeline" is the whole story. A verification is
        // not: run `137d8fd0` shows fourteen rows reading "Checking caption sync" and
        // "Checking transitions", one of which found 287 of 287 words uncaptioned and the
        // rest of which passed, and nothing on any of them said which was which.
        const verdict = readVerdict(call.name, value);
        return {
          ops: [],
          note,
          summary: verdict === undefined ? desc : `${desc} — ${verdict}`,
          // The card wants the label; the run's memory wants the conclusion.
          finding: preview,
          status: 'completed',
          data: value,
        };
      } catch (cause) {
        // Only the PLUMBING can reach here now — the tool boundary answered for itself
        // above — so this is our fault, not the model's. Untyped, and deliberately without
        // `deterministicFailure`, so `deterministicFailureKey` banks nothing and the next
        // attempt is allowed to succeed.
        const reason = cause instanceof Error ? cause.message : String(cause);
        orchestratorLog.error('read tool failed unexpectedly', { tool: call.name, reason });
        const note =
          `"${call.name}" failed unexpectedly: ${reason}. This is not a problem with your ` +
          'arguments — try it again, or reach for a different tool.';
        return { ops: [], note, summary: `${desc} — failed`, status: 'failed', data: note };
      }
    }
    // Same split on the mutating path. `operationsFor` is the tool boundary and throws a
    // typed `ToolInvocationError`; `assembleEdit`, `summarizeOperations` and
    // `applyProjectPatch` below are not, and a throw from any of them was being
    // relabelled as the model's bad arguments AND banked as permanent.
    let ops: AnyOperation[];
    try {
      ops = this.operationsFor(call, host.evidence ? { ...ctx, evidence: host.evidence } : ctx);
    } catch (error) {
      // `operationsForCall` only ever throws `ToolInvocationError` (unknown/unavailable/
      // invalid args/refusal) — all four are the model's to act on and all four are worth
      // banking.
      //
      // A REFUSAL is worded differently on purpose. The other three are mistakes, and
      // "Rejected … Invalid arguments for …" is the right thing to say about a mistake. A
      // refusal is the tool declining a call it understood — the picture-over-picture rule
      // of ADR 0140, a caption cue that would cross a cut — and telling the model its
      // arguments were invalid sends it to fix a `start` that was already correct instead
      // of taking the alternative the sentence names. So the sentence stands alone.
      const refusal =
        error instanceof ToolInvocationError && error.code === 'refusal' ? error : undefined;
      const refused = refusal !== undefined;
      const reason = error instanceof Error ? error.message : String(error);
      const note = refused
        ? `Refused "${call.name}": ${reason}`
        : `Rejected "${call.name}": ${reason}`;
      orchestratorLog.warn(
        refused ? 'tool call refused — policy' : 'tool call rejected — invalid args',
        { tool: call.name, reason },
      );
      return {
        ops: [],
        note,
        summary: note,
        status: 'failed',
        data: reason,
        deterministicFailure: true,
        // The rule's name, so run memory identifies the refusal by what it IS rather than
        // by a sentence that changes with every placement (see `deterministicFailureKey`).
        ...(refusal?.refusalCause ? { refusalCause: refusal.refusalCause } : {}),
        // A refusal loses its call's work, and until now it left NO trace in the run's
        // working state: only a landed patch's `describedActions` reach `recordOperation`,
        // so the remedy lived in a tool result and aged out of the window with it. Run
        // `369e8c82`'s briefing never once carried the picture-over-picture rule. The
        // ledger's existing route in is the per-call rejection tally the conductor reads
        // as `lostOpsPerCall`, which files the turn as a `failed` operation carrying this
        // note — and the note is the refusal sentence, remedy included. One, not
        // `ops.length`: the throw came out of `buildOps`, so no operations were ever built
        // to count.
        ...(refused ? { rejectedOpCount: 1 } : {}),
      };
    }
    try {
      if (ops.length === 0) {
        // A mutating tool can legitimately have nothing to do — e.g. manage_assets
        // when the bin is already organized. Say so plainly instead of implying an
        // edit happened: the user sees the call made no change, and the agent loop
        // feeds this note back so the model moves on to the real edit rather than
        // repeating the no-op or halting on it.
        const note = `${desc} — nothing to change`;
        return { ops, note, summary: note, status: 'warning' };
      }
      // Validate against the working copy NOW, not at turn end: an invalid call
      // (overlapping clips, unknown ids, …) fails its own card with the validator's
      // reason — which also reaches the model via the log so it can fix the cause —
      // instead of showing a checkmark and having the whole turn rejected later.
      const probe = assembleEdit(ctx.project, ops, 'validation probe', 'agent');
      if (!probe.validation.valid) {
        // Locate each issue, do not just quote it. A batch tool builds one operation per
        // cue/entry, so an unlocated reason is the same sentence for every one of them and
        // the model's only move is to reissue the identical call. `probe.patch.operations`
        // is the list the issues were raised against — normalized when the rejection came
        // after quantization, raw when it came before.
        const errors = probe.validation.issues.filter((i) => i.severity === 'error');
        const located = errors
          .map((i) => describeValidationIssue(i, probe.patch.operations))
          .join('; ');
        const clipHelp = unknownClipHelp(ctx.project, errors);
        // `Clip not found: clip_zz` ends without one, and two sentences need the stop.
        const problems =
          clipHelp === '' ? located : `${located}${located.endsWith('.') ? '' : '.'} ${clipHelp}`;
        const note = `Rejected "${call.name}" — ${problems}`;
        orchestratorLog.warn('tool call rejected — validator', { tool: call.name, problems });
        return {
          ops: [],
          note,
          summary: `${desc} — rejected: ${problems}`,
          status: 'failed',
          data: problems,
          rejectedOpCount: ops.length,
          deterministicFailure: true,
        };
      }
      // The NORMALIZED operations, not the raw ones the tool built.
      //
      // `assembleEdit` quantizes to the frame grid before it validates and applies, so the
      // working copy this call hands to the next one already holds the snapped times. The
      // raw ops were returned anyway, and the run accumulated numbers it had never
      // validated and that did not describe its own working copy. While `add_clip` was
      // exempt from the grid the two happened to be equal and nothing showed; the moment
      // it was not, a turn placing abutting clips rejected its own second call — the model
      // had computed `0.75` from the ungridded beat, clip one's end had already snapped to
      // 0.7667, and 0.75 now overlapped it. Both would have snapped to the same frame; the
      // seam was between raw and normalized, not between the two clips.
      //
      // One set of numbers, from here to the turn's patch to the ledger. `quantizePatch`
      // is idempotent, so re-normalizing at turn end is a no-op.
      const normalized = [...probe.patch.operations];
      const applied = applyProjectPatch(ctx.project, probe.patch);
      // A VALID EDIT THAT CHANGED NOTHING STILL HAS TO SAY SO.
      //
      // Writing the value a field already holds applies cleanly and reports success, and
      // nothing in the answer distinguishes that from work. Run `137d8fd0` made 65
      // `adjust_audio` calls, seven of them setting one clip to the −18 dB it was already
      // at, each answered "Adjusted audio WIZARDS_DRIVE.mp3" — so it set it again.
      //
      // The operations are NOT dropped. A re-derivation that comes out identical is still
      // the tool doing its job (`caption_the_edit` re-deriving cues off an unchanged
      // timeline is the standing case), and withholding it would make the turn's op count
      // depend on what the timeline happened to already say. Only the sentence changes,
      // which is the part the model reads.
      const changed = projectChanged(ctx.project, applied);
      // A REPEAT THAT CHANGES NOTHING IS THE ONE CASE WORTH WITHHOLDING.
      //
      // Neither signal is enough alone. "Changed nothing" on its own is legitimate —
      // `caption_the_edit` re-deriving cues off an unchanged timeline is the tool doing
      // its job, and two incident regressions pin that its operations must still flow.
      // "Byte-identical repeat" on its own is legitimate too — the same call after a cut
      // is exactly how captions are repaired. Together they are neither: the run already
      // made this call, and making it again moves nothing. Withholding is provably safe,
      // because `applyProjectPatch` has just demonstrated the result is the same project.
      //
      // Run `137d8fd0` did this 66 times, and the timeline it produced is what that looks
      // like: nineteen video layers for a sixty-second edit, one stock clip on three of
      // them, the music bed and the title card each placed twice.
      const callKey = appliedCallKey(call);
      if (!changed && host.appliedCalls?.has(callKey) === true) {
        const note =
          `${desc} — already done, and doing it again moved nothing. This run has ` +
          'made this exact call before and the project is unchanged by it, so the ' +
          'operations were not applied a second time. Read the current state with ' +
          'get_timeline or get_clips, and go on to the next part of the request.';
        orchestratorLog.warn('withheld a repeated call that changed nothing', {
          tool: call.name,
          opCount: normalized.length,
        });
        return { ops: [], note, summary: note, status: 'warning', satisfied: true };
      }
      host.appliedCalls?.add(callKey);
      const note =
        summarizeOperations(normalized, names, call) +
        (call.name === 'caption_the_edit'
          ? captionStyleNote(applied, (call.arguments as { trackId?: unknown }).trackId)
          : '') +
        autoReframeNote(call.name, normalized) +
        (changed
          ? ''
          : ' — nothing moved: the project already said exactly this. Read the current ' +
            'value with get_timeline or get_clips before setting it again.');
      orchestratorLog.action('tool produced ops', {
        tool: call.name,
        opCount: normalized.length,
        note,
      });
      // Invalidate what this patch actually changed — the ARRANGEMENT — and nothing more
      // (§3.7). This used to be a blanket `clear()`, which threw away the transcript and
      // the footage map every time a cut landed, forcing the run to buy its own
      // reconnaissance again. A ripple delete cannot change the words that were spoken.
      host.evidence?.invalidate(normalized.map((op) => op.type));
      return {
        ops: normalized,
        note,
        summary: note,
        status: 'completed',
        // A tool whose op count the model cannot influence does not spend the run's
        // blast-radius budget (see `ToolSpec.derivedFanOut`).
        ...derivedOps(call.name, normalized),
        project: applied,
      };
    } catch (error) {
      // The old comment here claimed only a `ToolInvocationError` for invalid args could
      // reach this point. That was never true: everything above except `operationsFor` is
      // orchestrator work, so a throw from `assembleEdit`, `summarizeOperations`
      // or `applyProjectPatch` was reported as the model's bad
      // arguments and banked as permanent — losing the tool for the rest of the run over a
      // fault it had no part in. Retryable by omission: no `deterministicFailure`, so
      // `deterministicFailureKey` returns nothing.
      const reason = error instanceof Error ? error.message : String(error);
      orchestratorLog.error('tool call failed unexpectedly', { tool: call.name, reason });
      const note =
        `"${call.name}" failed unexpectedly: ${reason}. This is not a problem with your ` +
        'arguments — try it again, or reach for a different tool.';
      return { ops: [], note, summary: `${desc} — failed`, status: 'failed', data: note };
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
      ...buildContext(this.budgeted(input, estimateTokens(AGENT_PLAN_DRAFT_INSTRUCTION))),
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
    /**
     * The same options the report was produced with, so a deterministic repair settles the
     * SAME question the check that failed asked. Recomputing them here would let the two
     * drift — the repair could refuse a trim the check demanded, or make one it did not.
     */
    critiqueOptions: CritiqueOptions;
    stepIndex: number;
    appliedPatchIds: Set<string>;
    /** The run's applied-call ledger (see `HostCallContext.appliedCalls`). */
    appliedCalls?: Set<string>;
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
    /** The run's tool-domain ledger, so a repair keeps the tools the run loaded. */
    loadedToolDomains: Set<ToolDomain>;
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
  }): Promise<{
    step: AgentStep;
    working: Project;
    ops: AnyOperation[];
    /**
     * What this pass did — carried even when `ops` is empty, so a repair that RAN and
     * produced nothing can be told apart from one that never ran. See
     * `VerifyResult.repairOutcome`; the four arms name four different next steps.
     */
    outcome: RepairOutcome;
  } | null> {
    const fixable = args.report.checks.filter(
      (c) => c.status === 'fail' && FIXABLE_CHECKS.has(c.id),
    );
    // The only branch that returns before a model call is made: nothing failed that this
    // pass knows how to fix, so there is no spend and nothing to report.
    if (fixable.length === 0) return null;

    // Some failures have an answer the Critic can compute, and asking a model for those is
    // strictly worse: it costs a large-model call, it can decline, and it can propose
    // something else. Run `fc10301a` failed on 23.7 seconds of black under a music bed
    // that outran the picture — two numbers and a trim — and its repair pass produced
    // nothing at all. Try the arithmetic first; fall through to the model for the rest.
    const deterministic = repairTrailingSoundOverrun(args.working, args.critiqueOptions);
    if (deterministic.length > 0) {
      const edit = assembleEdit(args.working, [...deterministic], 'Repair pass', 'agent');
      if (edit.validation.valid) {
        const names = projectNames(args.working);
        const note = deterministic
          .map((op) => describeOperation(op, names))
          .map((d) => `${d.action}${d.detail ? ` ${d.detail}` : ''}`)
          .join('; ');
        return {
          step: {
            index: args.stepIndex,
            rationale: 'Trimmed the sound back to where the picture ends.',
            toolCalls: ['trim_clip'],
            applied: true,
            // Prefixed like every other repair record, so a reader (and the two tests
            // that look for one) sees repair turns under one name whatever produced them.
            note: `Repair pass: ${note}`,
          },
          working: applyProjectPatch(args.working, edit.patch),
          // The PATCH's operations, not the raw ones: `assembleEdit` quantizes to the
          // frame grid, and these are pushed to `repairOps`/`cumulativeOps` — the run's
          // ledger of what it did. Reporting the pre-snap numbers there would make the
          // ledger disagree with the timeline over the same edit.
          ops: [...edit.patch.operations],
          outcome: { kind: 'applied', opCount: edit.patch.operations.length, note },
        };
      }
      // The computed trim did not validate — say so rather than applying nothing in
      // silence, then let the model try.
      orchestratorLog.warn('deterministic picture-coverage repair failed validation', {
        issues: edit.validation.issues,
      });
    }

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
      ).messages,
      { role: 'user' as const, content: instruction },
    ];
    const response = await this.completeModel(
      // The repair pass is the LAST TURN OF THE SAME RUN, so it advertises the same set
      // that run's turns did. Advertising the full registry here would both hand the
      // repair a surface no earlier turn had and break the prompt-prefix stability the
      // tool block's cache key depends on (E3.3).
      { messages, tools: this.agentTools('agent', undefined, args.loadedToolDomains) },
      args.signal,
      args.effectRuntime,
      'large',
    );
    // Reported UNCONDITIONALLY, `undefined` usage included: the call happened, and the
    // run's accumulator counts calls separately from tokens so a provider that priced
    // nothing still shows up as spend of unknown size rather than as no spend.
    args.onUsage?.(response.usage);
    const calls = response.toolCalls ?? [];
    if (calls.length === 0) {
      return {
        step: {
          index: args.stepIndex,
          rationale: response.text || 'Repair pass',
          toolCalls: [],
          applied: false,
          note: 'Repair pass: proposed no change.',
        },
        working: args.working,
        ops: [],
        outcome: { kind: 'no_calls' },
      };
    }

    // Thread the repair turn's speculative working copy call-to-call (see executeToolCalls).
    let ctx = this.toolContext({ ...args.input, project: args.working });
    let names = projectNames(args.working);
    const turnOps: AnyOperation[] = [];
    const notes: string[] = [];
    let satisfied = false;
    let askedQuestion = false;
    for (const call of calls) {
      const {
        ops,
        note,
        project,
        satisfied: callSatisfied,
        askedQuestion: callAsked,
      } = await this.runAgentCall(call, ctx, names, {
        ...(args.signal ? { signal: args.signal } : {}),
        effectRuntime: args.effectRuntime,
        loadedSkills: args.loadedSkills,
        loadedToolDomains: args.loadedToolDomains,
        // Every caller of `attemptRepair` threads the run's `analysisBudget` (created
        // once, up front, and always truthy) straight through — see `HostCallContext`.
        analysisBudget: args.analysisBudget,
        // The repair pass is the SAME run: an edit it re-issues unchanged is as much a
        // repeat as one a turn re-issues.
        ...(args.appliedCalls ? { appliedCalls: args.appliedCalls } : {}),
      });
      turnOps.push(...ops);
      notes.push(note);
      if (callSatisfied === true) satisfied = true;
      if (callAsked === true) askedQuestion = true;
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
        outcome:
          rejections.length > 0
            ? { kind: 'all_rejected', reasons: rejections }
            : { kind: 'no_calls' },
      };
    }
    // Respect the per-turn blast-radius bound even during repair.
    if (turnOps.length > args.maxOpsPerTurn) {
      return {
        step: {
          index: args.stepIndex,
          rationale: response.text || 'Repair pass',
          toolCalls: calls.map((c) => c.name),
          applied: false,
          note: `Repair pass: ${String(turnOps.length)} operations exceeds the per-turn cap of ${String(args.maxOpsPerTurn)}.`,
        },
        working: args.working,
        ops: [],
        outcome: { kind: 'over_cap', opCount: turnOps.length, cap: args.maxOpsPerTurn },
      };
    }

    const step = this.applyAgentTurn({
      index: args.stepIndex,
      rationale: response.text || 'Repair pass',
      toolCalls: calls.map((c) => c.name),
      notes,
      turnOps,
      working: args.working,
      appliedPatchIds: args.appliedPatchIds,
      ...(satisfied ? { satisfied: true } : {}),
      ...(askedQuestion ? { askedQuestion: true } : {}),
    });
    const record: AgentStep = { ...step.record, note: `Repair pass: ${step.record.note}` };
    return step.applied
      ? {
          step: record,
          working: step.working,
          ops: turnOps,
          outcome: { kind: 'applied', opCount: turnOps.length, note: step.record.note },
        }
      : {
          step: record,
          working: args.working,
          ops: [],
          // The turn-level assemble rejected what the per-call checks let through, so the
          // notes carry the validator's reasons.
          outcome: { kind: 'all_rejected', reasons: [step.record.note] },
        };
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
    // Per-run ledger of mutating calls already applied — see `HostCallContext.appliedCalls`.
    const appliedCalls = new Set<string>();
    // ADR 0057: per-run skill ledger — see the streaming loop's identical comment.
    const loadedSkills = new Map<string, string>();
    const loadedToolDomains = new Set<ToolDomain>();
    // Per-run analysis budget (B5.4): caps frames/ffmpeg-seconds/transcription across
    // the whole run so a spinning loop hits an honest ceiling, not the compute wall.
    const analysisBudget = createAnalysisBudget(options.analysisCaps);
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
            options,
          ).messages,
          // Re-read every turn: `load_tools` pins a domain mid-run and the next request
          // must advertise it (progressive disclosure — `tool-domains.ts`).
          tools: this.agentTools('agent', undefined, loadedToolDomains),
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
      let turnSatisfied = false;
      let turnAskedQuestion = false;
      const callFacts: TurnCallFact[] = [];
      const turnFrames: AiImage[] = [];
      /** Ops a tool derived from the project — excluded from the bound (see below). */
      let derivedOpCount = 0;
      for (const call of calls) {
        const {
          ops,
          note,
          project,
          status,
          fromCache,
          images,
          derivedOpCount: callDerivedOps,
          satisfied: callSatisfied,
          askedQuestion: callAskedQuestion,
        } = await this.runAgentCall(call, ctx, names, {
          effectRuntime,
          evidence,
          appliedCalls,
          loadedSkills,
          loadedToolDomains,
          analysisBudget,
        });
        turnOps.push(...ops);
        notes.push(note);
        if (callSatisfied === true) turnSatisfied = true;
        if (callAskedQuestion === true) turnAskedQuestion = true;
        if (callDerivedOps) derivedOpCount += callDerivedOps;
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
      // applied — the human can still re-prompt with a narrower goal. It counts what the
      // MODEL composed; operations a tool derived from the project are excluded, on the
      // same terms as the streaming path (`ToolSpec.derivedFanOut`).
      if (turnOps.length - derivedOpCount > maxOpsPerTurn) {
        const note = `Turn rejected: ${turnOps.length - derivedOpCount} operations exceeds the per-turn cap of ${maxOpsPerTurn}.`;
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
        ...(turnSatisfied ? { satisfied: true } : {}),
        ...(turnAskedQuestion ? { askedQuestion: true } : {}),
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
      // The run's applied-work counter. The legacy loop keeps no ledger, so the number of
      // operations it has landed is the same monotonic fact by another name.
      const signature = turnSignature(calls, cumulativeOps.length);
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

    let report = critique(
      working,
      // P4.3: the run's evidence, so the critic reviews with what the run learned rather
      // than with a thinner view than its own planner had.
      this.critiqueOptions(input, options, cumulativeOps.length > 0, evidence),
    );

    // R3 C3: one bounded Critic-driven repair pass if fixable findings remain.
    if ((options.autoRepair ?? true) && !report.ok) {
      const repair = await this.attemptRepair({
        input,
        working,
        log,
        report,
        critiqueOptions: this.critiqueOptions(input, options, cumulativeOps.length > 0, evidence),
        stepIndex: steps.length + 1,
        appliedPatchIds,
        appliedCalls,
        maxOpsPerTurn,
        effectRuntime,
        loadedSkills,
        loadedToolDomains,
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
            this.critiqueOptions(input, options, cumulativeOps.length > 0, evidence),
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
     * Some call in this turn reported the timeline already matched it. Only consulted
     * when the turn landed no operations — see the zero-op branch below.
     */
    satisfied?: boolean;
    /**
     * Some call in this turn put a question to the editor. The turn's operations are then
     * withheld — see the branch below.
     */
    askedQuestion?: boolean;
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
     * The refusal's STABLE identity — the same refusal twice produces the same key,
     * however much of the message varies with the offending values.
     *
     * `rejection` is the sentence the editor and the model both read, so it names the
     * exact times, counts and ids that need fixing. That is right for the message and
     * fatal for a guard: `conductor.ts#repeatedRejection` compared whole sentences, so
     * `beat-sync` r1's twenty-nine consecutive beat-grid refusals — identical rule,
     * different off-grid times — never matched each other, and the run spent twenty
     * minutes and $3.93 re-issuing the same rejected edit. Guards key on this; humans
     * read `rejection`.
     */
    rejectionKey?: string;
    /**
     * HOW MUCH of the proposal the refusal is still refusing — the count of offending
     * boundaries, validator errors, or operations over the cap. Never a severity.
     *
     * {@link rejectionKey} answers "the same wall again?"; this answers "is the run getting
     * through it?". See `conductor.ts#onTurnResult`, where a repeated refusal whose scale
     * has fallen to a new low is credited as progress instead of stall.
     */
    rejectionScale?: number;
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
        // Same distinction the identical-patch branch below draws, reached earlier: a
        // turn whose every operation was a no-op never assembles a patch, so its id can
        // never match a banked one. Without this it read as a turn that landed nothing —
        // which the reducer files as `failed`, and the model then hunts for a cause that
        // does not exist.
        ...(args.satisfied === true ? { satisfied: true } : {}),
        working,
      };
    }

    // ASKING IS NOT EDITING.
    //
    // Every operation in a turn comes from ONE model response, so a turn that calls
    // `ask_user` composed its edits BEFORE any answer existed — including the answer it
    // was asking for. Applying them anyway is the run acting on the guess it just told
    // the editor it could not make.
    //
    // The golden case `clarify-which-clip` is this, three runs out of three: "Cut the
    // clip a bit shorter" over five clips and no selection, the agent correctly asks
    // which one — and reframes all five in the same turn. The run reported "Applied 5
    // edits", the rubric expected an untouched timeline, and the editor got work they
    // never asked for while their question sat open.
    //
    // The ops are withheld, not rejected: nothing about them was invalid, and the note
    // says to make them again once the answer is in. A turn that only asks is unaffected
    // (it has no ops), and a run whose next turn re-issues them loses one step — which is
    // what asking a question costs, and is the point of asking one.
    if (args.askedQuestion === true) {
      const note =
        `${baseNote}; asked the editor a question, so this turn's ` +
        `${String(args.turnOps.length)} edit(s) were not applied — they were composed ` +
        'before the answer. Make them on the next turn, in light of what they said.';
      return {
        record: { index, rationale, toolCalls, applied: false, note },
        applied: false,
        working,
      };
    }

    const turnOps = args.turnOps;

    const edit = assembleEdit(working, turnOps, rationale || 'Agent step', 'agent');
    /* v8 ignore start -- defense in depth: every op in `turnOps` already passed its own
     * per-call probe (`runAgentCall`'s `assembleEdit(ctx.project, ops, …)`) against the
     * exact speculative state this whole-turn recombination replays against, so
     * `edit.validation` can only fail here if that invariant is broken by future code
     * (e.g. a new call site that pushes into `turnOps` without probing first). */
    if (!edit.validation.valid) {
      const errors = edit.validation.issues.filter((i) => i.severity === 'error');
      const problems = errors.map((i) => i.message).join('; ');
      // Codes, not messages: an overlap shrinking from 3s to 1s is the SAME refusal, and
      // keying it on the sentence made the guard read two unrelated failures.
      const problemKey = [...new Set(errors.map((i) => i.code))].sort().join(',');
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
        rejectionKey: `validator:${problemKey}`,
        // The number of errors left to fix: a turn that took eight overlaps down to one is
        // converging, and must not be filed as the same nothing as one that took eight to
        // eight (`conductor.ts#onTurnResult`).
        rejectionScale: errors.length,
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
          note: `${baseNote}; already in place — this exact change is already on the timeline`,
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
      record: { index, rationale, toolCalls, patch: edit.patch, applied: true, note: baseNote },
      applied: true,
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
  /**
   * The tool-schema cost of the previous request this orchestrator sent (P5.3).
   *
   * The tool block sits ABOVE the messages in the provider's cache hierarchy, so changing
   * it re-bills everything cached beneath at full price. The stage policy swaps the
   * descriptor set twice in a nine-turn run and that cost was invisible — the cost meter
   * sees input tokens, not *why* they were not cached. Comparing consecutive requests
   * turns it into a number the manifest reports.
   */
  private previousToolSchemaTokens: number | undefined;

  private manifestFor(
    request: AiCompletionRequest,
    sink: StreamSink,
    modelCall: ModelCallContext,
  ): ContextManifest {
    const capabilities = capabilitiesFor(this.provider.name, this.provider.modelId);
    const previous = this.previousToolSchemaTokens;
    this.previousToolSchemaTokens = toolSchemaCost(request.tools);
    return buildRequestManifest({
      ...(previous === undefined ? {} : { previousToolSchemaTokens: previous }),
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
    /**
     * The silence heartbeat for this call (`reliability/wait-heartbeat.ts`).
     *
     * Opt-in per caller, and today only the agent turn opts in: run `369e8c82` hung inside
     * the agent loop's twentieth model call, and the single-call routes (chat, edit, plan)
     * have a composer that is visibly disabled and a run that is over in one step — they
     * are not the surface where a user was left guessing for thirty-nine minutes. Absent ⇒
     * no timer is armed and the stream is drained exactly as it was before this existed.
     */
    wait?: { readonly timers?: TimerApi; readonly intervalMs?: number },
  ): AsyncGenerator<
    AiEvent,
    {
      text: string;
      calls: ToolCall[];
      aborted: boolean;
      usage?: Usage;
      truncated?: boolean;
      droppedToolCalls?: readonly string[];
    }
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
    // Tool calls the stream carried but could not be reassembled (see `done.droppedToolCalls`).
    // Named so the retry can tell the model WHICH ask never arrived — a blind retry of a
    // turn whose `add_clip` was cut in half asks for the same thing the same way.
    let droppedToolCalls: readonly string[] = [];
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
    /**
     * The waiting bar's stable id, scoped to THIS model call (`wait:seg-20`, `wait:seg-20:retry-1`).
     *
     * `emit.progress` upserts by id, so every beat of one silent call updates the same
     * single row instead of stacking a new line every four minutes — and a later step's
     * wait gets its own row, in its own place in the transcript, rather than reviving the
     * previous step's. It also does NOT consume the turn's `seq` counter, so a run that
     * beats and a run that does not produce byte-identical ids for every other event.
     */
    const waitKey = `wait:${segmentKey ?? 'main'}`;
    /** The last wait announced, if any — the row exists only once this is set. */
    let waitLabel: string | undefined;
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
    // Ask the provider for the output room the manifest reserved. Without an explicit
    // `maxTokens` every adapter/bridge falls back to its own default (8,192 on the
    // OpenAI-compatible path), so a long tool-call batch was cut mid-JSON, classified
    // "truncated", retried once at the same cap, and the run failed — while the window
    // accounting believed 128k of output was available (plan/system-mission P1.1).
    const outputRoom = request.maxTokens ?? outputRoomFor(this.provider, modelCall);
    const withOutputRoom: AiCompletionRequest =
      outputRoom === undefined ? request : { ...request, maxTokens: outputRoom };
    const modelRequest: AiCompletionRequest = captureReasoning
      ? { ...withOutputRoom, reasoningEffort: withOutputRoom.reasoningEffort ?? 'medium' }
      : withOutputRoom;
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
      // A CALL THAT IS WAITING SAYS IT IS WAITING (run `369e8c82`: a manifest at 15:16:45,
      // then nothing at all until the user force-quit at 15:55:33). Every chunk — text,
      // reasoning, tool-call fragment — resets the silence, so a call that streams says
      // nothing extra; only a call that has genuinely gone quiet does.
      for await (const step of withWaitHeartbeat(chunks, {
        intervalMs: wait ? (wait.intervalMs ?? MODEL_WAIT_HEARTBEAT_MS) : 0,
        ...(wait?.timers ? { timers: wait.timers } : {}),
        ...(signal ? { signal } : {}),
      })) {
        if (step.kind === 'waiting') {
          waitLabel = modelWaitLabel(step.waitedMs);
          // `progress`, not `notification`: the editor renders a progress node as an
          // indeterminate shimmer that updates in place and vanishes when it settles —
          // ongoing progress, not a new fact filed in the transcript. A notice per beat
          // would leave ten permanent info cards behind a slow call.
          yield emit.progress(waitLabel, 0, waitKey);
          continue;
        }
        const chunk = step.chunk;
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
          droppedToolCalls = chunk.droppedToolCalls ?? [];
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
        ...(droppedToolCalls.length > 0 ? { droppedToolCalls } : {}),
      };
    } finally {
      if (!settled) {
        const settle = settleReasoning();
        if (settle) yield settle;
      }
      // Settle the waiting row on EVERY exit — answered, aborted, deadline, or a consumer
      // that stopped draining. A bar left under 1 shimmers forever (`ProgressBar` renders
      // nothing at all once it reaches 1), and "waiting" outliving the wait is the same
      // class of lie as the spinner that outlived run `369e8c82`. Skipped entirely when no
      // beat ever fired, so a healthy call adds no event of any kind.
      if (waitLabel !== undefined) yield emit.progress(waitLabel, 1, waitKey);
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
    /** The run's tool-domain ledger (see `HostCallContext.loadedToolDomains`). */
    loadedToolDomains: Set<ToolDomain>,
    /** Answers the model's questions (P12); absent ⇒ `ask_user` degrades honestly. */
    askUser: AskUser | undefined,
    signal: AbortSignal | undefined,
    now: () => number,
    // Non-optional: both agent and tool-using question loops always thread the run's
    // up-front `createAnalysisBudget()` result — never a budget-less call.
    analysisBudget: AnalysisBudget,
    /** Enforce an exceptional route-scoped descriptor set at execution time. */
    allowedToolNames?: ReadonlySet<string>,
    /**
     * Names that {@link allowedToolNames} withholds ONLY because their tool domain is not
     * pinned yet (progressive disclosure — `tool-domains.ts`).
     *
     * A model that names one of these has guessed a real tool correctly and is being
     * refused over token economy, not policy. Refusing it would cost a turn and teach it
     * nothing, so the domain is pinned and the call runs. Every other narrowing — the
     * stage policy, the recovery turn, the commit-only latch — is a behavioural rail and
     * is NOT in this set, so it still refuses exactly as before.
     */
    domainGatedToolNames?: ReadonlySet<string>,
    /** Mutating calls this run already applied (see `HostCallContext.appliedCalls`). */
    appliedCalls?: Set<string>,
    /** Durable note sink for what the editor tells the run (see `rememberDecision`). */
    rememberDecision?: (note: { readonly title: string; readonly body: string }) => void,
    /**
     * Banked catalogue searches, when this turn is running commit-only (02). Present ⇒ a
     * withheld search is refused with the specific reason and the specific way out.
     */
    bankedSearches?: number,
    /**
     * `name:error` keys the run has already been refused with (`ConductorState.seenFailureKeys`).
     * A call that settles to one of them is replaced by {@link repeatedFailureOutcome}
     * instead of handing the model the same sentence a second time.
     */
    seenFailureKeys?: ReadonlySet<string>,
    /**
     * True when {@link allowedToolNames} is the STAGE rule rather than a recovery-turn
     * latch. The two withhold the same names and used to earn the same sentence — "it
     * becomes available again on the next turn" — which is true of a latch and false of a
     * stage: an analysis tool withheld in `apply` stays withheld until `verify`. Told to
     * wait a turn, the model waits a turn and calls again (run `137d8fd0`, `measure_color`,
     * twice). The refusal now says which it is.
     */
    stageWithheld?: boolean,
  ): AsyncGenerator<
    AiEvent,
    {
      turnOps: AnyOperation[];
      notes: string[];
      turnStatuses: ToolStatus[];
      /** Some call reported the timeline already matched it. See `AgentCallOutcome.satisfied`. */
      satisfied: boolean;
      /** Some call put a question to the editor. See `AgentCallOutcome.askedQuestion`. */
      askedQuestion: boolean;
      /** Calls the harness refused this turn (commit-only latch, recovery surface). */
      withheldCallCount: number;
      rejectedOpCount: number;
      derivedOpCount: number;
      rejectionNotes: string[];
      /** Per-call progress facts the reducer folds (see `TurnCallFact`). */
      callFacts: TurnCallFact[];
      /**
       * Every settled call of this turn, for the run-level "Not done" account
       * (GOLDEN-C.19 — see `reliability/unfinished-work.ts`). Carried separately from
       * `callFacts`, which is keyed by NOVELTY and deliberately carries neither the tool's
       * name nor a host failure's text.
       */
      toolAttempts: ToolAttempt[];
      /**
       * Images this turn's tool calls produced (`get_frame`), for the next request to
       * attach as real image content. Empty on every turn that did not look at a frame.
       */
      frames: AiImage[];
      /**
       * The cards of the calls that PROPOSED this turn's operations, so a whole-turn
       * rejection can settle them honestly (see `settleProposalCards`).
       *
       * A tool card is settled the moment its own call returns, which is before the turn
       * gate runs — necessarily, because the card is what makes the run watchable. So a
       * turn the gate then rejects leaves a wall of green checkmarks behind it: run
       * `ea8e46ec` showed the editor sixty-one "Added clip Video 1 · 0s–0.5s" rows, in the
       * past tense, for clips that never reached the timeline, six times over.
       */
      proposalCards: { id: string; name: string }[];
    }
  > {
    const turnOps: AnyOperation[] = [];
    const notes: string[] = [];
    const turnStatuses: ToolStatus[] = [];
    /** Did any call report the timeline already matched it? See `AgentCallOutcome.satisfied`. */
    let satisfied = false;
    /** Did any call put a question to the editor? See `AgentCallOutcome.askedQuestion`. */
    let askedQuestion = false;
    let withheldCallCount = 0;
    /** Frames this turn's `get_frame` calls rendered, for the NEXT request's images. */
    const frames: AiImage[] = [];
    const callFacts: TurnCallFact[] = [];
    const toolAttempts: ToolAttempt[] = [];
    // Per-call validator rejections (ops proposed but refused) — the honest
    // empty-run notice is built from these when the whole run lands nothing.
    let rejectedOpCount = 0;
    let derivedOpCount = 0;
    const rejectionNotes: string[] = [];
    const proposalCards: { id: string; name: string }[] = [];
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
      ...(appliedCalls ? { appliedCalls } : {}),
      loadedSkills,
      loadedToolDomains,
      ...(askUser ? { askUser } : {}),
      ...(rememberDecision ? { rememberDecision } : {}),
      // `analysisBudget` is created once up front (always truthy) and threaded
      // through every turn of this loop — see `HostCallContext.analysisBudget`.
      analysisBudget,
    };
    /**
     * May this call run — and, if the only thing standing in its way is an unpinned tool
     * domain, pin it so that it can.
     *
     * Idempotent and safe to ask repeatedly: the concurrency planner asks before the
     * executor does, and both must get the same answer for one call.
     */
    const admitCall = (call: ToolCall): boolean => {
      if (allowedToolNames === undefined || allowedToolNames.has(call.name)) return true;
      if (domainGatedToolNames?.has(call.name) !== true) return false;
      const domain = toolDomain(call.name);
      if (domain === undefined || domain === 'core') return false;
      loadedToolDomains.add(domain);
      orchestratorLog.action('tool domain pinned by use', { tool: call.name, domain });
      return true;
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
        if (!admitCall(call)) return false;
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

    // 03 — warm this turn's sourcing downloads CONCURRENTLY before the serial pass.
    //
    // `add_stock`/`add_music` are declared `concurrency: 'serial'` in `tool-contract.ts`
    // and must stay that way: their COMMIT computes placement from `ctx.project` and
    // probes it, `buildAddStockOps` derives `nextLayerId` from `timeline.tracks.length`
    // and mints deterministic clip ids, so two placements computed against the same stale
    // project would emit colliding layer and clip ids in one patch.
    //
    // But that row governs two operations with opposite requirements. The COMMIT is
    // milliseconds and order-dependent. The ACQUIRE is a `net.fetch` of a third-party file
    // — no project state, and where all the latency lives: in captured run `e36235cc` the
    // eighteen `add_stock` calls ran strictly serially for ~960 seconds, 16 of the run's 30
    // minutes, with six failing. `search_stock` was already parallel; this was not.
    //
    // Warming rather than restructuring: the host's download is idempotent and
    // ledger-deduplicated (`stock-service.ts`), so once a file is on disk the serial call
    // that follows hits the dedupe path at zero bytes and returns immediately. The serial
    // commit still runs against the advanced `turnCtx`, exactly as before. A warm that
    // fails is discarded in silence — the serial call will make the same request and report
    // the failure through the normal path, so an error is never reported twice or early.
    const warmable = calls.filter(
      (call) => (call.name === 'add_stock' || call.name === 'add_music') && admitCall(call),
    );
    if (warmable.length > 1) {
      orchestratorLog.action('warming sourcing downloads', {
        count: warmable.length,
        pool: poolSize,
      });
      await mapBounded(warmable, poolSize, async (call) => {
        const tool = getTool(call.name);
        if (!tool) return;
        try {
          await effectRuntime.run(
            {
              kind: 'host_tool',
              call: {
                ...call,
                arguments: sanitizeToolArgs(tool, call.arguments) as Record<string, unknown>,
              },
              project: turnCtx.project,
              analysisBudget,
            },
            signal,
          );
        } catch {
          // Deliberately swallowed — see above.
        }
      });
    }

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
        const inScope = admitCall(call);
        const asked = inScope ? askQuestionFor(call) : undefined;
        if (asked) yield emit.ask(call.id, asked.question, asked.options);
        const started = now();
        // AWAITED host execution (Phase T): the card stays `running` for as long
        // as the analysis/action actually takes, and the returned data reaches
        // the model's next turn via the log note. Abort mid-call settles the
        // card as `cancelled`, never a checkmark.
        if (!inScope) withheldCallCount += 1;
        const outcome: AgentCallOutcome = inScope
          ? await this.runAgentCall(call, turnCtx, turnNames, hostContext)
          : withheldCallOutcome(
              call,
              evidence,
              bankedSearches,
              stageWithheld === true,
              turnCtx.project,
            );
        settled = [{ call, outcome, runtimeMs: now() - started, announced: true }];
      }

      // Fold the batch in original call order (reference pattern #2): results, notes,
      // callFacts, emitted events, and the stop-on-cancelled point are exactly what
      // serial execution produces for the same outcomes.
      for (const { call, outcome: settledOutcome, runtimeMs, announced } of settled) {
        // A repeat is caught the moment its refusal SETTLES, not before it runs, and the
        // difference is not a detail. The key is `name:error` and the error is produced by
        // the attempt — so the only thing knowable before execution is the tool's name,
        // and blocking on that would refuse an `add_clip` at 30s because an earlier one
        // overlapped a clip at 3s. Refusing a corrected retry is a worse bug than the loop.
        //
        // Nothing is wasted by letting it settle: every branch that can produce a
        // `deterministicFailure` is side-effect-free (schema parse, op build, validator
        // probe). Host work that merely FAILED still never reaches this test — a timeout,
        // a 5xx, an unresolvable id and a missing key are all transient and are given no
        // key. The single exception is a host that DECLARES a `refusalCause`
        // (`tool-executor.ts#HostToolOutcome`): that is a policy verdict the host reached
        // from the project, not work it attempted, and `stock-host.ts` reaches it before
        // spending the download — so letting it settle still costs nothing.
        const bankedKey = deterministicFailureKey(call.name, settledOutcome);
        const isRepeat = bankedKey !== undefined && seenFailureKeys?.has(bankedKey) === true;
        if (isRepeat) {
          orchestratorLog.warn('tool call refused — already failed this run', {
            tool: call.name,
            error: settledOutcome.data,
          });
        }
        const outcome = isRepeat
          ? repeatedFailureOutcome(call, settledOutcome.data as string)
          : settledOutcome;
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
        if (outcome.ops.length > 0) proposalCards.push({ id: call.id, name: call.name });
        turnOps.push(...outcome.ops);
        notes.push(outcome.note);
        turnStatuses.push(outcome.status);
        if (outcome.satisfied === true) satisfied = true;
        if (outcome.askedQuestion === true) askedQuestion = true;
        // Dev-only hit counter (opt-in via FRAMEPILOT_RUNS_LOG) — see run-log.ts.
        {
          const tool = getTool(call.name);
          const argsSummary = summarizeArgs(call.arguments);
          recordToolRun({
            ts: new Date().toISOString(),
            tool: call.name,
            ...(tool ? { kind: tool.kind, mutates: tool.mutates } : {}),
            status: outcome.status,
            runtimeMs,
            summary: outcome.summary,
            fromCache: outcome.fromCache === true,
            ...(argsSummary ? { argsSummary } : {}),
            ...(outcome.status === 'failed' && typeof outcome.data === 'string'
              ? { error: outcome.data }
              : {}),
          });
        }
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
            // A withheld call learned nothing; filing its policy sentence as a fact is
            // how "search_stock withheld" reached the next session's ESTABLISHED list.
            status: outcome.withheld === true ? 'withheld' : outcome.status,
            fromCache: outcome.fromCache === true,
            ...(evidence.lookup(callMemoKey(call))
              ? { evidenceId: evidence.lookup(callMemoKey(call))!.id }
              : {}),
          });
          const failureKey = deterministicFailureKey(call.name, outcome);
          callFacts.push({
            key: callNoveltyKey(call),
            status: outcome.status,
            fromCache: outcome.fromCache === true,
            role,
            ...(distilled ? { distilled } : {}),
            ...(failureKey === undefined ? {} : { failureKey }),
          });
        }
        // The run-level record of what this tool managed. `data` over `summary` because a
        // repeat refusal's summary is the wrapper ("Refused repeat of …") while its `data`
        // is the ORIGINAL error — the sentence the editor needs in the "Not done" block.
        // A name the registry has never heard of is not unfinished WORK — there was no
        // tool to finish. Run `cc907070` invented `get_track_flags`, and its receipt told
        // the editor "Get track flags — never succeeded: There is no tool called …" as if
        // a step of the brief had been dropped.
        if (getTool(call.name)) {
          toolAttempts.push({
            tool: call.name,
            status: outcome.status,
            ...(outcome.status === 'failed'
              ? { failureReason: typeof outcome.data === 'string' ? outcome.data : outcome.summary }
              : {}),
          });
        }
        if (outcome.rejectedOpCount) {
          rejectedOpCount += outcome.rejectedOpCount;
          rejectionNotes.push(outcome.note);
        }
        if (outcome.derivedOpCount) derivedOpCount += outcome.derivedOpCount;
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
    return {
      turnOps,
      notes,
      turnStatuses,
      satisfied,
      askedQuestion,
      withheldCallCount,
      rejectedOpCount,
      derivedOpCount,
      rejectionNotes,
      callFacts,
      toolAttempts,
      frames,
      proposalCards,
    };
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
    // Routing is the cheapest judgement the orchestrator makes, so it is the one call
    // stamped `small`: with `FRAMEPILOT_TIER_SMALL_*` configured it runs on a cheap model
    // and the editing turn still runs on the host-selected one. Unset, this IS
    // `this.provider` and nothing about the call changes.
    const provider = this.providerForTier('small');
    orchestratorLog.action('classifyCommand → request', {
      provider: provider.name,
      model: provider.modelId,
      userTextChars: input.userPrompt.length,
    });
    const estimatedInput = messages.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    );
    // Classification is a small, self-contained call with no assembled tiers behind it,
    // so its manifest is payload-derived: honest about being coarse, but every figure
    // real. It is what makes the "thinking" phase's occupancy explainable too. The limits
    // come from the provider that ACTUALLY serves this call — a small model's context
    // window is smaller, and a manifest reporting the large model's would understate
    // occupancy for the one request it describes.
    const capabilities = capabilitiesFor(provider.name, provider.modelId);
    const manifest = buildRequestManifest({
      requestId: 'classify',
      provider: provider.name,
      ...(provider.modelId ? { model: provider.modelId } : {}),
      contextWindow: contextWindowFor(input, provider),
      windowSource: capabilities.source,
      reservedOutputTokens: reservedOutputFor(input, provider),
      request: { messages },
    });
    try {
      const response = await provider.complete({ messages }, signal);
      const classification = parseClassification(response.text) ?? FALLBACK_CLASSIFICATION;
      orchestratorLog.action('classifyCommand ← response', {
        provider: provider.name,
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
      // WHICH model made the routing call, and what it cost. Routing runs on the `small`
      // tier, so a run that routed oddly is often a run that routed on a different model
      // than the reader assumes; without these the log cannot tell those apart.
      provider: classifierManifest.provider,
      model: classifierManifest.model,
      ...(classifierUsage === undefined ? {} : { usage: classifierUsage }),
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
    const tools = this.agentTools('question');
    // The budget is resolved BEFORE assembly (P1.2), from the model actually selected and
    // inclusive of what this route attaches afterwards: the question-scope tool schemas
    // and the route contract. Assembling first and budgeting second is how the trimmer
    // came to decide against a fraction of the prompt.
    const assembled = assembleContext({
      ...input,
      budget: resolveContextBudget(
        input,
        this.provider,
        toolSchemaCost(tools) +
          estimateTokens(questionModeInstruction({ canSeeFrames: this.canSeeFrames() })),
      ),
    });
    yield* trimNotices(emit, assembled.trimmed);
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
    const loadedToolDomains = new Set<ToolDomain>();
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
            explicitOutputCap: input.budget?.maxOutputTokens !== undefined,
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
            loadedToolDomains,
            chatOptions.controls?.askUser,
            options.signal,
            Date.now,
            analysisBudget,
            // A question turn can `ask_user` too, and an answer given there is just as
            // worth keeping as one given mid-edit. It never edits, so it needs no
            // applied-call ledger.
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
          explicitOutputCap: input.budget?.maxOutputTokens !== undefined,
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
    // No tools on a plan turn (see below), so the only unassembled cost is the mode
    // instruction — a real number, and the honest one to reserve.
    const assembled = assembleContext({
      ...input,
      budget: resolveContextBudget(input, this.provider, estimateTokens(PLAN_MODE_INSTRUCTION)),
    });
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
        explicitOutputCap: input.budget?.maxOutputTokens !== undefined,
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
          //
          // Split by whether the run ever GOT to act, because the two say very different
          // things to the person reading them and the old wording said only the second.
          // A review of the last turn's edit settles after the agent has stopped — in run
          // 4c9b5f82, twenty-six milliseconds after the run reported `completed` — so the
          // finding was never steered on, never attempted, and was reported in language
          // ("they are not perceptually clean") that reads as a verdict the run stood
          // behind rather than as work it never reached. Saying which one it is costs a
          // sentence and tells the editor whether asking again is worth anything.
          const unattempted = remaining.filter(
            (finding) => !findings.hasExhaustedSteering(finding),
          );
          const attempted = remaining.filter((finding) => findings.hasExhaustedSteering(finding));
          if (attempted.length > 0) {
            const notice: AiEvent = {
              ...evidenceBase(),
              id: `${options.turnId}:review-unresolved`,
              type: 'warning',
              text: `The perceptual review finished with ${String(attempted.length)} unresolved finding${attempted.length === 1 ? '' : 's'} that a correction attempt did not fix. Your edits are applied and validated, but they are not perceptually clean: ${describeFindings(attempted)}`,
            };
            projector?.observe(notice);
            yield notice;
          }
          if (unattempted.length > 0) {
            const notice: AiEvent = {
              ...evidenceBase(),
              id: `${options.turnId}:review-unattempted`,
              type: 'warning',
              text: `The review of the last edit came back after the run had finished, so nothing was done about it: ${describeFindings(unattempted)} Your edits are applied and validated. Ask me to fix this and I will start from what the review found.`,
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
    /**
     * Where in the programme the earliest FAILING evidence sits, when it has a frame.
     *
     * The finding's own location, as opposed to the reviewed turn's. See
     * {@link failingReviewSecond}.
     */
    readonly atSeconds?: number;
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
    const atSeconds = failingReviewSecond(requests, failing, workingProject.fps);
    return {
      report,
      passed,
      repairable: failing.length > 0 && failing.every((check) => check.status === 'fail'),
      detail,
      ...(atSeconds === undefined ? {} : { atSeconds }),
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
    // The turn's location, used only when a finding cannot place itself.
    const turnSecond = earliestTouchedSecond(args.after, region);
    const found: ReviewFinding[] = [];
    const base = {
      turnIndex: args.turnIndex,
      scope,
      ...(args.planStepId === undefined ? {} : { planStepId: args.planStepId }),
      ...(turnSecond === undefined ? {} : { atSeconds: turnSecond }),
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
          // The failing evidence places itself; `base`'s turn location is the fallback.
          ...(review.atSeconds === undefined ? {} : { atSeconds: review.atSeconds }),
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
    const editTools = toolDescriptors((t) => t.mutates);
    const assembled = assembleContext({
      ...input,
      budget: resolveContextBudget(input, this.provider, toolSchemaCost(editTools)),
    });
    yield* trimNotices(emit, assembled.trimmed);
    const result = yield* this.streamAssistant(
      emit,
      { messages: assembled.messages, tools: editTools },
      options.signal,
      { kind: 'assistant', id: emit.assistantId, captureReasoning: true },
      undefined,
      {
        tier: 'mid',
        contextWindow: contextWindowFor(input, this.provider),
        reservedOutputTokens: reservedOutputFor(input, this.provider),
        explicitOutputCap: input.budget?.maxOutputTokens !== undefined,
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
        // The editor reads this (a warning, and the failure card when every call was
        // rejected), so it gets the plain summary — the raw schema text is machine-speak.
        callErrors.push((error as ToolInvocationError).editorSummary);
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
    const assembled = assembleContext({
      ...input,
      budget: resolveContextBudget(
        input,
        this.provider,
        toolSchemaCost(toolDescriptors((t) => t.mutates)),
      ),
    });
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
    const { command, handlers, settle, dispose } = this.agentRun(
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
    } finally {
      // Normal completion, error, Stop, deadline — and the fourth path neither `finalize`
      // nor `settle` reaches: a consumer that stops draining this generator. An armed
      // deadline is a live `setTimeout`, and a leaked one keeps the process alive.
      dispose();
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
    /** Clear the run's wall-clock deadline. Idempotent; a leaked timer holds the process open. */
    dispose: () => void;
  } {
    // `async function*` handlers below carry their own `this`; capture the instance so
    // they can reuse the orchestrator's shared turn mechanics without `.bind` (which
    // would erase their contextual parameter types).
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- generator handlers need the instance
    const self = this;
    // ADR 0057: agent runs advertise the bundled skills manifest by default.
    input = this.withSkills(input);
    const now = options.now ?? Date.now;
    const runStartedAt = now();
    const signal = options.signal;
    /**
     * THE RUN'S OWN CLOCK, armed on the step that is in flight.
     *
     * The Conductor's budget check reads `runElapsedMs`, and `turnBase` below stamps that
     * only when a turn FINISHES — so the wall-clock bound covered the gaps between model
     * calls and never a call itself. Run `369e8c82` was given 37 minutes, hung inside its
     * twentieth model call at 15:16:45, and was still hanging at 15:55:33 when the app
     * closed: the limit expired at 15:24:11 and nothing was there to notice. A step that
     * does not return was unbounded.
     *
     * Same number as the reducer's cap, from the same function, so the two can never
     * disagree about when this run is over.
     */
    const deadline = createRunDeadline(
      maxWallMsFor(agentOptions.maxMinutes),
      options.signal,
      controls.timers,
    );
    /**
     * The signal for the run's IN-FLIGHT step work — the model stream and the turn's tool
     * calls (which is also what reaches `withRetry`, so a retry loop is cut off too).
     *
     * Deliberately not threaded into the plan draft, the approval gate, or the verify /
     * repair pass. None of those sits inside the turn loop, and none has a route that could
     * turn an abort into a report: `toVerify` issues a `run_verify` effect, so a deadline
     * that aborted the whole run would kill the very verification it triggered and the run
     * would report nothing — the exact failure this exists to remove, reproduced by the fix.
     * They stay on the editor's Stop signal, where an abort means what it says.
     */
    const runSignal = deadline.signal;
    /** The run stopped on its own clock rather than on the editor's Stop. */
    const deadlineStopped = (): boolean =>
      deadline.expired() && !(options.signal?.aborted ?? false);
    const maxOpsPerTurn = agentOptions.maxOpsPerTurn ?? DEFAULT_MAX_OPS_PER_TURN;
    const { runtime: effectRuntime, finish: finishEffects } = this.createRunRuntime(
      this.controlEffectExecutor(controls),
    );
    // Per-run evidence store (see `HostCallContext.evidence`): a repeat read on an
    // unchanged working copy is served from here and marked non-novel, so re-reading is
    // never mistaken for progress. Cleared inside `runAgentCall` when an edit lands.
    const evidence = new EvidenceStore();
    // Per-run ledger of mutating calls already applied — see `HostCallContext.appliedCalls`.
    const appliedCalls = new Set<string>();
    // ADR 0057: per-run skill ledger — shared across the run's turns AND its repair
    // pass, so a playbook is fetched once and stays pinned in context for the rest of
    // the run (see `HostCallContext.loadedSkills` / `agentSkillsBlock`).
    const loadedSkills = new Map<string, string>();
    const loadedToolDomains = new Set<ToolDomain>();
    // Per-run analysis budget (B5.4) — same role as the non-streaming loop's; shared
    // across the run's turns AND its repair pass so the ceiling is truly per-run.
    const analysisBudget = createAnalysisBudget(agentOptions.analysisCaps);
    const appliedPatchIds = new Set<string>();
    const log: string[] = [];
    let plan: readonly string[] | undefined;
    let working: Project = input.project;
    // Mirror of the reducer's cumulative applied ops; feeds the completion report and
    // keeps the closure's view of "what landed" in lockstep with the reducer.
    const cumulativeOps: AnyOperation[] = [];
    /**
     * Patches this run has proposed and the HOST has not yet ruled on
     * (`kernel/commit-ledger.ts`).
     *
     * Local validation is the last word only where nothing else can speak. On desktop the
     * host re-checks each patch against the authoritative project and can refuse it — wrong
     * project open, revision moved, media not on disk — and it used to record that verdict
     * for the UI alone. So the run's ledger read `succeeded` for two edits a captured
     * project never received, and the briefing then listed them under "ALREADY APPLIED — do
     * not repeat", guaranteeing the run would never retry the work it still owed.
     *
     * Collected at turn boundaries rather than inline, because the graph's event queue is a
     * fire-and-forget push: the diff may not have reached the host when the turn's generator
     * resumes. By the next turn it has — a model call sits in between — and `finalize` is
     * the backstop for the last one.
     */
    const unsettledPatches: {
      patchId: string;
      intent: string;
      workingBefore: Project;
      opCount: number;
    }[] = [];
    const hostRefusals: HostPatchRefusal[] = [];
    /**
     * Collect the host's verdicts on everything still outstanding.
     *
     * A refusal REWINDS the working copy to the state before the refused patch. Continuing
     * to edit against a project the authority never accepted is how a run builds a second,
     * private timeline and reports it as the user's — the failure this whole mechanism
     * exists to end. Later patches are rewound with it: they were built on top of work that
     * does not exist, so they cannot be salvaged independently.
     */
    const reconcileHostVerdicts = async (): Promise<void> => {
      const ledger = agentOptions.commitLedger;
      if (ledger === undefined || unsettledPatches.length === 0) return;
      const outstanding = unsettledPatches.splice(0);
      // AWAIT the verdicts rather than sampling them. There is no ordering to sample
      // against — the graph queue is a fire-and-forget push, so a diff may or may not have
      // reached the host by any point the run chooses to look, and in practice it usually
      // had not. Waiting is also the property that matters: a turn is never planned against
      // an edit whose fate is unknown. A ledger's presence is the host's promise to rule on
      // every patch exactly once (`deferred` included), so this cannot outlive the run.
      const verdicts = await Promise.all(
        outstanding.map(async (patch) => ({
          patch,
          reason: hostRefusalFor(await ledger.settled(patch.patchId)),
        })),
      );
      const firstRefused = verdicts.findIndex((v) => v.reason !== undefined);
      if (firstRefused === -1) return;
      for (const { patch, reason } of verdicts.slice(firstRefused)) {
        // Everything from the first refusal on is unsalvageable, refused or not: a later
        // patch was validated against a timeline that only ever existed in this run's own
        // copy. Reported as the same loss, because that is what it is.
        const cause = reason ?? verdicts[firstRefused]!.reason!;
        hostRefusals.push({ patchId: patch.patchId, intent: patch.intent, reason: cause });
        log.push(`The editor could not write "${patch.intent}" — ${cause}`);
        // FORGET the id as well as the ops. `patchIdFor` is a pure content hash of the
        // normalized operations, so the corrected retry of a refused edit — which is very
        // often the byte-identical call, because the refusal was the host's ("wrong project
        // open", "revision moved"), not the model's — recomputes the SAME id. Left in
        // `appliedPatchIds` it hit the no-op branch in `applyTurnEdit` and came back
        // "already in place — this exact change is already on the timeline" with
        // `satisfied: true`, which is excluded from the rejection path: green cards, a
        // completion report claiming the edit, and a project that never received it.
        //
        // Removing it restores the only honest state — the run has NOT applied this patch —
        // so a retry is assembled, validated and offered to the host again.
        appliedPatchIds.delete(patch.patchId);
      }
      const removedOps = verdicts
        .slice(firstRefused)
        .reduce((total, v) => total + v.patch.opCount, 0);
      working = verdicts[firstRefused]!.patch.workingBefore;
      cumulativeOps.splice(Math.max(0, cumulativeOps.length - removedOps));
    };
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
     * Every settled tool call of the run, in call order, for the completion report's
     * "Not done" block (GOLDEN-C.19 — `reliability/unfinished-work.ts`).
     *
     * Held here rather than in the reducer for the same reason `sawContentEvidence` is: it
     * is an observation the RUNTIME makes about calls it executed, and the pure reducer has
     * neither the tool's name nor a host failure's text.
     */
    const toolAttempts: ToolAttempt[] = [];
    /**
     * Did this run's request ask for a rendered FILE? The agent cannot make one — render and
     * export have no route from the panel — so the completion account says so rather than
     * reporting a finished job over a deliverable that was never produced.
     */
    const asksForFile = asksForRenderedFile(input.userPrompt);
    /** …and did it ask to SEE a preview first? Same answer: no route from the panel. */
    const asksToPreview = asksForPreview(input.userPrompt);
    /** …and did it state something to remember for future edits? */
    const asksToRemember = asksToRememberPreference(input.userPrompt);
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
    /**
     * Every `agent_turn` result leaves through here, which is why the host's refusals are
     * attached here and not at the one exit that happens to produce an edit.
     *
     * They are collected at the START of a turn (`reconcileHostVerdicts`) and belong to
     * whatever result that turn produces — including the turn where the model says it is
     * done, which is exactly when the last patch's verdict lands and exactly the result the
     * first version of this fix missed.
     */
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
      turnPlacementCount: 0,
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
      // The run's meter and clock, so the reducer can hold the run to its budget.
      runUsd: usageUsd,
      runElapsedMs: now() - runStartedAt,
      ...(hostRefusals.length > 0 ? { hostRefusals: hostRefusals.splice(0) } : {}),
      ...over,
    });

    /**
     * What the request asked for that the timeline does not yet deliver.
     *
     * Only the checks that can FAIL — the ones read deterministically off the request by
     * `acceptance.ts` and measured off the timeline by `critique`. Warnings are advisory by
     * contract and must never hold a run open; a `fail` is an unmet condition the editor
     * stated, and the run has no business calling itself finished while one stands.
     *
     * Cheap by construction: pure, render-free, and computed once, on the single turn where
     * the model says it is done.
     *
     * Judged as a DELTA, exactly as the verify pass judges it (`reconcileInheritedFailures`):
     * a health finding the starting project already had is not a shortfall of this run.
     * Unreconciled, every `s9-live-reorder` run that finished correctly after one
     * `reorder_clips` was told "The request is not met yet — continuing. 5 of 5 picture
     * clips use a landscape source … Crop each to fill the frame." and cropped all five on
     * a request that named none of them. A request-derived check is never excused.
     */
    const acceptanceShortfall = (producedChanges: boolean): string[] => {
      const options = self.critiqueOptions(input, agentOptions, producedChanges, evidence);
      return reconcileInheritedFailures(critique(input.project, options), critique(working, options))
        .checks.filter((check) => check.status === 'fail')
        .map((check) => check.detail);
    };

    const stepHandlers: ConductorHandlers = {
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

        // Top-of-loop stop (streamAgent's `if (signal.aborted) break`) — now reading the
        // run signal, so an expired deadline stops the loop here too. Which of the two
        // fired decides how the run settles: Stop cancels, the clock running out reports.
        if (runSignal.aborted) {
          return turnBase(
            index,
            emit.seq(),
            deadlineStopped() ? { deadlineExpired: true } : { aborted: true },
          );
        }

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

        // The host has had a turn's worth of time (a model call) to rule on the previous
        // turn's patch. Collect the verdict BEFORE this turn reads the project, so a turn
        // is never planned against edits the authority refused.
        await reconcileHostVerdicts();
        const names = projectNames(working);
        const segmentId = `${emit.assistantId}:seg-${index}`;
        // Pre-request invariants (ADR 0080). A turn that goes out with no objective or
        // no next action leaves the model nothing to continue from, so it re-explores the
        // whole project — the behaviour that reads as "the agent forgot everything".
        // Repair what state already implies; say so plainly when it cannot be repaired,
        // rather than letting the model compensate by starting over.
        /* v8 ignore next -- RunTurnEffect.working is optional on the type (additive, for the legacy loop and older fixtures per its own doc comment), but every REAL run_turn effect dispatched here comes from conductor.ts#runTurnEffect, which always sets working unconditionally — the undefined side is not reachable through the live gateway/conductor path today. */
        // Apply the verdicts just collected to THIS turn's briefing, not only to the fold
        // that follows it. The reducer corrects the ledger when the turn ends — but the
        // prompt is built now, and a briefing that lists a refused edit under
        // "ALREADY APPLIED — do not repeat" tells the model the one thing it still owes is
        // already done. That is a whole wasted turn, on the turn that could have fixed it.
        const briefedWorking =
          effect.working && hostRefusals.length > 0
            ? hostRefusals.reduce(
                (acc, refusal) => recordHostRefusal(acc, refusal.patchId, refusal.reason),
                effect.working,
              )
            : effect.working;
        const invariants = briefedWorking ? ensureContextInvariants(briefedWorking) : undefined;
        if (invariants && invariants.unrecovered.length > 0) {
          yield emit.warning(describeUnrecovered(invariants.unrecovered));
          // Integrity loss is an execution barrier. Do not call the model and do not
          // expose mutating tools while the durable ledger cannot authorize this turn.
          //
          // This note names no next action ON PURPOSE, and it is the one failure in this
          // file that should not (goal.md C; exempted by name in
          // `model-facing-failure.gate.test.ts`). It carries `done: true`, so the model is
          // never called again and never reads it: the reducer files it as the failed plan
          // step's detail, for the editor. There is also no move to name — the run's own
          // objective and committed plan are what could not be recovered, so every tool
          // the model could be pointed at would act on a ledger this turn just refused to
          // trust. The move belongs to the person, and `describeUnrecovered` above is what
          // reaches them.
          return turnBase(index, emit.seq(), {
            done: true,
            note: 'Run paused because its objective or committed plan could not be recovered.',
          });
        }
        /* v8 ignore next -- see the guard above: `effect.working` is always defined on the live path, so `invariants` is always defined too once we reach here, and the `?? effect.working` fallback never runs. */
        const taskMemory = invariants?.state ?? briefedWorking;
        // 02 — a run holding unspent sourcing candidates and nothing on the timeline loses
        // the catalogue searches for this turn. Recomputed per turn from live state (not
        // latched in a variable) so the first successful placement releases it immediately,
        // and so a run that never searched is never affected.
        const bankedSearches = bankedSearchCount(taskMemory);
        const withholdSearch = shouldWithholdCatalogueSearch({
          bankedSearches,
          placementsApplied: placementCount(state.cumulativeOps),
        });
        const turnScope: AgentToolScope = withholdSearch ? 'commit-only' : 'agent';
        if (withholdSearch) {
          orchestratorLog.action('commit-only turn — catalogue search withheld', {
            bankedSearches,
            stage: effect.stage,
          });
        }
        // C2: the turn's assistant text is about to stream, before its tool calls (if
        // any) are even known — `generating` is the specific, honest status for that
        // phase (vs. the generic `editing` the caller set for the whole run).
        yield emit.status('generating');
        /** One attempt at this turn's model call. Re-callable — see the retry below. */
        // Built once per attempt and held, so the manifest can report the TIER account
        // rather than falling back to one row per message (GAP-020).
        const built = () =>
          self.agentMessages(
            input,
            working,
            log,
            loadedSkills,
            plan,
            steeringMessage,
            effect.actionRecovery,
            taskMemory,
            pendingFrames,
            agentOptions,
          );
        const streamOnce = (attempt: number, prompt = built()) =>
          self.streamAssistant(
            emit,
            {
              messages: prompt.messages,
              // Stage-scoped surface (ADR 0075 §3.6): action recovery still wins when it
              // fires, but an executing run is closed to fresh reconnaissance regardless.
              tools: effect.actionRecovery
                ? self.agentTools('action-recovery', undefined, loadedToolDomains)
                : self.agentTools(turnScope, effect.stage, loadedToolDomains),
            },
            runSignal,
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
              explicitOutputCap: input.budget?.maxOutputTokens !== undefined,
              // What the project view actually held, tier by tier — the only way a dropped
              // section reaches the manifest, since a trimmed tier leaves no trace in the
              // payload. See `agentMessages`'s return type.
              assembled: prompt.assembled,
              // The run's durable memory rides with the request so the composer can say
              // "memory intact" while the prompt itself shrinks between turns.
              /* v8 ignore next -- taskMemory is always defined on the live path (see the effect.working guard above), so the empty-object fallback never runs. */
              ...(taskMemory ? { memory: memoryStatusFrom(taskMemory) } : {}),
            },
            // The waiting heartbeat, on the one call that actually went silent for
            // thirty-nine minutes. Same injected timers as the run's deadline — one clock
            // abstraction for the run, not two — and the same `runSignal`, so Stop and the
            // deadline end the beat exactly where they end the call.
            { ...(controls.timers ? { timers: controls.timers } : {}) },
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
          // A cut-off reply retried verbatim is cut off again at the same place (both
          // montage baseline failures, plan/system-mission P1.1e). The retry says why the
          // last attempt was unusable and asks for the same work in smaller pieces.
          const retryPrompt = built();
          const retryMessages =
            unusable === 'truncated'
              ? [
                  ...retryPrompt.messages,
                  {
                    role: 'user' as const,
                    content: truncationRetryHint(turn.droppedToolCalls ?? []),
                  },
                ]
              : retryPrompt.messages;
          // The attempt being replaced was still billed, so fold its usage in before it is
          // overwritten; the surviving attempt is folded in by the block below, once.
          if (turn.usage) {
            const supersededCost = costFromUsage(turn.usage);
            usageTokens += supersededCost.tokens;
            usageUsd += supersededCost.usd;
          }
          turn = yield* streamOnce(attempt, { ...retryPrompt, messages: retryMessages });
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
          //
          // Two shapes, and telling them apart is the whole point of the message. With
          // nothing applied the run genuinely produced no edit. With edits already on the
          // timeline the run STOPPED EARLY holding real work — which used to be reported
          // as an ordinary finish, so a run that was cut off halfway through the plan it
          // had just narrated closed as "completed" with the rest silently abandoned.
          const applied = state.cumulativeOps.length > 0;
          yield emit.warning(
            applied
              ? 'The model ran out of output room mid-reply on every attempt, so this run stopped early. The edits from the earlier steps are kept — ask for the rest in a smaller step.'
              : 'The model ran out of output room mid-reply and asked for no tool call, on every attempt. Nothing was applied. Retry, or ask for a smaller step.',
          );
          return turnBase(index, emit.seq(), {
            done: true,
            note: applied
              ? 'The model response was truncated; the run stopped early with the earlier edits kept.'
              : 'The model response was truncated before it proposed anything.',
          });
        }
        if (turn.aborted) {
          return turnBase(
            index,
            emit.seq(),
            deadlineStopped() ? { deadlineExpired: true } : { aborted: true },
          );
        }

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
            //
            // Unless it BILLED for the whole reply. A reasoning model handed a small output
            // cap can spend every one of those tokens thinking and emit no visible answer:
            // the wire carries an empty completion, but the cause is a budget, not an
            // outage. Measured against the cap actually SENT, never against the budget's
            // reservation — with no cap on the wire the model stopped for its own reasons
            // and nothing here is entitled to name one.
            const detail = emptyResponseDetail(
              turn.usage,
              outputRoomFor(self.provider, {
                reservedOutputTokens: reservedOutputFor(input, self.provider),
                explicitOutputCap: input.budget?.maxOutputTokens !== undefined,
              }),
            );
            if (state.cumulativeOps.length > 0) {
              log.push(`Step ${index}: empty model response — keeping the edits already applied.`);
              yield emit.warning(`${detail} The edits from earlier steps are kept.`);
              return turnBase(index, emit.seq(), { done: true, note: detail });
            }
            log.push(`Step ${index}: empty model response — nothing to apply.`);
            // `detail` is already the editor's sentence (it names the cause and the next
            // step), so the failure card keeps it instead of the generic server copy.
            throw new ProviderError(detail, 'server', { editorMessage: detail });
          }
          log.push(`Step ${index}: ${turn.text}`);
          yield emit.assistant(segmentId, turn.text);
          // The model has declared itself finished. Measure the conditions the REQUEST
          // stated against the timeline as it actually is, so the reducer can tell a run
          // that is done from one that has stopped. See `AgentTurnResult.acceptanceShortfall`.
          const shortfall = acceptanceShortfall(state.cumulativeOps.length > 0);
          return turnBase(index, emit.seq(), {
            done: true,
            ...(shortfall.length > 0 ? { acceptanceShortfall: shortfall } : {}),
          });
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
        // The run's own applied-work counter, read BEFORE this turn's calls run — the
        // signature describes "these calls, asked against this arrangement".
        const signature = turnSignature(turn.calls, taskMemory?.currentProjectRevision ?? 0);
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
        const {
          turnOps,
          notes,
          turnStatuses,
          satisfied: executedSatisfied,
          askedQuestion: executedAskedQuestion,
          withheldCallCount,
          rejectedOpCount,
          derivedOpCount,
          rejectionNotes,
          callFacts,
          toolAttempts: turnToolAttempts,
          frames,
          proposalCards,
        } = yield* self.executeToolCalls(
          emit,
          turn.calls,
          ctx,
          names,
          effectRuntime,
          evidence,
          loadedSkills,
          loadedToolDomains,
          controls.askUser,
          runSignal,
          now,
          analysisBudget,
          // Enforced, not merely advertised. `allowedToolNames` used to be passed only on
          // the recovery path, so a stage-narrowed tool called anyway executed normally —
          // the narrowing was a suggestion. A withholding scope that the model can step
          // around is the same advisory lever that has now failed four times.
          new Set(
            (effect.actionRecovery
              ? self.agentTools('action-recovery', undefined, loadedToolDomains)
              : self.agentTools(turnScope, effect.stage, loadedToolDomains)
            ).map((tool) => tool.name),
          ),
          // The same set with every domain pinned, minus the set above: the names this
          // turn withholds for token economy alone. `admitCall` loads their domain and
          // runs them rather than spending a turn refusing a correct guess.
          new Set(
            (effect.actionRecovery
              ? self.agentTools('action-recovery')
              : self.agentTools(turnScope, effect.stage)
            ).map((tool) => tool.name),
          ),
          appliedCalls,
          controls.rememberDecision,
          withholdSearch ? bankedSearches : undefined,
          // The run's proven-refusal memory, so a call that settles to a refusal this run
          // has already had is answered with "that cannot work" instead of the same
          // sentence again (see `ConductorState.seenFailureKeys`).
          effect.seenFailureKeys ? new Set(effect.seenFailureKeys) : undefined,
          // A recovery turn is a latch (next turn is different); anything else narrowed here
          // is the stage rule, and stays narrowed until the stage changes.
          !effect.actionRecovery,
        );
        // Some calls survived the stream and some did not. The survivors already ran, so the
        // turn is usable — but the model must be told which of its asks never arrived, or it
        // will read the next turn's timeline as proof that the missing call did nothing and
        // move on without it.
        for (const lost of new Set(turn.droppedToolCalls ?? [])) {
          // The instruction has to close off the WRONG move as well as name the right
          // one — the comment above is the whole reason this note exists, and a model that
          // reads the next turn's timeline as proof the call did nothing moves on without
          // it (goal.md C; `reliability/next-action.ts`).
          const note =
            `"${lost}" was not run: its arguments arrived incomplete and were discarded. ` +
            'Nothing from that call happened. Do not use the timeline as proof it did ' +
            'nothing; call it again on its own.';
          notes.push(note);
          log.push(`Step ${index}: ${note}`);
        }
        if (callFacts.some(isContentEvidenceFact)) sawContentEvidence = true;
        toolAttempts.push(...turnToolAttempts);
        // Hand this turn's frames to the NEXT request (see `pendingFrames`).
        pendingFrames = frames;
        const anyToolFailed = turnStatuses.includes('failed');
        const common = {
          planSteps,
          planStepIndex: stepIdx,
          withheldCallCount,
          intent,
          // The turn's own prose, so the reducer can tell whether four differently-worded
          // turns were the same turn (ADR 0075 §3.5).
          rationale: turn.text,
          signature,
          callFacts,
          rejectedOpCount,
          derivedOpCount,
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
            turnPlacementCount: placementCount(turnOps),
          });
        }

        // Blast-radius bound. It counts what the MODEL composed: operations a tool
        // derived from the project (`ToolSpec.derivedFanOut`) are excluded, because a
        // caption pass whose length is a fact about the transcript is not a runaway turn.
        //
        // The reducer emits the `failed` step + warning — but this branch states the
        // reason itself rather than relying on that. It used to return `...common` alone,
        // so `turnBase`'s `note: ''` default travelled to the reducer as the reason the
        // turn was refused, and the editor was shown a rejection count with three empty
        // strings where the reasons should have been. A veto that cannot say why is worse
        // than no veto: the model reads this note next turn and had nothing to fix.
        if (turnOps.length - derivedOpCount > maxOpsPerTurn) {
          yield* settleProposalCards(emit, proposalCards);
          const overCap =
            `Turn rejected: ${turnOps.length - derivedOpCount} model-composed operations ` +
            `exceeds the per-turn cap of ${maxOpsPerTurn}. Make the change in smaller steps.`;
          return turnBase(index, emit.seq(), {
            ...common,
            anyToolFailed,
            note: overCap,
            rejection: overCap,
            // The cap message names the op count, which changes every attempt.
            rejectionKey: 'over-cap',
            // …and the overage IS the measurement of how far over it still is, so a turn
            // that halves its batch is credited as converging rather than as a repeat.
            rejectionScale: turnOps.length - derivedOpCount - maxOpsPerTurn,
            turnOpCount: turnOps.length,
            turnPlacementCount: placementCount(turnOps),
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
          ...(executedSatisfied ? { satisfied: true } : {}),
          ...(executedAskedQuestion ? { askedQuestion: true } : {}),
        });
        // A whole-turn rejection un-settles the cards that proposed it. Not a cosmetic
        // detail: those cards are the editor's only live account of the run, and past-tense
        // green rows for edits that never reached the timeline is the difference between
        // watching a run and being told a story about one.
        //
        // `satisfied` is deliberately excluded — a turn that landed nothing because the
        // timeline already said what it asked for did not fail, and marking it failed is
        // the same lie in the other direction.
        if (applied.rejection !== undefined) yield* settleProposalCards(emit, proposalCards);
        const describedActions: DescribedAction[] = [];
        const workingBefore = working;
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
            // NOT adjudicated here. The graph buffers events (`kernel/agent-graph.ts`'s
            // queue is a fire-and-forget push), so the host may not have seen this diff yet
            // when the generator resumes — the verdict is collected at the NEXT turn
            // boundary and at finalize instead, by `reconcileHostVerdicts` below.
            unsettledPatches.push({
              patchId: applied.edit.patch.patchId,
              intent: applied.record.note,
              workingBefore,
              opCount: turnOps.length,
            });
          }
        }
        log.push(`Step ${index}: ${applied.record.note}`);
        return turnBase(index, emit.seq(), {
          ...common,
          anyToolFailed,
          turnOpCount: turnOps.length,
          turnPlacementCount: placementCount(turnOps),
          applied: applied.applied,
          appliedOps: applied.applied ? [...turnOps] : [],
          // The timeline the run just made, so the next turn does not have to ask.
          // See `AgentTurnResult.arrangement` and `arrangementLine`.
          ...(applied.applied ? { arrangement: arrangementLine(working) } : {}),
          describedActions,
          note: applied.record.note,
          ...(applied.edit ? { patchId: applied.edit.patch.patchId } : {}),
          ...(applied.rejection === undefined ? {} : { rejection: applied.rejection }),
          ...(applied.rejectionKey === undefined ? {} : { rejectionKey: applied.rejectionKey }),
          ...(applied.rejectionScale === undefined
            ? {}
            : { rejectionScale: applied.rejectionScale }),
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
        // The backstop for the LAST turn's patch, which no later turn boundary will reach.
        // Critiquing a timeline the authoritative project never received would grade the
        // run's private copy and report the verdict as if it were the user's.
        await reconcileHostVerdicts();
        // P4.3: the run's evidence, so the critic reviews with what the run learned
        // rather than with a thinner view than its own planner had. Held in a variable so
        // the repair pass settles against the SAME reading the checks were run with.
        const verifyOptions = self.critiqueOptions(
          input,
          agentOptions,
          state.cumulativeOps.length > 0,
          evidence,
        );
        // The self-check grades what the run CHANGED. A defect the footage already had —
        // measured on the project the run started from, with the same reading — is said as
        // an advisory and does not fail a correct edit (`reconcileInheritedFailures`).
        const inheritedFrom = critique(input.project, verifyOptions);
        let report = reconcileInheritedFailures(inheritedFrom, critique(working, verifyOptions));
        const repairOps: AnyOperation[] = [];
        let repairOutcome: RepairOutcome | undefined;
        if ((agentOptions.autoRepair ?? true) && !report.ok) {
          const repair = await self.attemptRepair({
            input,
            working,
            log,
            report,
            critiqueOptions: verifyOptions,
            stepIndex: state.planSteps.length + 1,
            appliedPatchIds,
            appliedCalls,
            maxOpsPerTurn,
            effectRuntime,
            loadedSkills,
            loadedToolDomains,
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
          // Carried whether or not anything landed: a repair that RAN and produced nothing
          // is a different fact from one that never ran, and it cost a large-model call.
          repairOutcome = repair?.outcome;
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
            report = reconcileInheritedFailures(
              inheritedFrom,
              critique(working, self.critiqueOptions(input, agentOptions, true, evidence)),
            );
          }
        }
        const named = (status: 'fail' | 'warn'): { label: string; detail: string }[] =>
          report.checks
            .filter((c) => c.status === status)
            .map((c) => ({ label: c.label, detail: c.detail }));
        return {
          kind: 'verify',
          ok: report.ok,
          summary: report.summary,
          failedChecks: named('fail'),
          // Advisory checks reached the editor as a COUNT and nothing else. See
          // `VerifyResult.warnedChecks`.
          warnedChecks: named('warn'),
          repairOps,
          ...(repairOutcome ? { repairOutcome } : {}),
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
        // THE BACKSTOP ON EVERY TERMINAL PATH.
        //
        // `reconcileHostVerdicts` otherwise runs only at a turn boundary and in `runVerify`.
        // A cancelled run reaches neither: `kernel/conductor.ts`'s `cancelFinalize` goes
        // straight to `finalize`, bypassing `toVerify`. So a Stop pressed after a refused
        // patch left the last patches' verdicts uncollected, and the completion report
        // below then told the editor about work the project never received — the exact
        // failure the ledger exists to prevent, surviving on the one path that skipped it.
        //
        // Idempotent: `unsettledPatches` is spliced empty by each call, so the normal
        // post-verify path reaches this with nothing outstanding and it costs nothing.
        const refusalsBefore = hostRefusals.length;
        await reconcileHostVerdicts();
        const refusedAtTheEnd = hostRefusals.length > refusalsBefore;
        // `effect.ops` was snapshotted by the reducer BEFORE those verdicts existed, so it
        // still counts the refused patches. `cumulativeOps` is this closure's mirror and HAS
        // been rewound by the reconcile above, which makes it the only honest account of
        // what the project actually holds. Used only when a refusal landed here, so every
        // other run keeps the reducer's list byte-for-byte.
        const reportedOps = refusedAtTheEnd ? cumulativeOps : effect.ops;
        // C1: the run's real, combined cost (classifier + every turn + any repair pass) —
        // emitted once at the terminal boundary, mirroring `streamRecipe`/
        // the single terminal `emit.usage(...)` contract every route shares.
        yield emit.usage({ tokens: usageTokens, usd: usageUsd, modelCalls });
        // Say the refusal out loud. The per-turn path emits these as warnings through the
        // reducer (`onTurnResult`); a run that ends here has no turn left to carry them, and
        // silence is how "your edit was refused" becomes "your edit was applied".
        for (const refusal of hostRefusals.slice(refusalsBefore)) {
          yield emit.warning(`Couldn’t apply “${refusal.intent}” — ${refusal.reason}`);
        }
        // A cancelled run still gets a receipt when it applied something. Stopping a run
        // does not un-apply its edits — run e30c1fe9 left 38 operations in the project and
        // said nothing about any of them, because this gate treated "cancelled" as "there
        // is nothing to report". The last word the editor got was a perceptual warning
        // about frames, over a timeline they had no summary of.
        // A FAILED run that applied something gets the receipt too. The edits are on the
        // timeline whether or not verification passed; withholding the list left the
        // editor with a bare "failed" over a project that had changed under them.
        if (reportedOps.length > 0) {
          yield emit.assistant(
            emit.assistantId,
            agentCompletionReport({
              ops: reportedOps,
              names: projectNames(working),
              steps: Math.max(effect.appliedTurns, 1),
              rejectedOpCount: effect.rejectedOpCount,
              rejectionReasons: effect.rejectionReasons,
              contentEvidence: sawContentEvidence,
              // What the run announced and never delivered, and what it never got working.
              // Both are free: the plan ledger and the settled tool cards already exist.
              planSteps: effect.planSteps,
              neverSucceeded: neverSucceededTools(toolAttempts),
              ...(effect.cancelled ? { cancelled: true } : {}),
              ...(effect.failed && !effect.cancelled ? { failed: true } : {}),
              ...(asksForFile ? { deliverableFileRequested: true } : {}),
              ...(asksToPreview ? { previewRequested: true } : {}),
              ...(asksToRemember ? { preferenceRequested: true } : {}),
            }),
          );
        }
        // No run-level reasoning settle here: each step settled its OWN reasoning node
        // (per-step ids), so there is no shared per-run node left spinning.
        yield emit.status(effect.cancelled ? 'cancelled' : effect.failed ? 'failed' : 'completed');
        deadline.dispose();
        finishEffects();
      },
    };

    /**
     * The deadline's landing pad.
     *
     * A model call or host tool that the deadline aborts does not RETURN a turn result — it
     * THROWS, out of `streamAssistant` and out of the handler, and the graph settles a
     * throw as an error card plus a terminal `failed`. That is how run `369e8c82` reported
     * `failed` with nine committed patches it never mentioned, and re-arming the clock
     * without catching here would have reproduced it 39 minutes earlier.
     *
     * So: catch, and only when the run's own clock is what stopped it (a real provider
     * failure, and the editor's Stop, both still settle exactly as before). The synthetic
     * result folds nothing — the interrupted turn applied nothing — and carries the flag
     * that routes it through the ordinary budget stop instead of the cancel path. Seeded at
     * `seqAtThrow()`, the seq the throwing handler had reached, so the run's event ids stay
     * continuous.
     */
    const handlers: ConductorHandlers = {
      ...stepHandlers,
      runTurn: async function* (effect, state) {
        try {
          return yield* stepHandlers.runTurn(effect, state);
        } catch (error) {
          if (!deadlineStopped()) throw error;
          return turnBase(effect.stepIndex, seqAtThrow(), { deadlineExpired: true });
        }
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
    // other throw surfaces an error card and settles `failed`. Partial work is
    // already represented by the per-turn diffs emitted before the throw (ADR 0056) —
    // no trailing combined diff. Seeded at `seqAtThrow()` so ids continue the sequence.
    //
    // Whether the card offers a retry comes from the error itself when it knows.
    // `ProviderError.retryable` is derived once at classification time so that
    // "downstream code never re-guesses it" — and this was downstream code
    // re-guessing it, hardcoding `true` for everything. A captured run ended on
    // `openrouter API error 403: Key limit exceeded (total limit)` — a quota wall
    // classified `auth`, permanent by construction — and was still presented as
    // retryable, inviting the editor to re-run a request that could not succeed
    // until they changed something outside the app. An unrecognised throw keeps the
    // optimistic default: without a classification, offering the retry is kinder
    // than refusing one that might have worked.
    //
    // The headline itself comes from `plainRunFailure` (GOLDEN-F.5): the same
    // classification that decides retryability also decides which sentence the
    // editor reads, so the card never shows a raw wire message.
    // `function*` expressions do not inherit `this`, so the provider name is captured here.
    const providerName = this.provider.name;
    const settle = async function* (error: unknown): AsyncGenerator<AiEvent> {
      const emit = createTurnEmitter(options, seqAtThrow());
      const aborted = options.signal?.aborted ?? false;
      if (!aborted) {
        // The card the editor reads is a sentence naming the next action; the raw
        // provider text moves into `detail` so nothing is lost for a bug report.
        const plain = plainRunFailure(error, providerName);
        yield emit.error(plain.message, { detail: plain.detail, retryable: plain.retryable });
      }
      // C1: a run that threw mid-flight can still have spent real tokens (the classifier,
      // completed turns, a repair call) — settle honestly with whatever cost accrued
      // before the throw, same as `finalize`'s normal-exit emission.
      yield emit.usage({ tokens: usageTokens, usd: usageUsd, modelCalls });
      // Per-step reasoning nodes each settled themselves (streamAssistant's abort-safe
      // settle) — no shared per-run node to close here.
      yield emit.status(aborted ? 'cancelled' : 'failed');
      deadline.dispose();
      finishEffects();
    };

    return { command, handlers, settle, dispose: () => deadline.dispose() };
  }

  /**
   * The Conductor execution handlers for one agent run — the parity harness's seam
   * onto {@link agentRun}. {@link streamAgent} itself uses `agentRun` directly so it
   * also gets the run's {@link Command} and the throw-settling generator.
   *
   * `dispose` comes with them because a run compiled here arms the same wall-clock
   * deadline `streamAgent`'s does (that is the point of a parity seam — it must exercise
   * what the real path runs), and this seam has no `finally` of its own to clear it. The
   * caller owns the run, so the caller owns the timer: drive the handlers, then dispose.
   */
  public agentConductorHandlers(
    input: ContextInput,
    options: StreamOptions,
    agentOptions: AgentOptions = {},
    controls: AgentRunControls = {},
  ): { handlers: ConductorHandlers; dispose: () => void } {
    const { handlers, dispose } = this.agentRun(input, options, agentOptions, controls);
    return { handlers, dispose };
  }
}

/**
 * Re-settle the cards of the calls that proposed a rejected turn's operations as `failed`.
 *
 * A tool card is settled when its own call returns, which is necessarily BEFORE the turn
 * gate runs — the card is what makes a streaming run watchable, and deferring every card
 * until after the gate would leave the editor staring at nothing for the length of a turn.
 * The consequence is that a turn the gate rejects leaves behind a wall of green checkmarks
 * for work that never landed. In run `ea8e46ec` that was sixty-one "Added clip Video 1 ·
 * 0s–0.5s" rows, in the past tense, six times over, for a timeline that ended with no
 * picture on it at all.
 *
 * `reduceEvents` upserts tool cards by id, carrying the original start time and result
 * popup forward, so a second settle updates the card in place rather than adding a row.
 */
function* settleProposalCards(
  emit: ReturnType<typeof createTurnEmitter>,
  cards: readonly { readonly id: string; readonly name: string }[],
): Generator<AiEvent> {
  for (const card of cards) yield emit.toolCall(card.id, card.name, 'failed');
}

/**
 * The refusal for a call that names an asset this project does not hold.
 *
 * ONE function for two paths, because they used to disagree. A withheld call (stage rule,
 * recovery turn) is refused here in process; an ADMITTED call went to the host and came
 * back "Analysis failed (404): Asset 'X' not found" — a host failure, unkeyed by the rule
 * that host work is never keyed. Same invented id, keyed on one path and not the other, so
 * a run could be refused it forever on the admitted path. Asset existence is a pure
 * function of the project and the argument — the verdict the rule DOES allow to be keyed —
 * so it is decided before dispatch, identically, and remembered.
 *
 * Keyed on the ID, not the sentence: the sentence lists the bin, and the bin grows every
 * time the run downloads something, which is exactly what makes the same wrong id look like
 * a new wall (see `music-placement.ts#musicDuckRefusalKey` for the same trap, closed).
 */
function unknownAssetRefusal(
  callName: string,
  assetId: string,
  project: Project,
): AgentCallOutcome {
  const known = project.assets.map((asset) => asset.id);
  const shown = known.slice(0, 12).join(', ');
  const more = known.length > 12 ? `, and ${String(known.length - 12)} more` : '';
  const note =
    `No asset "${assetId}" is in this project. Known asset ids: ${shown}${more}. ` +
    'A search_stock / search_music result is a catalogue entry, not an asset, until ' +
    'add_stock / add_music downloads it — do that first, then use the asset id it returns.';
  return {
    ops: [],
    note,
    summary: `Refused "${callName}" — no asset "${assetId}" in this project`,
    status: 'failed',
    data: note,
    deterministicFailure: true,
    failureKeyText: `unknown_asset:${assetId}`,
  };
}

/**
 * The outcome for a call this turn does not offer.
 *
 * Two different things used to share one sentence, and the wrong one was said far more
 * often. A recovery turn withholds the READING tools because the run has gathered
 * enough — so a read it refuses really is redundant, and saying so is useful. But the
 * same branch also caught calls the run had never made: in run e30c1fe9 the single
 * `add_stock` — a valid remoteId the run had found itself, for a file that had never
 * been downloaded — came back as "Skipped redundant add_stock call", and the model,
 * told the result was already in hand, moved on and built a reel with no footage.
 *
 * So the reason is derived from the run's own memo rather than assumed: if the result is
 * genuinely stored, name the handle that returns it; if it is not, say plainly that the
 * tool is unavailable on this turn and what the turn is for. A refusal a run can act on
 * beats a checkmark it cannot — and a false refusal is worse than either.
 */
function withheldCallOutcome(
  call: ToolCall,
  evidence: EvidenceStore,
  /**
   * Banked catalogue searches, when this refusal is the commit-only latch (02) rather than
   * the recovery turn. Given, the refusal names the specific reason and the specific way
   * out instead of the generic one — a run refused with no legal move named is how ADR 0143
   * stranded a run on an empty project.
   */
  bankedSearches?: number,
  /** The narrowing is the stage rule, not a one-turn latch — see `executeToolCalls`. */
  stageWithheld = false,
  /**
   * The working copy at the moment of refusal, so a call that names an asset the project
   * does not hold is refused for THAT reason rather than for the stage. Optional only so
   * the question route, which never withholds by stage, can keep passing nothing.
   */
  project?: Project,
): AgentCallOutcome {
  // A name the registry has never heard of is not "withheld this turn" — it is not a tool.
  //
  // Every branch below explains a REAL tool that this turn is not offering, and each ends
  // by telling the model to try again later or reach for the stored answer instead. Told
  // that about a hallucinated name, a model does exactly what it is told: it waits a turn
  // and calls the same non-existent tool again. Worse, the outcome settled as `warning`,
  // which `callAnswered` reads as "this call answered" — so inventing a tool CREDITED the
  // turn with having learned something, resetting the guards that exist to stop it.
  //
  // The one honest thing to say is that the name is wrong, and to say it as a failure.
  // `runAgentCall` answers this way on the serial path too, in the SAME words —
  // `unknownToolNote` — because it is the same verdict for the path that never reaches it.
  if (!getTool(call.name)) {
    const note = unknownToolNote(call.name);
    // `data` + the flag, or `deterministicFailureKey` banks nothing and the sentence above
    // is all this branch achieves — the model waits a turn and calls the same invented name
    // again, which is precisely the loop described in the comment at the top of this branch.
    return {
      ops: [],
      note,
      summary: `Refused unknown tool "${call.name}"`,
      status: 'failed',
      data: note,
      deterministicFailure: true,
    };
  }
  // THE MOST SPECIFIC TRUE REASON WINS. The stage refusal below is generic by design —
  // "this turn is for acting on what has been gathered" — and it used to be reached before
  // the call's arguments were looked at. Run `137d8fd0`, turn 7: fresh from `search_stock`,
  // the model called `describe_footage` on five `stock_pexels_<id>` asset ids it had
  // CONSTRUCTED from catalogue results not yet downloaded (the first `add_stock` came at
  // turn 17). The true answer was "no such asset — add it first". It was told "unavailable
  // this turn" five times, never learned its ids were invented, and described no stock
  // footage at all in a 153-step run. A refusal that hides the fixable cause behind a
  // generic one costs exactly what a missing refusal does.
  const namedAsset = (call.arguments as { assetId?: unknown } | undefined)?.assetId;
  if (
    project &&
    typeof namedAsset === 'string' &&
    namedAsset.trim() !== '' &&
    !project.assets.some((asset) => asset.id === namedAsset)
  ) {
    return unknownAssetRefusal(call.name, namedAsset, project);
  }
  if (bankedSearches !== undefined && isCatalogueSearch(call.name)) {
    return {
      ops: [],
      note: catalogueSearchRefusal(bankedSearches),
      summary: `${call.name} withheld — place what this run already found`,
      status: 'warning',
      withheld: true,
    };
  }
  const stored = evidence.lookup(callMemoKey(call));
  if (stored) {
    return {
      ops: [],
      note:
        `Refused redundant "${call.name}" — its result is already in this run as ` +
        `${stored.id}. Recall that handle, or make the edit it supports.`,
      summary: `Skipped redundant ${call.name} call`,
      status: 'failed',
    };
  }
  // WHICH kind of withholding this is decides the last sentence, and getting it wrong is
  // not cosmetic. A recovery-turn latch really does lift next turn. The stage rule does
  // not: an analysis tool withheld in `apply` stays withheld until the run reaches
  // `verify`. Run `137d8fd0` was told "available again on the next turn" about a
  // stage-withheld `measure_color`, did exactly as told — waited a turn, called again —
  // and was refused identically. A refusal has to name the real way out.
  const wayOut = stageWithheld
    ? `It stays held for the rest of this stage. If the run already measured this, ` +
      `recall_evidence returns it; if it has not, finish the edit and check it in verify.`
    : 'It becomes available again on the next turn.';
  return {
    ops: [],
    note:
      `"${call.name}" is not available on this turn. This turn is for acting on what ` +
      'the run has already gathered: make the edit, recall_evidence for a detail you ' +
      `need, or ask_user. ${wayOut}`,
    // The MODEL gets the paragraph above; the editor gets this row, and "unavailable this
    // turn" told them nothing about why or for how long. Run `137d8fd0` showed five of
    // them in a stack with no reason attached to any.
    summary: stageWithheld
      ? `${call.name} held back for this stage — this stage is for acting on what has been gathered`
      : `${call.name} held back — this turn is for acting on what has been gathered`,
    status: 'warning',
    withheld: true,
  };
}

/**
 * The outcome for a HOST-BACKED tool whose built operations the validator refused.
 *
 * Five branches ran this probe after a host returned a usable payload — `transcribe`,
 * `remove_silences`, `add_music`, `add_stock` and `track_subject_automatically` — and not
 * one of them set {@link AgentCallOutcome.deterministicFailure}, while the generic mutate
 * path's byte-identical branch always has. So the same rejection could be re-earned every
 * turn for the length of the run, which is run `369e8c82`'s loop with a host in front of
 * it. The probe itself is as deterministic as the generic one: `assembleEdit` reads only
 * the working copy and the operations, so the same operations against the same project are
 * refused the same way every time.
 *
 * THE COLLISION HAZARD, resolved rather than skipped. These operations are built from a
 * DOWNLOADED payload, so two different assets can produce one validator sentence and share
 * one key — and refusing a second asset because a first one failed is the mistake ADR 0166
 * is the standing lesson about. It cannot happen here. The key is computed only once a
 * call has SETTLED, and only a `failed` outcome ever yields one, so the second asset is
 * fetched and validated in full and a payload that VALIDATES lands with no key to match
 * against. The most a collision can do is replace the prose of a call that had already
 * failed — with the sentence of a call that failed for the identical stated reason, since
 * the validator names the clip ids, track ids and times it objected to and `failureCause`
 * strips only the operation locator. The remedy transfers because it is the same remedy.
 *
 * `rejectedOpCount` IS the trace, and without it the run lied about itself. These five
 * return `ops: []` with the operations they lost carried nowhere, so the turn reported zero
 * operations, `lostOpsPerCall` saw nothing, no `failed` ledger row was written, and a run
 * that lost everything to one of them closed with "this run reviewed the footage but never
 * made a change" — true of the timeline, false about the run, and the class of dishonest
 * report goal.md's release gate names outright. It is the same defect `b7f1fd3` closed for
 * the declared host refusal, and the same route out: the count reaches the conductor's
 * `lostOpsPerCall`, which files the turn as a `failed` operation whose `failureReason` is
 * this note — so the validator's sentence reaches the state briefing's "FAILED — fix the
 * cause" section and the closing empty-/partial-run notice, instead of ageing out of the
 * context window with the tool result the way run `369e8c82`'s remedy did.
 *
 * The count is the REAL one, not the refusal path's `1`. A refusal is reached before any
 * operation is built; these five have already built theirs and lose every one — three for a
 * music bed (`add_asset`, `add_layer`, `add_clip`, four with a duck), one `ripple_delete`
 * per silence cut, one per compiled tracking operation. `emptyRunMessage` and
 * `agentCompletionReport` both say "N proposed change(s)", so a hardcoded `1` in front of a
 * fifty-cut silence pass would be its own small dishonesty. The unit is the one the generic
 * mutate path's byte-identical branch already uses (`rejectedOpCount: ops.length`), so an
 * operation lost behind a host and one lost in process are counted the same way.
 *
 * The OPERATIONS are taken rather than a number so a call site cannot report a count that
 * does not belong to the list the probe actually refused.
 *
 * @param callName - The tool being refused — the note the model reads and the key's prefix.
 * @param issues - The probe's validation issues; only errors are quoted.
 * @param refusedOps - The operations the probe refused; their count is what the run lost.
 * @returns A failed outcome the run can remember for the rest of its life.
 */
function hostBackedValidatorRejection(
  callName: string,
  issues: readonly ValidationIssue[],
  refusedOps: readonly AnyOperation[],
): AgentCallOutcome {
  const problems = issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message)
    .join('; ');
  const note = `Rejected "${callName}" — ${problems}`;
  return {
    ops: [],
    note,
    summary: note,
    status: 'failed',
    data: problems,
    deterministicFailure: true,
    rejectedOpCount: refusedOps.length,
  };
}

/**
 * The run-memory key for a refusal the run can PROVE will repeat, or `undefined`.
 *
 * `name:error`, because the error is the identity and the arguments are not. In run
 * `7d159862` `caption_the_edit` was refused four times with the byte-identical sentence
 * `add_caption_layer.end must be greater than start.`; three of those attempts shared one
 * set of arguments and the fourth varied both `preset` and `maxWordsPerCue`. An args-keyed
 * guard would have let that one through — and it was the third of the four, so the loop
 * would have run on regardless.
 *
 * Only a {@link AgentCallOutcome.deterministicFailure} yields a key: a host or transport
 * failure is transient by nature, and a permanent block on one would refuse work that the
 * next attempt would have completed. A host outcome earns the flag in exactly one way —
 * by DECLARING a {@link HostToolOutcome.refusalCause}, which asserts a policy verdict read
 * off the project rather than work that failed. Nothing else about a host outcome, however
 * byte-identical it repeats, is ever keyed.
 */
function deterministicFailureKey(
  callName: string,
  outcome: Pick<
    AgentCallOutcome,
    'status' | 'data' | 'deterministicFailure' | 'refusalCause' | 'failureKeyText'
  >,
): string | undefined {
  if (outcome.status !== 'failed' || outcome.deterministicFailure !== true) return undefined;
  // The error text is the key's whole discriminating power; without it every failure of a
  // tool would collapse to one key and the guard would block the tool outright. Tested
  // before the cause branch as well, because a key promises the caller a sentence to
  // hand back (`repeatedFailureOutcome`), and a refusal always has one.
  if (typeof outcome.data !== 'string' || outcome.data.trim() === '') return undefined;
  // A POLICY refusal that named its rule is keyed on the RULE. Its sentence is written to
  // be acted on, so it carries the asset, the times and the conflicting clip — and in run
  // `369e8c82` that made four refusals of one rule into four keys. Nothing matched, and
  // the model, nudging 4.48–6s to 4.2–6s to 4.2–6.2s, spent fifteen minutes discovering
  // the same "no" three more times. Prose-stripping cannot rescue that the way it rescues
  // a validator locator: here the varying parts are the whole body of the sentence.
  if (outcome.refusalCause !== undefined) return `${callName}:${outcome.refusalCause}`;
  // An explicit key beats the sentence, for refusals whose remedy names things that move
  // with the project (see `AgentCallOutcome.failureKeyText`).
  if (typeof outcome.failureKeyText === 'string' && outcome.failureKeyText.trim() !== '') {
    return `${callName}:${outcome.failureKeyText}`;
  }
  return `${callName}:${failureCause(outcome.data)}`;
}

/**
 * The operation LOCATOR `describeValidationIssue` prefixes onto a rejection: which
 * operation of how many, and what it was.
 *
 * Two shapes, because the locator drops the identity when the message already opens with
 * the operation type: `op 12 of 63: ` and `op 1 of 1 (trim_clip, 0s–8s): `.
 */
const OPERATION_LOCATOR = /(^|; )op \d+ of \d+(?: \([^)]*?\))?: /g;

/**
 * A rejection with its operation locator removed — WHY it was refused, without WHERE.
 *
 * The locator is the right thing to show the author and the wrong thing to key run memory
 * on. `caption_the_edit` proposes one operation per cue, so `maxWordsPerCue: 4` and
 * `maxWordsPerCue: 5` produce different cue counts and the identical defect is reported at
 * `op 12 of 63` and `op 9 of 48`. Keyed on the decorated string those read as two unrelated
 * failures — which is precisely the attempt this guard exists to catch, since in run
 * `7d159862` the third of four attempts was the one that varied its arguments.
 *
 * Nothing semantic is stripped. Every value the validator named — clip ids, track ids, the
 * offending times — lives in the message body and survives, so a different defect is still
 * a different key.
 */
function failureCause(error: string): string {
  return error.replace(OPERATION_LOCATOR, '$1');
}

/**
 * The outcome for a call the run has already been refused for the same CAUSE.
 *
 * It used to say "with exactly this error", and while the key was the error text that was
 * literally true. It no longer is: a policy refusal keys on its rule
 * ({@link deterministicFailureKey}), so run `369e8c82`'s second attempt — a different
 * asset at different times against a different clip — reaches here with a sentence the run
 * has never seen, matched to a rule it has.
 *
 * Settled as `failed`, NOT `warning` — the same trap `withheldCallOutcome`'s unknown-tool
 * branch documents. `callAnswered` treats a warning as an answer, so a warning here would
 * credit the turn with progress and bank the call's novelty key, which is to say the guard
 * against spinning would reset the guards against spinning.
 *
 * The REMEDY has to survive, and that is the whole reason `error` is quoted in full rather
 * than summarized. This note REPLACES the refusal the model would otherwise have read, and
 * the picture-over-picture sentence is where "split at the in/out and place it on the same
 * track" lives. Dropping it would turn a helpful refusal into a dead end — worse than the
 * loop it is closing.
 */
function repeatedFailureOutcome(call: ToolCall, error: string): AgentCallOutcome {
  const note =
    `"${call.name}" already failed this run for this same reason: ${error} ` +
    'The arguments changed and the answer did not, so nudging them again will not help. ' +
    'Do what that reason names instead, use a different tool, or move on to the next ' +
    'part of the request.';
  return {
    ops: [],
    note,
    summary: `Refused repeat of "${call.name}" — it already failed this run`,
    status: 'failed',
    // The ORIGINAL error, not the wrapper prose. This outcome carries no `refusalCause`,
    // so a policy repeat banks its own text key beside the rule key that caught it —
    // harmless bookkeeping, since the rule key is what every further attempt matches on.
    data: error,
    deterministicFailure: true,
  };
}

/** How many "Not done" lines the report prints before collapsing the rest into a count. */
const NOT_DONE_MAX_LINES = 6;

/**
 * How much of a failure reason survives into the report. The reason is a tool result
 * written for the MODEL — a paragraph, sometimes — and this block is a list, not the
 * error card. Enough to recognise the wall; not enough to bury the other five lines.
 */
const NOT_DONE_REASON_MAX_CHARS = 160;

/** One-line failure reason: first sentence's worth, ellipsised, never a paragraph. */
function trimFailureReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim();
  if (flat.length <= NOT_DONE_REASON_MAX_CHARS) return flat;
  return `${flat.slice(0, NOT_DONE_REASON_MAX_CHARS).trimEnd()}…`;
}

/**
 * What the run set out to do and did not do (GOLDEN-C.19).
 *
 * WHY: the report's other blocks only account for work that reached the validator. Run
 * `137d8fd0` applied 416 edits against a seven-part brief and closed without a word about
 * the two parts that never landed at all — captioning, refused eleven times, and
 * `professional_audio`, which failed all ten times it was called. "Applied 416 edits" is
 * true and, on its own, misleading.
 *
 * Empty when there is nothing to say, so an ordinary clean run is unchanged.
 */
function notDoneBlock(
  planSteps: readonly PlanStep[],
  neverSucceeded: readonly NeverSucceededTool[],
): string {
  const lines: string[] = [];
  for (const step of planSteps) {
    if (step.status === 'completed') continue;
    lines.push(`- ${step.label} — ${step.status}`);
  }
  for (const { tool, reason } of neverSucceeded) {
    const label = describeToolCall({ name: tool, arguments: {} });
    const why = reason === '' ? '' : `: ${trimFailureReason(reason)}`;
    lines.push(`- ${label} — never succeeded${why}`);
  }
  if (lines.length === 0) return '';
  const shown = lines.slice(0, NOT_DONE_MAX_LINES);
  const more = lines.length - NOT_DONE_MAX_LINES;
  if (more > 0) shown.push(`- …and ${more} more`);
  return `\n\n**Not done:**\n${shown.join('\n')}`;
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
   * True when the request asked for a rendered/exported file. The panel cannot produce one, so
   * the report says where to get it instead of leaving the editor to notice the absence.
   */
  deliverableFileRequested?: boolean;
  /**
   * True when the request asked to be shown a preview before rendering. `render_preview`
   * has no route from the panel, so the report says where the preview actually is.
   */
  previewRequested?: boolean;
  /**
   * True when the request stated a preference to remember for future edits. Checked against
   * the applied ops: a run that never wrote memory is told so, in the report, instead of the
   * instruction vanishing (run `cc907070` never called `remember_preference`).
   */
  preferenceRequested?: boolean;
  /**
   * True when the editor stopped the run. The edits still landed and still need
   * accounting for; only the claim that the work is finished changes.
   */
  cancelled?: boolean;
  /**
   * True when the run settled `failed` after applying these edits (verification did not
   * pass). The list is the same receipt; the head stops claiming the work is done.
   */
  failed?: boolean;
  /**
   * The run's drafted plan as it finished. Every step that is not `completed` is a thing
   * the run announced and did not deliver (GOLDEN-C.19). Empty/absent for a run that
   * drafted no plan — see `FinalizeEffect.planSteps` for why an unplanned run's derived
   * steps are NOT this.
   */
  planSteps?: readonly PlanStep[];
  /** Tools the run called, failed, and never got an answer out of. See `neverSucceededTools`. */
  neverSucceeded?: readonly NeverSucceededTool[];
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
  const applied = `**Applied ${args.ops.length} edit${args.ops.length === 1 ? '' : 's'}** in ${args.steps} step${args.steps === 1 ? '' : 's'}`;
  const head = args.cancelled
    ? `${applied} before you stopped the run — they are on your timeline and can be undone.`
    : args.failed
      ? `${applied}, but the run did not finish cleanly — see the error above. They are on your timeline and can be undone.`
      : `${applied} — review the proposed change below.`;
  const skipped =
    args.rejectedOpCount > 0
      ? `\n\n**Skipped:** ${args.rejectedOpCount} proposed change${args.rejectedOpCount === 1 ? '' : 's'} did not validate (${args.rejectionReasons.join('; ')}).`
      : '';
  // After "Skipped" (work that was attempted and refused) and before the caveats: what was
  // never delivered at all. A cancelled run keeps it — that is the run that needs it most.
  const notDone = notDoneBlock(args.planSteps ?? [], args.neverSucceeded ?? []);
  // An honest receipt for a montage chosen blind. The captured run picked nine spans out of
  // 575 seconds having read nothing about the content, and told the editor the choices came
  // from a footage map it never asked for. The edit still stands — the editor may well have
  // wanted exactly this — but they should know what it was based on.
  const placedShots = args.ops.filter((op) => op.type === 'add_clip').length;
  const unevidenced =
    args.contentEvidence === false && placedShots >= UNEVIDENCED_SHOT_CAVEAT_THRESHOLD
      ? `\n\nHeads up: these ${String(placedShots)} shots were chosen from timings alone — nothing was read about what is actually in the footage. Ask for a footage map, or for specific moments, if you want the selection grounded in content.`
      : '';
  // The deliverable the panel cannot make. Run 2's brief closed with "One final rendered 30s
  // vertical MP4"; the run never attempted it, never mentioned it, and reported completed.
  const deliverable =
    args.deliverableFileRequested === true
      ? '\n\nThis asks for a rendered file, which the AI panel cannot produce — the edits are ' +
        'on your timeline; use the Export dialog to render them out.'
      : '';
  // The preview the brief asked to see. Run `cc907070` asked for one before the render,
  // the one `render_preview` call was withheld, and the report never mentioned it.
  const preview =
    args.previewRequested === true
      ? '\n\nThis also asks to see a preview first. The panel cannot render one — the ' +
        'timeline monitor plays the current cut, and the Export dialog renders it.'
      : '';
  // "Remember this for future edits" is an instruction the run can drop without anyone
  // noticing; the memory write is an ordinary op, so its absence is checkable here.
  const remembered = args.ops.some((op) => op.type === 'set_ai_memory');
  const memory =
    args.preferenceRequested === true && !remembered
      ? '\n\nYou asked for something to be remembered for future edits, and nothing was saved ' +
        'to project memory this run. Tell the AI the preference again on its own, or set it ' +
        'in the AI settings.'
      : '';
  return `${head}\n\n${lines.join('\n')}${skipped}${notDone}${unevidenced}${deliverable}${preview}${memory}`;
}

/** Render a {@link CritiqueReport} as a compact human-readable block. */
function formatReport(report: CritiqueReport): string {
  const lines = report.checks.map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`);
  return [report.summary, ...lines].join('\n');
}
