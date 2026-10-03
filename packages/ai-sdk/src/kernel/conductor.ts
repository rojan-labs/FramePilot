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
  SELF_CHECK_NOTICE_REASON,
  createTurnEmitter,
} from '../events.js';
import {
  acceptanceCriteria,
  checkableAcceptance,
  hasCheckableAcceptance,
  statedDuration,
} from '../acceptance.js';
import { survivesAppliedEdit } from '../tool-refusal.js';
import type { Command } from './commands.js';
import { deriveObjectiveText } from './continuation.js';
import type { Distillation } from './briefing.js';
import { type ToolRole, executedAnEdit, settledStageFor } from './stage-policy.js';
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
  recordDecision,
  recordEvidence,
  recordFact,
  recordHostRefusal,
  recordOperation,
  recordVerification,
  isRequestEcho,
  setObjective,
  setExecutionAuthorization,
  setNextAction,
} from './working-state.js';
import {
  recordPictureVerification,
  type PictureVerificationReport,
} from './picture-verification.js';
import { referenceDecisions, referenceDirectives } from '../references/directives.js';
import type { HostPatchRefusal } from './commit-ledger.js';
import { assessEditCompletion } from '../completion-gate.js';
import {
  type ModelPlanItem,
  type ModelPlanRecord,
  describeOpenItems,
  modelPlanDigest,
  modelPlanObjectiveKey,
  modelPlanSteps,
  nextOpenItem,
  openPlanItems,
  parseModelPlan,
  planItemLabel,
} from './model-plan.js';
import type { AgentOptions } from '../agent.js';
import type { ContextInput } from '../context-builder.js';

// Hard resource rails — blast-radius and cost bounds, NOT behavioral tuning. They exist
// so a runaway or malfunctioning run hits a ceiling; they are deliberately generous
// because *normal* termination is decided by convergence (the model finishing, or the
// run detecting it can no longer make progress — see {@link STALL_CONFIRM_TURNS}), never
// by burning down a step budget. A movie/documentary-length plan can legitimately run
// 20+ turns, so these are sized well above any real plan and left alone.
//
// A run that keeps researching novel material without editing is bounded by the cost and
// time budgets, which the editor sets (Settings → AI → Run budget) — not by a turn count
// that decides for the model when it has looked enough (ADR 0199). NOTE the browser's
// non-streaming `agent()` loop in `orchestrator.ts` keeps its own, much smaller default
// (30); the two are independent by design.
const DEFAULT_MAX_AGENT_STEPS = 300;
/**
 * The blast-radius bound on ONE agent turn, and the single owner of that number.
 *
 * It used to be two numbers. `orchestrator.ts` declared 100 and enforced it in the
 * streaming path's `runTurn` handler; this file declared 200 and reported it from the
 * reducer, and a comment on each explained that the divergence was deliberate because
 * the reducer "has rails the legacy loop does not". That was true of a loop this handler
 * is not: `agentRun` IS the conductor path, so the two halves of one code path disagreed
 * about the same cap. A turn between 101 and 200 operations was refused by the enforcing
 * half and invisible to the reporting half, which is how run `35746d4c` told an editor
 * `313 proposed changes couldn't be applied to the timeline (; ; )` — three empty strings
 * where three reasons belonged. Both halves now import this.
 *
 * It bounds what the MODEL composed. Operations a tool derives from the project rather
 * than from the model's arguments do not count against it — see
 * {@link ToolSpec.derivedFanOut}. Without that split the bound was not a blast-radius
 * rail at all but a ceiling on how long a video could be captioned, and it sat below the
 * length of an ordinary talking head.
 */
export const AGENT_MAX_OPS_PER_TURN = 200;
/** The same bound across a whole run. Also excludes derived fan-out. */
export const AGENT_MAX_OPS_PER_RUN = 800;
const DEFAULT_MAX_OPS_PER_TURN = AGENT_MAX_OPS_PER_TURN;
const DEFAULT_MAX_OPS_PER_RUN = AGENT_MAX_OPS_PER_RUN;
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
  // A MUTATION is an attempt, not an answer, and it is already credited as one.
  //
  // `progressed` reads `(attemptedEdit && !repeatedRejection) || turnLearnedSomethingNew`.
  // The first clause is where a proposed edit earns its progress, and it deliberately
  // withholds that credit from a turn refused at the same wall as the last one. Letting
  // the same proposal ALSO earn credit through the second clause hands it back — and it
  // did: in `beat-sync` r1 each of twenty-nine refused turns called `add_clips` with
  // slightly different arguments, so each produced a first-seen novelty key, `callAnswered`
  // said the turn had learned something, and the stall streak reset every time. Five facts
  // were derived across thirty-two model calls; the run's own working memory knew it had
  // stopped learning eight minutes before it stopped spending.
  //
  // Nothing legitimate loses credit here. A mutation that LANDS resets every streak
  // explicitly in the applied branch, and a mutation that is refused for a NEW reason
  // still passes the attempt clause.
  if (fact.role === 'mutation') return false;
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

/**
 * Default cost bound on one run, in USD (goal.md Workstream D: "bound every run with
 * explicit turn, time, and cost budgets, surfaced to the user before an expensive
 * operation starts"). Generous on purpose — a good thirty-call montage on a large model
 * costs a few dollars, and a cap that kills a valid long run trades correctness for
 * cost, which the priority order forbids. What it stops is the run that spends without
 * landing anything: the captured run in plan/PLAN.md burned $1.20 applying nothing, and
 * nothing bounded it. An unpriced provider (usd stays 0) never trips this.
 */
export const DEFAULT_MAX_RUN_USD = 5;
/** Default wall-clock bound on one run, in minutes. */
export const DEFAULT_MAX_RUN_MINUTES = 20;

/**
 * The run's wall-clock bound in milliseconds — the ONE place `maxMinutes` meets its default.
 *
 * Shared with the orchestrator, which arms the same number as a live deadline on the step
 * in flight (`reliability/deadline.ts`). Two copies of this expression is two budgets: run
 * `369e8c82` stopped at neither, and a deadline that disagreed with the reducer's own cap
 * would stop a run the reducer then refused to call over-budget.
 */
export function maxWallMsFor(maxMinutes: number | undefined): number {
  return (maxMinutes ?? DEFAULT_MAX_RUN_MINUTES) * 60_000;
}

