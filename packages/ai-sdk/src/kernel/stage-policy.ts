/**
 * @framepilot/ai-sdk/kernel/stage-policy — what each tool means for the task stage, and
 * which tools a stage may use (plan/AGENT-TASK-MEMORY.md §3.2/§3.6, ADR 0075).
 *
 * ## Why the stage is DERIVED, never declared
 *
 * The obvious design is a tool the model calls to announce "I am now planning". It is the
 * wrong one: a model that has lost the thread will happily announce whatever stage its
 * current sentence implies, which is exactly the failure — the run re-announcing that it
 * is about to understand the project on turn twelve. So the stage is inferred from what
 * the turn actually DID. Reading the timeline is inspection whatever the prose around it
 * says; applying a patch is execution whether or not the model calls it that.
 *
 * The harness therefore never judges intent, only evidence — the same principle the
 * progress guard already follows.
 *
 * ## Why the boundary is structural
 *
 * Once the run is executing, read and analysis tools are withheld rather than discouraged
 * (reusing ADR 0068's descriptor-withholding). Instruction has already been tried: the
 * contract said "inspect/analyze ONCE, then commit to the edit" throughout the run that
 * spent eight turns doing reconnaissance. A tool that is absent cannot be called.
 */
import { RUN_STAGES, type RunStage, isExecutionStage } from './working-state.js';
import { type ToolRole, classifyTool } from '../tool-classification.js';
import { getTool } from '../tool-registry.js';

/** Upper bound on transitions one turn can earn — the machine has no cycles. */
const RUN_STAGE_COUNT = RUN_STAGES.length;

export type { ToolRole };

/**
 * Classify one tool call.
 *
 * Delegates to the registry-wide classification table rather than keeping a local
 * allowlist. The three `Set`s that used to live here had drifted from `TOOL_REGISTRY` —
 * `detect_beats`, `get_project_state`, `map_time` and others fell through to `other`,
 * which meant `distil` recorded no fact for them and the run re-gathered them forever
 * (see `tool-classification.ts`). A single table with a parity test cannot drift like
 * that.
 *
 * `mutates` stays an explicit parameter rather than being read from the registry: callers
 * already hold the resolved `ToolSpec`, and an unregistered-but-mutating tool must be
 * classified as a mutation whatever the table says.
 */
export function toolRole(name: string, mutates: boolean): ToolRole {
  if (mutates) return 'mutation';
  return classifyTool(name, getTool(name)?.kind).role;
}

/**
 * The stage this turn's evidence justifies moving to, or `null` to stay put.
 *
 * Deliberately conservative and monotonic: it only ever proposes the NEXT stage, and only
 * when the turn produced the evidence that stage is defined by. `advanceStage` then
 * refuses anything the transition table does not allow, so a bug here cannot corrupt the
 * machine — it can only fail to advance it.
 */
export function stageAdvanceFor(
  stage: RunStage,
  roles: readonly ToolRole[],
  applied: boolean,
): RunStage | null {
  switch (stage) {
    case 'interpret':
      // Any tool call at all means the run has read the request and started work.
      return roles.length > 0 ? 'inspect' : null;
    case 'inspect':
      // A mutation from inspection is the shortest correct path there is — read the
      // timeline, make the cut — and it used to earn nothing: the run stayed at `inspect`,
      // its next briefing said "Continue inspect: read only what the objective still
      // needs" directly under "ALREADY APPLIED — do not repeat", and the model did as told.
      // `s9-live-reorder` r3 read the timeline after each landed `reorder_clips`, found a
      // different clip last, and rotated "the last clip to the front" five times, ending on
      // the order it started with. `inspect → plan` is a declared successor; a reach for a
      // mutation is the same commitment here as it is from `analyze`.
      if (roles.includes('mutation') || applied) return 'plan';
      // Content work has begun; the arrangement is understood well enough. Sourcing
      // counts: a run searching a stock library has plainly stopped reading the project.
      return roles.some((r) => r === 'analysis' || r === 'guidance' || r === 'sourcing')
        ? 'analyze'
        : null;
    case 'analyze':
      // Reaching for a mutation is the moment analysis ends and a plan is being committed
      // to — whether or not the validator let that particular edit through. `applied`
      // closes it too: a sourcing call that landed a clip is a commitment by any reading,
      // and it carries no `mutation` role of its own.
      return roles.includes('mutation') || applied ? 'plan' : null;
    case 'plan':
      // A patch that actually landed is unambiguous proof the run is executing.
      return applied ? 'apply' : null;
    default:
      return null;
  }
}

