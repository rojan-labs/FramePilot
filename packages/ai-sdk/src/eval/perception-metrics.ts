/**
 * @framepilot/ai-sdk/eval/perception-metrics — how much the agent LOOKED, and where its
 * numbers came from (plan/visual-understanding VU0.1).
 *
 * The visual-understanding plan starts from a measurement, not an opinion. Folding the
 * per-turn tool-call records of ten recorded runs — 318 scored turns, 210 accepted edits —
 * gives: `get_timeline` 192 calls, `get_frame` **zero**, and `search_visual`,
 * `describe_footage`, `map_footage`, `measure_color` **zero, in every run**
 * (`reports/golden/BASELINE.md`, reproducible with `scripts/perception-baseline.mjs`). The
 * agent edits the geometry it can read and guesses everything it cannot.
 *
 * These metrics turn that into a number a change can move, and they are deliberately hostile
 * to the easy fix — sending a frame with every model call would push `framesSeenPerEdit` UP,
 * not down, and that is the point: the plan's claim is that the agent should need FEWER
 * pixels, because the facts reached it as text.
 *
 * Pure, like every other metric module here: events and applied operations in, numbers out.
 * A metric that cannot be computed from the evidence is `null`, never 0 — `null` means "this
 * run does not say", and 0 is a real, different answer.
 */
import type { Patch } from '@framepilot/editor-core';
import type { AiEvent } from '../events.js';

/**
 * Looking at the composited timeline: the model's own eyes on its own edit (ADR 0096).
 *
 * Counted per FRAME, not per call, because the cost the plan is arguing about is image
 * tokens. A vision review asks for several frames in one call.
 */
export const FRAME_TOOLS: ReadonlySet<string> = new Set(['get_frame']);

/**
 * Asking the footage what it contains. These are the pull-based surfaces the plan replaces
 * with facts that are simply present: a run that still needs them is a run whose state did
 * not carry what it needed.
 */
export const PERCEPTION_TOOLS: ReadonlySet<string> = new Set([
  'search_visual',
  'describe_footage',
  'map_footage',
  'measure_color',
]);

/**
 * Tools that produce a MEASURED basis for a number the model would otherwise invent.
 *
 * `measure_color` is here as well as in {@link PERCEPTION_TOOLS} on purpose: before the VU3
 * solvers exist it is the only way a grade can be grounded at all, so a run that measured and
 * then graded is honestly not a guess even though no solver ran. The solver names are listed
 * ahead of their implementation (VU3/VU4) so the baseline and the post-change runs are scored
 * by the same function and the delta is real.
 */
export const SOLVER_TOOLS: ReadonlySet<string> = new Set([
  'measure_color',
  'match_color',
  'normalize_exposure',
  'apply_look',
  'add_transitions',
]);

/**
 * Operations whose parameters are a judgement the model cannot make from clip geometry —
 * exactly the two the user named: how much grade, and which transition.
 */
export const SOLVED_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'apply_color_grade',
  'add_transition',
]);

/** One tool call as the metrics read it: the terminal state of an id, in order. */
interface TerminalCall {
  readonly toolName: string;
  readonly index: number;
}

/**
 * The terminal state of every tool call, in first-appearance order.
 *
 * A `tool_call` event is re-emitted under the same id as it moves `running → completed`
 * (events.ts), so counting events would count most calls twice. The runner's own accounting
 * (`mission-baseline.mjs`) drops `running` for the same reason; this keeps the FIRST index of
 * the id so "did the model measure BEFORE it graded?" is asked about when the call started,
 * not when it happened to finish.
 */
function terminalCalls(events: readonly AiEvent[]): TerminalCall[] {
  const firstIndex = new Map<string, number>();
  const name = new Map<string, string>();
  const terminal = new Set<string>();
  events.forEach((event, index) => {
    if (event.type !== 'tool_call') return;
    if (!firstIndex.has(event.id)) firstIndex.set(event.id, index);
    name.set(event.id, event.toolName);
    if (event.status !== 'running') terminal.add(event.id);
  });
  return [...terminal]
    .map((id) => ({ toolName: name.get(id) ?? '', index: firstIndex.get(id) ?? 0 }))
    .sort((a, b) => a.index - b.index);
}