/** Run bounds resolved from the command's {@link AgentOptions} (with defaults). */
export interface ConductorConfig {
  readonly maxSteps: number;
  readonly maxOpsPerTurn: number;
  readonly maxOpsPerRun: number;
  /** Cost bound in USD — see {@link DEFAULT_MAX_RUN_USD}. */
  readonly maxUsd: number;
  /** Wall-clock bound in milliseconds — see {@link DEFAULT_MAX_RUN_MINUTES}. */
  readonly maxWallMs: number;
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
  /**
   * How many of {@link cumulativeOps} are derived fan-out (`ToolSpec.derivedFanOut`).
   * The per-run bound subtracts these for the same reason the per-turn one does — it
   * bounds the model, not the length of the video being captioned.
   */
  readonly derivedOpTotal: number;
  /** Turns that produced applied edits (the completion report's step count). */
  readonly appliedTurns: number;
  /**
   * How many turns in a row made no progress (reset to 0 by any turn that applied or
   * attempted an edit, or learned something new — see {@link turnMadeProgress}). The run
   * converges and stops once this reaches {@link STALL_CONFIRM_TURNS}. It is the stop for
   * a run that is provably STUCK; a run that keeps finding something new is bounded by the
   * editor's cost and time budgets instead, never by a count of how long it looked.
   */
  readonly stallStreak: number;
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
  /**
   * `name:error` of every call the run's DETERMINISTIC refusal path has already turned
   * down (see {@link TurnCallFact.failureKey}). A call that settles to a key already in
   * here is refused instead of folded: the run has proof that exact refusal is what this
   * tool answers, so paying for it again cannot teach it anything.
   *
   * Banked UNCONDITIONALLY, which is the exact inverse of {@link ConductorState.seenCallKeys}
   * and for the mirrored reason: that set is a claim that the run HOLDS an answer, so only
   * a call that answered may enter it. This one is a claim that the run has already been
   * REFUSED, and only a failure can prove that.
   *
   * Cleared by any applied edit. A validator verdict is a statement about the arrangement
   * that was in front of it ("this overlaps the clip at 3s"), so the patch that changes the
   * arrangement retires it — the same reason {@link ConductorState.lastRejectionReason}
   * clears there. Without that, one rejected `add_clip` would lock out every later
   * `add_clip` whose cause the run had genuinely fixed.
   */
  readonly seenFailureKeys: readonly string[];
  /** Count + reasons of proposed ops the validator rejected (empty-run notice). */
  readonly rejectedOpCount: number;
  readonly rejectionReasons: readonly string[];
  /**
   * The reason the previous turn was rejected, so a VERBATIM repeat is not counted as
   * progress.
   *
   * "A rejected op is a bounded retry" was the rule, and nothing bounded it. Run `ea8e46ec`
   * proposed the same 61-clip montage six times over thirty minutes, was refused six times
   * with one byte-identical sentence, and reset its own stall streak on every attempt
   * because it had "attempted an edit". A retry that changes nothing about the proposal AND
   * learns nothing new is the same nothing the stall guard exists to catch.
   *
   * Cleared by any applied edit, so a long multi-step edit that hits one bad step and
   * recovers is untouched. Empty string means "no rejection stands" — always present, so
   * every state literal carries it and none can silently forget to.
   */
  readonly lastRejectionReason: string;
  /**
   * The SMALLEST refusal scale seen so far at the wall named by {@link lastRejectionReason}
   * — the run's best attempt at getting through it. Absent when no rejection stands, or
   * when the standing one reports no scale.
   *
   * Why a floor and not simply the last turn's scale: `beat-sync` r3 of `session6` went
   * 12 → 10 → 10 → 18 → 24 → 4 → 8 → 8 → 2 off-grid cuts. Comparing against the previous
   * turn alone would credit 8 → 2 and 24 → 4 but also 18 → … every oscillation back down to
   * a number the run had already beaten, which is not new ground. A new LOW is.
   *
   * Reset (not merely lowered) when the wall changes, and cleared by any applied edit,
   * for the same reason {@link lastRejectionReason} is: a refusal describes the arrangement
   * the validator was shown, and the patch that changes it retires the measurement too.
   */
  // `| undefined` explicitly: `exactOptionalPropertyTypes` is on, and this field is
  // ASSIGNED undefined (an applied edit retires the measurement), not merely omitted.
  readonly lastRejectionScale?: number | undefined;
  readonly cancelled: boolean;
  /** Integrity failure is terminal and distinct from creator cancellation. */
  readonly integrityFailed: boolean;
  /**
   * What the run has spent so far, folded from each turn's {@link AgentTurnResult.runUsd}
   * / {@link AgentTurnResult.runElapsedMs} so the pure reducer can hold the run to its
   * budget without a clock or a price table of its own. Always present; 0 until a turn
   * reports.
   */
  readonly runUsd: number;
  readonly runElapsedMs: number;
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
   * The plan the MODEL wrote with `update_plan`, as its latest call left it
   * (`kernel/model-plan.ts`). Present ⇒ the model owns the plan: its list is the checklist
   * the editor sees, a reply with no tool call continues the run while an item is open,
   * and the positional drafted ledger ({@link planSteps}) keeps only its internal
   * bookkeeping — it never again draws over the model's list.
   *
   * Absent until the model first writes one, which leaves every run that never calls
   * `update_plan` — and every `planFirst` run — exactly as it was.
   */
  readonly modelPlan?: readonly ModelPlanItem[];
  /**
   * What the run had done the last time a no-tool reply was CONTINUED over an open plan:
   * how much had landed, and what the plan said ({@link planProgressMark}).
   *
   * This is the bound on that continuation, and it is a bound by progress rather than a
   * one-shot latch. A reply that ends with open items continues the run; the next one does
   * too if anything landed or the plan moved in between; a second reply with the SAME mark
   * proves the continuation bought nothing, and the run settles and reports what is open.
   */
  readonly modelPlanDoneMark?: string;
  /**
   * Set once a reply with no tool call has been continued over an unfinished DRAFTED ledger
   * (`planFirst`). Once per run: the second such reply settles the run — the model has heard
   * which step is next and chosen to stop, and that choice is its to make.
   */
  readonly ledgerContinued?: boolean;
  /**
   * {@link modelPlanObjectiveKey} of the request this run works toward, stamped on every plan
   * event the model's list produces so the next run continuing that request can find it
   * (AL5). Set at the start of an agent run; absent only on the idle state.
   */
  readonly modelPlanObjectiveKey?: string;
  /**
   * The run's durable task memory (ADR 0075). Distinct from every other field here:
   * those describe the HARNESS's view of the run (how many turns, how stalled, which
   * ledger step), while this is the TASK's — what the run learned, decided, and did.
   * The harness fields are all resettable per turn; this one is the thing that must
   * survive every turn, every compaction, and every restart.
   */
  readonly working: RunWorkingState;
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
      maxUsd: DEFAULT_MAX_RUN_USD,
      maxWallMs: DEFAULT_MAX_RUN_MINUTES * 60_000,
      planApprovalGated: false,
      diminishingReturnsTurns: DIMINISHING_RETURNS_TURNS,
      diminishingReturnsMinOutputTokens: DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS,
    },
    stepIndex: 0,
    cumulativeOps: [],
    derivedOpTotal: 0,
    appliedTurns: 0,
    stallStreak: 0,
    recentOutputDeltas: [],
    seenCallKeys: [],
    seenFailureKeys: [],
    rejectedOpCount: 0,
    rejectionReasons: [],
    lastRejectionReason: '',
    runUsd: 0,
    runElapsedMs: 0,
    working: initialWorkingState({ runId: turnRef.turnId, request: '' }),
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
  /**
   * The task stage this turn runs in (ADR 0075). Bookkeeping only: it labels the run's
   * memory and lets the handler tell a truncated reply at the end of a run from one in the
   * middle. It never narrows the tools a turn may call or how hard it thinks (ADR 0199).
   */
  readonly stage?: RunStage;
  /**
   * The run's task memory, so the handler can brief the model with it (ADR 0075 §3.3).
   * Passed on the effect rather than read from state by the handler, because the handler
   * is deliberately stateless — every input a turn depends on arrives here.
   */
  readonly working?: RunWorkingState;
  /**
   * The `name:error` keys the run has already been refused with
   * ({@link ConductorState.seenFailureKeys}), so the handler can refuse a call that
   * settles to one of them instead of feeding the model the same sentence again.
   *
   * Omitted while the set is empty, which keeps the effect byte-identical to what every
   * existing caller and fixture already asserts on.
   */
  readonly seenFailureKeys?: readonly string[];
  /**
   * The model's plan ({@link ConductorState.modelPlan}), for the briefing to show and so
   * the handler knows not to draw the drafted ledger over it. Omitted until one exists.
   */
  readonly modelPlan?: readonly ModelPlanItem[];
}

