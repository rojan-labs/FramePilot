/**
 * Scoring for the AI masking eval (AM5.2) against the gates in plan 06 "AI masking".
 *
 * Pure: what each run produced goes in, per-item verdicts and the gate numbers come out. Two
 * things are judged from the PATCH, never from what the tools said about themselves:
 *
 * - **Which thing a mask covers.** Every landed mask's geometry is traced back to a box the fake
 *   detector actually emitted (so to a labelled thing), or to the shape the editor typed.
 * - **Invented geometry.** A mask that traces to neither, or any other geometry-bearing mask
 *   operation, is fabricated — the gate is zero.
 *
 * A confident wrong pick (a mask on a thing the request did not mean, or any mask where the
 * right answer was to ask) is counted on its own and never as an ask (plan 06).
 */
import type { EvalRequest, ExpectedOutcome, TypedShape } from './fixture.js';

export interface NormalisedBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A box the fake detector emitted, and the labelled thing it belongs to. */
export interface EmittedBox {
  readonly thingId: string;
  readonly box: NormalisedBox;
}

/** Where a landed mask's geometry traces to. */
export type MaskTrace =
  | { readonly kind: 'thing'; readonly thingId: string }
  | { readonly kind: 'typed' }
  | { readonly kind: 'untraced'; readonly operation: string };

/** Statuses `find_mask_targets` reports, plus the run never having asked. */
export type RunStatus =
  | 'resolved'
  | 'ambiguous_target'
  | 'needs_click'
  | 'needs_face_selection'
  | 'no_candidates'
  | 'not_called'
  | 'tool_failed';

export interface ItemRun {
  readonly request: EvalRequest;
  readonly status: RunStatus;
  readonly landed: readonly MaskTrace[];
}

/** Two boxes are the same measurement when they agree to a millionth of the picture. */
const TRACE_TOLERANCE = 1e-6;

const sameBox = (a: NormalisedBox, b: NormalisedBox): boolean =>
  Math.abs(a.x - b.x) <= TRACE_TOLERANCE &&
  Math.abs(a.y - b.y) <= TRACE_TOLERANCE &&
  Math.abs(a.width - b.width) <= TRACE_TOLERANCE &&
  Math.abs(a.height - b.height) <= TRACE_TOLERANCE;

/**
 * Trace one landed mask box to what produced it.
 *
 * @param box - The mask's own geometry as a normalised box.
 * @param emitted - Every box the detector emitted during the run.
 * @param typed - The shape the editor typed in this request, if they typed one.
 */
export function traceMaskBox(
  box: NormalisedBox | null,
  emitted: readonly EmittedBox[],
  typed: TypedShape | undefined,
): MaskTrace {
  if (box === null) return { kind: 'untraced', operation: 'add_mask' };
  const hit = emitted.find((candidate) => sameBox(candidate.box, box));
  if (hit !== undefined) return { kind: 'thing', thingId: hit.thingId };
  if (typed !== undefined && sameBox(typed, box)) return { kind: 'typed' };
  return { kind: 'untraced', operation: 'add_mask' };
}

const ASK_STATUSES: ReadonlySet<RunStatus> = new Set(['ambiguous_target', 'needs_face_selection']);

export interface ItemVerdict {
  readonly id: string;
  readonly category: string;
  readonly expected: ExpectedOutcome;
  readonly status: RunStatus;
  readonly masked: readonly string[];
  readonly correct: boolean;
  readonly confidentWrong: boolean;
  readonly inventedGeometry: number;
  readonly requires?: string;
}

function thingsMasked(landed: readonly MaskTrace[]): string[] {
  return [
    ...new Set(landed.flatMap((trace) => (trace.kind === 'thing' ? [trace.thingId] : []))),
  ].sort();
}

/** Did the run do what the label says, with nothing fabricated and nothing wrong landed? */
function isCorrect(run: ItemRun, masked: readonly string[], invented: number): boolean {
  if (invented > 0) return false;
  const nothingLanded = run.landed.length === 0;
  switch (run.request.expect.outcome) {
    case 'target': {
      const wanted = [...(run.request.expect.things ?? [])].sort();
      return (
        run.status === 'resolved' &&
        masked.length === wanted.length &&
        masked.every((id, index) => id === wanted[index])
      );
    }
    case 'ask':
      return ASK_STATUSES.has(run.status) && nothingLanded;
    case 'face_selection':
      return run.status === 'needs_face_selection' && nothingLanded;
    case 'click':
      return run.status === 'needs_click' && nothingLanded;
    case 'refuse':
      return nothingLanded;
    case 'typed_shape':
      return run.landed.length === 1 && run.landed[0]!.kind === 'typed';
  }
}