/** Frames a single `get_frame`/vision call put in front of the model. */
function framesOf(event: AiEvent & { type: 'tool_call' }): number {
  // `get_frame` renders exactly one composited frame per call (ADR 0096). A vision review
  // asks for up to MAX_VISION_FRAMES in one call; when a host records the count in the
  // args summary we read it, and otherwise we count the call as one frame rather than
  // inventing a number.
  const summary = event.argsSummary ?? '';
  const match = /(\d+)\s*frames?/i.exec(summary);
  return match ? Math.max(1, Number(match[1])) : 1;
}

export interface PerceptionTurnMetrics {
  /** Frames the model was shown this turn (`get_frame`, vision review). */
  readonly framesSeen: number;
  /** Calls to the pull-based footage surfaces. */
  readonly perceptionCalls: number;
  /** Per-tool counts, so a report can say WHICH surface a run leaned on. */
  readonly perceptionCallsByTool: Readonly<Record<string, number>>;
  /**
   * Grade/transition operations, split by whether anything measured them first.
   *
   * `rate` is the share that was NOT grounded — the guess rate. `null` when the turn applied
   * no such operation, which is not the same as a turn that guessed nothing.
   */
  readonly numericGuess: {
    readonly total: number;
    readonly grounded: number;
    readonly guessed: number;
    readonly rate: number | null;
  };
}

/** The applied operation types of a turn, from patches when recorded and diffs when not. */
function appliedOperationTypes(
  events: readonly AiEvent[],
  appliedPatches: readonly Patch[] | undefined,
): { readonly type: string; readonly index: number }[] {
  if (appliedPatches) {
    // Patches carry no event index; a recorded patch was applied at the end of the turn, so
    // every tool call in the turn precedes it. Index `events.length` says exactly that.
    return appliedPatches.flatMap((patch) =>
      patch.operations.map((op) => ({ type: op.type, index: events.length })),
    );
  }
  const out: { type: string; index: number }[] = [];
  events.forEach((event, index) => {
    if (event.type !== 'diff') return;
    const edit = (event.edit ?? {}) as {
      validation?: { valid?: boolean };
      valid?: boolean;
      ops?: readonly unknown[];
    };
    if (!(edit.validation?.valid ?? edit.valid ?? false)) return;
    for (const op of edit.ops ?? []) {
      const type =
        typeof op === 'string'
          ? op
          : typeof (op as { type?: unknown }).type === 'string'
            ? (op as { type: string }).type
            : '';
      if (type) out.push({ type, index });
    }
  });
  return out;
}

/**
 * Measure one turn's looking and grounding.
 *
 * @param events - The turn's event stream, in order.
 * @param appliedPatches - The patches the turn applied, when the evidence records them.
 * @returns Frames seen, perception calls, and the numeric-guess split.
 */
export function measurePerceptionTurn(
  events: readonly AiEvent[],
  appliedPatches?: readonly Patch[],
): PerceptionTurnMetrics {
  const calls = terminalCalls(events);
  const byId = new Map<string, AiEvent & { type: 'tool_call' }>();
  for (const event of events) if (event.type === 'tool_call') byId.set(event.id, event);

  let framesSeen = 0;
  for (const event of byId.values()) {
    if (event.status !== 'running' && FRAME_TOOLS.has(event.toolName))
      framesSeen += framesOf(event);
  }

  const perceptionCallsByTool: Record<string, number> = {};
  let perceptionCalls = 0;
  for (const call of calls) {
    if (!PERCEPTION_TOOLS.has(call.toolName)) continue;
    perceptionCalls += 1;
    perceptionCallsByTool[call.toolName] = (perceptionCallsByTool[call.toolName] ?? 0) + 1;
  }

  const solverIndices = calls
    .filter((call) => SOLVER_TOOLS.has(call.toolName))
    .map((call) => call.index);
  const judged = appliedOperationTypes(events, appliedPatches).filter((op) =>
    SOLVED_OPERATION_TYPES.has(op.type),
  );
  let grounded = 0;
  for (const op of judged) if (solverIndices.some((index) => index < op.index)) grounded += 1;
  const total = judged.length;

  return {
    framesSeen,
    perceptionCalls,
    perceptionCallsByTool,
    numericGuess: {
      total,
      grounded,
      guessed: total - grounded,
      rate: total === 0 ? null : (total - grounded) / total,
    },
  };
}