/** Run the deterministic self-check over the working copy and report what it finds. */
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
  /**
   * The drafted plan as it finished, so the completion report can say which of the steps
   * the run announced were never completed (GOLDEN-C.19).
   *
   * EMPTY when the run drafted no plan, even though {@link ConductorState.planSteps} is
   * not: an unplanned run appends one derived step per turn purely for status tracking
   * (see `runTurn` in the orchestrator), and those are a log of what the run DID, not a
   * statement of what it set out to do. Listing the last one as "running" would report a
   * finished turn as unfinished work.
   *
   * Also EMPTY when the model owns the plan: {@link modelPlan} is then the account.
   */
  readonly planSteps: readonly PlanStep[];
  /**
   * The model's plan as the run ended ({@link ConductorState.modelPlan}), so the completion
   * report can list every item that is not done in the model's own words. Absent when the
   * model never wrote one.
   */
  readonly modelPlan?: readonly ModelPlanItem[];
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
  /**
   * `name:error` for a call the DETERMINISTIC refusal path turned down — argument
   * validation or the per-call validator probe, never a host/transport error.
   *
   * The error is the identity, not the arguments. In run `7d159862` `caption_the_edit`
   * was refused four times with the byte-identical sentence
   * `add_caption_layer.end must be greater than start.`; three attempts shared one set of
   * arguments and the fourth varied both `preset` and `maxWordsPerCue`, so an args-keyed
   * guard would have waved that one through. Roughly ten of the run's eighteen model
   * calls went into that loop.
   *
   * Absent for every success, every warning, and every host failure — the last of those
   * deliberately, because a sidecar restart or a network timeout is transient and banking
   * it would block work that would have succeeded on the next attempt.
   */
  readonly failureKey?: string;
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
  /** The run's cumulative cost in USD after this turn (the runtime keeps the meter). */
  readonly runUsd?: number;
  /** Milliseconds since the run started, at the end of this turn. */
  readonly runElapsedMs?: number;
  /** The run's signal aborted at the turn boundary / mid-stream (no plan event). */
  readonly aborted: boolean;
  /**
   * The turn ended because the RUN'S OWN wall-clock deadline fired, not because the editor
   * pressed Stop (`reliability/deadline.ts`). Set only when the interrupted turn folded
   * nothing — a turn that finished its work first reports that work normally and is stopped
   * by the ordinary between-steps budget check.
   *
   * A separate flag rather than a flavour of {@link aborted} because the two must not settle
   * the same way. A cancellation is the editor saying "stop"; a deadline is the run saying
   * "that is all the time you gave me" — and a run out of time still owes the editor the
   * account of what it applied. See the fold in `onTurnResult`.
   */
  readonly deadlineExpired?: boolean;
  /** The model made no tool calls — it considers the goal met. */
  readonly done: boolean;
  /**
   * The turn ended the run WITHOUT a reply from the model: the provider cut every attempt
   * off, returned nothing, or the run's ledger could not be trusted to call it at all. Set
   * only with {@link done}. Such a turn is not "the model finished" — it ends the run
   * straight away, and a run that changed nothing this way settles as failed rather than as
   * an answer (ADR 0199).
   */
  readonly unanswered?: boolean;
  /** A host tool was cancelled mid-turn (⇒ a `failed` 'Stopped by user' plan + cancel). */
  readonly anyToolCancelled: boolean;
  /** A host tool genuinely failed (drives a real-work turn's plan-step status). */
  readonly anyToolFailed: boolean;
  /**
   * How many of {@link turnOpCount} are DERIVED fan-out — operations a tool built from
   * the project rather than from the model's arguments (`ToolSpec.derivedFanOut`). The
   * blast-radius bounds subtract these: they bound the model, not the media. Absent ⇒ 0.
   */
  readonly derivedOpCount?: number;
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
  /**
   * Did this turn's patch move, add or remove PICTURE on the timeline?
   *
   * Read for one thing only: which banked refusals an applied edit clears
   * (`tool-refusal.ts#PICTURE_ARRANGEMENT_CAUSES`). A caption restyle lands hundreds of
   * operations and moves no picture, so it must not clear the run's memory of "there is
   * already picture at 0s" — clearing it there is why one run was refused the identical
   * `add_stock` twenty times.
   *
   * Computed by the orchestrator from the merged picture spans before and after the patch
   * (`editor-core#pictureOccupancySignature`), because the reducer is pure and holds no
   * project. Absent ⇒ treated as TRUE, the conservative reading and the behaviour before
   * this field existed.
   */
  readonly pictureArrangementChanged?: boolean;
  /** Pre-described applied ops for the reducer's `timeline_action` cards. */
  readonly describedActions: readonly DescribedAction[];
  /**
   * The arrangement as it stands AFTER this turn's patch, in one line.
   *
   * Present only on a turn that applied something. Recorded as a `timeline_dependent`
   * fact, which means it replaces the previous one rather than accumulating —
   * `onProjectRevisionChanged` has just dropped it.
   *
   * WHY: applying a patch invalidates every timeline fact the run held, correctly, because
   * a cut moves the ids and positions the next patch is written against. But the run
   * AUTHORED that cut and is handed the resulting project, so making it call
   * `get_timeline` to learn what it just did is asking it to pay for knowledge it already
   * has. Run `fc10301a` alternated apply / re-read for its entire second half — roughly
   * 40% of its model calls — and the re-read is also what collided with the spin guard.
   *
   * Computed from the post-apply project by the caller, never from the model's prose.
   */
  readonly arrangement?: string;
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
   * The refusal's STABLE identity, free of the values that vary between attempts —
   * `beat-grid:off-grid`, `validator:overlap_error`, `over-cap`. Absent for a refusal
   * whose producer states no key, in which case {@link rejection} is the identity, as
   * before.
   *
   * WHY the two are separate: `rejection` is what the editor and the model read, so it
   * names the exact off-grid times or the exact op count — and that is what broke
   * {@link ConductorState.lastRejectionReason} as a guard. In `beat-sync` r1 the beat grid
   * refused twenty-nine consecutive turns for one reason, listing different offending cuts
   * each time; no two sentences matched, so `repeatedRejection` never fired and the run
   * re-issued the same rejected edit for twenty minutes and $3.93.
   */
  readonly rejectionKey?: string;
  /**
   * HOW MUCH of the proposal the refusal is still refusing — offending boundaries,
   * validator errors, operations over the cap. A count, never a severity, and absent for a
   * refusal that has no size (`beat-grid:ungrounded` is true or false, never partly fixed).
   *
   * {@link rejectionKey} says the turn hit the same wall as the last one. This says whether
   * it is getting through it, and the two together are what separate a run repeating itself
   * from a run converging — see {@link ConductorState.lastRejectionScale}.
   */
  readonly rejectionScale?: number;
  /**
   * The turn's own prose, for semantic-loop detection (ADR 0075 §3.5). Optional so the
   * legacy loop and existing fixtures keep compiling; without it a turn's intent reads as
   * `unknown`, which never contributes to a loop — silence is not evidence of repetition.
   */
  readonly rationale?: string;
  /**
   * Set on a done turn when the review of the run's own edits, awaited (bounded) at that
   * moment, came back with findings that are now queued on the steering channel. The reducer
   * gives the model ONE more turn to act on them instead of verifying; the runtime makes that
   * wait at most once per run, so a second declaration settles as usual.
   *
   * WHY a flag and not a reducer rule: the reducer holds no review state and cannot wait on
   * anything. The runtime waits and measures; the reducer decides.
   *
   * This is the one continuation a finished reply can still earn besides the model's own
   * open plan items (ADR 0199), and it is earned by EVIDENCE the model has not seen — a
   * rendered look at its last edit — never by a rule's opinion of the timeline.
   */
  readonly lateReviewSteering?: boolean;
  /**
   * What the pixels said about the cuts THIS apply is answerable for
   * (`kernel/picture-verification.ts`, VU7).
   *
   * The reducer holds no project and no shot ledger, so it cannot compute a picture diff
   * itself — the effect layer has both at the moment of the apply and hands the finished
   * report over here, exactly as it already does for `arrangement` and `callFacts`. The
   * runtime measures; the reducer folds.
   *
   * Absent when the run has no ledger, when the apply touched no picture cut it is
   * responsible for, or when the host wired no evidence route at all. It is a FACT
   * channel and nothing else: no value of it can turn an applied turn into a rejected
   * one, which is why it is read only inside the `applied` branch and why nothing
   * downstream of the fold reads it back.
   */
  readonly pictureVerification?: PictureVerificationReport;
  /**
   * The plan the model wrote with `update_plan` during this turn — the last call's list,
   * since each call replaces the whole plan. Absent when the turn did not touch it.
   *
   * Folded before every other decision in {@link onTurnResult}: the call succeeded whatever
   * else the turn did, so a turn that is then cancelled or rejected still leaves the
   * model's plan standing.
   */
  readonly modelPlan?: readonly ModelPlanItem[];
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
/** One self-check finding, as the verify effect reports it. */
export interface VerifyCheck {
  readonly label: string;
  readonly detail: string;
}

export interface VerifyResult {
  readonly kind: 'verify';
  readonly ok: boolean;
  readonly summary: string;
  readonly failedChecks: readonly { readonly label: string; readonly detail: string }[];
  /**
   * Checks that came back `warn` — advisory by contract, and until now invisible.
   *
   * The Critic's advisory checks are deliberately non-blocking ("a false alarm here cannot
   * block a run that did the work"), and the price of that was that their advice never
   * arrived: only `failedChecks` was carried, so a `warn` reached the editor as the number
   * in "3 check(s) failed, 1 warning(s)" and nothing else. In run `fc10301a` the withheld
   * sentence was `checkReframeCoverage`'s — "any landscape source will render with black
   * bars" — over a montage of landscape stills in a 1080x1920 frame, which is the single
   * most actionable thing anyone could have said about that output.
   *
   * Carried separately from `failedChecks` so the severity distinction survives to the
   * event stream: a failure is a warning event, an advisory is a notification.
   */
  readonly warnedChecks: readonly { readonly label: string; readonly detail: string }[];
  readonly endSeq: number;
}

/**
 * Why the browser `agent()` loop's bounded repair pass produced no operations, or that it
 * produced some. The streaming agent run has no repair pass (ADR 0199): a second model
 * editing behind the first one's back is exactly the kind of harness decision the run's
 * own model should be making.
 */
export type RepairOutcome =
  | { readonly kind: 'applied'; readonly opCount: number; readonly note: string }
  | { readonly kind: 'no_calls' }
  | { readonly kind: 'all_rejected'; readonly reasons: readonly string[] }
  | { readonly kind: 'over_cap'; readonly opCount: number; readonly cap: number };

/** What the runtime folds back into the Conductor. */
export type ConductorResult =
  DraftPlanResult | ResumeResult | ApprovalResult | AgentTurnResult | VerifyResult;

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

/** The honest partial-run explanation: some edits landed, others were refused. */
function partialRunMessage(rejectedOpCount: number, rejectionReasons: readonly string[]): string {
  const plural = rejectedOpCount === 1 ? '' : 's';
  const why = rejectionReasons.length > 0 ? ` (${rejectionReasons.join('; ')})` : '';
  return (
    `Some of this edit did not land — ${rejectedOpCount} proposed change${plural} ` +
    `couldn't be applied to the timeline${why}. What did apply is on the timeline and can ` +
    'be undone.'
  );
}

/**
 * Why the run stopped, when it stopped because it stopped progressing.
 *
 * "No further edits could be found for this request" was said unconditionally, and in run
 * `ea8e46ec` it was false: 61 edits were found, six times over, and refused six times by one
 * internal rule. The editor was shown a stall and two self-check warnings about the SYMPTOM
 * ("the cut uses 0 shots"), and nothing at all about the cause. A run that knows exactly why
 * it could not act must say so — that is the difference between a report and a shrug.
 */
function stalledRunMessage(rejectionReasons: readonly string[]): string {
  if (rejectionReasons.length === 0) {
    return 'The run stopped making progress — no further edits could be found for this request.';
  }
  const plural = rejectionReasons.length === 1 ? '' : 's';
  return (
    `The run stopped making progress — its edits kept being refused (${rejectionReasons.length} ` +
    `reason${plural}): ${rejectionReasons.join('; ')}.`
  );
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

/**
 * The kinds of action one applied patch made, each with its count, in first-seen order.
 *
 * The run's ledger used to take one row per applied OPERATION, and the whole ledger rides in
 * every `run_state` event the run streams and persists. Desktop run `001be135` regenerated
 * its captions a few times — about a thousand operations each — so its ledger reached 5,730
 * rows, every `run_state` event carried ~3 MB of it, and the run died at the 64 MiB
 * durable-log limit. A row per kind per patch keeps everything the briefing's ALREADY
 * APPLIED section and a host refusal need (`recordHostRefusal` corrects rows by patch id).
 */
function actionTally(
  actions: readonly DescribedAction[],
): readonly { readonly action: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const { action } of actions) counts.set(action, (counts.get(action) ?? 0) + 1);
  return [...counts].map(([action, count]) => ({ action, count }));
}