/**
 * The stage a turn's evidence justifies, applying EVERY transition it earns rather than
 * one per turn.
 *
 * A single turn can legitimately close more than one stage — the turn that first applies
 * a patch both ends analysis and starts execution — and advancing one step per turn would
 * leave the run offering reconnaissance tools for a turn after it had provably stopped
 * reconnoitring. Bounded by the number of stages, so it terminates whatever the inputs.
 */
export function settledStageFor(
  stage: RunStage,
  roles: readonly ToolRole[],
  applied: boolean,
): RunStage {
  let current = stage;
  for (let i = 0; i < RUN_STAGE_COUNT; i += 1) {
    const next = stageAdvanceFor(current, roles, applied);
    if (!next) return current;
    current = next;
    /* v8 ignore start -- unreachable: every path through stageAdvanceFor is monotonic,
       so the loop always returns above well before RUN_STAGE_COUNT iterations; kept as a
       total-function guarantee (TS cannot see the loop always returns early) rather than
       a live branch. */
  }
  return current;
}
/* v8 ignore stop */

/**
 * May a stage use a tool with this role?
 *
 * Execution stages (`apply`, `enhance`, `repair`) are closed to fresh reconnaissance OF
 * THE MATERIAL: the plan is locked and the evidence for it is already stored, so the way
 * to check a detail is `recall_evidence`, not another `map_footage`. `inspection` stays
 * open because applying an edit legitimately needs the CURRENT arrangement — the ids and
 * positions a patch is written against, which the last cut may have moved.
 *
 * ## Why `guidance` is no longer withheld
 *
 * The rule this function encodes is "the evidence for the plan is already stored, so
 * recall it instead of gathering again". That is true of a footage map or a beat grid,
 * which `analysis` produces and the evidence store holds. It is false of the five
 * `guidance` tools, and the falseness had teeth:
 *
 * `discover_effects` and `discover_transitions` read the SHIPPED CATALOGS — static data
 * the run may never have fetched, so there is nothing to recall — and their own
 * descriptions are the contract that makes them load-bearing: "Call this before
 * `add_transition` — the ids are not guessable, and a kind this build does not know is
 * refused outright rather than rendering as nothing." `add_transition` and `apply_effect`
 * ARE offered in `apply` (they are mutations). So the moment a run landed its first clip,
 * it kept the tools that demand a real catalog id and lost the only sanctioned way to
 * learn one. Run `fc10301a` was asked for a rich variety of transitions and placed none.
 *
 * `load_skill`, `session_context` and `discover_caption_styles` are the same shape:
 * reference data, not observation.
 *
 * A run that browses catalogs instead of editing is still stopped, by the guards that
 * exist for it — a repeated catalog read is a memo hit, which arms `allFromCache` and the
 * action-recovery lockout, and the no-progress streak climbs either way. Withholding the
 * reference data an offered tool requires was never the right instrument for that.
 *
 * The invariant this restores is checked directly: see `stage-policy.test.ts`'s
 * "a tool that says 'call X first' is offered no stage before X is".
 */
export function stageAllowsRole(stage: RunStage, role: ToolRole): boolean {
  if (!isExecutionStage(stage)) return true;
  return role !== 'analysis';
}

/**
 * Measurements a run legitimately needs AFTER its first cut has landed, because what they
 * measure is chosen and placed during execution.
 *
 * `detect_beats` is the case. A run picks its music while it edits — `search_music` and
 * `add_music` are execution-stage tools — so the onsets it needs to cut to belong to a bed
 * that did not exist when reconnaissance closed. Withholding the measurement then leaves the
 * run cutting to a track it never analysed: in run `ea8e46ec` the model said, correctly,
 * "let me detect beats on the placed music" and was told "detect_beats is unavailable this
 * turn", twice, until the run died. (That run was also being refused by a runtime beat-grid
 * validator, which ADR 0174 removed — where a cut lands against the music is the model's
 * editorial call now — but the measurement itself is still the model's to take.)
 *
 * This is the same defect this file already corrected for `guidance`, in the same words:
 * "the moment a run landed its first clip, it kept the tools that demand a real catalog id
 * and lost the only sanctioned way to learn one."
 *
 * The rule this exempts is "the evidence for the plan is already stored, so recall it
 * instead of gathering again". Exempting a tool does NOT leave a redundant re-analysis
 * unbounded, but be precise about what still bounds it, because the obvious answer is
 * circular: `withheldCallOutcome`'s memo hit only runs for a call the stage WITHHELD, and
 * an exemption is exactly what stops it running. What actually holds:
 *
 *  - `orchestrator.ts#callNoveltyKey` keys an asseted analysis on `name:assetId`, so a
 *    second `detect_beats` on the same track scores as nothing learned and the
 *    no-progress streak climbs toward the stall guard;
 *  - `allFromCache` still arms the action-recovery lockout when a turn is all repeats;
 *  - the per-run `ffmpegSeconds` cap (`kernel/cost/analysis-caps.ts`, charged in
 *    `sidecar-executor.ts`) refuses the call outright once the run has spent its
 *    analysis budget.
 *
 * What none of that ever justified was withholding the measurement of media the run
 * itself placed.
 *
 * Keep this set minimal. A tool belongs here only when the thing it measures is placed
 * during execution; `stage-policy.test.ts` pins the property rather than trusting the list.
 */
