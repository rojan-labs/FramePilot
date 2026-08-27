/**
 * @framepilot/ai-sdk/kernel/conductor — the control plane (Phase K1.1 / K1.2)
 * (plan/AI-ORCHESTRATION-REDESIGN.md §7).
 *
 * The Conductor is the kernel's ring 0: a **pure, deterministic reducer** that owns
 * the run state machine and decides *what happens next*, expressing every side
 * effect as an inert {@link ConductorEffect} description (tenet 1 & 5). It never
 * performs I/O — it does not call the model, run tools, or touch the project doc.
 * A driver interprets its effects via injectable handlers, distils the outcome into
 * a {@link ConductorResult}, and folds it back in with {@link onEffectResult}.
 * Because both entry points are pure `(state, x) → step`, the entire orchestration is
 * table-testable with no mocks, no fake timers, and is replayable from recorded
 * results (§18).
 *
 * ## K1.2 scope — full event-stream parity with `Orchestrator.streamAgent`
 * This reproduces streamAgent's agent loop *and its exact event stream*: the
 * per-turn assistant segments + tool cards (streamed by the handlers), the live plan
 * ledger, the resume checkpoint, the self-check/repair notices, and the terminal
 * diff + completion report. The reducer OWNS the plan-ledger state (design §1): a
 * turn's `run_turn` handler flips the current step to `running` (the only place the
 * derived intent exists), and the reducer emits every TERMINAL plan event
 * (completed / failed / stopped-by-user / cap-exceeded) plus the per-op
 * `timeline_action` cards on the fold, because those are its decisions.
 *
 * ## Event-id parity (the split-emitter seq contract)
 * streamAgent stamps every one-off event id from ONE monotonic sequence. The
 * Conductor splits emission between the reducer (structural events) and the handlers
 * (fine events: deltas, tool results, actions, diff), so both must advance the SAME
 * counter. The reducer threads `seq` in {@link ConductorState}; the driver seeds each
 * handler's {@link createTurnEmitter} at `state.seq`, the handler returns the advanced
 * `endSeq` on its result, and {@link onEffectResult} seeds its emitter at
 * `result.endSeq` — so ids stay byte-identical across the control/execution boundary.
 *
 * Execution mechanics stay OUT of the reducer, in effects the handlers interpret:
 * drafting the up-front plan ({@link DraftPlanEffect}), replaying a resume checkpoint
 * ({@link ResumeEffect}), streaming one turn ({@link RunTurnEffect}), the Critic
 * self-check + one repair pass ({@link RunVerifyEffect}), and the terminal diff +
 * report + status ({@link FinalizeEffect}).
 */
import type { AnyOperation } from '@framepilot/editor-core';
import {
  type AiEvent,
  type PlanStep,
  type Reference,
  type ToolStatus,
  type TurnRef,
  createTurnEmitter,
} from '../events.js';
import { acceptanceCriteria, checkableAcceptance, hasCheckableAcceptance } from '../acceptance.js';
import { explicitDurationTargetSeconds } from '../critic.js';
import type { Command } from './commands.js';
import { deriveObjectiveText } from './continuation.js';
import type { Distillation } from './briefing.js';
import { type ToolRole, settledStageFor } from './stage-policy.js';
import {
  MAX_NO_PROGRESS_TURNS,
  SEMANTIC_LOOP_TURNS,
  type TurnIntent,
  isSemanticLoop,
  madeMeaningfulProgress,
  normalizeIntent,
  recoveryAction,
} from './loop-detector.js';
import {
  RUN_STAGES,
  type RunStage,
  type RunWorkingState,
  advanceStage,
  addDiagnostic,
  commitExecutionPlan,
  carryForwardWorkingState,
  initialWorkingState,
  onProjectRevisionChanged,
  parseWorkingState,
  recordEvidence,
  recordFact,
  recordHostRefusal,
  recordOperation,
  recordVerification,
  setObjective,
  setExecutionAuthorization,
  setNextAction,
} from './working-state.js';
import type { HostPatchRefusal } from './commit-ledger.js';
import { assessEditCompletion } from '../completion-gate.js';

// Hard resource rails — blast-radius and cost bounds, NOT behavioral tuning. They exist
// so a runaway or malfunctioning run hits a ceiling; they are deliberately generous
// because *normal* termination is decided by convergence (the model finishing, or the
// run detecting it can no longer make progress — see {@link STALL_CONFIRM_TURNS}), never
// by burning down a step budget. A movie/documentary-length plan can legitimately run
// 20+ turns, so these are sized well above any real plan and left alone.
//
// Generous only works when a behavioral rail actually fires first. It did not: a run that
// researched novel-looking information every turn tripped neither the stall guard nor the
// diminishing-returns guard, so this 300 was the ONLY thing bounding it and the run burned
// through turns applying nothing. {@link RESEARCH_BUDGET_TURNS} is now that behavioral
// rail, which is what lets this stay a true last-resort ceiling. NOTE the legacy
// `streamAgent` loop in `orchestrator.ts` keeps its own, much smaller default (30); the
// two are independent by design — that path has no research budget to protect it.
const DEFAULT_MAX_AGENT_STEPS = 300;
const DEFAULT_MAX_OPS_PER_TURN = 200;
const DEFAULT_MAX_OPS_PER_RUN = 800;
/** How many distinct validator-rejection reasons to retain for the empty-run notice. */
const MAX_REJECTION_REASONS = 3;

/**
 * The plan-approval blast-radius threshold (P11.3, plan/AGENT-NATIVE-COMPLETION-PLAN.md).
 *
 * At draft-plan time the ONLY size signal available is the drafted plan's step count —
 * the actual ops/tracks/clips a plan will touch aren't known until turns execute (there
 * is no earlier metric anywhere in the kernel to reuse). A plan with MORE than this many
 * steps is "high blast radius" and gets gated when `requirePlanApproval` is set: it is
 * meaningfully more likely to do something big or wrong before the creator sees anything,
 * while 1–3 steps (the common "trim this", "add captions", "tighten the intro" asks)
 * stays frictionless. Sized against a typical run's real step count (not the 300-step
 * resource ceiling, which no healthy run approaches), so gating catches genuinely large
 * plans rather than firing at the edges.
 * A multi-scene movie/documentary plan routinely drafts more than 3 steps; that alone
 * is not "high blast radius" (it's just long-form), which is why this is sized off the
 * step budget rather than pinned to the old short-form-only default. Kept below 12 —
 * the drafter's own hard cap on parsed plan steps (`parsePlanLines`'s default `max` in
 * `orchestrator.ts`) — so an actually-maximal plan can still cross the gate; setting it
 * AT 12 would make the gate unreachable (no plan can ever have more than 12 steps).
 */
export const PLAN_APPROVAL_STEP_THRESHOLD = 10;

/**
 * Turns granted beyond a drafted plan's step count (W3.4). A plan step does not always
 * land in exactly one turn — a rejected op costs a turn to correct, and the run still
 * needs a turn to say it is done. Raised from 2 to 4 alongside the wider step budget:
 * a long-form plan's steps are individually heavier (a scene edit vs. "add captions"),
 * so each one is more likely to need a correction turn.
 */
export const PLAN_STEP_HEADROOM = 4;

/**
 * How many *consecutive* turns that make no progress confirm the run has **converged** —
 * i.e. the model can no longer move the edit forward and the run should stop honestly.
 *
 * This replaced (2026-07-15) a whole apparatus of behavioral guesswork — a recon-vs-spin
 * dual budget, a productive/unproductive streak split, an escalating prompt "nudge", and
 * a stack of interacting magic constants — that tried to infer the model's intent from
 * the outside and force it to edit. That system did not scale and had an off-by-one that
 * killed real runs one turn before its own forcing function could fire.
 *
 * The model decides *when* it is ready to edit (that is its job, not the harness's). The
 * harness only answers one deterministic question: is the run still making progress? A
 * turn makes progress if it applied an edit, attempted one (rejected ops are a bounded
 * retry), or LEARNED something new (a first-seen tool result — see {@link turnMadeProgress}).
 * A turn that did none of those learned nothing and changed nothing; repeating it can only
 * produce the same nothing. One such turn can be a momentary re-read, so we require two in
 * a row before declaring convergence — deliberately small, because redundant reads are now
 * served from the run memo as non-novel (the driver marks them `fromCache`), so a genuine
 * stall surfaces immediately rather than being masked by re-execution.
 *
 * This is a *convergence-confirmation count*, not a tuning knob: it does not cap how long
 * a productive run may go (that is bounded only by the resource rails and the model itself),
 * it only says how many turns of provable non-progress prove the run is stuck.
 */
export const STALL_CONFIRM_TURNS = 4;

/**
 * The research budget (R1): consecutive information-gathering turns a run may spend
 * before the next turn is FORCED to act.
 *
 * The stall guard proves a run is stuck and the diminishing-returns guard proves it has
 * converged. Neither catches the failure this exists for: a run whose every turn is
 * genuinely novel, genuinely expensive, and genuinely useless — reading a new transcript
 * window, re-mapping the footage, re-proposing edits from slightly grown inputs — while
 * the project never changes. Each such turn "learns something new" (stall streak resets)
 * and emits pages of reasoning (diminishing-returns streak resets), so nothing stops it
 * short of the step cap. A real run reported six such turns before giving up having
 * applied nothing.
 *
 * The fix is a budget, not another detector: past this many consecutive no-edit-attempt
 * turns, the run has enough to act on by construction, so it acts. Sized generously —
 * orienting, reading a transcript, mapping footage, analysing silence and loading two or
 * three skills all fit inside it — because the cost of cutting a legitimately thorough
 * run short is worse than one extra turn of reconnaissance. Attempting an edit resets it,
 * so a long multi-step edit renews its budget between every applied step and is never
 * squeezed by this.
 */
export const RESEARCH_BUDGET_TURNS = 8;

/**
 * Has the run spent its research budget — i.e. must the next turn act? Pure; folded from
 * the streak the reducer already maintains.
 */
export function researchBudgetSpent(researchStreak: number, budget: number): boolean {
  return researchStreak >= budget;
}

/**
 * Diminishing-returns stop (E4, plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md) — the
 * token-delta complement to {@link STALL_CONFIRM_TURNS}.
 *
 * The stall guard catches provable non-progress (repeats, memo hits, failures). What it
 * cannot catch is a run that keeps looking *novel* while producing next to nothing — a
 * model enumerating one tiny first-seen read after another without ever editing. Each
 * turn resets the stall streak (it "learned something new"), so only the resource rails
 * would end it. The reference loop's answer is measured by TOKEN DELTA, not call
 * novelty: {@link DIMINISHING_RETURNS_TURNS} consecutive turns each under
 * {@link DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS} output tokens **with zero applied
 * edits** mean the run has converged — honestly done, not spinning — and stops with a
 * distinct notice. An applied edit resets the streak; a turn whose provider reports no
 * usage never counts (no delta, no proof). Both are tunable via
 * `AgentOptions.diminishingReturns`.
 *
 * The default threshold is sized for tool-calling turns (a read call's JSON + a line of
 * text is typically well under 120 output tokens; any turn with real reasoning text or
 * an edit proposal exceeds it), so a genuine working turn never trips it.
 */