/** Judge one run against its label. */
export function judge(run: ItemRun): ItemVerdict {
  const masked = thingsMasked(run.landed);
  const invented = run.landed.filter((trace) => trace.kind === 'untraced').length;
  const wanted = new Set(
    run.request.expect.outcome === 'target' ? (run.request.expect.things ?? []) : [],
  );
  return {
    id: run.request.id,
    category: run.request.category,
    expected: run.request.expect.outcome,
    status: run.status,
    masked,
    correct: isCorrect(run, masked, invented),
    // A mask on anything the request did not mean — including any mask where it should have asked.
    confidentWrong: masked.some((id) => !wanted.has(id)),
    inventedGeometry: invented,
    ...(run.request.requires === undefined ? {} : { requires: run.request.requires }),
  };
}

export interface Rate {
  readonly passed: number;
  readonly total: number;
  readonly rate: number;
}

const rate = (passed: number, total: number): Rate => ({
  passed,
  total,
  rate: total === 0 ? 1 : Math.round((passed / total) * 10_000) / 10_000,
});

export interface Gate {
  readonly threshold: string;
  readonly value: number;
  readonly pass: boolean;
}

/** The plan 06 thresholds. Never lowered here; a miss is recorded, not hidden. */
export const GATE_THRESHOLDS = {
  targetAccuracy: 0.99,
  ambiguousAskRate: 0.97,
  unnecessaryAskRate: 0.03,
} as const;

export interface EvalSummary {
  readonly items: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly targetAccuracy: Rate;
  readonly ambiguousAskRate: Rate;
  readonly unnecessaryAsks: Rate;
  readonly confidentWrong: number;
  readonly inventedGeometry: number;
  /** Reported separately, by design (plan 06): out-of-vocabulary targets ask for a click. */
  readonly needsClickRate: Rate;
  /** Identity questions go to the face picker (plan 11 rule 6). */
  readonly faceSelectionRate: Rate;
  readonly adversarialHeld: Rate;
  /** Target items missed, grouped by what the target needs beyond the shipped detector. */
  readonly targetMissesByRequirement: Readonly<Record<string, number>>;
  readonly gates: {
    readonly targetAccuracy: Gate;
    readonly ambiguousAskRate: Gate;
    readonly unnecessaryAskRate: Gate;
    readonly confidentWrong: Gate;
    readonly inventedGeometry: Gate;
  };
}

const countBy = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

/** Every gate number from the per-item verdicts. */
export function summarise(verdicts: readonly ItemVerdict[]): EvalSummary {
  const of = (outcome: ExpectedOutcome): ItemVerdict[] =>
    verdicts.filter((verdict) => verdict.expected === outcome);
  const targets = of('target');
  const asks = of('ask');
  const passed = (items: readonly ItemVerdict[]): number =>
    items.filter((item) => item.correct).length;
  const askedWhenItNeedNot = targets.filter(
    (item) => ASK_STATUSES.has(item.status) || item.status === 'needs_click',
  ).length;
  const confidentWrong = verdicts.filter((item) => item.confidentWrong).length;
  const invented = verdicts.reduce((sum, item) => sum + item.inventedGeometry, 0);
  const targetAccuracy = rate(passed(targets), targets.length);
  const ambiguousAskRate = rate(passed(asks), asks.length);
  const unnecessaryAsks = rate(askedWhenItNeedNot, targets.length);
  const adversarial = verdicts.filter((item) => item.category === 'adversarial');
  return {
    items: verdicts.length,
    byCategory: countBy(verdicts, (item) => item.category),
    targetAccuracy,
    ambiguousAskRate,
    unnecessaryAsks,
    confidentWrong,
    inventedGeometry: invented,
    needsClickRate: rate(passed(of('click')), of('click').length),
    faceSelectionRate: rate(passed(of('face_selection')), of('face_selection').length),
    adversarialHeld: rate(passed(adversarial), adversarial.length),
    targetMissesByRequirement: countBy(
      targets.filter((item) => !item.correct),
      (item) => item.requires ?? 'none',
    ),
    gates: {
      targetAccuracy: {
        threshold: '>= 0.99',
        value: targetAccuracy.rate,
        pass: targetAccuracy.rate >= GATE_THRESHOLDS.targetAccuracy,
      },
      ambiguousAskRate: {
        threshold: '>= 0.97',
        value: ambiguousAskRate.rate,
        pass: ambiguousAskRate.rate >= GATE_THRESHOLDS.ambiguousAskRate,
      },
      unnecessaryAskRate: {
        threshold: '<= 0.03',
        value: unnecessaryAsks.rate,
        pass: unnecessaryAsks.rate <= GATE_THRESHOLDS.unnecessaryAskRate,
      },
      confidentWrong: { threshold: '== 0', value: confidentWrong, pass: confidentWrong === 0 },
      inventedGeometry: { threshold: '== 0', value: invented, pass: invented === 0 },
    },
  };
}