export const EXECUTION_MEASUREMENT_TOOL_NAMES: ReadonlySet<string> = new Set(['detect_beats']);

/**
 * May a stage use this tool? {@link stageAllowsRole}, plus the named exemptions.
 *
 * Prefer this over {@link stageAllowsRole} at any call site that decides what a run may
 * actually call — the role alone cannot express "the runtime will hold you to this".
 */
/**
 * Tools that LOOK AT THE RESULT of an edit rather than gather evidence for a plan.
 *
 * `get_frame` is classified `analysis` because it renders a picture, but in an execution
 * stage its use is verification: the model has just cropped a landscape source into a
 * portrait frame and wants to see whether the subject survived. The mission montage ledger
 * (plan/system-mission P1.1) shows seven such calls across five requests, every one
 * answered "unavailable this turn" — ~110k prompt tokens spent on a check the run was
 * forbidden to make, while the run never reached `verify` (the stage machine only leaves
 * `apply` through the explicit verify effect).
 *
 * What bounds the frames, stated exactly (the earlier wording said "the analysis caps and
 * the redundant-call memo", and BOTH halves were wrong for this tool):
 *
 *  - the per-run `ffmpegSeconds` cap — real, and charged for `get_frame` in
 *    `sidecar-executor.ts`; a run that spends its budget on frames is refused the next one;
 *  - `callNoveltyKey`, which keys a `get_frame` on its own arguments: asking for the SAME
 *    time twice scores as nothing learned, while a look at a different time is genuinely
 *    new and should not be penalised.
 *
 * Not the memo. `get_frame` declares `cacheScope: 'none'` (`tool-contract.ts`) precisely so
 * a picture is never served from one — a cached frame would show the model the timeline it
 * had before its own edit, which is the failure the tool exists to prevent. And the
 * withheld-call memo cannot apply to a tool this set stops the stage withholding.
 */
export const VERIFICATION_LOOK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_frame',
  // `measure_color` is the same tool with numbers instead of pixels, and the contract says
  // so in one place: `tool-contract.ts` gives the two an identical entry (`pure_read`,
  // `cacheScope: 'none'`, `stateDependency: 'project_revision'`) under a shared docstring
  // that calls them both "PICTURE measurements". Grading is measure → adjust → re-measure,
  // and the second measurement is a look at the edit, which is this set's whole definition.
  //
  // Run `137d8fd0` is what withholding it cost. The brief said "Colour: … Measure what's
  // actually on screen". The run loaded the color domain at minute 2, entered `apply`, and
  // called `measure_color` twice — refused both times as an analysis tool, told it would be
  // "available again on the next turn" (false for a stage rule), and never measured
  // anything. The colour half of the brief was then graded blind.
  //
  // Bounded by exactly what bounds `get_frame`, and for the same reasons: it is in
  // `FFMPEG_BACKED_TOOLS` (`kernel/cost/analysis-caps.ts`) so the per-run `ffmpegSeconds`
  // cap refuses a spree, and `callNoveltyKey` keys it on `clipId` (not a tuning key), so
  // re-measuring the SAME clip scores as nothing learned while measuring a different clip is
  // genuinely new. Not the memo — `cacheScope: 'none'` means there is none, deliberately.
  'measure_color',
]);