export const DIMINISHING_RETURNS_TURNS = 6;
export const DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS = 120;

/** The machine-inspectable `reason` tag on the diminishing-returns notification (E4.3). */
export const DIMINISHING_RETURNS_REASON = 'diminishing_returns';

/**
 * Did this turn learn something the run did not already have? True iff at least one call
 * was first-seen this run, settled successfully, and was not served from the run memo.
 *
 * All three conditions matter, and each rules out a real failure mode seen in the wild:
 * a first-seen call that FAILED taught nothing (for example, a failed analysis call
 * twice and got two 422s); a memo hit returns real data but no *new* data; and an
 * already-seen key is definitionally a repeat. Pure — it reads facts the driver
 * measured, never a result payload.
 */
export function turnLearnedSomethingNew(
  facts: readonly TurnCallFact[],
  seenCallKeys: readonly string[],
): boolean {
  const seen = new Set(seenCallKeys);
  return facts.some((f) => !seen.has(f.key) && callAnswered(f));
}

/**
 * Did this call return an answer the run did not have to work for again? True for a call
 * that settled successfully and was not served from the run memo. Shared by
 * {@link turnLearnedSomethingNew} (may this turn be credited?) and `mergeSeenKeys` (may
 * this key be banked?) so the two can never disagree about what counts as an answer.
 *
 * **A recall is exempt from the memo test, and only from that test.** `recall_evidence` is
 * `fromCache` BY CONSTRUCTION — serving stored data is the entire tool, not a sign that
 * the run asked twice. Reading that flag as redundancy meant a first-ever recall of a
 * handle, which puts material in front of the model that was not there a moment ago, was
 * scored as learning nothing.
 *
 * That is not a theoretical unfairness. The agent log keeps payloads for only the two
 * freshest entries (`AGENT_LOG_PAYLOAD_FRESH`), and a `remoteId` exists nowhere else — so
 * a run that searched a stock catalogue twenty-one times could see the ids of at most
 * eighty of its eight hundred candidates, and the harness's own instruction is to recall
 * rather than re-read. Run `09529490` did exactly that, said so out loud ("I'll recall the
 * search results to get remoteIds, then gather the best clips"), and was killed by
 * `STALL_CONFIRM_TURNS` for obeying the contract.
 *
 * The guard this exemption might be thought to weaken is untouched, because the novelty
 * KEY does that work instead: a recall keys on its `evidenceId`, so opening ev_1 then ev_2
 * then ev_3 is three genuinely different answers, while recalling ev_1 three times is
 * already seen after the first and still increments the stall streak. A run that recalls
 * the same thing forever remains provably stuck; a run working through its own material
 * no longer looks identical to one.
 */