/** Past this many actions in one patch, the action cards are grouped by kind. */
const ACTION_CARDS_SHOWN = 24;

/**
 * The `timeline_action` cards for one applied patch: one per action, or — for a patch too
 * big to list — one per kind, with its count and the first and last of its details. A
 * caption regeneration used to put a thousand rows in the sidebar.
 */
function actionCards(actions: readonly DescribedAction[]): readonly DescribedAction[] {
  if (actions.length <= ACTION_CARDS_SHOWN) return actions;
  return actionTally(actions).map(({ action, count }) => {
    const ofKind = actions.filter((a) => a.action === action);
    const first = ofKind[0]!;
    const last = ofKind.at(-1)!;
    return {
      action: count > 1 ? `${action} ×${String(count)}` : action,
      detail: count > 1 ? `${first.detail} … ${last.detail}` : first.detail,
      ...(first.refs ? { refs: first.refs } : {}),
    };
  });
}

/** Replace one ledger step immutably. */
function withStep(steps: readonly PlanStep[], index: number, next: PlanStep): readonly PlanStep[] {
  return steps.map((s, i) => (i === index ? next : s));
}

/**
 * What the run has DONE, as of now, in the two terms the model's plan can move in: work
 * that landed on the timeline, and what the plan says. See
 * {@link ConductorState.modelPlanDoneMark}.
 *
 * Applied turns as well as the operation count, because the count alone can go DOWN (a host
 * refusal winds `cumulativeOps` back) and a smaller number is not "nothing happened".
 */
export function planProgressMark(state: ConductorState): string {
  return [
    `turns:${String(state.appliedTurns)}`,
    `ops:${String(state.cumulativeOps.length)}`,
    modelPlanDigest(state.modelPlan ?? []),
  ].join('\n');
}

/**
 * Fold the plan a turn wrote into the run: the plan itself, and a step budget wide enough to
 * work through it.
 *
 * The widening is the drafted plan's (W3.4), for the same reason: turns map onto work, and
 * a host that set a small `maxSteps` would otherwise end a compliant run with items it never
 * reached. It never shrinks an explicit cap, and it is bounded by the schema's own item cap
 * (`MODEL_PLAN_MAX_ITEMS`), so no plan can widen it without limit; the cost and time budgets
 * bound the run regardless.
 */
function withModelPlan(state: ConductorState, plan: readonly ModelPlanItem[]): ConductorState {
  return {
    ...state,
    modelPlan: plan,
    config: {
      ...state.config,
      maxSteps: Math.max(state.config.maxSteps, plan.length + PLAN_STEP_HEADROOM),
    },
  };
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
    ...(state.seenFailureKeys.length > 0 ? { seenFailureKeys: state.seenFailureKeys } : {}),
    ...(state.modelPlan ? { modelPlan: state.modelPlan } : {}),
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
 * The request a run works toward, as the conductor resolves it: the reader's objective when
 * `streamAuto` ran, else the message (a bare nudge resolving to the request under it). One
 * function, so the run's objective and the key its plan is filed under never disagree.
 */
export function runObjectiveText(
  agentOptions: AgentOptions | undefined,
  input: Pick<ContextInput, 'userPrompt' | 'history'>,
): string {
  return (
    agentOptions?.requestReading?.objectiveText ??
    deriveObjectiveText(input.userPrompt, input.history)
  );
}

/** The model's plan as a keyed record for a plan event, or `undefined` when it has none. */
export function modelPlanRecordOf(state: ConductorState): ModelPlanRecord | undefined {
  if (!state.modelPlan || state.modelPlanObjectiveKey === undefined) return undefined;
  return { objectiveKey: state.modelPlanObjectiveKey, items: [...state.modelPlan] };
}

/**
 * The plan a run starts with (AL5): a resumed run's own list from its checkpoint, else the
 * list the last run on the request this message continues ended with. A new request gets
 * none — `RequestReading.continuedPlan` is only ever set for a continuation.
 */
function inheritedModelPlan(
  agentOptions: AgentOptions,
  resuming: boolean,
): readonly ModelPlanItem[] | undefined {
  if (resuming) return parseModelPlan(agentOptions.resume?.modelPlan);
  return parseModelPlan(agentOptions.requestReading?.continuedPlan);
}

/**
 * Finalize the run: emit the resume checkpoint (cancelled runs with applied work),
 * the empty-run notice (a non-cancelled run that landed nothing after trying), then
 * hand off to the {@link FinalizeEffect} which emits the diff + report + terminal
 * reasoning/status. Shared by the cancel path and the post-verify path.
 */
function finalize(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  // The plan card must not outlive the run. A step still `pending` or `running` when the
  // run ends kept its hollow dot or spinner on the pinned ledger after "Made 1 edit" —
  // the UI walk's `reports/golden/s9-ui-walk/04-cards-expanded.png` reads "Plan 1/2" with
  // a step apparently in progress under a finished run. Settle every unreached step as
  // failed with the reason on its mark, in the same terminal event the reducer already
  // owns for the ledger.
  //
  // The model's plan settles the same way, and it is the ONLY checklist once it exists.
  if (state.modelPlan) {
    if (openPlanItems(state.modelPlan).length > 0) {
      events.push(
        em.plan(
          modelPlanSteps(
            state.modelPlan,
            state.cancelled ? 'Stopped before this was done' : 'Not done — the run ended first',
          ),
          // The steps settle open items as failed; the record keeps them open, because it is
          // what a follow-up continuing this request picks up (AL5).
          modelPlanRecordOf(state),
        ),
      );
    }
  } else if (
    state.ledgerLength > 0 &&
    state.planSteps.some((step) => step.status === 'pending' || step.status === 'running')
  ) {
    const reason = state.cancelled ? 'Stopped before this step' : 'The run ended before this step';
    events.push(
      em.plan(
        state.planSteps.map((step) =>
          step.status === 'pending' || step.status === 'running'
            ? { ...step, status: 'stopped' as const, detail: reason }
            : step,
        ),
      ),
    );
  }
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
        // And its own to-do list (AL5): a resumed run without it re-planned from the brief.
        ...(state.modelPlan ? { modelPlan: [...state.modelPlan] } : {}),
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
  //
  // The model's plan is the same promise made by the model instead of a drafter, and its
  // open items are the work the run said it would do and did not — named, because the
  // editor watched each one on the checklist. Same gates: not on a Stop, and not on a run
  // that changed nothing (the empty-run notice below is the truer account of that one).
  const openModelItems = state.modelPlan ? openPlanItems(state.modelPlan) : [];
  if (!state.cancelled && openModelItems.length > 0 && state.cumulativeOps.length > 0) {
    events.push(
      em.warning(
        `Not everything in the plan was done — still open: ${describeOpenItems(state.modelPlan ?? [])}.`,
      ),
    );
  }
  if (
    !state.cancelled &&
    !state.modelPlan &&
    state.ledgerLength > 0 &&
    state.cumulativeOps.length > 0
  ) {
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
  if (!state.cancelled && state.cumulativeOps.length > 0 && state.rejectedOpCount > 0) {
    // A run that landed SOMETHING used to say nothing about what it could not land, because
    // the only account of a refusal was gated on the run being completely empty. Run
    // `ea8e46ec` landed two audio operations and was refused sixty-one picture clips six
    // times over; the editor saw a stall notice and two warnings about the resulting
    // timeline, and no word about the rule that produced it. A partial outcome the creator
    // cannot distinguish from a complete one is the failure, not the partiality.
    events.push(em.warning(partialRunMessage(state.rejectedOpCount, state.rejectionReasons)));
  }
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
        // Only a DRAFTED ledger travels — see `FinalizeEffect.planSteps` — and only while the
        // model has not taken the plan over.
        planSteps: state.ledgerLength > 0 && !state.modelPlan ? [...state.planSteps] : [],
        ...(state.modelPlan ? { modelPlan: [...state.modelPlan] } : {}),
      },
    ],
    events,
  };
}

/** Cancel the run (user interruption) and finalize with a checkpoint. */
function cancelFinalize(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  return finalize({ ...state, cancelled: true }, em, events);
}

/**
 * Why the run must stop now on its cost or time budget, or `undefined` while within both.
 * Cost is only ever compared when a turn reported a price; an unpriced run (usd 0) is
 * never stopped for money it could not measure.
 *
 * THE BUDGET IS A STOPPING RULE, NOT A CEILING, and the notice now says so. The check
 * runs after a turn settles, so the turn that crosses the line has already been paid for;
 * and `toVerify` — the self-check and its one bounded repair pass — is what produces the
 * report the notice promises, so it runs after the stop and costs model calls of its own.
 * Run `137d8fd0` announced "$26.61 spent" against a $26.50 budget and finished at $27.76,
 * 4.8% over, and every dollar of that gap is one of those two. Suppressing the check to
 * hold the line would buy the number by deleting the verdict.
 */
