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