function callAnswered(fact: TurnCallFact): boolean {
  if (fact.status !== 'completed' && fact.status !== 'warning') return false;
  return fact.role === 'recall' || !fact.fromCache;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The run state-machine phase the Conductor is in. */
export type RunPhase =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'resuming'
  | 'executing'
  | 'verifying'
  | 'review'
  | 'cancelled';

/** Run bounds resolved from the command's {@link AgentOptions} (with defaults). */
export interface ConductorConfig {
  readonly maxSteps: number;
  readonly maxOpsPerTurn: number;
  readonly maxOpsPerRun: number;
  /** Gate a high-blast-radius drafted plan for approval (P11.3) — see `AgentOptions.requirePlanApproval`. */
  readonly planApprovalGated: boolean;
  /** Consecutive low-delta, zero-edit turns that confirm convergence (E4). */
  readonly diminishingReturnsTurns: number;
  /** A turn under this many output tokens counts toward the low-delta streak (E4). */
  readonly diminishingReturnsMinOutputTokens: number;
}

/**
 * The whole run state — pure data, no live objects. `cumulativeOps` are the
 * validated operations applied to the working copy so far (the reviewable patch and
 * the resume checkpoint are built from them); everything else drives the decisions.
 */
export interface ConductorState {
  readonly phase: RunPhase;
  /** Identifies the conversation/turn every emitted event is stamped with. */
  readonly turnRef: TurnRef;
  /** The user's request (echoed into the checkpoint so Resume needs no lookup). */
  readonly goal: string;
  readonly config: ConductorConfig;
  /** 1-based index of the turn currently executing / just folded. */
  readonly stepIndex: number;
  readonly cumulativeOps: readonly AnyOperation[];
  /** Turns that produced applied edits (the completion report's step count). */
  readonly appliedTurns: number;
  /** Tool-call signatures already seen to make no progress (exact-repeat spin guard). */
  readonly noProgress: readonly string[];
  /**
   * How many turns in a row made no progress (reset to 0 by any turn that applied or
   * attempted an edit, or learned something new — see {@link turnMadeProgress}). The run
   * converges and stops once this reaches {@link STALL_CONFIRM_TURNS}. It is the stop for
   * a run that is provably STUCK; a run that is merely researching forever is caught by
   * {@link RESEARCH_BUDGET_TURNS} instead, which forces action rather than stopping.
   */
  readonly stallStreak: number;
  /**
   * Consecutive turns that gathered information without ATTEMPTING an edit (R1). Reset by
   * any turn that proposed operations — applied or rejected — because both prove the run
   * has left reconnaissance. Once it reaches {@link RESEARCH_BUDGET_TURNS} the run has
   * researched enough and the next turn is forced to act; see {@link researchBudgetSpent}.
   */
  readonly researchStreak: number;
  /**
   * The model ended the run itself (a turn with no tool calls), rather than a guard or a
   * resource rail cutting it short. Distinguishes a legitimate "nothing to do here" from
   * a run that was stopped mid-task — see the empty-run notice in `finalize` (R2).
   */
  readonly modelDeclaredDone?: boolean;
  /**
   * Some turn proposed operations at least once, whether or not any survived validation.
   * Distinct from `rejectedOpCount > 0`, which misses ops discarded before the rejection
   * tally (a turn rejected wholesale for exceeding the per-turn cap). Used to keep the
   * never-attempted notice honest: a run that tried and lost the work is not a run that
   * never tried, and only the latter should be told it never made a change (R2).
   */
  readonly attemptedAnyEdit?: boolean;
  /**
   * The next turn must act: the previous turn either consisted entirely of memo hits, or
   * spent the run's {@link RESEARCH_BUDGET_TURNS} research budget. Read and analysis tool
   * descriptors are withheld for that one turn, so continuing to research is structurally
   * impossible rather than merely discouraged.
   */
  readonly actionRecoveryPending?: boolean;
  /**
   * The last K per-turn output-token deltas from turns that applied nothing (E4.1),
   * bounded to `config.diminishingReturnsTurns`. An applied edit — or a turn whose
   * provider reported no usage — resets it to empty. Once it holds K entries all under
   * `config.diminishingReturnsMinOutputTokens`, the run has converged (E4.2).
   */
  readonly recentOutputDeltas: readonly number[];
  /**
   * Novelty keys of every call the run has already made (see {@link TurnCallFact}).
   * A call whose key is here taught the model nothing it did not already have.
   */
  readonly seenCallKeys: readonly string[];
  /** Count + reasons of proposed ops the validator rejected (empty-run notice). */
  readonly rejectedOpCount: number;
  readonly rejectionReasons: readonly string[];
  readonly cancelled: boolean;
  /** Integrity failure is terminal and distinct from creator cancellation. */
  readonly integrityFailed: boolean;
  /**
   * The action log the handlers build (byte-identical to streamAgent's), mirrored
   * here so the resume {@link CheckpointEvent} the reducer emits carries it.
   */
  readonly log: readonly string[];
  /** The live plan ledger the reducer owns (design §1). */
  readonly planSteps: readonly PlanStep[];
  /** How many ledger steps were seeded up front (0 when planFirst is off / resumed). */
  readonly ledgerLength: number;
  /**
   * The run's durable task memory (ADR 0075). Distinct from every other field here:
   * those describe the HARNESS's view of the run (how many turns, how stalled, which
   * ledger step), while this is the TASK's — what the run learned, decided, and did.
   * The harness fields are all resettable per turn; this one is the thing that must
   * survive every turn, every compaction, and every restart.
   */
  readonly working: RunWorkingState;
  /**
   * The normalized purpose of each recent turn (ADR 0075 §3.5), bounded to the detector's
   * window. Tracks what turns were FOR, which is the only thing that reveals a run saying
   * the same thing in four different sentences.
   */
  readonly recentIntents: readonly TurnIntent[];
  /**
   * Consecutive turns that produced no meaningful progress (ADR 0075 §3.5). Distinct from
   * {@link stallStreak}, which counts turns that made no progress in the looser sense that
   * includes "learned something new" — a run can keep learning genuinely novel things
   * forever without ever moving the task, which is exactly what happened.
   */
  readonly noProgressStreak: number;
  /**
   * Consecutive turns whose only claim to progress was novelty (02).
   *
   * Reset by any stronger signal — an attempted edit, a stage advance, a committed
   * decision — so a run doing real work never accumulates one.
   */
  readonly noveltyOnlyStreak: number;
  /** Monotonic per-run event sequence, threaded so ids never collide across folds. */
  readonly seq: number;
}

/** The idle starting state, before any command. */
export function initialConductorState(turnRef: TurnRef): ConductorState {
  return {
    phase: 'idle',
    turnRef,
    goal: '',
    config: {
      maxSteps: DEFAULT_MAX_AGENT_STEPS,
      maxOpsPerTurn: DEFAULT_MAX_OPS_PER_TURN,
      maxOpsPerRun: DEFAULT_MAX_OPS_PER_RUN,
      planApprovalGated: false,
      diminishingReturnsTurns: DIMINISHING_RETURNS_TURNS,
      diminishingReturnsMinOutputTokens: DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
    },
    stepIndex: 0,
    cumulativeOps: [],
    appliedTurns: 0,
    noProgress: [],
    stallStreak: 0,
    researchStreak: 0,
    recentOutputDeltas: [],
    seenCallKeys: [],
    rejectedOpCount: 0,
    rejectionReasons: [],
    working: initialWorkingState({ runId: turnRef.turnId, request: '' }),
    recentIntents: [],
    noProgressStreak: 0,
    noveltyOnlyStreak: 0,
    cancelled: false,
    integrityFailed: false,
    log: [],
    planSteps: [],
    ledgerLength: 0,
    seq: 0,
  };
}

// ---------------------------------------------------------------------------
// Effects (what the runtime must execute) and Results (what it reports back)
// ---------------------------------------------------------------------------

/** Draft the up-front numbered plan (planFirst): a read-only model call. */
export interface DraftPlanEffect {
  readonly kind: 'draft_plan';
}

/** Replay a resume checkpoint's ops onto the working copy (validate → apply). */
export interface ResumeEffect {
  readonly kind: 'resume';
}

/**
 * Pause the run and await the creator's approve/cancel decision on a high-blast-radius
 * drafted plan (P11.3). Carries the ledger snapshot so the handler can hand the plan's
 * human-readable labels to whatever live approval resolver the host wired.
 */
export interface AwaitApprovalEffect {
  readonly kind: 'await_approval';
  readonly planSteps: readonly PlanStep[];
}

/** Execute one agent turn against the working copy (model → tools → patch). */
export interface RunTurnEffect {
  readonly kind: 'run_turn';
  readonly stepIndex: number;
  /** The current ledger snapshot the handler flips a step of to `running`. */
  readonly planSteps: readonly PlanStep[];
  /** How many ledger steps were seeded up front (turns map onto them positionally). */
  readonly ledgerLength: number;
  /** Withhold read/analysis tools for one recovery turn after proven non-progress. */
  readonly actionRecovery?: boolean;
  /**
   * The task stage this turn runs in (ADR 0075 §3.6), so the handler can advertise a
   * stage-appropriate tool surface. Optional: a handler that ignores it behaves exactly
   * as before, which keeps the effect additive for the legacy loop and the fixtures.
   */
  readonly stage?: RunStage;
  /**
   * The run's task memory, so the handler can brief the model with it (ADR 0075 §3.3).
   * Passed on the effect rather than read from state by the handler, because the handler
   * is deliberately stateless — every input a turn depends on arrives here.
   */
  readonly working?: RunWorkingState;
}

/** Run the Critic self-check (+ one bounded repair pass) over the working copy. */
export interface RunVerifyEffect {
  readonly kind: 'run_verify';
}

/**
 * Assemble + emit the run's terminal artefacts: the reviewable combined diff, the
 * completion report, and the terminal reasoning + status events. Carries everything
 * the handler needs so the reducer stays decoupled from the project doc + editor-core.
 */
export interface FinalizeEffect {
  readonly kind: 'finalize';
  readonly ops: readonly AnyOperation[];
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly appliedTurns: number;
  readonly rejectedOpCount: number;
  readonly rejectionReasons: readonly string[];
}

/** The inert effect descriptions the Conductor emits for the runtime to interpret. */
export type ConductorEffect =
  | DraftPlanEffect
  | ResumeEffect
  | AwaitApprovalEffect
  | RunTurnEffect
  | RunVerifyEffect
  | FinalizeEffect;

/** A pre-described applied operation the reducer emits as a `timeline_action` card. */
export interface DescribedAction {
  readonly action: string;
  readonly detail: string;
  readonly refs?: readonly Reference[];
}

/** The distilled outcome of a {@link DraftPlanEffect}. */
export interface DraftPlanResult {
  readonly kind: 'draft_plan';
  /** The parsed plan-step labels (empty when the model drafted no usable plan). */
  readonly labels: readonly string[];
  readonly endSeq: number;
}

/** The distilled outcome of a {@link ResumeEffect}. */
export interface ResumeResult {
  readonly kind: 'resume';
  /** The prior ops still validate against the current project — the replay applied. */
  readonly ok: boolean;
  readonly ops: readonly AnyOperation[];
  readonly log: readonly string[];
  readonly stepsCompleted: number;
  readonly endSeq: number;
}

/** The distilled outcome of an {@link AwaitApprovalEffect}: the creator's decision. */
export interface ApprovalResult {
  readonly kind: 'approval';
  readonly decision: 'approved' | 'cancelled';
  readonly endSeq: number;
}

/**
 * What one tool call in a turn tells the reducer about progress.
 *
 * `key` is the call's **novelty key**, deliberately coarser than its raw arguments for
 * analysis tools (`name + assetId`, dropping the tuning args — see
 * `orchestrator.ts#callNoveltyKey`). That coarseness is the whole point: re-running
 * `detect_beats` on the same asset at sensitivity 1.5 → 3.5 → 2 collapses to ONE key, so
 * the arg-varying spin the old guard was built to catch is still caught — while
 * analysing a *different* asset stays genuinely novel.
 */
export interface TurnCallFact {
  readonly key: string;
  readonly status: ToolStatus;
  /** Served from the run's memo — real data, but no new information this turn. */
  readonly fromCache: boolean;
  /**
   * What this call means for the task stage (ADR 0075). Optional so every existing
   * fixture and both loops keep compiling; an absent role is stage-neutral, which
   * degrades stage derivation to "does not advance" rather than to a wrong guess.
   */
  readonly role?: ToolRole;
  /**
   * The distilled conclusion this call produced (ADR 0075 §3.4), ready to enter the
   * working state as a {@link Fact}. Distillation needs the payload, which only the
   * handler has, so the handler does it while the payload is FRESHEST — the moment the
   * old design threw the data away instead.
   *
   * Absent for calls that conclude nothing (a recall, a failure, a memo hit).
   */
  readonly distilled?: Distillation;
}

/**
 * The distilled outcome of executing one {@link RunTurnEffect}. The handler produces
 * this by streaming the model, running the turn's tool calls, and assembling +
 * validating the patch; the Conductor only reads these decision inputs and emits the
 * terminal plan/timeline events.
 */
export interface AgentTurnResult {
  readonly kind: 'agent_turn';
  readonly stepIndex: number;
  /** The run's signal aborted at the turn boundary / mid-stream (no plan event). */
  readonly aborted: boolean;
  /** The model made no tool calls — it considers the goal met. */
  readonly done: boolean;
  /** A host tool was cancelled mid-turn (⇒ a `failed` 'Stopped by user' plan + cancel). */
  readonly anyToolCancelled: boolean;
  /** A host tool genuinely failed (drives a real-work turn's plan-step status). */
  readonly anyToolFailed: boolean;
  /**
   * Calls this turn made that the HARNESS refused (02's commit-only latch, the recovery
   * turn's withheld surface) rather than the model wasting.
   *
   * A withheld call returns a `warning` outcome with no payload, so it banks no fact and no
   * novelty — which means a turn made entirely of refusals scores `learnedSomethingNew:
   * false`, increments `noProgressStreak`, and reaches `MAX_NO_PROGRESS_TURNS` in two
   * turns. Without this the gate that exists to save a stalling run would be the thing that
   * kills it. The run is not failing to progress; it is being told to do something else.
   */
  readonly withheldCallCount?: number;
  /** Operations the turn proposed, before validation (drives the per-turn cap). */
  readonly turnOpCount: number;
  /** Ops proposed by the turn's calls but refused by the per-call validator. */
  readonly rejectedOpCount: number;
  /** The per-call validator rejection notes (drive the empty-run notice). */
  readonly rejectionNotes: readonly string[];
  /** The validator accepted and applied this turn. */
  readonly applied: boolean;
  /**
   * The turn produced a valid edit that landed nothing because the timeline ALREADY
   * matched it — the same operations were applied earlier in this run.
   *
   * Distinct from `applied: false` alone, which otherwise means "rejected". A run that
   * recomputes an edit it already made has not failed at anything; there is no cause to
   * fix and nothing to retry. Recording it as a failure is what kept the captured caption
   * run re-attempting emphasis that was already on the timeline, twenty-four times.
   */
  readonly satisfied?: boolean;
  /** The patch this turn produced, so a later host refusal can correct its ledger row. */
  readonly patchId?: string;
  /**
   * Patches an earlier turn proposed that the HOST then refused to write
   * (`kernel/commit-ledger.ts`).
   *
   * Arrive a turn late by construction: the host rules on a diff after it is published, and
   * the graph's event queue is a fire-and-forget push, so the verdict is not available when
   * the turn that produced the patch ends. Folding them here is what stops the ledger
   * claiming `succeeded` for an edit the authoritative project never received — the state a
   * captured run was in when it reported a revision that did not exist.
   */
  readonly hostRefusals?: readonly HostPatchRefusal[];
  /** The validated operations that applied (empty when `applied` is false). */
  readonly appliedOps: readonly AnyOperation[];
  /** Pre-described applied ops for the reducer's `timeline_action` cards. */
  readonly describedActions: readonly DescribedAction[];
  /** Stable signature of the turn's tool calls, for the no-progress guard. */
  readonly signature: string;
  /**
   * One fact per tool call the turn ran, so the reducer can tell **reconnaissance from
   * spinning** without inspecting any result payload (which would be impure in spirit,
   * huge in state, and brittle).
   *
   * The driver already knows all three — it computed the novelty key, it saw the status,
   * and it knows whether the memo served the call — and used to throw them away before
   * the fold, leaving the reducer with only "did this turn edit?". That is why a run of
   * four genuinely productive setup turns looked identical to a model spinning.
   */
  readonly callFacts: readonly TurnCallFact[];
  /**
   * The turn's real model-call usage as the provider reported it (E4.1). Absent when
   * the provider reports none — such turns can never count toward the
   * diminishing-returns streak (no delta, no proof).
   */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  /** The turn record note (the model-facing log line for this turn — every call in it). */
  readonly note: string;
  /**
   * WHY the turn was rejected, with none of the turn's read output in it. Present only on a
   * rejection; this is what the editor is shown, so it must never carry a tool payload.
   */
  readonly rejection?: string;
  /**
   * The turn's own prose, for semantic-loop detection (ADR 0075 §3.5). Optional so the
   * legacy loop and existing fixtures keep compiling; without it a turn's intent reads as
   * `unknown`, which never contributes to a loop — silence is not evidence of repetition.
   */
  readonly rationale?: string;
  /** The ledger snapshot with this turn's step flipped to `running` (design §2). */
  readonly planSteps: readonly PlanStep[];
  /** Which ledger index this turn occupies (the reducer sets its terminal status). */
  readonly planStepIndex: number;
  /** The derived human intent used as the running step's detail (kept on success). */
  readonly intent: string;
  /** The action log after this turn (mirrored into state for the checkpoint). */
  readonly log: readonly string[];
  readonly endSeq: number;
}

/** The distilled outcome of a {@link RunVerifyEffect} (self-check + one repair pass). */
export interface VerifyResult {
  readonly kind: 'verify';
  readonly ok: boolean;
  readonly summary: string;
  readonly failedChecks: readonly { readonly label: string; readonly detail: string }[];
  /** Ops the bounded repair pass applied (folded into the run's combined diff). */
  readonly repairOps: readonly AnyOperation[];
  readonly endSeq: number;
}

/** What the runtime folds back into the Conductor. */
export type ConductorResult =
  | DraftPlanResult
  | ResumeResult
  | ApprovalResult
  | AgentTurnResult
  | VerifyResult;

/** One reducer step: the next state, the effects to run, and the events to stream. */
export interface ConductorStep {
  readonly state: ConductorState;
  readonly effects: readonly ConductorEffect[];
  readonly events: readonly AiEvent[];
}

/**
 * The pure id-stamper the decision functions emit through.
 *
 * Exported alongside the decision seam because a caller outside this module — a graph
 * node, a table test — must seed one at `state.seq` to call a decision at all.
 */
export type Emitter = ReturnType<typeof createTurnEmitter>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The honest empty-run explanation when a run attempted edits but landed none. */
function emptyRunMessage(rejectedOpCount: number, rejectionReasons: readonly string[]): string {
  const plural = rejectedOpCount === 1 ? '' : 's';
  return `No edits were applied — ${rejectedOpCount} proposed change${plural} couldn't be applied to the timeline (${rejectionReasons.join('; ')}). Try rephrasing the request.`;
}

/**
 * The empty-run notice for a run that never even proposed an operation (R2) — it read,
 * analysed and reasoned, but the timeline is untouched. Worded so the creator knows the
 * project did NOT change and what to do about it, without blaming them for the phrasing
 * (the common cause is the run over-researching, not a bad request).
 */
function noAttemptMessage(): string {
  return (
    'No edits were applied — this run reviewed the footage but never made a change, ' +
    'so your timeline is exactly as you left it. Try again, or ask for a smaller, more ' +
    'specific edit to start from.'
  );
}

/**
 * The notice for a run that ends `failed` with nothing applied and nothing else to show
 * for it — the outcome the host settles as "integrity or verification did not pass".
 */
function failedRunMessage(): string {
  return (
    'This run ended without applying anything — it could not verify that it had done ' +
    'what you asked, so your timeline is unchanged. Retry, or ask for a smaller, more ' +
    'specific edit.'
  );
}

/** Replace one ledger step immutably. */
function withStep(steps: readonly PlanStep[], index: number, next: PlanStep): readonly PlanStep[] {
  return steps.map((s, i) => (i === index ? next : s));
}

// ---------------------------------------------------------------------------
// Transitions shared by the fold paths
// ---------------------------------------------------------------------------

/** Emit the next `run_turn` effect carrying the current ledger snapshot. */
function runTurnEffect(state: ConductorState, stepIndex: number): RunTurnEffect {
  return {
    kind: 'run_turn',
    stepIndex,
    planSteps: state.planSteps,
    ledgerLength: state.ledgerLength,
    ...(state.actionRecoveryPending ? { actionRecovery: true } : {}),
    stage: state.working.stage,
    working: state.working,
  };
}

/** Stop the turn loop and run the verify phase. */
function toVerify(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  if (state.working.integrity.status === 'needs_review') {
    const detail =
      state.working.integrity.diagnostics.at(-1)?.message ?? 'Run integrity is incomplete.';
    return finalize({ ...state, integrityFailed: true }, em, [
      ...events,
      em.warning(`Run paused before verification: ${detail}`),
    ]);
  }
  return {
    state: { ...state, phase: 'verifying', seq: em.seq() },
    effects: [{ kind: 'run_verify' }],
    events,
  };
}

/**
 * Finalize the run: emit the resume checkpoint (cancelled runs with applied work),
 * the empty-run notice (a non-cancelled run that landed nothing after trying), then
 * hand off to the {@link FinalizeEffect} which emits the diff + report + terminal
 * reasoning/status. Shared by the cancel path and the post-verify path.
 */
function finalize(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  if (state.cancelled && state.cumulativeOps.length > 0) {
    events.push(
      em.checkpoint({
        goal: state.goal,
        ops: state.cumulativeOps as readonly unknown[],
        log: [...state.log],
        stepsCompleted: state.appliedTurns,
        // Carry the task memory across the interruption (ADR 0075). Replaying `ops`
        // restores the project; this restores the run — so a resumed run picks up at
        // the stage it reached instead of re-orienting from scratch.
        working: state.working,
      }),
    );
  }
  // A run that changed nothing must SAY so (R2). This used to fire only when the
  // validator had rejected something, which meant the worst case was also the quietest
  // one: a run that researched until its budget ran out and never attempted an edit has
  // no rejections, so it finalized with no warning at all and read as a normal,
  // successful run that happened to produce an empty diff. Attempting is not achieving,
  // and neither is analysing — both now report honestly.
  //
  // Rejections are reported however the run ended: work was attempted and provably lost,
  // which the creator needs to know even if the model then declared itself done. The
  // never-attempted notice is narrower — it fires only when a GUARD stopped the run
  // (stalled, converged, out of research budget, out of steps). A model that ended the
  // run itself has already said why in its own prose ("the silences were already trimmed
  // — nothing to do"), and contradicting that would be a false alarm on a legitimate
  // no-op.
  // An integrity failure (a pre-turn plan/resume rejection, or a needs_review pause)
  // already pushed its own specific, accurate warning onto `events` above — the generic
  // "reviewed the footage but never made a change" notice would be both redundant and
  // literally false in that case (no turn ever ran), so it is skipped whenever this fold
  // already explained itself.
  // The deterministic completion gate (`completion-gate.ts`), on the SHIPPING path.
  //
  // It was written to stop a run reporting a no-op, a cosmetic-only result, or incomplete
  // planned work as success — and then wired only into `autonomous-edit-runtime.ts`, which no
  // production code ever called. Its tests passed against fake adapters while agent mode, the
  // path that actually runs, used none of it: a green suite for a rail that was not installed.
  //
  // The no-op halves (`no_applied_edit`, `no_meaningful_change`) are covered below by the
  // empty-run notices, and duration by the Critic's `duration_target`. What nothing covered is
  // PLANNED WORK LEFT UNDONE: a run that drafted a checklist, ran three of seven steps and
  // finished reported "Applied N edits" with no mention of the four the editor was shown and
  // never got.
  //
  // Gated on `ledgerLength > 0` — the editor was actually shown a checklist. An unplanned run
  // keeps step rows internally for status tracking (see the `ledgerLength > 0` guard the plan
  // event uses) and made no promise to report against. Gated on ops too, because a run that
  // changed NOTHING gets the empty-run notice below, which is both truer and more actionable
  // than a step tally.
  if (!state.cancelled && state.ledgerLength > 0 && state.cumulativeOps.length > 0) {
    const assessment = assessEditCompletion(
      { intentKind: 'mutation', requireTimelineChange: false },
      {
        appliedOperationCount: state.cumulativeOps.length,
        plannedTaskCount: state.planSteps.length,
        completedTaskCount: state.planSteps.filter((step) => step.status === 'completed').length,
        failedTaskCount: state.planSteps.filter((step) => step.status === 'failed').length,
        rendered: false,
        renderVerified: false,
        visualEvidenceCount: 0,
      },
    );
    // Only the plan-completeness findings: the rest are either covered elsewhere on this path
    // or about a render this panel cannot run, and reporting those would be noise the editor
    // has no action for.
    const unfinished = assessment.failures.filter(
      (failure) => failure.code === 'planned_work_incomplete' || failure.code === 'task_failed',
    );
    if (unfinished.length > 0) {
      events.push(
        em.warning(
          `Not everything in the plan was done — ${unfinished.map((f) => f.message).join(' ')}`,
        ),
      );
    }
  }
  const alreadyExplained = events.some((e) => e.type === 'warning');
  if (!state.cancelled && state.cumulativeOps.length === 0) {
    if (state.rejectedOpCount > 0) {
      events.push(em.warning(emptyRunMessage(state.rejectedOpCount, state.rejectionReasons)));
    } else if (!alreadyExplained && !state.modelDeclaredDone && !state.attemptedAnyEdit) {
      events.push(em.warning(noAttemptMessage()));
    } else if (!alreadyExplained && state.integrityFailed) {
      // A terminal `failed` the creator can SEE. The exemption above trusts a model that
      // ended the run itself to have explained why in its own prose — but a run that also
      // failed verification cannot be left to that prose alone: the host settles it as
      // `failed` (which shows a bare Retry button and nothing else), so with no warning here
      // the only visible account of the run was the model's own "nothing more to do" —
      // contradicted, invisibly, by the actual outcome.
      events.push(em.warning(failedRunMessage()));
    }
  }
  return {
    state: { ...state, phase: state.cancelled ? 'cancelled' : 'review', seq: em.seq() },
    effects: [
      {
        kind: 'finalize',
        ops: [...state.cumulativeOps],
        cancelled: state.cancelled,
        failed: state.integrityFailed,
        appliedTurns: state.appliedTurns,
        rejectedOpCount: state.rejectedOpCount,
        rejectionReasons: [...state.rejectionReasons],
      },
    ],
    events,
  };
}

/** Cancel the run (user interruption) and finalize with a checkpoint. */
function cancelFinalize(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  return finalize({ ...state, cancelled: true }, em, events);
}

/** Continue to the next turn, or verify once the step cap is reached. */
function advance(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  if (state.stepIndex < state.config.maxSteps) {
    const stepIndex = state.stepIndex + 1;
    return {
      state: { ...state, stepIndex, seq: em.seq() },
      effects: [runTurnEffect(state, stepIndex)],
      events,
    };
  }
  return toVerify(state, em, events);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Start a run from a {@link Command}. K1.2 handles the agent `submit_turn`; other
 * modes stay on the K0 coarse gateway path (single-shot, not a multi-turn run), so
 * this returns an unchanged idle state with no effects for them.
 *
 * Opens the run with the header `thinking` spinner (per-step reasoning shimmers are
 * opened later, inside each `run_turn`), then emits the first pre-turn effect: `resume`
 * (replay a checkpoint), else `draft_plan` (planFirst), else the first `run_turn`.
 */
export function onCommand(state: ConductorState, command: Command): ConductorStep {
  if (command.mode !== 'agent') {
    return { state, effects: [], events: [] };
  }
  const ao = command.agentOptions ?? {};
  const config: ConductorConfig = {
    maxSteps: ao.maxSteps ?? DEFAULT_MAX_AGENT_STEPS,
    maxOpsPerTurn: ao.maxOpsPerTurn ?? DEFAULT_MAX_OPS_PER_TURN,
    maxOpsPerRun: ao.maxOpsPerRun ?? DEFAULT_MAX_OPS_PER_RUN,
    planApprovalGated: !!ao.requirePlanApproval,
    diminishingReturnsTurns: ao.diminishingReturns?.turns ?? DIMINISHING_RETURNS_TURNS,
    diminishingReturnsMinOutputTokens:
      ao.diminishingReturns?.minOutputTokens ?? DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
  };
  const em = createTurnEmitter(command.stream, 0);
  // Immediate feedback is the header `thinking` status; reasoning is now opened PER STEP
  // (each step's `run_turn` streams its own `${turnId}:reasoning:${index}` node), so there
  // is no shared per-run reasoning node to open here — that node was the one every later
  // step overwrote.
  const events: AiEvent[] = [em.status('thinking')];

  const resuming = !!(ao.resume && ao.resume.ops.length > 0);
  const planning = !resuming && !!ao.planFirst && !command.stream.signal?.aborted;
  const restored = resuming ? parseWorkingState(ao.resume?.working) : null;
  const created = initialWorkingState({
    runId: command.stream.runId ?? command.stream.turnId,
    request: command.input.userPrompt,
    conversationId: command.stream.conversationId,
    projectId: command.input.project.id,
    attemptId: command.stream.turnId,
    projectRevision: command.input.project.timeline.revision ?? 0,
  });
  // P5.1: a new run starts where the last one finished. Only what is still true crosses
  // the boundary — `revision_independent` facts and committed decisions — and only when
  // the conversation and project both match; `carryForwardWorkingState` owns those rules.
  // Skipped while resuming, because a crash checkpoint already carries this run's own
  // ledger and seeding it a second time would duplicate its facts.

  // What the run is actually being asked to do. A message that only says "continue"
  // names no work of its own, so it resolves to the request underneath it: seeding the
  // objective from the literal nudge made "contine" the run's outcome, its acceptance
  // criterion, its committed decision AND the criterion verification checked — so the run
  // both forgot the real goal and could only report itself inconclusive.
  const objectiveText = deriveObjectiveText(command.input.userPrompt, command.input.history);
  // WHAT DONE MEANS, in terms something can check. `acceptance.ts` reads the conditions the
  // request actually stated — a deliverable length, a minimum shot count — and the Critic
  // checks those same numbers, so the criterion the ledger reports against and the check that
  // settles it are one reading rather than two.
  //
  // Recording them is what makes the objective more than a copy of the request. Until now the
  // outcome, the single acceptance criterion, the committed decision and the criterion
  // verification reported against were all the same sentence the editor typed, so
  // verification could only ever answer "did any operation succeed" — a request for "20+
  // different best moments" was satisfied, as far as the ledger knew, by eight shots.
  //
  // `provisional` still marks a reading with nothing checkable in it: the request's prose is
  // the objective, and the field stays open for a turn that records a real interpretation.
  const checkable = checkableAcceptance(
    command.input.userPrompt,
    explicitDurationTargetSeconds(command.input.userPrompt),
  );
  const criteria = acceptanceCriteria(checkable);
  const interpreted = setObjective(created, {
    outcome: objectiveText,
    acceptance: criteria.map((description) => ({ description })),
    provisional: !hasCheckableAcceptance(checkable),
  });
  // When the creator disables the visible detailed-planning turn, commit a minimal
  // objective-backed authorization record from the persisted request itself. It is
  // machine-readable and durable before the first tool turn, never inferred from prose.
  const planned = planning ? interpreted : commitExecutionPlan(interpreted, [objectiveText], 0);
  // P5.1: a new run starts where the last one finished. Applied AFTER the plan commit on
  // purpose — `commitExecutionPlan` REPLACES the decision list with the plan's own, so
  // seeding earlier would have the new run's plan silently erase what the editor settled
  // in the last one. Only what is still true crosses (`revision_independent` facts and
  // committed decisions), and only when the conversation and project both match;
  // `carryForwardWorkingState` owns those rules. Skipped while resuming, because a crash
  // checkpoint already carries this run's own ledger.
  const freshWorking = resuming
    ? planned
    : carryForwardWorkingState(parseWorkingState(ao.carriedForward), planned);
  const started: ConductorState = {
    phase: resuming ? 'resuming' : planning ? 'planning' : 'executing',
    turnRef: command.stream,
    goal: command.input.userPrompt,
    config,
    stepIndex: 1,
    cumulativeOps: [],
    appliedTurns: 0,
    noProgress: [],
    stallStreak: 0,
    researchStreak: 0,
    recentOutputDeltas: [],
    seenCallKeys: [],
    rejectedOpCount: 0,
    rejectionReasons: [],
    cancelled: false,
    integrityFailed: false,
    log: [],
    planSteps: [],
    ledgerLength: 0,
    working: restored ?? freshWorking,
    recentIntents: [],
    noProgressStreak: 0,
    noveltyOnlyStreak: 0,
    seq: em.seq(),
  };
  const firstEffect: ConductorEffect = resuming
    ? { kind: 'resume' }
    : planning
      ? { kind: 'draft_plan' }
      : runTurnEffect(started, 1);
  return { state: started, effects: [firstEffect], events };
}

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------

/**
 * Fold the up-front plan: seed the todo ledger (all `pending`), emit it, then emit
 * `status('thinking')` and the first turn — preserving streamAgent's
 * `status('planning')`→`plan`→`status('thinking')` order (the handler emitted
 * `status('planning')` before the model call).
 */
// ---------------------------------------------------------------------------
// The decision seam (plan/LANGCHAIN-MIGRATION.md M3.1)
// ---------------------------------------------------------------------------
//
// The five functions below are the run's decision points, one per result kind. They
// were already pure — this reducer performs no I/O and expresses side effects as inert
// `ConductorEffect` descriptions — but they were private, reachable only through
// `onEffectResult`'s dispatch.
//
// M3 exports them so a LangGraph node can call the decision directly: read state, do
// its I/O, call the pure decision, write state. That is §5.2's "nodes are shells", and
// it is what keeps the orchestration logic table-testable with no mocks and replayable
// after the migration, rather than dissolving into async node bodies.
//
// **They stay the single implementation.** `onEffectResult` dispatches to exactly these,
// so the graph path and the kernel path cannot drift into two behaviours — the failure
// mode a parallel "graph-flavoured" copy would guarantee.
//
// The `Emitter` argument is not I/O. `createTurnEmitter(ref, startSeq)` is a pure
// id-stamper over one monotonic sequence; seeding it at `state.seq` is precisely the
// split-emitter contract (§7.4) that keeps event ids byte-identical across the
// control/execution boundary.

export function onDraftPlanResult(
  state: ConductorState,
  r: DraftPlanResult,
  em: Emitter,
): ConductorStep {
  const events: AiEvent[] = [];
  let planSteps: readonly PlanStep[] = [];
  let ledgerLength = 0;
  if (r.labels.length > 0) {
    planSteps = r.labels.map((label, i) => ({ id: `step-${i + 1}`, label, status: 'pending' }));
    ledgerLength = planSteps.length;
    events.push(em.plan([...planSteps]));
  }
  const working = commitExecutionPlan(state.working, r.labels, 0);
  if (working.plan.status !== 'committed') {
    // `commitExecutionPlan` only ever leaves `plan.status` un-committed via its own
    // `addDiagnostic` call, which always pushes a diagnostic before returning — so
    // `diagnostics` is never empty here. The `??` fallback is a total-function guard
    // against that pairing drifting, not a reachable path (confirmed by reading every
    // return in `commitExecutionPlan`).
    /* v8 ignore next -- unreachable: see comment above */
    const detail = working.integrity.diagnostics.at(-1)?.message ?? 'No plan was committed.';
    return finalize({ ...state, working, integrityFailed: true }, em, [
      em.warning(`Run paused before editing: ${detail}`),
    ]);
  }
  // W3.4: a plan the run cannot execute is a promise we break in the UI. The ledger maps
  // turns onto plan steps positionally, so with the drafter free to write up to 12 steps
  // and the budget fixed at 8, a *compliant* model was structurally guaranteed to leave
  // steps unrun — exactly the trailing never-started steps seen in the reported run.
  // Widen the budget to fit the plan the run just committed to (never shrink: an explicit
  // maxSteps acts as a floor). Bounded by the drafter's own cap, so this cannot run away.
  const config =
    planSteps.length > 0
      ? {
          ...state.config,
          maxSteps: Math.max(state.config.maxSteps, planSteps.length + PLAN_STEP_HEADROOM),
        }
      : state.config;
  // P11.3: a gated, high-blast-radius plan pauses HERE — before the first turn, before
  // any tool runs or op touches the working copy — instead of falling through to
  // `status('thinking')` + the first `run_turn` effect.
  if (state.config.planApprovalGated && planSteps.length > PLAN_APPROVAL_STEP_THRESHOLD) {
    events.push(em.status('awaiting_approval'));
    const next: ConductorState = {
      ...state,
      working: setExecutionAuthorization(working, false),
      phase: 'awaiting_approval',
      config,
      planSteps,
      ledgerLength,
      seq: em.seq(),
    };
    return { state: next, effects: [{ kind: 'await_approval', planSteps }], events };
  }
  events.push(em.status('thinking'));
  const next: ConductorState = {
    ...state,
    working,
    phase: 'executing',
    config,
    planSteps,
    ledgerLength,
    seq: em.seq(),
  };
  return { state: next, effects: [runTurnEffect(next, 1)], events };
}

/**
 * Fold the creator's approve/cancel decision (P11.3): approved falls through to the
 * first turn exactly like an un-gated `planFirst` run; cancelled finalizes the run
 * immediately with NO turn ever having executed — nothing was touched, so `finalize`
 * emits an empty (no-op) diff, never a fabricated partial result.
 */
export function onApprovalResult(
  state: ConductorState,
  r: ApprovalResult,
  em: Emitter,
): ConductorStep {
  if (r.decision === 'cancelled') {
    return cancelFinalize(state, em, [em.notification('Plan cancelled — no edits were made.')]);
  }
  const next: ConductorState = {
    ...state,
    working: setExecutionAuthorization(state.working, true),
    phase: 'executing',
    seq: em.seq(),
  };
  return { state: next, effects: [runTurnEffect(next, 1)], events: [em.status('thinking')] };
}

/**
 * Fold a resume replay: on success adopt the prior ops/log and continue from the next
 * step (verifying immediately when the checkpoint already spent the step budget). On
 * failure the run does NOT silently start over from step 1 (RSI1) — the checkpoint's
 * ops no longer validating means the project moved on without this run's knowledge, so
 * blindly restarting risks executing against a project state the interrupted run never
 * saw. Instead the run pauses for reconciliation: a `PROJECT_REVISION_STALE` diagnostic
 * is recorded and the run finalizes as an integrity failure, preserving whatever the
 * interrupted run had already applied for the creator to review.
 */
export function onResumeResult(state: ConductorState, r: ResumeResult, em: Emitter): ConductorStep {
  if (!r.ok) {
    const working = addDiagnostic(state.working, {
      code: 'PROJECT_REVISION_STALE',
      message: 'The interrupted run no longer matches the current project revision.',
      stage: state.working.stage,
      blocking: true,
    });
    return finalize({ ...state, working, integrityFailed: true }, em, [
      em.warning('Resume paused for reconciliation; no additional edits were applied.'),
    ]);
  }
  const startIndex = r.stepsCompleted + 1;
  const next: ConductorState = {
    ...state,
    phase: 'executing',
    cumulativeOps: [...r.ops],
    appliedTurns: r.stepsCompleted,
    stepIndex: startIndex,
    log: [...r.log],
    seq: em.seq(),
  };
  if (startIndex > state.config.maxSteps) {
    return toVerify(next, em, []);
  }
  return { state: next, effects: [runTurnEffect(next, startIndex)], events: [] };
}

/** Fold one executed turn's outcome and decide the next step (the loop body). */
export function onTurnResult(
  state: ConductorState,
  r: AgentTurnResult,
  em: Emitter,
): ConductorStep {
  const events: AiEvent[] = [];
  // FIRST, before any other read of the ledger.
  //
  // The host's verdicts arrive a turn late by construction (see
  // `AgentTurnResult.hostRefusals`): it rules on a diff after publishing it, and the graph's
  // event queue is a fire-and-forget push, so no verdict exists when the turn that produced
  // the patch ends. Each one corrects a row previously recorded as `succeeded` and winds the
  // project revision back to what still exists.
  //
  // At the top because `onTurnResult` returns from several places — the applied path folds
  // and returns long before the rejection path is reached — and a correction applied on only
  // one of them would leave the ledger claiming success exactly where an edit did land
  // locally and was then refused, which is the whole case.
  if (r.hostRefusals && r.hostRefusals.length > 0) {
    state = {
      ...state,
      working: r.hostRefusals.reduce(
        (acc, refusal) => recordHostRefusal(acc, refusal.patchId, refusal.reason),
        state.working,
      ),
      // The refused ops never reached the project, so they must not go on counting toward
      // the run's completion report or its "what landed" account.
      cumulativeOps: [],
    };
    for (const refusal of r.hostRefusals) {
      events.push(em.warning(`Couldn’t apply “${refusal.intent}” — ${refusal.reason}`));
    }
  }
  // Task stage first (ADR 0075 §3.2): derived from what the turn DID — the roles of the
  // tools it ran and whether a patch landed — never from what its prose claimed. A turn
  // that re-announces "let me understand the project" while calling nothing new moves
  // nothing, which is the point. `advanceStage` refuses any move the transition table
  // does not permit, so this can only fail to advance, never corrupt.
  const roles = r.callFacts.map((f) => f.role ?? 'other');
  // Captured BEFORE the stage walk and the fact fold below, because "did this turn
  // advance the run?" is asked much later — after `state.working` has been replaced by
  // the fact-folded copy — and asking it by object identity there answered a different
  // question. See `stageAdvanced`.
  const stageBefore = state.working.stage;
  const target = settledStageFor(state.working.stage, roles, r.applied);
  const staged =
    target === state.working.stage
      ? state.working
      : // Walk the machine one legal edge at a time so `advanceStage` still vets every
        // transition; `settledStageFor` only says where the evidence leads.
        RUN_STAGES.slice(
          RUN_STAGES.indexOf(state.working.stage) + 1,
          RUN_STAGES.indexOf(target) + 1,
        ).reduce((w, next) => advanceStage(w, next, r.stepIndex), state.working);
  // Fold this turn's distilled conclusions into task memory. These are what the next
  // turn's briefing is built from, and they are deliberately recorded BEFORE any of the
  // guards below run: what the run learned must survive even a turn that is about to be
  // judged as making no progress.
  const learned = r.callFacts.reduce((w, fact) => {
    if (!fact.distilled) return w;
    // Index the handle BEFORE the fact that cites it. `recordEvidence` had no caller at
    // all: every run's `working.evidence` was `[]` while its facts cited `[ev_3]`, so the
    // durable state carried references it could not resolve and a resumed run restored
    // them broken. The payload itself still lives in the run's EvidenceStore — this is the
    // index that says which handles exist and what each one was.
    const indexed = fact.distilled.evidence ? recordEvidence(w, fact.distilled.evidence) : w;
    return recordFact(indexed, {
      kind: fact.distilled.kind,
      statement: fact.distilled.statement,
      scope: fact.distilled.scope,
      ...(fact.distilled.evidenceId ? { evidenceIds: [fact.distilled.evidenceId] } : {}),
    });
  }, staged);
  state = learned === state.working ? state : { ...state, working: learned };
  const base = { ...state, log: [...r.log] };

  // Turn-boundary / mid-stream abort — the interrupted turn is not applied and emits
  // NO plan event; finalize with a resume checkpoint.
  if (r.aborted) {
    return cancelFinalize(base, em, events);
  }

  // A tool cancelled mid-turn — mark its step failed ('Stopped by user'), then cancel.
  if (r.anyToolCancelled) {
    const planSteps = withStep(r.planSteps, r.planStepIndex, {
      ...r.planSteps[r.planStepIndex]!,
      status: 'failed',
      detail: 'Stopped by user',
    });
    // Only surface a checklist when a plan was actually drafted (`ledgerLength > 0`).
    // Unplanned runs keep planSteps in state for status tracking but never render a
    // pinned, ever-growing ledger — their per-step tool cards ARE the visible activity.
    if (state.ledgerLength > 0) events.push(em.plan([...planSteps]));
    return cancelFinalize({ ...base, planSteps }, em, events);
  }

  // A model may SAY it is done only after the committed ledger agrees. Large edits used
  // to stop here after the first successful batch: the model emitted prose with no tool
  // call while later drafted deliverables were still pending, and the harness jumped to
  // verification instead of asking it to continue. Give that mismatch one bounded,
  // mutation-only recovery turn aimed at the first unfinished deliverable. If the model
  // still returns no action, `actionRecoveryPending` makes the second declaration settle
  // through verification rather than looping forever.
  if (r.done) {
    const nextIndex = state.planSteps.findIndex((step) => step.status !== 'completed');
    const nextStep = nextIndex >= 0 ? state.planSteps[nextIndex] : undefined;
    if (state.ledgerLength > 0 && nextStep && !state.actionRecoveryPending) {
      const working = setNextAction(state.working, {
        stage: state.working.stage,
        action: nextStep.label,
        ...(state.working.objectives[nextIndex]?.id
          ? { objectiveId: state.working.objectives[nextIndex]!.id }
          : {}),
      });
      events.push(
        em.notification(
          `The plan still has unfinished work — continuing with “${nextStep.label}”.`,
        ),
      );
      return advance(
        { ...base, working, actionRecoveryPending: true, modelDeclaredDone: false },
        em,
        events,
      );
    }
    return toVerify({ ...base, modelDeclaredDone: true }, em, events);
  }

  // Blast-radius bound: a single runaway turn is rejected wholesale (not applied) —
  // its step fails with the diagnostic and the run stops to verify.
  if (r.turnOpCount > state.config.maxOpsPerTurn) {
    const note = `Turn rejected: ${r.turnOpCount} operations exceeds the per-turn cap of ${state.config.maxOpsPerTurn}.`;
    const planSteps = withStep(r.planSteps, r.planStepIndex, {
      ...r.planSteps[r.planStepIndex]!,
      status: 'failed',
      detail: note,
    });
    if (state.ledgerLength > 0) events.push(em.plan([...planSteps]));
    events.push(em.warning(note));
    // The run DID attempt an edit — this warning explains what happened to it, so the
    // generic never-attempted notice must not also fire and contradict it (R2).
    return toVerify({ ...base, planSteps, attemptedAnyEdit: true }, em, events);
  }

  // Plan completion must be backed by an applied patch. Previously one drafted row was
  // checked per MODEL TURN, so a cached get_timeline call could mark "add every image"
  // complete with zero operations. Read-only work keeps its row running. Once an edit
  // lands, the setup rows through that turn are also proven complete; a real failure
  // marks only the active row.
  const running = r.planSteps[r.planStepIndex]!;
  const failed = r.turnOpCount > 0 || r.anyToolFailed;
  const planSteps = r.applied
    ? r.planSteps.map((step, index) =>
        index <= r.planStepIndex ? { ...step, status: 'completed' as const } : step,
      )
    : failed
      ? withStep(r.planSteps, r.planStepIndex, {
          ...running,
          status: 'failed',
          detail: r.note,
        })
      : r.planSteps;
  if (state.ledgerLength > 0 && (r.applied || failed)) events.push(em.plan([...planSteps]));
  // Per-call validator rejections count toward the empty-run notice even when the
  // turn also landed other calls' ops — the notice only fires when the whole RUN
  // lands nothing, so this only ever surfaces honest, user-relevant reasons.
  const rejectionTally = [...state.rejectionReasons];
  for (const note of r.rejectionNotes) {
    if (rejectionTally.length < MAX_REJECTION_REASONS) rejectionTally.push(note);
  }
  const withPlan = {
    ...base,
    planSteps,
    rejectedOpCount: state.rejectedOpCount + r.rejectedOpCount,
    rejectionReasons: rejectionTally,
  };

  // The turn validated and applied — surface its `timeline_action` cards (only now
  // that it landed) and accumulate its ops.
  if (r.applied) {
    for (const a of r.describedActions) {
      events.push(em.timelineAction(a.action, a.detail, a.refs));
    }
    const cumulativeOps = [...state.cumulativeOps, ...r.appliedOps];
    // Task memory (ADR 0075): the edit landed, so the project moved to a new revision.
    // Recording the operation is what makes completion COMPUTABLE later — an objective is
    // discharged by an applied patch plus a passing verification, never by the model
    // saying it is done — and the revision bump invalidates the arrangement facts while
    // leaving the transcript, footage map and committed decisions untouched.
    const revisionBefore = state.working.currentProjectRevision;
    const revisionAfter = revisionBefore + 1;
    const decisionId =
      state.working.plan.decisionIds[
        Math.min(r.planStepIndex, state.working.plan.decisionIds.length - 1)
      ]!;
    const objectiveId = state.working.objectives.find((objective) =>
      objective.id.endsWith(`_${Math.min(r.planStepIndex + 1, state.working.objectives.length)}`),
    )?.id;
    const planId = state.working.plan.id!;
    const advancedWorking = onProjectRevisionChanged(state.working, revisionAfter);
    const working = r.describedActions.reduce(
      (ledger, action, index) =>
        recordOperation(ledger, {
          intent: action.action,
          status: 'succeeded',
          planId,
          decisionId,
          idempotencyKey: `${state.working.runId}:${planId}:${decisionId}:${r.signature}:${index}`,
          projectRevisionBefore: revisionBefore,
          projectRevisionAfter: revisionAfter,
          // The patch these rows came from, so a LATER host refusal can find and correct
          // them (`working-state.ts#recordHostRefusal`). Without it the ledger has no way
          // back from "succeeded" to the truth, which is the state a captured run ended in.
          ...(r.patchId === undefined ? {} : { patchId: r.patchId }),
          ...(objectiveId ? { objectiveId } : {}),
        }),
      advancedWorking,
    );
    const s: ConductorState = {
      ...withPlan,
      working,
      cumulativeOps,
      appliedTurns: state.appliedTurns + 1,
      // A real edit landed — the run is progressing, so the convergence streak resets,
      // and so does the diminishing-returns delta window (E4.2: the streak requires
      // zero applied ops across ALL of its turns).
      stallStreak: 0,
      // R1: an applied edit refunds the research budget, so the next step of a long
      // multi-step edit gets a full reconnaissance allowance of its own.
      researchStreak: 0,
      // An applied edit is meaningful progress by definition, so both new streaks clear
      // with the old ones.
      noProgressStreak: 0,
      noveltyOnlyStreak: 0,
      recentIntents: [],
      recentOutputDeltas: [],
      actionRecoveryPending: false,
      seenCallKeys: mergeSeenKeys(state.seenCallKeys, r.callFacts),
    };
    if (cumulativeOps.length >= state.config.maxOpsPerRun) {
      const note = `Reached the per-run cap of ${state.config.maxOpsPerRun} operations — stopping.`;
      events.push(em.notification(note));
      return toVerify(s, em, events);
    }
    return advance(s, em, events);
  }

  // A real-ops turn the validator rejected is NOT a dead end: the rejection reason is
  // already in the action log the model reads next turn, so give it a bounded chance to
  // fix the cause (per-call validation in the turn handler makes a whole-turn rejection
  // rare — repeated edits and cross-call conflicts). Remember why for the empty-run notice.
  const attemptedEdit = r.turnOpCount > 0;
  // An already-satisfied turn attempted an edit but was not REJECTED by anything, so it must
  // not feed the rejection tally. That tally becomes the completion report's
  // "**Skipped:** N proposed changes did not validate (…)" line — and in the captured run it
  // told the editor two changes had failed validation when both had validated perfectly and
  // were simply already on the timeline. A run that misreports its own outcome to the person
  // reviewing it is worse than one that says nothing.
  const rejected = attemptedEdit && r.satisfied !== true;
  const rejectionReasons =
    rejected && withPlan.rejectionReasons.length < MAX_REJECTION_REASONS
      ? [...withPlan.rejectionReasons, r.rejection ?? r.note]
      : withPlan.rejectionReasons;
  const rejectedOpCount = withPlan.rejectedOpCount + (rejected ? r.turnOpCount : 0);

  // Did this no-edit turn make PROGRESS? The harness does not judge the model's intent —
  // only whether the run can still move forward. A turn progresses if it attempted an edit
  // (a rejected op is a bounded retry, its reason now in the log) or learned something new
  // (a first-seen read/analysis — the raw material an edit is built from). Re-reading what
  // the run already has (served from the memo as non-novel) is neither: it changes nothing
  // and reveals nothing, so it cannot be progress.
  const progressed = attemptedEdit || turnLearnedSomethingNew(r.callFacts, state.seenCallKeys);
  const seenCallKeys = mergeSeenKeys(state.seenCallKeys, r.callFacts);
  // Convergence is the sole behavioral stop: a turn that made no progress increments the
  // streak, any progress resets it. Two provable non-progress turns in a row (or an exact
  // verbatim repeat, caught immediately) mean the run is stuck — stop and finalize
  // honestly rather than burn resource rails re-deriving the same nothing.
  const stallStreak = progressed ? 0 : state.stallStreak + 1;
  // E4.1: extend the low-delta window with this zero-edit turn's output-token delta.
  // A turn with no reported usage RESETS the window rather than riding in it — a streak
  // must be provable end-to-end, never inferred across gaps in the data.
  const outputDelta = r.usage?.outputTokens;
  const recentOutputDeltas: readonly number[] =
    outputDelta === undefined
      ? []
      : [...state.recentOutputDeltas, outputDelta].slice(-state.config.diminishingReturnsTurns);
  // R1: this turn gathered information without attempting an edit, so it spends research
  // budget. Any attempt — even one the validator rejected — proves the run has left
  // reconnaissance and refunds the whole budget.
  const researchStreak = attemptedEdit ? 0 : state.researchStreak + 1;
  // Recalls are excluded from this question, and the exclusion is load-bearing.
  //
  // `recall_evidence` returns stored data, so it is `fromCache` by construction — which
  // meant a turn that did exactly what the contract asks (recall rather than re-read)
  // read as "this turn learned nothing" and armed the recovery lockout. In run e30c1fe9
  // that fired four times: the model recalled the stock candidates it needed the ids of,
  // and the next turn withheld the tool that could act on them. The tools the recovery
  // turn preserves must not be the trigger for entering it.
  //
  // A turn of ONLY recalls therefore leaves this false. A run that recalls and nothing
  // else forever is still caught — by the no-progress and stall guards, which is where
  // "provably going nowhere" belongs.
  const gathering = r.callFacts.filter((fact) => fact.role !== 'recall');
  const allFromCache =
    gathering.length > 0 &&
    gathering.every(
      (fact) => fact.fromCache && (fact.status === 'completed' || fact.status === 'warning'),
    );
  // A turn that proposed operations and lost them to the validator is recorded too: the
  // ledger must show what the run TRIED, or a failure looks identical to never having
  // attempted anything (the distinction ADR 0074's empty-run notice turns on).
  // A turn whose edit was already on the timeline is recorded as SUCCEEDED, not failed:
  // the state it was trying to reach is the state that exists. Filing it as a failure put
  // it under the briefing's "FAILED — fix the cause, do not retry unchanged", which is
  // advice with no cause behind it; as a success it lands under "ALREADY APPLIED — do not
  // repeat", which is both true and the instruction the run actually needs.
  const workingAfterTurn = attemptedEdit
    ? recordOperation(state.working, {
        intent: r.signature,
        status: r.satisfied === true ? 'succeeded' : 'failed',
        ...(r.patchId === undefined ? {} : { patchId: r.patchId }),
        ...(r.satisfied === true ? {} : { failureReason: r.rejection ?? r.note }),
        planId: state.working.plan.id!,
        decisionId:
          state.working.plan.decisionIds[
            Math.min(r.planStepIndex, state.working.plan.decisionIds.length - 1)
          ]!,
        // The key carries the outcome so a signature that failed once and is later found
        // already-satisfied does not overwrite its own failure record in place — the two
        // are different facts about the run, and `recordOperation` keys updates on this.
        idempotencyKey:
          `${state.working.runId}:${state.working.plan.id!}:` +
          `${r.signature}:${r.satisfied === true ? 'satisfied' : 'failed'}`,
        projectRevisionBefore: state.working.currentProjectRevision,
        projectRevisionAfter: state.working.currentProjectRevision,
      })
    : state.working;
  // The STAGE, not "anything at all changed". This was `staged !== state.working`, an
  // object comparison against a `state.working` that the fact fold above had already
  // replaced — so it read true on any turn that recorded a fact, and a re-orienting run
  // records one every turn. That silently disabled the escape hatch's inverse: a genuine
  // loop always looked like "repeating an intent while advancing", so `isSemanticLoop`
  // never fired in production. It appeared to work only where the reads produced
  // duplicate conclusions, which `recordFact` deduplicates into a no-op — an accident
  // that ended the moment a read's fact carried its actual finding.
  const stageAdvanced = stageBefore !== state.working.stage;
  const learnedSomethingNew = turnLearnedSomethingNew(r.callFacts, state.seenCallKeys);
  // Meaningful progress is a stricter question than the stall guard's: reasoning text,
  // restated summaries and memo hits are a run describing itself, not progressing.
  const strongerSignal = attemptedEdit || stageAdvanced;
  const noveltyOnlyStreak =
    strongerSignal || !learnedSomethingNew ? 0 : state.noveltyOnlyStreak + 1;
  const progressedMeaningfully = madeMeaningfulProgress({
    learnedSomethingNew,
    attemptedEdit,
    appliedEdit: false,
    recordedVerification: false,
    advancedStage: stageAdvanced,
    committedDecision: false,
    satisfiedObjective: false,
    // The streak BEFORE this turn: the budget asks how many turns have already been spent
    // discovering and not acting, so counting this one would spend the allowance a turn early.
    noveltyOnlyStreak: state.noveltyOnlyStreak,
  });
  // Semantic loop detection (ADR 0075 §3.5). Tracks what turns were FOR: a run that
  // re-announces the same purpose three times while advancing nothing is circling, however
  // freshly it words itself each time.
  //
  // The window holds turns that LEARNED NOTHING — a turn with a first-seen, successful,
  // uncached call empties it rather than extending it. Without that the detector was
  // judging the model's prose and nothing else, and the prose of a working run repeats by
  // nature: `'find the'` is an `analyze` marker, so "find the right music" / "find the
  // right track" / "find the right music first" read as three turns of one intent even
  // though each search returned a different catalogue. Run `f1d5285e` was declared to be
  // going in circles for describing three productive turns consistently. Clear writing is
  // not a loop.
  //
  // `learnedSomethingNew` specifically, NOT `progressedMeaningfully`. The broader test
  // would make this detector unreachable: a turn that progresses in any other sense
  // resets `noProgressStreak`, and a turn that does not hits MAX_NO_PROGRESS_TURNS on its
  // second occurrence — before a three-turn window could ever fill. What is left for this
  // guard is precisely the run that keeps moving its stage (or re-proposing rejected
  // edits) under one unchanging purpose while discovering nothing, which is the failure
  // it was built for and which this still catches.
  const intent = normalizeIntent(r.rationale ?? '');
  const recentIntents = learnedSomethingNew
    ? []
    : [...state.recentIntents, intent].slice(-SEMANTIC_LOOP_TURNS);
  const looping = isSemanticLoop(recentIntents, {
    stageAdvanced,
    decisionCommitted: false,
  });
  // A turn the harness refused outright is not a turn that failed to progress: the model
  // asked for something, was told no, and banked nothing BECAUSE of the refusal. Holding
  // the streak (rather than resetting it) keeps a genuinely stuck run on its way to the
  // guard while giving the refused turn the chance to obey the refusal.
  const everyCallWithheld =
    (r.withheldCallCount ?? 0) > 0 && (r.withheldCallCount ?? 0) === r.callFacts.length;
  const noProgressStreak = progressedMeaningfully
    ? 0
    : everyCallWithheld
      ? state.noProgressStreak
      : state.noProgressStreak + 1;
  const recovering = looping || noProgressStreak >= MAX_NO_PROGRESS_TURNS;
  // Recovery yields an ACTION, never another plan — the run's problem is that it cannot
  // stop planning, so the remedy must not be an invitation to plan again.
  const recovered = recovering ? recoveryAction(workingAfterTurn) : null;
  // Force the next turn to act when the previous one only re-read what the run already
  // had, when the run has spent its research budget (R1), or when the loop/progress
  // detectors fired (ADR 0075 §3.5). Four signals, one executable consequence: withhold
  // the tools that would let the run keep circling. They share the single recovery flag
  // the handler already understands, because an ignored prompt warning is precisely what
  // the failing run already had.
  const actionRecoveryPending =
    allFromCache || researchBudgetSpent(researchStreak, RESEARCH_BUDGET_TURNS) || recovering;
  const guarded = {
    ...withPlan,
    working: recovered ? setNextAction(workingAfterTurn, recovered) : workingAfterTurn,
    recentIntents,
    noProgressStreak,
    noveltyOnlyStreak,
    rejectedOpCount,
    rejectionReasons,
    attemptedAnyEdit: state.attemptedAnyEdit || attemptedEdit,
    stallStreak,
    researchStreak,
    recentOutputDeltas,
    actionRecoveryPending,
    seenCallKeys,
  };
  // An exact repeated read batch used to terminate HERE before the next turn could act.
  // Give one deterministic recovery turn first: the handler withholds every read and
  // analysis descriptor, so the same loop is structurally impossible. This exception
  // is single-use because `state.actionRecoveryPending` is already true on a recovery
  // turn; failures then fall through to the normal convergence guard.
  if (actionRecoveryPending && !state.actionRecoveryPending) {
    // Explain the switch in the creator's terms — but only on the path that CONTINUES.
    // A run about to stop gets the more specific stall notice below instead; two
    // explanations for one event would read as two problems.
    if (looping) {
      events.push(
        em.notification(
          'Going in circles — switching to the edit with what has already been gathered.',
        ),
      );
    } else if (researchBudgetSpent(researchStreak, RESEARCH_BUDGET_TURNS) && !allFromCache) {
      events.push(
        em.notification(
          'Gathered enough to work from — switching from reviewing the footage to making the edit.',
        ),
      );
    } else if (allFromCache) {
      // The third trigger had no sentence at all. A run switched to a restricted surface,
      // a tool card went red for a reason the harness had chosen, and the editor watching
      // was shown nothing that connected the two.
      events.push(
        em.notification(
          'That last look turned up nothing new — working from what has already been gathered.',
        ),
      );
    }
    return advance({ ...guarded, noProgress: [...state.noProgress, r.signature] }, em, events);
  }
  const converged = stallStreak >= STALL_CONFIRM_TURNS;
  if (state.noProgress.includes(r.signature) || converged) {
    if (converged) {
      events.push(
        em.notification(
          'The run stopped making progress — no further edits could be found for this request.',
        ),
      );
    }
    return toVerify(guarded, em, events);
  }
  // E4.2: diminishing returns — enough consecutive zero-edit turns each under the
  // output-token threshold prove the run has CONVERGED: it keeps making novel-looking
  // little calls but is adding nothing. Distinct from the stall notice above (that is
  // "provably stuck"; this is "honestly finished") and checked after it, so a genuine
  // stall keeps its more specific explanation.
  const diminished =
    recentOutputDeltas.length >= state.config.diminishingReturnsTurns &&
    recentOutputDeltas.every((d) => d < state.config.diminishingReturnsMinOutputTokens);
  if (diminished) {
    events.push(
      em.notification(
        'The run converged — its last turns produced almost no new output and no edits, so it stopped here instead of spending more of the budget.',
        {
          reason: DIMINISHING_RETURNS_REASON,
          detail: `output-token deltas ${recentOutputDeltas.join(', ')} over the last ${recentOutputDeltas.length} turns, each under the ${state.config.diminishingReturnsMinOutputTokens}-token threshold with no applied edits`,
        },
      ),
    );
    return toVerify(guarded, em, events);
  }
  return advance({ ...guarded, noProgress: [...state.noProgress, r.signature] }, em, events);
}

/**
 * Append this turn's novelty keys to the run's seen set, de-duplicated. Pure.
 *
 * Only calls that ACTUALLY ANSWERED are recorded — {@link callAnswered}, the same test
 * {@link turnLearnedSomethingNew} applies before it asks whether the key is new. A key is a claim that the run
 * already holds this call's answer, and a call that failed holds nothing: recording it
 * meant the retry that finally succeeded was scored as a repeat. That is not
 * hypothetical — in run `f1d5285e` the first `search_music` was rejected by the
 * provider, its key was banked anyway, and every later search inherited the verdict
 * "already seen"; the run stalled out four turns later having applied no edit.
 *
 * Nothing about the spin guard weakens: a call that keeps failing is never novel on its
 * own status, so a run retrying one forever still increments the stall streak every turn.
 */
function mergeSeenKeys(seen: readonly string[], facts: readonly TurnCallFact[]): readonly string[] {
  return [...new Set([...seen, ...facts.filter(callAnswered).map((f) => f.key)])];
}

/** Fold the verify self-check (+ repair): surface its findings, fold repair ops, finalize. */
export function onVerifyResult(state: ConductorState, r: VerifyResult, em: Emitter): ConductorStep {
  // A Critic verdict is meaningful only when there is an edited result to inspect.
  // Previously a zero-op run displayed "Self-check: Passed" immediately before
  // "No edits were applied", which misrepresented a rejected run as successful.
  // Keep the verification machinery shared, but surface its verdict only for an
  // actual edit; finalize emits the specific empty-run failure below.
  const events: AiEvent[] = [];
  if (state.cumulativeOps.length > 0) {
    events.push(em.notification(`Deterministic self-check: ${r.summary}`));
    for (const check of r.failedChecks) {
      events.push(em.warning(`${check.label}: ${check.detail}`));
    }
  }
  let working = state.working;
  if (r.repairOps.length > 0) {
    const revisionBefore = working.currentProjectRevision;
    const revisionAfter = revisionBefore + 1;
    const planId = working.plan.id!;
    const decisionId = working.plan.decisionIds.at(-1)!;
    working = onProjectRevisionChanged(working, revisionAfter);
    for (const [index] of r.repairOps.entries()) {
      working = recordOperation(working, {
        intent: `verification repair ${index + 1}`,
        status: 'succeeded',
        planId,
        decisionId,
        idempotencyKey: `${working.runId}:${planId}:${decisionId}:repair:${index}`,
        projectRevisionBefore: revisionBefore,
        projectRevisionAfter: revisionAfter,
      });
    }
  }
  if (working.operations.some((operation) => operation.status === 'succeeded')) {
    const from = RUN_STAGES.indexOf(working.stage) + 1;
    const throughVerify = RUN_STAGES.indexOf('verify') + 1;
    working = RUN_STAGES.slice(from, throughVerify).reduce(
      (ledger, stage) => advanceStage(ledger, stage, state.stepIndex),
      working,
    );
  }
  const planReconciled =
    state.ledgerLength === 0 ||
    (state.planSteps.length > 0 && state.planSteps.every((step) => step.status === 'completed'));
  // Causal completion (ADR 0081) asks a narrower question than the Critic's content
  // report (ADR 0022): did the run trace a real, successful mutation to the plan it
  // committed to? That is `deliveredWork` + `planReconciled` — NOT `r.ok`. The Critic's
  // battery includes aspirational, caller-supplied targets (duration, export platform)
  // that critic.ts's own contract says "inform, they don't block" (only a `fail` status
  // is stronger than a `warn`, but neither was ever meant to undo a run that genuinely
  // did what it committed to). Folding `r.ok` into this gate meant an edit that fully
  // landed — validated, applied, traceable to its decision — was denied its own
  // completion (no "Applied N edits" summary, terminal `failed`) solely because a
  // duration/platform target the model's tools cannot invent their way to went unmet.
  // That verdict is still shown to the caller: `events` above already carries the
  // Self-check notice and one warning per failed check, unconditionally.
  //
  // `deliveredWork` is required unconditionally, even for a run that never attempted an
  // edit: ADR 0081's decision is that completion is forbidden without a successful
  // traceable operation, full stop — `working-state.ts`'s own `stageEntryViolation`
  // enforces the same rule at the schema layer (entering `verify` requires a succeeded
  // operation; entering `complete` requires `isDelivered`). A run that made no edit is
  // not "completed" under this model — it is an honest `failed` with no diff, which is
  // why the empty-run notice above exists: the creator needs to know nothing changed.
  const deliveredWork = working.operations.some((operation) => operation.status === 'succeeded');
  // A failed deterministic Critic check is an unmet acceptance condition, not an
  // advisory footnote. Treating `r.ok` as display-only allowed a six-second partial
  // montage to finish a request for a full 30-second video. The bounded repair pass has
  // already had its chance before this fold; if a check still fails, keep the partial
  // validated edits reviewable but settle the run honestly as failed.
  const verificationPassed = r.ok && planReconciled && deliveredWork;
  /**
   * Why this verification did not pass, or `undefined` when it did.
   *
   * ONE derivation, two consumers: the per-objective `detail` and the blocking diagnostic.
   * They used to be computed independently, and the `detail` arm only looked at
   * `planReconciled` — so a run that failed for "no traceable mutation" was filed as
   * `{ passed: false, detail: "Passed with 1 warning(s)." }`. A record that contradicts
   * itself is worse than a terse one: the creator reading it cannot tell which half is
   * true, and neither can a later turn reading the briefing.
   */
  const failureReason = (deliverableReached: boolean): string | undefined => {
    if (!planReconciled) return 'The committed plan still has incomplete deliverables.';
    if (!deliveredWork) return 'No traceable project mutation for the committed plan.';
    if (!r.ok) return `Deterministic acceptance checks still fail — ${r.summary}`;
    if (!deliverableReached) return 'This deliverable was not completed by the run.';
    return undefined;
  };
  for (const [index, objective] of working.objectives.entries()) {
    const deliverableReached =
      state.ledgerLength === 0 ? deliveredWork : state.planSteps[index]?.status === 'completed';
    working = recordVerification(working, {
      criterion: objective.description,
      passed: verificationPassed && deliverableReached,
      detail: failureReason(deliverableReached) ?? r.summary,
      objectiveId: objective.id,
    });
  }
  if (verificationPassed) {
    working = advanceStage(working, 'complete', state.stepIndex);
  } else {
    working = addDiagnostic(working, {
      code: 'VERIFICATION_INCONCLUSIVE',
      message: `Verification found: ${failureReason(false) ?? r.summary}`,
      stage: 'verify',
      blocking: true,
    });
  }
  const failed = !verificationPassed || working.stage !== 'complete';
  return finalize(
    {
      ...state,
      working,
      integrityFailed: state.integrityFailed || failed,
      cumulativeOps: [...state.cumulativeOps, ...r.repairOps],
    },
    em,
    events,
  );
}

/** Fold a runtime {@link ConductorResult} back into the run (the pure `onEffectResult`). */
export function onEffectResult(state: ConductorState, result: ConductorResult): ConductorStep {
  const em = createTurnEmitter(state.turnRef, result.endSeq);
  switch (result.kind) {
    case 'draft_plan':
      return onDraftPlanResult(state, result, em);
    case 'resume':
      return onResumeResult(state, result, em);
    case 'approval':
      return onApprovalResult(state, result, em);
    case 'agent_turn':
      return onTurnResult(state, result, em);
    case 'verify':
      return onVerifyResult(state, result, em);
  }
}

// ---------------------------------------------------------------------------
// M3.4 — the frozen run-state contract
// ---------------------------------------------------------------------------

/**
 * The orchestration state both paths consume, frozen as one named type
 * (plan/LANGCHAIN-MIGRATION.md M3.4 / §4.2).
 *
 * It is deliberately an alias of {@link ConductorState} rather than a new shape. §4.2
 * says "state is the same shape it is today", and it says so for a reason: keeping it
 * identical is what lets the existing pure reducers be reused as-is by graph nodes, and
 * what lets the WAL-backed checkpointer (§5.4) keep writing the records it already
 * writes. A parallel state type would mean a translation layer on every node boundary —
 * and translation layers are where `Operation` and `Patch` contracts get quietly bent,
 * which §7 risk 10 escalates to the maintainer rather than absorbing.
 *
 * Naming it separately still buys something real: from here on, a phase that needs to
 * change the graph's state says so by changing THIS type, and every consumer of the
 * contract breaks visibly instead of a field being added to the reducer's internals and
 * silently diverging from what the graph reads.
 */
export type FramePilotRunState = ConductorState;
