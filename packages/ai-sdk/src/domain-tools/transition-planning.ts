/**
 * What goes at a cut, decided from the cut (VU4.2).
 *
 * `add_transition` used to take a catalog id and a duration, and knew nothing about the two
 * shots it sat between (ADR 0175, "Nothing consumes measurements"). `chooseTransition` in
 * `@framepilot/editor-core` is the policy that turns a stated *reason* plus the measured
 * cut into a kind and a length; this module is its caller, and it is where the two are
 * joined to the timeline's own boundaries.
 *
 * ## The rule that makes the plural tool safe
 *
 * A pass over every cut must be allowed to decide that most of them get nothing. The
 * continuity cut — same scene, shots that follow one another — is the one where a
 * transition is the classic amateur tell, so `'auto'` leaves it hard.
 *
 * But a result that only lists what it added reads as an omission, and a model that reads
 * an omission fixes it: the next turn adds the dissolves the pass deliberately withheld.
 * So {@link describeTransitionPlan} names **every** cut left hard and why, and that
 * sentence is the tool's result. It is not decoration.
 */
import { listEditBoundaries } from '@framepilot/editor-core';
import type { EditBoundary, MeasuredCut, TransitionChoice } from '@framepilot/editor-core';
import { TRANSITION_REASONS, chooseTransition } from '@framepilot/editor-core';
import type { TransitionReason } from '@framepilot/editor-core';
import type { ToolContext } from '../tool-context.js';
import type { PictureCut, PictureSlice } from '../kernel/semantic-index/picture.js';
import {
  cutHasFacts,
  cutIndexOf,
  cutKey,
  pacingOf,
  pictureClipOf,
  pictureOf,
} from './picture-facts.js';

export { TRANSITION_REASONS };
export type { TransitionReason };

/**
 * Mean luma below which a shot is treated as dark for the dip-to-black rule.
 *
 * A fifth of full scale. The policy asks "is the incoming shot dark?" only to decide
 * whether a big exposure change should dip through black rather than blend through a grey
 * neither shot contains, so the threshold wants to be where an audience would say "that
 * shot is dark", not where a waveform would. A shot the ledger flagged `black` is dark
 * whatever its mean says.
 */
const DARK_LUMA_MEAN = 0.2;

/** One cut, the reason chosen for it, and what the policy answered. */
export interface TransitionDecision {
  readonly trackId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
  /** TIMELINE seconds. */
  readonly at: number;
  readonly reason: TransitionReason;
  /** `null` means the policy's answer is a hard cut. */
  readonly choice: TransitionChoice | null;
  /** Why this cut got what it got, in the words the result prints. */
  readonly why: string;
  /** True when no tier has measured this cut, so the reason is stated rather than derived. */
  readonly unmeasured: boolean;
  /** The transition already sitting on this cut, when there is one. */
  readonly existingKind?: string;
}

/** The picture facts of one cut, in the shape the policy reads. */
export function measuredCutOf(
  slice: PictureSlice,
  cut: PictureCut | undefined,
  boundary: EditBoundary,
  index: number,
  isFirstCut: boolean,
): MeasuredCut {
  const from = pictureClipOf(slice, boundary.fromClipId)?.dominant?.measured;
  const to = pictureClipOf(slice, boundary.toClipId)?.dominant?.measured;
  const movement = pictureClipOf(slice, boundary.fromClipId)?.dominant?.described?.camera?.movement;
  const delta = cut?.delta;
  const flags = cut?.flags ?? [];
  return {
    ...(delta?.luma === null || delta?.luma === undefined ? {} : { lumaDelta: delta.luma }),
    ...(delta?.warmth === null || delta?.warmth === undefined ? {} : { warmthDelta: delta.warmth }),
    ...(delta?.shotSizeSteps === null || delta?.shotSizeSteps === undefined
      ? {}
      : { shotSizeSteps: delta.shotSizeSteps }),
    // The picture slice says `none` where the policy says `same`; both mean "neither side is
    // busier". `null` there is UNKNOWN and stays absent, which is not the same thing.
    ...(delta?.motionChange === null || delta?.motionChange === undefined
      ? {}
      : { motionChange: delta.motionChange === 'none' ? ('same' as const) : delta.motionChange }),
    ...(movement === null || movement === undefined ? {} : { outgoingCameraMovement: movement }),
    ...(delta?.duplicate === null || delta?.duplicate === undefined
      ? {}
      : { duplicate: delta.duplicate }),
    jumpCut: flags.includes('jump_cut'),
    ...(from === null || from === undefined
      ? {}
      : { outgoingIsDark: from.black || from.luma.mean < DARK_LUMA_MEAN }),
    ...(to === null || to === undefined
      ? {}
      : { incomingIsDark: to.black || to.luma.mean < DARK_LUMA_MEAN }),
    isFirstCut,
    index,
  };
}