/**
 * Tools that a MUTATION's own runtime precondition names as the way to satisfy it.
 *
 * The same shape as {@link EXECUTION_MEASUREMENT_TOOL_NAMES}, one step earlier: there
 * the measurement is of media the run placed, here the tool refuses the call. Either way a
 * run cannot clear a bar it is forbidden to reach.
 *
 * `transcribe` is the case. `caption_the_edit` is a mutation and stays offered through
 * `apply`; it throws "This project has no transcript yet ... Run transcribe first" when
 * there is no transcript. A run that placed a clip before transcribing — the natural
 * order, and the order the pacing skills teach — is in `apply` from that first patch on,
 * so it is told to run `transcribe` and refused in the same breath. Captioning becomes
 * unreachable for the rest of the run, which is the third recurrence of the defect this
 * file already corrected for `guidance` and for `detect_beats`, in the same words.
 *
 * What bounds a redundant re-transcription, precisely — and it is NOT the memo, which the
 * earlier wording claimed twice over:
 *
 *  - `withheldCallOutcome`'s memo hit only ever runs for a call the stage WITHHELD, and
 *    membership in this set is what stops the stage withholding it. The guard cannot fire
 *    for the tools listed here, by construction.
 *  - There is no memo to hit anyway. `runAgentCall` stores the result under
 *    `callMemoKey(call)` and then, because `transcribe` lands a `set_transcript` operation,
 *    calls `evidence.invalidate(['set_transcript'])` — which drops every
 *    `transcript_dependent` entry INCLUDING the one it just wrote. Correct (the words were
 *    genuinely rewritten), and it means the transcript is never recallable from the store.
 *
 * What does hold: `callNoveltyKey` keys an asseted analysis on `name:assetId`, so a second
 * `transcribe` of the same asset is scored as nothing learned and the no-progress streak
 * climbs; and `maxTranscriptionMinutes` (`kernel/cost/analysis-caps.ts`, charged from the
 * real word timings in `sidecar-executor.ts`) caps what a run may transcribe in total, so
 * a loop hits an honest refusal rather than transcribing the bin.
 *
 * Keep this set minimal. A tool belongs here only when some mutation's description or
 * thrown message names it as the remedy; `stage-policy.test.ts` asserts that property
 * rather than trusting the list.
 */
export const PRECONDITION_TOOL_NAMES: ReadonlySet<string> = new Set(['transcribe']);

/**
 * Tools that look at the run's OWN EDIT — never at the material — and so survive the
 * action-recovery turn (`orchestrator.ts#agentTools('action-recovery')`).
 *
 * That turn withholds everything read-shaped because its premise is "you have gathered
 * enough about the footage; act". A look at the edit is not gathering. Run `cc907070` was
 * asked "show me a preview before you render", called `render_preview` once — on a
 * recovery turn — was told "this turn is for acting on what has been gathered", and never
 * previewed. On the same run's verification fix turn the Critic's own remedy said "read
 * the word's startFrame from get_mapped_transcript" and the recovery scope refused it:
 * a refusal naming a tool the same turn forbids, the shape `EXECUTION_MEASUREMENT_TOOL_NAMES`
 * exists to prevent.
 *
 * Every entry reads the timeline or renders it; none of them mints a candidate, opens the
 * footage, or answers something `recall_evidence` already holds for free. The
 * `actionRecoveryPending` latch still ends a recovery turn that only looks.
 */
export const EDIT_LOOK_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...VERIFICATION_LOOK_TOOL_NAMES,
  'render_preview',
  'verify_transitions',
  'get_mapped_transcript',
]);

export function stageAllowsTool(stage: RunStage, name: string, mutates: boolean): boolean {
  if (EXECUTION_MEASUREMENT_TOOL_NAMES.has(name)) return true;
  if (VERIFICATION_LOOK_TOOL_NAMES.has(name)) return true;
  if (PRECONDITION_TOOL_NAMES.has(name)) return true;
  return stageAllowsRole(stage, toolRole(name, mutates));
}

/*
 * `sourcing` is deliberately absent from the closed set above, and that is the whole
 * point of the role existing. The rule this function encodes is "the evidence for the
 * plan is already stored, so recall it instead of gathering again" — true of a transcript
 * or a beat grid, false of a stock library, which holds material the project does not own
 * and `recall_evidence` cannot conjure. Withholding it here is what left run `e30c1fe9`
 * unable to put a single frame of picture into a 30-second reel after its first patch
 * landed. See `tool-classification.ts` for the rest of that account.
 */

/*
 * `planningExhausted(researchStreak, budget)` used to live here. It was a byte-for-byte
 * duplicate of the Conductor's `researchBudgetSpent`, it had no caller, and its docstring
 * claimed it "expresses it as a STAGE change so the closure is durable instead of lasting
 * a single turn" — which nothing in the run ever did. Two copies of one predicate, one of
 * them dead and describing behaviour the product did not have, is worse than one: a reader
 * checking whether the research budget closes the stage durably would have found this and
 * believed it. The live rail is `conductor.ts#researchBudgetSpent` + `RESEARCH_BUDGET_TURNS`,
 * which withholds reconnaissance descriptors for the following turn.
 */