/**
 * How many of the timeline rows the model was shown carried a fact about the picture.
 *
 * Read from the RENDERED timeline slice rather than from events, because that is where the
 * claim lives: `renderTrackClips` prints `c12[0–4.2s]` today and
 * `c12[61–66.4s] · MS man at desk · static · bright warm` after VU2. A row is "with facts"
 * when it carries the fact separator after its bracketed time span.
 *
 * @param timelineSliceText - The timeline block exactly as it goes into the prompt.
 * @returns Rows shown, rows carrying facts, and the share — `null` share when no row was shown.
 */
export function pictureFactsInPrompt(timelineSliceText: string): {
  readonly rows: number;
  readonly withFacts: number;
  readonly rate: number | null;
} {
  // A clip row is `id[start–end s]`, optionally followed by ` · facts` before the next
  // comma-separated row. The en dash is the one `renderTrackClips` writes.
  const ROW = /[^\s,[\]]+\[[^\]]*\]( · [^,]*)?/g;
  const rows = [...timelineSliceText.matchAll(ROW)];
  const withFacts = rows.filter((match) => match[1] !== undefined).length;
  return {
    rows: rows.length,
    withFacts,
    rate: rows.length === 0 ? null : withFacts / rows.length,
  };
}

export interface PerceptionSummary {
  /** Frames shown per accepted edit — the number the plan must NOT increase. */
  readonly framesSeenPerEdit: number | null;
  readonly framesSeen: number;
  readonly perceptionCallsPerRun: number | null;
  readonly perceptionCallsByTool: Readonly<Record<string, number>>;
  /** Share of grade/transition operations applied without a measured basis. */
  readonly numericGuessRate: number | null;
  readonly numericGuess: { readonly total: number; readonly guessed: number };
}

/**
 * Aggregate turn metrics into the run-level figures the report prints.
 *
 * @param turns - Per-turn perception metrics, one per scored turn.
 * @param acceptedEdits - Accepted edits over the same turns (the harness's own count).
 * @param runs - Distinct runs, for the per-run call average.
 */
export function summarizePerception(
  turns: readonly PerceptionTurnMetrics[],
  acceptedEdits: number,
  runs: number,
): PerceptionSummary {
  const framesSeen = turns.reduce((sum, turn) => sum + turn.framesSeen, 0);
  const perceptionCalls = turns.reduce((sum, turn) => sum + turn.perceptionCalls, 0);
  const byTool: Record<string, number> = {};
  for (const turn of turns) {
    for (const [tool, count] of Object.entries(turn.perceptionCallsByTool)) {
      byTool[tool] = (byTool[tool] ?? 0) + count;
    }
  }
  const total = turns.reduce((sum, turn) => sum + turn.numericGuess.total, 0);
  const guessed = turns.reduce((sum, turn) => sum + turn.numericGuess.guessed, 0);
  return {
    framesSeenPerEdit: acceptedEdits > 0 ? framesSeen / acceptedEdits : null,
    framesSeen,
    perceptionCallsPerRun: runs > 0 ? perceptionCalls / runs : null,
    perceptionCallsByTool: byTool,
    numericGuessRate: total === 0 ? null : guessed / total,
    numericGuess: { total, guessed },
  };
}