/**
 * The reason `'auto'` derives for one cut, and the sentence explaining it.
 *
 * Three rules and a default, exactly as VU4.2 states them: a jump cut is softened, a change
 * of place gets a location transition, and everything else is left as the hard cut it
 * already is. An unmeasured cut is NOT guessed at — a transition placed on a cut nothing
 * has looked at is the same guess the whole phase exists to remove.
 */
export function autoReasonFor(cut: PictureCut | undefined): {
  reason: TransitionReason;
  why: string;
  unmeasured: boolean;
} {
  if (cut === undefined) {
    return {
      reason: 'continuity',
      why: 'nothing has measured this cut, so it was left hard rather than guessed at',
      unmeasured: true,
    };
  }
  if (cut.flags.includes('jump_cut')) {
    return {
      reason: 'soften',
      why: 'the two sides show the same framing a moment apart — a jump cut, softened',
      unmeasured: false,
    };
  }
  if (cut.delta.sameSetting === false) {
    return {
      reason: 'location_change',
      why: 'the setting changes across this cut',
      unmeasured: false,
    };
  }
  if (cut.delta.sameSetting === null) {
    return {
      reason: 'continuity',
      why:
        'nothing has recognised what either side shows, so there is no change of place to ' +
        'transition on and the cut was left hard',
      unmeasured: true,
    };
  }
  return {
    reason: 'continuity',
    why: 'both sides are the same setting and the cut reads as continuous',
    unmeasured: false,
  };
}

/** How a caller names the cuts to treat. */
export interface TransitionPassRequest {
  /** Limit the pass to one layer. Absent ⇒ every layer that has cuts. */
  readonly trackId?: string | undefined;
  /** `'auto'` reads each cut's flags; a reason word applies that reason to every cut. */
  readonly reason?: 'auto' | TransitionReason | undefined;
  /** Specific cuts, each optionally with its own reason. Absent ⇒ every cut in scope. */
  readonly cuts?:
    | readonly {
        readonly fromClipId: string;
        readonly toClipId: string;
        readonly reason?: TransitionReason | undefined;
      }[]
    | undefined;
}

/**
 * Decide what belongs at every cut in scope.
 *
 * Pure over `(project, ledger)`: the picture slice and the project index are both memoized,
 * so the planner can be run twice — once to build the operations, once to write the result
 * sentence — without doing the work twice.
 *
 * @param ctx - The tool context; supplies the project and, when the host fetched one, the
 *   shot ledger the deltas come from.
 * @param request - Which cuts, and the reason to read them by.
 * @returns One decision per cut, in timeline order, including the ones left hard.
 */
export function planTransitions(
  ctx: ToolContext,
  request: TransitionPassRequest,
): readonly TransitionDecision[] {
  const slice = pictureOf(ctx);
  const cuts = cutIndexOf(slice);
  const boundaries = listEditBoundaries(ctx.project.timeline, ctx.project.assets)
    .filter((boundary) => request.trackId === undefined || boundary.trackId === request.trackId)
    .sort((a, b) => a.at - b.at || a.trackId.localeCompare(b.trackId));

  const wanted =
    request.cuts === undefined
      ? undefined
      : new Map(request.cuts.map((cut) => [cutKey(cut.fromClipId, cut.toClipId), cut.reason]));

  // Position is counted PER LAYER, because `isFirstCut` is what makes `reveal` mean
  // something and the first cut of the programme is the first cut of its own layer.
  const seenPerTrack = new Map<string, number>();
  const decisions: TransitionDecision[] = [];
  for (const boundary of boundaries) {
    const key = cutKey(boundary.fromClipId, boundary.toClipId);
    if (wanted !== undefined && !wanted.has(key)) continue;
    const index = seenPerTrack.get(boundary.trackId) ?? 0;
    seenPerTrack.set(boundary.trackId, index + 1);

    // A cut with no fact on it is treated as absent, not as "measured and unremarkable":
    // the picture slice yields a cut for every touching pair, ledger or no ledger.
    const found = cuts.get(key);
    const cut = found !== undefined && cutHasFacts(found) ? found : undefined;
    const existingCut = found;
    const explicit = wanted?.get(key) ?? (request.reason === 'auto' ? undefined : request.reason);
    // A cut that already carries a transition is left alone unless the caller named it.
    // A sweep that re-decided every cut would replace the editor's own choices with the
    // policy's, which is not what "add transitions where they belong" asks for.
    const existingKind = existingCut?.delta.transition ?? undefined;
    if (existingKind !== undefined && wanted === undefined) {
      decisions.push({
        trackId: boundary.trackId,
        fromClipId: boundary.fromClipId,
        toClipId: boundary.toClipId,
        at: boundary.at,
        reason: 'continuity',
        choice: null,
        why: `it already carries a ${existingKind}, so it was left as it is`,
        unmeasured: false,
        existingKind,
      });
      continue;
    }
    const derived = autoReasonFor(cut);
    const reason = explicit ?? derived.reason;
    const measured = measuredCutOf(slice, cut, boundary, index, index === 0);
    const choice = chooseTransition(reason, measured, pacingOf(slice, boundary.trackId));
    decisions.push({
      trackId: boundary.trackId,
      fromClipId: boundary.fromClipId,
      toClipId: boundary.toClipId,
      at: boundary.at,
      reason,
      choice,
      why:
        explicit === undefined
          ? derived.why
          : choice === null
            ? `"${reason}" is a hard cut by policy`
            : `you asked for "${reason}" here`,
      unmeasured: explicit === undefined ? derived.unmeasured : cut === undefined,
      ...(existingKind === undefined ? {} : { existingKind }),
    });
  }
  return decisions;
}

