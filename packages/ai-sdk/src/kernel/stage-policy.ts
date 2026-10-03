/**
 * @framepilot/ai-sdk/kernel/stage-policy — what each tool means for the task stage
 * (plan/AGENT-TASK-MEMORY.md §3.2, ADR 0075).
 *
 * ## Why the stage is DERIVED, never declared
 *
 * The obvious design is a tool the model calls to announce "I am now planning". It is the
 * wrong one: a model that has lost the thread will happily announce whatever stage its
 * current sentence implies. So the stage is inferred from what the turn actually DID.
 * Reading the timeline is inspection whatever the prose around it says; applying a patch is
 * execution whether or not the model calls it that.
 *
 * ## The stage is bookkeeping, not a gate
 *
 * It used to be one. Once the run was "executing", analysis tools were withheld and the
 * step thought at `low` effort, and every time that stranded a run a tool was added to an
 * exemption list (`get_frame`, `detect_beats`, `transcribe`, `measure_color`,
 * `measure_subject`, `render_preview`…). Desktop run `001be135` laid its voiceover down
 * first, which put it in `apply` on step two, and was refused `describe_footage` for the
 * rest of the run while it matched a narration to footage. ADR 0199 removed the gate: the
 * stage labels the run's memory and nothing else.
 */
import { RUN_STAGES, type RunStage } from './working-state.js';
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
 * Operation types that record something ABOUT the project without editing the cut:
 * a transcript, a lane, a marker, a lane's flags.
 *
 * `plan → apply` fires on an applied patch (`stageAdvanceFor`). A transcript is what
 * analysis reads, not what execution writes, so a patch made only of these does not move the
 * run's memory into `apply` (run `df81d58e`'s second turn was `add_track` + `transcribe`).
 */
export const BOOKKEEPING_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'set_transcript',
  'add_layer',
  'remove_layer',
  'move_layer',
  'set_track_flags',
  'add_marker',
  'remove_marker',
]);

/**
 * Did an applied patch EDIT the cut, or only keep books about it?
 *
 * An empty list answers yes — a caller that applied something but did not hand the
 * operations over is trusted exactly as before this predicate existed — so only a patch
 * made wholly of {@link BOOKKEEPING_OPERATION_TYPES} leaves the stage where it was.
 */
export function executedAnEdit(ops: readonly { readonly type: string }[]): boolean {
  if (ops.length === 0) return true;
  return ops.some((op) => !BOOKKEEPING_OPERATION_TYPES.has(op.type));
}