export function budgetExhausted(state: ConductorState): string | undefined {
  const { maxUsd, maxWallMs } = state.config;
  const steps = `${String(state.stepIndex)} step${state.stepIndex === 1 ? '' : 's'}`;
  if (state.runUsd > 0 && state.runUsd >= maxUsd) {
    return (
      `Reached this run's $${maxUsd.toFixed(2)} budget after ${steps} ` +
      `($${state.runUsd.toFixed(2)} spent) — no more editing turns; a final self-check ` +
      'still runs, then the run reports what was applied.'
    );
  }
  if (state.runElapsedMs >= maxWallMs) {
    return (
      `Reached this run's ${String(Math.round(maxWallMs / 60_000))}-minute limit after ${steps} ` +
      '— no more editing turns; a final self-check still runs, then the run reports what ' +
      'was applied.'
    );
  }
  return undefined;
}

/** Continue to the next turn, or verify once the step cap — or the cost/time budget — is reached. */
function advance(state: ConductorState, em: Emitter, events: AiEvent[]): ConductorStep {
  const exhausted = budgetExhausted(state);
  if (exhausted !== undefined) {
    events.push(em.notification(exhausted));
    return toVerify(state, em, events);
  }
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
    maxUsd: ao.maxUsd ?? DEFAULT_MAX_RUN_USD,
    maxWallMs: maxWallMsFor(ao.maxMinutes),
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
  // The budget is NOT announced here. It is a setting the editor shows permanently
  // (Settings → AI → Run budget), so the user can read the same three numbers whenever
  // they want; repeating them as the second event of every run spent a transcript line
  // on something nothing had changed. This supersedes the earlier reading of goal.md
  // Workstream D ("surfaced before an expensive operation starts") — the maintainer chose
  // a permanent surface over a per-run one. Do not put the notice back. What the run
  // still owes the user is the REASON it stopped, which `budgetExhausted` says at the
  // moment a limit is actually reached.
  const events: AiEvent[] = [em.status('thinking')];

  const resuming = !!(ao.resume && ao.resume.ops.length > 0);
  const inheritedPlan = inheritedModelPlan(ao, resuming);
  // A run that carries a plan forward already has one; drafting another would be a model
  // call spent on a list the model's own then draws over.
  const planning =
    !resuming && inheritedPlan === undefined && !!ao.planFirst && !command.stream.signal?.aborted;
  const restored = resuming ? parseWorkingState(ao.resume?.working) : null;
  // What the run is actually being asked to do. A message that only says "continue"
  // names no work of its own, so it resolves to the request underneath it: seeding the
  // objective from the literal nudge made "contine" the run's outcome, its acceptance
  // criterion, its committed decision AND the criterion verification checked — so the run
  // both forgot the real goal and could only report itself inconclusive.
  //
  // The command reader (`streamAuto`'s classifier) settles that first when it ran: it reads
  // "load the tools and complete the task" as carrying on with the brief above it, which
  // the word-list fallback cannot — that message has content words, so run `6cb12e30`'s
  // follow-up turns recorded it verbatim as their objective and lost the brief.
  const objectiveText = runObjectiveText(ao, command.input);
  const created = initialWorkingState({
    runId: command.stream.runId ?? command.stream.turnId,
    // The request the run works toward, not the nudge that started it: every echo check
    // (`isRequestEcho`) compares against this field, so recording "load the tools and
    // complete the task" here stored the continued 27k-character brief as a NEW outcome in
    // every run-state serialization and printed it in every briefing.
    request: objectiveText,
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
  const references = command.input.references ?? [];
  const directives = referenceDirectives(references);
  // Read off the OBJECTIVE, not the literal message: the Critic reads the same text
  // (`orchestrator.ts#critiqueOptions`), and a criterion and the check that settles it
  // must be about one request.
  const checkable = checkableAcceptance(objectiveText, statedDuration(ao), directives);
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
  const carried = resuming
    ? planned
    : carryForwardWorkingState(
        parseWorkingState(ao.carriedForward),
        planned,
        // The complete live set of tiles, not "the ones re-sent this turn": a reference the
        // editor never removed still arrives on every turn, so a subject missing from this
        // set means the tile is gone and its decision must stop binding (P3.5).
        references.map((profile) => profile.id),
      );
  // What the attached references commit this run to. Recorded AFTER the carry-forward for
  // the same reason it runs after `commitExecutionPlan`: a decision recorded earlier would
  // be either erased by the plan or duplicated by the inherited copy of itself. Re-recording
  // a reference the last run already committed is skipped by the text match below, so the
  // DECIDED section holds one line per reference rather than one per turn.
  const alreadyDecided = new Set(carried.decisions.map((decision) => decision.decision));
  const freshWorking = referenceDecisions(references).reduce(
    (state, entry) =>
      alreadyDecided.has(entry.decision)
        ? state
        : recordDecision(state, {
            decision: entry.decision,
            reconsiderIf: entry.reconsiderIf,
            committed: true,
            source: 'reference',
            until: 'superseded',
            subject: entry.subject,
          }),
    carried,
  );
  const started: ConductorState = {
    phase: resuming ? 'resuming' : planning ? 'planning' : 'executing',
    turnRef: command.stream,
    goal: command.input.userPrompt,
    config,
    stepIndex: 1,
    cumulativeOps: [],
    derivedOpTotal: 0,
    appliedTurns: 0,
    stallStreak: 0,
    recentOutputDeltas: [],
    seenCallKeys: [],
    seenFailureKeys: [],
    rejectedOpCount: 0,
    rejectionReasons: [],
    lastRejectionReason: '',
    runUsd: 0,
    runElapsedMs: 0,
    cancelled: false,
    integrityFailed: false,
    log: [],
    planSteps: [],
    ledgerLength: 0,
    working: restored ?? freshWorking,
    modelPlanObjectiveKey: modelPlanObjectiveKey(objectiveText),
    seq: em.seq(),
  };
  // The carried plan is the run's own from the first turn: the briefing shows it, the
  // no-tool continuation rule holds the run to its open items, and the editor sees the
  // checklist it left off with before the first model call returns.
  const seeded = inheritedPlan ? withModelPlan(started, inheritedPlan) : started;
  if (inheritedPlan) {
    events.push(em.plan(modelPlanSteps(inheritedPlan), modelPlanRecordOf(seeded)));
  }
  const firstEffect: ConductorEffect = resuming
    ? { kind: 'resume' }
    : planning
      ? { kind: 'draft_plan' }
      : runTurnEffect(seeded, 1);
  return { state: { ...seeded, seq: em.seq() }, effects: [firstEffect], events };
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

/**
 * The run's own reading of the request, drawn from the plan it just drafted — or
 * `undefined` when the plan says nothing the request did not.
 *
 * A drafted plan is the one place in the run where the model states what it believes the
 * request means BEFORE acting on it. That is what an objective's `outcome` is for, and
 * until now the field held a bounded copy of the request forever, which
 * `buildStateBriefing` then had to suppress as noise.
 *
 * Rejects a single step that echoes the request, because that is the seed arriving by
 * another route. Bounded, because this is stored and streamed on every turn.
 */
function planInterpretation(state: RunWorkingState, labels: readonly string[]): string | undefined {
  if (!state.objective.provisional) return undefined;
  const steps = labels.map((label) => label.trim()).filter(Boolean);
  if (steps.length === 0) return undefined;
  if (steps.every((step) => isRequestEcho(step, state.objective.request))) return undefined;
  const joined = `Plan: ${steps.join('; ')}`;
  return joined.length > PLAN_INTERPRETATION_CHARS
    ? `${joined.slice(0, PLAN_INTERPRETATION_CHARS).trimEnd()}…`
    : joined;
}

/**
 * How much of a drafted plan is kept as the run's outcome.
 *
 * Twice {@link REQUEST_ECHO_CHARS}: a real interpretation earns more room than the request
 * said back, and a twelve-step plan still has to fit in a state serialized every turn.
 */
const PLAN_INTERPRETATION_CHARS = 360;

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
  // The missing caller. `setObjective` is written to yield a provisional outcome — the
  // request read back — to "the first real interpretation", and `acceptance.ts` records
  // that nothing ever produced one: it "had exactly one caller, the seed itself". A
  // drafted plan IS an interpretation. It is the model saying, in its own words and before
  // it touches anything, what this request means it should do — which is the whole content
  // of an outcome.
  //
  // Only a plan that says something new is taken. One step that is the request echoed back
  // is the request echoed back however it arrived, and storing it as an interpretation
  // would put a second copy of the brief in a state that is persisted and streamed every
  // turn — the exact duplication `requestEcho` exists to stop.
  const interpretation = planInterpretation(state.working, r.labels);
  const interpreted = interpretation
    ? setObjective(state.working, {
        outcome: interpretation,
        acceptance: state.working.objective.acceptance,
      })
    : state.working;
  const working = commitExecutionPlan(interpreted, r.labels, 0);
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
    derivedOpTotal: 0,
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
  stateIn: ConductorState,
  r: AgentTurnResult,
  em: Emitter,
): ConductorStep {
  // The meter first: every path below derives its next state from `state`, so folding the
  // turn's spend here is what lets `advance` hold the run to its budget on any of them.
  let state: ConductorState = {
    ...stateIn,
    runUsd: r.runUsd ?? stateIn.runUsd,
    runElapsedMs: r.runElapsedMs ?? stateIn.runElapsedMs,
  };
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
      derivedOpTotal: 0,
    };
    for (const refusal of r.hostRefusals) {
      events.push(em.warning(`Couldn’t apply “${refusal.intent}” — ${refusal.reason}`));
    }
  }
  // The model's plan, before any path can return: the `update_plan` call succeeded whatever
  // else this turn did, and a cancelled or rejected turn must not lose it.
  if (r.modelPlan) state = withModelPlan(state, r.modelPlan);
  // Task stage first (ADR 0075 §3.2): derived from what the turn DID — the roles of the
  // tools it ran and whether a patch landed — never from what its prose claimed. A turn
  // that re-announces "let me understand the project" while calling nothing new moves
  // nothing, which is the point. `advanceStage` refuses any move the transition table
  // does not permit, so this can only fail to advance, never corrupt.
  const roles = r.callFacts.map((f) => f.role ?? 'other');
  // A patch made only of bookkeeping (a transcript, a lane, a marker) is not execution —
  // see `stage-policy.ts#BOOKKEEPING_OPERATION_TYPES` for the run that lost its whole
  // understanding phase to one.
  const target = settledStageFor(
    state.working.stage,
    roles,
    r.applied && executedAnEdit(r.appliedOps),
  );
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

  // Out of time, not cancelled. Run `369e8c82` was given 37 minutes, hung inside its
  // twentieth model call, and was still hanging 39 minutes later when the app closed — nine
  // committed patches, and a final status of `failed` that mentioned none of them. The
  // deadline that now cuts that call off must NOT settle it the way Stop does: it takes the
  // same route the between-steps budget check has always taken (`advance` → the
  // `budgetExhausted` notification → `toVerify`), so the run still verifies and still
  // reports what it applied.
  //
  // The elapsed floor is what makes that route deterministic. The deadline fired, so at
  // least `maxWallMs` of wall clock has passed by definition — but the reducer only ever
  // learns the time a turn chose to report, and a turn cut off mid-flight may report a
  // reading taken before it. Without the floor `budgetExhausted` could decline, `advance`
  // would start another turn, and that turn would walk straight back into an expired
  // deadline.
  if (r.deadlineExpired === true) {
    return advance(
      { ...base, runElapsedMs: Math.max(base.runElapsedMs, base.config.maxWallMs) },
      em,
      events,
    );
  }

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
    // A model-owned plan is the checklist instead; `finalize` settles it.
    if (state.ledgerLength > 0 && !state.modelPlan) events.push(em.plan([...planSteps]));
    return cancelFinalize({ ...base, planSteps }, em, events);
  }

  // A reply with no tool call is the model saying it has finished, and the run ends on it
  // except in two cases. Both are read off structured state that the model or the renderer
  // produced, never off a rule's opinion of the timeline (ADR 0199):
  //
  //   1. the run's plan still has work the model itself marked open — its own `update_plan`
  //      list has an item pending or in progress, or (planFirst) a drafted step no edit has
  //      reached yet, the latter once per run;
  //   2. a review of the run's last edit has rendered evidence the model has not seen.
  //
  // The deterministic checks are deliberately not on that list. They are measured after
  // every turn and shown to the model under WHERE YOU STAND, so a model that finishes has
  // already weighed them, and the final self-check reports them to the editor. Re-opening a
  // finished run because a check disagreed is what told desktop run `001be135` "The request
  // is not met yet — continuing" five times over, about a check that was measuring a muted
  // soundtrack, until the run failed with its edit on the timeline.
  if (r.done) {
    // No reply to honour: the warning the runtime already raised is the account.
    if (r.unanswered === true) {
      return toVerify({ ...base, modelDeclaredDone: false }, em, events);
    }
    // The review of the last edit, first. It landed while the model was saying it had
    // finished, and it is the only account of that edit's pixels the run will ever get; the
    // finding is already queued on the steering channel, so the next turn reads it. One
    // turn, bounded by the runtime (it waits for late reviews once per run) and by
    // `advance`'s step, clock and cost checks.
    if (r.lateReviewSteering === true) {
      return advance({ ...base, modelDeclaredDone: false }, em, events);
    }
    // THE MODEL'S OWN PLAN, next. Run `d8d2e445` replied "Not done yet: colour, speed,
    // transitions, fade, masking & graphics, SFX & levels, deliverables" after one montage,
    // and the run COMPLETED — a reply with no tool call was the end of the run, whatever the
    // reply said. Nothing here reads that prose. The model states what is left as data
    // (`update_plan`), and while an item is pending or in progress a reply is not the end.
    //
    // Bounded by PROGRESS, not by a latch: the run continues again after any continuation
    // that landed work or moved the plan, and settles on the first reply that finds the
    // mark unchanged — the continuation bought nothing, so another would buy nothing too.
    // `blocked` is not open, so a model that says why no tool can do an item can end on it.
    // `maxSteps`, the wall clock and the cost budget still bound all of it (`advance`).
    const nextItem = state.modelPlan ? nextOpenItem(state.modelPlan) : undefined;
    let stalledPlanNotice: string | undefined;
    if (state.modelPlan && nextItem) {
      const mark = planProgressMark(state);
      const open = openPlanItems(state.modelPlan).length;
      const items = `${String(open)} plan item${open === 1 ? '' : 's'}`;
      if (mark !== state.modelPlanDoneMark) {
        const working = setNextAction(state.working, {
          stage: state.working.stage,
          action: planItemLabel(nextItem),
        });
        events.push(
          em.notification(`${items} still open — continuing with “${planItemLabel(nextItem)}”.`),
        );
        return advance(
          { ...base, working, modelPlanDoneMark: mark, modelDeclaredDone: false },
          em,
          events,
        );
      }
      // Said out loud: the editor watched the run keep going and deserves to know why it
      // ended. What is left is named by `finalize` and the report.
      stalledPlanNotice = `Stopping with ${items} still open — nothing landed and the plan did not change since the last time the run said it was done.`;
    }
    // A drafted ledger (planFirst) the model has not taken over is the same promise made by a
    // drafter: one continuation toward its first unreached step, then the model's next reply
    // without a tool call ends the run. Nothing is withheld on that turn — the model hears
    // which step is next and decides what to do about it.
    const nextIndex = state.planSteps.findIndex((step) => step.status !== 'completed');
    const nextStep = nextIndex >= 0 ? state.planSteps[nextIndex] : undefined;
    if (state.ledgerLength > 0 && !state.modelPlan && nextStep && state.ledgerContinued !== true) {
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
        { ...base, working, ledgerContinued: true, modelDeclaredDone: false },
        em,
        events,
      );
    }
    if (stalledPlanNotice !== undefined) events.push(em.notification(stalledPlanNotice));
    return toVerify({ ...base, modelDeclaredDone: true }, em, events);
  }

  // A turn over the per-turn operation cap arrives here as an ordinary REJECTION (the
  // runtime refuses it with the cap in the reason and `rejectionKey: 'over-cap'`), and the
  // rejection path below continues the run so the model can send the edit in batches. It
  // used to end the run on the spot: desktop run `001be135` proposed a 111-clip rebuild in
  // one turn, was stopped before it could split it, and finished with one uncut clip.

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
  // The positional statuses above still track the drafted ledger internally (the verify
  // fold reads them), but once the model owns the plan they never reach the screen: the
  // checklist is one node per run, and this event would overwrite the model's list.
  if (state.ledgerLength > 0 && !state.modelPlan && (r.applied || failed)) {
    events.push(em.plan([...planSteps]));
  }
  // Per-call validator rejections count toward the empty-run notice even when the
  // turn also landed other calls' ops — the notice only fires when the whole RUN
  // lands nothing, so this only ever surfaces honest, user-relevant reasons.
  const rejectionTally = [...state.rejectionReasons];
  for (const note of r.rejectionNotes) {
    // Never bank a blank. These become the user-facing "(reason; reason)" list, and an
    // empty one renders as bare punctuation that says nothing and cannot be acted on.
    if (note.trim() === '') continue;
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
    for (const a of actionCards(r.describedActions)) {
      events.push(em.timelineAction(a.action, a.detail, a.refs));
    }
    const cumulativeOps = [...state.cumulativeOps, ...r.appliedOps];
    const derivedOpTotal = state.derivedOpTotal + (r.applied ? (r.derivedOpCount ?? 0) : 0);
    // Task memory (ADR 0075): the edit landed, so the project moved to a new revision.
    // Recording the operation is what makes completion COMPUTABLE later — an objective is
    // discharged by an applied patch plus a passing verification, never by the model
    // saying it is done — and the revision bump invalidates the arrangement facts while
    // leaving the transcript, footage map and committed decisions untouched.
    const revisionBefore = state.working.currentProjectRevision;
    // One per applied patch, and deliberately NOT `project.timeline.revision`.
    //
    // That field is tempting — it is the project's own counter and it is what
    // `get_timeline` reports — but it bumps only when an operation changes the
    // source↔sequence MAPPING (`applyOperation`, ADR 0076). A colour grade, an audio gain
    // change, a track rename and a blend-mode change all leave it exactly where it was.
    // This counter drives `onProjectRevisionChanged`, which invalidates every
    // timeline-dependent fact and evidence handle the run holds — and a grade absolutely
    // does stale a `get_clips` payload. Keying invalidation to a mapping counter would
    // leave the run reasoning from evidence its own edit had just outdated.
    //
    // The host's document revision (`PatchCommitOutcome.revision`) is a third counter
    // again, counting everything written to the open project, the user's edits included.
    // Three numbers, three questions; see that field's note for why they must not be
    // conflated.
    const revisionAfter = revisionBefore + 1;
    const decisionId =
      state.working.plan.decisionIds[
        Math.min(r.planStepIndex, state.working.plan.decisionIds.length - 1)
      ]!;
    const objectiveId = state.working.objectives.find((objective) =>
      objective.id.endsWith(`_${Math.min(r.planStepIndex + 1, state.working.objectives.length)}`),
    )?.id;
    const planId = state.working.plan.id!;
    const revised = onProjectRevisionChanged(state.working, revisionAfter);
    // Immediately after the invalidation, and only there: the run's own account of the
    // timeline it just produced, standing in for the `get_timeline` it would otherwise
    // have to spend a turn on. See `AgentTurnResult.arrangement`.
    const advancedWorking = r.arrangement
      ? recordFact(revised, {
          kind: 'project',
          statement: r.arrangement,
          scope: 'timeline_dependent',
        })
      : revised;
    // VU7: what the pixels said about the cuts this patch just made. Folded HERE, after
    // `onProjectRevisionChanged` and beside the arrangement fact, for the same reason that
    // one is: these are `timeline_dependent` facts about the revision this turn produced,
    // and recording them before the invalidation would drop them on the way past.
    const verifiedWorking = r.pictureVerification
      ? recordPictureVerification(advancedWorking, r.pictureVerification)
      : advancedWorking;
    const working = actionTally(r.describedActions).reduce(
      (ledger, action, index) =>
        recordOperation(ledger, {
          intent: action.count > 1 ? `${action.action} ×${String(action.count)}` : action.action,
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
      verifiedWorking,
    );
    const s: ConductorState = {
      ...withPlan,
      working,
      cumulativeOps,
      derivedOpTotal,
      appliedTurns: state.appliedTurns + 1,
      // A real edit landed — the run is progressing, so the convergence streak resets,
      // and so does the diminishing-returns delta window (E4.2: the streak requires
      // zero applied ops across ALL of its turns).
      stallStreak: 0,
      recentOutputDeltas: [],
      // An edit landed, so whatever was refused before is behind the run.
      lastRejectionReason: '',
      lastRejectionScale: undefined,
      seenCallKeys: mergeSeenKeys(state.seenCallKeys, r.callFacts),
      // Same reason as `lastRejectionReason`: a deterministic refusal describes the
      // arrangement the validator was shown, and this patch has just replaced it. Holding
      // the keys across an applied edit would refuse a retry whose cause the edit fixed.
      //
      // EXCEPT the refusals no edit can fix. `render_preview: surface_unavailable` is a
      // verdict about the runtime, not the timeline, and clearing it here is why one
      // desktop run was refused it eight times in 86 minutes with every mutation in
      // between wiping the memory (`tool-refusal.ts#ARRANGEMENT_INDEPENDENT_CAUSES`).
      //
      // AND except the refusals THIS edit cannot have fixed. `picture_over_picture` is a
      // verdict about where picture sits; a caption patch does not move any, so it leaves
      // the memory of that verdict standing (`PICTURE_ARRANGEMENT_CAUSES`). Without this,
      // a run that restyles captions between attempts hands the model a clean slate for a
      // placement it has already been refused — 35 times, in the captured case.
      seenFailureKeys: state.seenFailureKeys.filter((key) =>
        survivesAppliedEdit(key, r.pictureArrangementChanged ?? true),
      ),
    };
    if (cumulativeOps.length - derivedOpTotal >= state.config.maxOpsPerRun) {
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
  // `??` is not enough here: `AgentTurnResult.note` DEFAULTS to the empty string, so a
  // rejecting branch that forgets to state a reason contributes `''` rather than falling
  // through. That is exactly what happened — three refused turns produced three empty
  // strings, and the editor was shown `(; ; )`. Fall through blanks, and if a branch still
  // manages to refuse a turn without saying why, say THAT rather than showing nothing.
  const rejectionReason = [r.rejection, r.note].find((candidate) => candidate?.trim());
  const rejectionReasons =
    rejected && withPlan.rejectionReasons.length < MAX_REJECTION_REASONS
      ? [
          ...withPlan.rejectionReasons,
          rejectionReason ?? 'the edit was refused without a stated reason',
        ]
      : withPlan.rejectionReasons;
  const rejectedOpCount = withPlan.rejectedOpCount + (rejected ? r.turnOpCount : 0);

  // Did this no-edit turn make PROGRESS? The harness does not judge the model's intent —
  // only whether the run can still move forward. A turn progresses if it attempted an edit
  // (a rejected op is a bounded retry, its reason now in the log) or learned something new
  // (a first-seen read/analysis — the raw material an edit is built from). Re-reading what
  // the run already has (served from the memo as non-novel) is neither: it changes nothing
  // and reveals nothing, so it cannot be progress.
  // A retry is bounded by being a DIFFERENT attempt. A turn refused with the exact reason
  // that refused the last one has changed nothing the runtime can see, so it does not earn
  // the attempt's progress credit — it must learn something new to count. Compared on the
  // rejection alone, never on the turn note, which carries every read result in the turn
  // and would almost never repeat byte for byte.
  // Compared on the refusal's stable IDENTITY, not on its sentence. A rejection message
  // names the values that need fixing, so it varies between attempts at the same wall —
  // and comparing sentences meant a run refused twenty-nine times for one reason read as
  // twenty-nine different refusals. `rejectionKey` is the producer's own answer to "is
  // this the same wall?"; a producer that states none still falls back to the sentence,
  // which is the previous behaviour exactly.
  const rejectionIdentity = r.rejectionKey ?? r.rejection;
  const repeatedRejection =
    rejected && rejectionIdentity !== undefined && rejectionIdentity === state.lastRejectionReason;

  // …and the same wall is not the same ATTEMPT at it. A refusal that names fewer offenders
  // than the run's best so far is the run getting through the wall, one course correction at
  // a time, and it earns the attempt's progress credit even though the wall has not moved.
  //
  // Measured, not assumed. `beat-sync` r3 of `session6` was refused eleven consecutive times
  // by `beat-grid:off-grid` with 12, 10, 10, 18, (a different wall), 24, 4, 8, 8, 2 cuts off
  // the grid, and its NEXT proposal — the first with every interior cut on a detected onset
  // — landed 35 operations for a score of 1.00. Replaying that recording against the
  // key-only guard stopped the run at the eleventh refusal (`stallStreak` reaching
  // {@link STALL_CONFIRM_TURNS}), one model call short of the edit: 5 operations, 0.56.
  //
  // A new LOW, not merely a lower number than last turn — see
  // {@link ConductorState.lastRejectionScale}. `beat-sync` r1, which re-proposed cuts that
  // stayed 18, 16, 16, 32, 16 wrong, never reaches a new low after its second attempt and
  // still stops exactly where it does today.
  const convergingRejection =
    repeatedRejection &&
    r.rejectionScale !== undefined &&
    state.lastRejectionScale !== undefined &&
    r.rejectionScale < state.lastRejectionScale;
  // The wall the run stands at now, and its best attempt at it. A new wall replaces the
  // floor outright rather than lowering it: fewer overlaps is no evidence about the beat
  // grid, and carrying one wall's number to another would credit an unrelated refusal as
  // progress.
  const lastRejectionScale = !rejected
    ? state.lastRejectionScale
    : repeatedRejection && state.lastRejectionScale !== undefined
      ? Math.min(state.lastRejectionScale, r.rejectionScale ?? state.lastRejectionScale)
      : r.rejectionScale;

  // A SATISFIED turn is not an attempt at the cut. By its own definition it "landed nothing
  // because the timeline ALREADY matched it" — nothing moved, there is nothing to retry. It
  // is right that it is not filed as a rejection (above). It is wrong that it earned the
  // attempt's progress credit: run `137d8fd0` re-set `music_1_clip` to the −18 dB it was
  // already at TEN times across turns 15→149, and each identical no-op reset every
  // run-stopper as if a fader had moved. Same principle as `callAnswered` for mutations —
  // a re-derivation can still count as progress, but only by LEARNING something, not by
  // proposing again what is already there.
  const attemptedChange = attemptedEdit && r.satisfied !== true;
  const progressed =
    (attemptedChange && (!repeatedRejection || convergingRejection)) ||
    turnLearnedSomethingNew(r.callFacts, state.seenCallKeys);
  const seenCallKeys = mergeSeenKeys(state.seenCallKeys, r.callFacts);
  const seenFailureKeys = mergeFailureKeys(state.seenFailureKeys, r.callFacts);
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
  // A turn that proposed operations and lost them to the validator is recorded too: the
  // ledger must show what the run TRIED, or a failure looks identical to never having
  // attempted anything (the distinction ADR 0074's empty-run notice turns on).
  //
  // `turnOpCount > 0` alone did not see the commonest way to lose them. The PER-CALL
  // validator probe refuses inside the call, so the outcome it returns is `ops: []` with
  // the count carried out of band in `rejectedOpCount` — meaning the turn reported zero
  // operations and nothing was recorded at all. Run `7d159862` ended with 584 rejected
  // operations and a ledger of five rows, every one of them `succeeded`; the briefing's
  // "FAILED — fix the cause, do not retry unchanged" section therefore never rendered
  // once, and the model retried `caption_the_edit` four times with nothing in its memory
  // to say it had ever been refused.
  //
  // A turn whose edit was already on the timeline is recorded as SUCCEEDED, not failed:
  // the state it was trying to reach is the state that exists. Filing it as a failure put
  // it under the briefing's "FAILED — fix the cause, do not retry unchanged", which is
  // advice with no cause behind it; as a success it lands under "ALREADY APPLIED — do not
  // repeat", which is both true and the instruction the run actually needs. Ops the
  // validator refused are never "already there", so a turn that lost any is always failed.
  const lostOpsPerCall = r.rejectedOpCount > 0;
  const recordable = attemptedEdit || lostOpsPerCall;
  const recordSucceeded = r.satisfied === true && !lostOpsPerCall;
  // The per-call notes name the tool AND the validator's reason; the turn note carries
  // every read result in the turn, which is far too much to put in front of the model as
  // "the cause to fix".
  const recordedFailureReason =
    r.rejection ?? (r.rejectionNotes.length > 0 ? r.rejectionNotes.join('; ') : r.note);
  const workingAfterTurn = recordable
    ? recordOperation(state.working, {
        intent: r.signature,
        status: recordSucceeded ? 'succeeded' : 'failed',
        ...(r.patchId === undefined ? {} : { patchId: r.patchId }),
        ...(recordSucceeded ? {} : { failureReason: recordedFailureReason }),
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
          `${r.signature}:${recordSucceeded ? 'satisfied' : 'failed'}`,
        projectRevisionBefore: state.working.currentProjectRevision,
        projectRevisionAfter: state.working.currentProjectRevision,
      })
    : state.working;
  const guarded: ConductorState = {
    ...withPlan,
    working: workingAfterTurn,
    rejectedOpCount,
    rejectionReasons,
    attemptedAnyEdit: state.attemptedAnyEdit || attemptedEdit,
    stallStreak,
    recentOutputDeltas,
    // Only a real rejection is remembered; a turn that landed nothing for any other reason
    // (a pure read, an already-satisfied edit) must not make the NEXT rejection look like a
    // repeat of it.
    lastRejectionReason: rejected ? (rejectionIdentity ?? '') : state.lastRejectionReason,
    lastRejectionScale,
    seenCallKeys,
    seenFailureKeys,
  };
  // The run stops on its own only when it has provably stopped moving: STALL_CONFIRM_TURNS
  // turns in a row that learned nothing new and attempted no new change. Nothing narrows the
  // tools or forces the model's next move on the way there (ADR 0199) — a turn that repeats
  // a read gets the same answer from the memo and the streak climbs; the model decides what
  // to do with that, and the run ends if it keeps doing nothing.
  if (stallStreak >= STALL_CONFIRM_TURNS) {
    events.push(em.notification(stalledRunMessage(rejectionReasons)));
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
  return advance(guarded, em, events);
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

/**
 * Append this turn's deterministic refusals to the run's failure set, de-duplicated. Pure.
 *
 * Unconditional, unlike {@link mergeSeenKeys}: the runtime has already decided which
 * failures are provable by attaching a {@link TurnCallFact.failureKey} at all, and it
 * attaches one only on the deterministic argument/validator path. A transient host error
 * carries no key and therefore cannot be banked here — the distinction has to live where
 * the outcome is produced, because the reducer is pure and cannot tell a sidecar restart
 * from a malformed argument by looking at a status.
 */
function mergeFailureKeys(
  seen: readonly string[],
  facts: readonly TurnCallFact[],
): readonly string[] {
  const keys = facts.map((f) => f.failureKey).filter((key): key is string => key !== undefined);
  return keys.length === 0 ? seen : [...new Set([...seen, ...keys])];
}

/**
 * Fold the self-check: report what it found, record the run's verdict, finalize.
 *
 * The self-check REPORTS; it does not decide (ADR 0199). Its checks are the same ones the
 * model was shown after every turn under WHERE YOU STAND, so by the time a run gets here the
 * model has already weighed each finding and either acted or chosen not to — which is its
 * call to make, and the editor reads both the findings and the model's reply. It used to
 * decide: a failed check bought a hidden repair pass (a second model editing behind the
 * first), then a "verification fix turn", and a finding that survived both settled the run
 * as `failed` under "Applied N changes, but the run could not finish". Desktop run
 * `001be135` ended exactly that way, its 162 changes on the timeline, over a check that was
 * measuring the words of a muted soundtrack.
 *
 * What the run's status DOES rest on is what happened: a traceable edit landed, or the model
 * finished on its own having been refused nothing (an answer, or "this is already done") —
 * completed; otherwise the run was stopped with nothing to show, or every attempt was
 * refused — failed, with the empty-run notice saying why.
 */
export function onVerifyResult(state: ConductorState, r: VerifyResult, em: Emitter): ConductorStep {
  // A Critic verdict is meaningful only when there is an edited result to inspect: a
  // zero-op run that displayed "Self-check: Passed" right before "No edits were applied"
  // read as a successful run.
  const events: AiEvent[] = [];
  if (state.cumulativeOps.length > 0) {
    // Every notice of this pass carries one tag, so a host can present the self-check as
    // one unit instead of a stack of full-width rows under the reply.
    const tag = { reason: SELF_CHECK_NOTICE_REASON };
    events.push(em.notification(`Deterministic self-check: ${r.summary}`, tag));
    for (const check of r.failedChecks) {
      events.push(em.warning(`${check.label}: ${check.detail}`, tag));
    }
    // Advisory, so a notification rather than a warning — but SAID. See
    // `VerifyResult.warnedChecks`.
    for (const check of r.warnedChecks) {
      events.push(em.notification(`${check.label}: ${check.detail}`, tag));
    }
  }
  let working = state.working;
  if (working.operations.some((operation) => operation.status === 'succeeded')) {
    const from = RUN_STAGES.indexOf(working.stage) + 1;
    const throughVerify = RUN_STAGES.indexOf('verify') + 1;
    working = RUN_STAGES.slice(from, throughVerify).reduce(
      (ledger, stage) => advanceStage(ledger, stage, state.stepIndex),
      working,
    );
  }
  // A model-owned plan is accounted for by `finalize` (its open items, by name); the drafted
  // ledger it superseded is not on screen, so "N planned steps" would count a list the
  // editor was never shown.
  const planReconciled =
    state.modelPlan !== undefined ||
    state.ledgerLength === 0 ||
    (state.planSteps.length > 0 && state.planSteps.every((step) => step.status === 'completed'));
  if (!planReconciled) {
    const unreached = state.planSteps.filter((step) => step.status !== 'completed').length;
    events.push(
      em.notification(
        `${String(unreached)} planned step${unreached === 1 ? '' : 's'} never reached an edit — listed under "Not done" in the summary.`,
      ),
    );
  }
  // Causal completion (ADR 0081): did the run trace a real, successful mutation to the plan
  // it committed to? That is the verdict recorded against each objective — NOT the Critic's
  // findings, which are reported above and were in front of the model all along.
  const deliveredWork = working.operations.some((operation) => operation.status === 'succeeded');
  // A run that changed nothing can still have finished properly: the model ended it itself,
  // nothing it tried was refused, and its reply is the answer ("the silences were already
  // trimmed"). That is a completed run with an empty diff, not a failure.
  const answeredWithoutEditing =
    !deliveredWork && state.modelDeclaredDone === true && state.rejectedOpCount === 0;
  for (const [index, objective] of working.objectives.entries()) {
    // One objective per drafted step, and a step completes only by an applied patch on its
    // own turn; a step that never got a turn of its own is said in the detail and in the
    // "Not done" block rather than failing the run.
    const stepReached = state.ledgerLength === 0 || state.planSteps[index]?.status === 'completed';
    working = recordVerification(working, {
      // LABEL IT FOR WHAT IT TESTED. When the objective is the request said back, a record
      // reading `criterion: "<the editor's request>", passed: true` asserts the request was
      // satisfied — and the next run's briefing inherits that claim (run `29eee2df`).
      criterion:
        isRequestEcho(objective.description, working.objective.request) ||
        objective.description === working.objective.outcome
          ? GENERIC_DELIVERY_CRITERION
          : objective.description,
      passed: deliveredWork,
      detail: !deliveredWork
        ? 'No traceable project mutation for the committed plan.'
        : stepReached
          ? r.summary
          : `${r.summary} (this planned step never had a turn of its own)`,
      objectiveId: objective.id,
    });
  }
  if (deliveredWork) {
    working = advanceStage(working, 'complete', state.stepIndex);
  } else if (!answeredWithoutEditing) {
    working = addDiagnostic(working, {
      code: 'VERIFICATION_INCONCLUSIVE',
      message: 'Verification found: No traceable project mutation for the committed plan.',
      stage: 'verify',
      blocking: true,
    });
  }
  const failed = !deliveredWork && !answeredWithoutEditing;
  return finalize(
    { ...state, working, integrityFailed: state.integrityFailed || failed },
    em,
    events,
  );
}

/**
 * What the run's whole-request verdict actually tested, said plainly.
 *
 * The verdict is "a traceable mutation landed". It does not know whether the editor got what
 * they asked for, so a record labelled with their own sentence claims more than it checked.
 */
const GENERIC_DELIVERY_CRITERION = 'A validated edit landed on the timeline';

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