/** Seconds, printed the way an editor reads a timecode field. */
function at(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
}

/**
 * The result sentence: what was added, and every cut deliberately left hard.
 *
 * The second half is the load-bearing one. A pass that says "added 2 transitions" over a
 * 12-cut sequence has told the model nothing about the other ten, and the model's next move
 * is to add ten more.
 */
export function describeTransitionPlan(decisions: readonly TransitionDecision[]): string {
  if (decisions.length === 0) {
    return ' — no cuts in scope: a transition needs two clips that touch on one layer.';
  }
  const added = decisions.filter((decision) => decision.choice !== null);
  const hard = decisions.filter(
    (decision) => decision.choice === null && decision.existingKind === undefined,
  );
  const kept = decisions.filter(
    (decision) => decision.choice === null && decision.existingKind !== undefined,
  );
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(
      `${String(added.length)} transition(s): ` +
        added
          .map(
            (decision) =>
              `${at(decision.at)} ${decision.choice?.kind ?? ''} ` +
              `${String(decision.choice?.durationSeconds ?? 0)}s (${decision.reason})`,
          )
          .join(', '),
    );
  }
  if (hard.length > 0) {
    parts.push(
      `${String(hard.length)} cut(s) deliberately left as hard cuts: ` +
        hard.map((decision) => `${at(decision.at)} — ${decision.why}`).join('; ') +
        '. Those are decisions, not omissions',
    );
  }
  if (kept.length > 0) {
    parts.push(
      `${String(kept.length)} cut(s) already carried a transition and were untouched: ` +
        kept.map((decision) => `${at(decision.at)} ${decision.existingKind ?? ''}`).join(', '),
    );
  }
  return ` — ${parts.join('. ')}.`;
}

/**
 * The result note for the two transition tools, or `''` for any other call.
 *
 * Re-plans rather than carrying state out of `buildOps`, for the reason
 * {@link planTransitions} is pure: two derivations of one decision are cheaper than a
 * second place where the decision lives.
 */
export function transitionsNote(toolName: string, ctx: ToolContext, rawArgs: unknown): string {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (toolName === 'add_transitions') {
    try {
      return describeTransitionPlan(
        planTransitions(ctx, {
          ...(typeof args.trackId === 'string' ? { trackId: args.trackId } : {}),
          reason: readReason(args.reason) ?? 'auto',
          ...(Array.isArray(args.cuts) ? { cuts: args.cuts as TransitionPassRequest['cuts'] } : {}),
        }),
      );
    } catch {
      // The patch is already applied and reported; a note that cannot be built is not a
      // reason to fail the call.
      return '';
    }
  }
  if (toolName === 'add_transition' && typeof args.reason === 'string' && args.kind === undefined) {
    return (
      ` — chosen from the reason "${args.reason}" and what the two shots measure, not from a ` +
      'catalog id.'
    );
  }
  return '';
}

/** `'auto'`, a known reason, or `undefined` for anything else. */
function readReason(value: unknown): 'auto' | TransitionReason | undefined {
  if (value === 'auto') return 'auto';
  return TRANSITION_REASONS.find((reason) => reason === value);
}
