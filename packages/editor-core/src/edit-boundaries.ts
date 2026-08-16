/**
 * Edit boundaries — where the sequence actually cuts, and whether a transition
 * can live there.
 *
 * ## WHY this module exists
 *
 * `add_transition` used to stamp a transition effect onto whatever clip id it
 * was handed. It never checked that the two clips were adjacent, on the same
 * track, in the right order, or that either had the source footage a dissolve
 * needs to overlap into. So "add a transition at the pivot" returned success for
 * a pivot in the *middle of a continuous clip* — where there is no cut to
 * transition across — and the agent, seeing `applied`, reported the transition
 * as done. Nothing was visible in playback, and nothing said so.
 *
 * A transition is not an effect on a clip. It is a treatment of a **boundary**
 * between two clips, and asking for one where no boundary exists is a request
 * that cannot be satisfied, however cleanly the operation applies.
 *
 * ## What this engine does and does not require
 *
 * FramePilot's renderer models a transition as a ramp over the **incoming
 * clip's** first `durationSeconds` — opacity for fade/cross-dissolve, geometry
 * for push/zoom/slide, a reveal for wipe, a radius for blur (see
 * `engine/python/framepilot_engine/render/transitions.py`). Because the compiler
 * composites top-down, that one primitive is a true cross-dissolve where the
 * clips overlap and a fade-from-black where they are sequential.
 *
 * So this engine needs **no source handles**: nothing is borrowed from beyond
 * the cut, and a transition never fails for want of footage. Handles are still
 * worth reporting — they are what tells an editor whether a dissolve will blend
 * two shots or fade through black — but they are information, not a gate.
 * Gating on them (as most NLEs must, because they conform the media) would
 * refuse transitions this renderer produces perfectly well.
 *
 * What genuinely constrains a transition here is the boundary itself and the
 * length of the two clips, and that is what this module checks.
 *
 * @see docs/adr/0076-canonical-timeline-mapping.md
 */
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { getTransition } from '@framepilot/timeline-schema/transition-catalog';
import { TIME_EPSILON, buildTimelineMap, type ClipSpan } from './timeline-map.js';

/**
 * A real cut: two clips meeting on one track, with the footage available on
 * either side to transition across.
 */
export interface EditBoundary {
  readonly trackId: string;
  /** Sequence time of the cut — the outgoing clip's end and the incoming's start. */
  readonly at: number;
  readonly fromClipId: string;
  readonly toClipId: string;
  /**
   * Source seconds available *after* the outgoing clip's out-point. `Infinity`
   * when the asset's duration is unknown (no asset list was supplied).
   *
   * Informational, not a gate — see the module note. It answers "would a
   * dissolve here blend two shots, or fade through black?", which is worth
   * telling an editor and worth an AI reading before it promises a look.
   */
  readonly outgoingHandle: number;
  /** Source seconds available *before* the incoming clip's in-point. Informational. */
  readonly incomingHandle: number;
  /**
   * The longest transition this boundary can carry: half of the shorter clip.
   * Past that the transition has eaten the shot it was meant to introduce.
   */
  readonly maxTransitionSeconds: number;
}

/** Why a requested transition cannot be applied as asked. */
export type TransitionRejection =
  | 'unknown_kind'
  | 'invalid_duration'
  | 'no_such_clip'
  | 'different_tracks'
  | 'not_adjacent'
  | 'wrong_order'
  | 'clip_too_short';

/** The verdict on a requested transition, with the numbers behind it. */
export type TransitionEligibility =
  | {
      readonly ok: true;
      readonly boundary: EditBoundary;
      /** The duration that will actually be applied (never more than asked). */
      readonly durationSeconds: number;
      /** Set when the request was shortened to fit the boundary. */
      readonly clampedFrom?: number;
    }
  | {
      readonly ok: false;
      readonly reason: TransitionRejection;
      /** Plain-language explanation, safe to show an editor verbatim. */
      readonly detail: string;
      /** The boundary that was found, when one was — absent for a bad reference. */
      readonly boundary?: EditBoundary;
    };

/**
 * How much source lies beyond a clip's out-point, given what we know about the
 * asset. Unknown duration ⇒ `Infinity`; see {@link EditBoundary.outgoingHandle}.
 */
function tailHandle(span: ClipSpan, assetDurations: ReadonlyMap<string, number>): number {
  const duration = assetDurations.get(span.assetId);
  if (duration === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, duration - span.sourceEnd);
}

/**
 * Every real cut in the timeline, in sequence order.
 *
 * A boundary exists where one clip *ends exactly where the next begins* on the
 * same track. A gap is not a boundary (there is no cut, there is black), and
 * neither is a moment inside a continuous clip — which is the case that used to
 * silently accept a transition.
 *
 * @param timeline - The timeline to read.
 * @param assets - Optional asset list; supplying it lets handle availability be
 *   computed exactly rather than assumed unbounded.
 */
export function listEditBoundaries(
  timeline: Timeline,
  assets: readonly Asset[] = [],
): readonly EditBoundary[] {
  const assetDurations = new Map<string, number>();
  for (const asset of assets) {
    if (asset.durationSeconds !== undefined) assetDurations.set(asset.id, asset.durationSeconds);
  }

  const byTrack = new Map<string, ClipSpan[]>();
  for (const span of buildTimelineMap(timeline).spans) {
    const list = byTrack.get(span.trackId);
    if (list === undefined) byTrack.set(span.trackId, [span]);
    else list.push(span);
  }

  const boundaries: EditBoundary[] = [];
  for (const [trackId, spans] of byTrack) {
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1] as ClipSpan;
      const to = ordered[i] as ClipSpan;
      // Abutting, within frame-rounding tolerance. A gap or an overlap is not a
      // clean cut and is not offered as a transition point.
      if (Math.abs(to.start - from.end) > TIME_EPSILON) continue;

      const outgoingHandle = tailHandle(from, assetDurations);
      const incomingHandle = to.sourceStart;
      boundaries.push({
        trackId,
        at: from.end,
        fromClipId: from.clipId,
        toClipId: to.clipId,
        outgoingHandle,
        incomingHandle,
        // Bounded by the clips, NOT by the handles: this renderer borrows no
        // footage from beyond the cut (see the module note).
        maxTransitionSeconds: Math.max(
          0,
          Math.min((from.end - from.start) / 2, (to.end - to.start) / 2),
        ),
      });
    }
  }
  return boundaries.sort((a, b) => a.at - b.at || a.trackId.localeCompare(b.trackId));
}

/** Format a duration for an editor-facing message: "0.5s", "1.25s". */
const secs = (n: number): string => `${Number.isFinite(n) ? +n.toFixed(2) : '∞'}s`;

/**
 * Can this transition actually be applied between these two clips?
 *
 * Every rejection names what is wrong in terms an editor can act on, because the
 * caller's next move differs by reason: a `not_adjacent` request usually wants a
 * split first, while `clip_too_short` wants different clips or no transition.
 *
 * A request longer than the boundary can carry is **clamped, not rejected** —
 * the editor asked for a dissolve there and a shorter one is what the footage
 * supports, so the honest result is the shorter dissolve plus a note. Only a
 * boundary with no usable handles at all is refused.
 *
 * @param timeline - The timeline the transition would be applied to.
 * @param request - The clips to join, and how long the transition should be.
 * @param assets - Optional asset list, for exact handle availability.
 */
/**
 * One timeline's cut structure, prepared once so many eligibility questions can be
 * answered against it.
 *
 * ## WHY this exists
 *
 * {@link transitionEligibility} derives everything it needs from the timeline on every
 * call: a full {@link buildTimelineMap} walk, two linear span scans, and a full
 * {@link listEditBoundaries} pass (which builds the map a second time and sorts). That is
 * fine for the one-off question an AI tool asks. It is quadratic for the caller that asks
 * it about *every cut on a lane* — which is exactly what the timeline UI does to decide
 * whether each junction gets an "add a transition here" affordance. On a track of ~150
 * butt-joined caption clips that was ~150 full-timeline walks per re-render, and the
 * re-render happens on every horizontal scroll, zoom, selection change and drag frame.
 *
 * Building this once and reusing it turns that O(cuts × clips) rebuild into O(clips).
 * `transitionEligibility` itself is now a thin wrapper that builds one of these, so no
 * existing caller changes behaviour or has to know this type exists.
 */
export interface TransitionBoundaryIndex {
  /** Every mapped clip span, keyed by clip id — replaces the per-call linear scans. */
  readonly spanByClipId: ReadonlyMap<string, ClipSpan>;
  /** Every real cut, keyed by `${fromClipId}→${toClipId}` — replaces the per-call `find`. */
  readonly boundaryByCut: ReadonlyMap<string, EditBoundary>;
}

/** Key a boundary by the ordered clip pair it joins. */
const cutKey = (fromClipId: string, toClipId: string): string => `${fromClipId} ${toClipId}`;

/**
 * Prepare a timeline's cut structure for repeated {@link transitionEligibilityIn}
 * questions. Pure, and safe to memoize on the timeline's identity.
 *
 * @param timeline - The timeline to index.
 * @param assets - Optional asset list, for exact handle availability (same meaning as
 *   {@link transitionEligibility}'s).
 */
export function buildTransitionBoundaryIndex(
  timeline: Timeline,
  assets: readonly Asset[] = [],
): TransitionBoundaryIndex {
  const spanByClipId = new Map<string, ClipSpan>();
  for (const span of buildTimelineMap(timeline).spans) spanByClipId.set(span.clipId, span);
  const boundaryByCut = new Map<string, EditBoundary>();
  for (const boundary of listEditBoundaries(timeline, assets)) {
    boundaryByCut.set(cutKey(boundary.fromClipId, boundary.toClipId), boundary);
  }
  return { spanByClipId, boundaryByCut };
}

/** The request shape both eligibility entry points take. */
export interface TransitionEligibilityRequest {
  readonly fromClipId: string;
  readonly toClipId: string;
  readonly durationSeconds: number;
  /**
   * A transition catalog id. Checked for existence and otherwise ignored:
   * every kind this engine renders is a ramp over the incoming clip and none
   * of them needs handles, so no *known* kind is eligible where another is
   * not. The existence check is what stops a typo — or a project written by a
   * newer build — from applying cleanly and rendering nothing.
   */
  readonly kind?: string;
}

/**
 * Can this transition be applied between these two clips? See
 * {@link transitionEligibility} for the full contract — this is the same decision,
 * answered against a prepared {@link TransitionBoundaryIndex} instead of re-deriving
 * one. Identical results; the split exists purely so a caller asking about many cuts
 * on one timeline pays for the derivation once.
 *
 * @param index - A {@link buildTransitionBoundaryIndex} result for the timeline in question.
 * @param request - The clips to join, and how long the transition should be.
 */
export function transitionEligibilityIn(
  index: TransitionBoundaryIndex,
  request: TransitionEligibilityRequest,
): TransitionEligibility {
  if (request.kind !== undefined && getTransition(request.kind) === undefined) {
    return {
      ok: false,
      reason: 'unknown_kind',
      detail: `"${request.kind}" is not a transition this build knows. It may come from a newer version of FramePilot; pick one from the transitions panel instead.`,
    };
  }

  if (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0) {
    return {
      ok: false,
      reason: 'invalid_duration',
      detail: `Transition duration must be a positive finite number, got ${String(request.durationSeconds)}.`,
    };
  }

  const from = index.spanByClipId.get(request.fromClipId);
  const to = index.spanByClipId.get(request.toClipId);

  if (from === undefined || to === undefined) {
    const missing = from === undefined ? request.fromClipId : request.toClipId;
    return {
      ok: false,
      reason: 'no_such_clip',
      detail: `No media clip "${missing}" on the timeline. A transition joins two clips on a video or audio track; caption and overlay clips cannot carry one.`,
    };
  }

  if (from.trackId !== to.trackId) {
    return {
      ok: false,
      reason: 'different_tracks',
      detail: `"${from.clipId}" is on ${from.trackId} and "${to.clipId}" is on ${to.trackId}. A transition treats a cut *within* one track; clips on different tracks are composited, not cut between.`,
    };
  }

  if (to.start < from.start) {
    return {
      ok: false,
      reason: 'wrong_order',
      detail: `"${to.clipId}" plays before "${from.clipId}" (${secs(to.start)} vs ${secs(from.start)}). The outgoing clip must come first.`,
    };
  }

  const boundary = index.boundaryByCut.get(cutKey(from.clipId, to.clipId));
  if (boundary === undefined) {
    const gap = to.start - from.end;
    return {
      ok: false,
      reason: 'not_adjacent',
      detail:
        gap > 0
          ? `There is no cut between these clips — a ${secs(gap)} gap separates them. Close the gap, or transition across a real edit point.`
          : `These clips do not meet at a cut (they overlap by ${secs(-gap)}). A transition needs a clean boundary.`,
    };
  }

  if (boundary.maxTransitionSeconds <= TIME_EPSILON) {
    return {
      ok: false,
      reason: 'clip_too_short',
      detail: `The clips at the ${secs(boundary.at)} cut are too short to carry a transition. Lengthen one of them, or leave it as a hard cut.`,
      boundary,
    };
  }

  const durationSeconds = Math.min(request.durationSeconds, boundary.maxTransitionSeconds);
  return durationSeconds < request.durationSeconds - TIME_EPSILON
    ? { ok: true, boundary, durationSeconds, clampedFrom: request.durationSeconds }
    : { ok: true, boundary, durationSeconds };
}

/**
 * Can this transition actually be applied between these two clips?
 *
 * Every rejection names what is wrong in terms an editor can act on, because the
 * caller's next move differs by reason: a `not_adjacent` request usually wants a
 * split first, while `clip_too_short` wants different clips or no transition.
 *
 * A request longer than the boundary can carry is **clamped, not rejected** —
 * the editor asked for a dissolve there and a shorter one is what the footage
 * supports, so the honest result is the shorter dissolve plus a note. Only a
 * boundary with no usable handles at all is refused.
 *
 * Asking about MANY cuts on one timeline? Build a {@link TransitionBoundaryIndex} once
 * and call {@link transitionEligibilityIn} instead — this entry point re-derives the
 * whole timeline's cut structure per call, which is quadratic over a lane's worth of
 * questions.
 *
 * @param timeline - The timeline the transition would be applied to.
 * @param request - The clips to join, and how long the transition should be.
 * @param assets - Optional asset list, for exact handle availability.
 */
export function transitionEligibility(
  timeline: Timeline,
  request: TransitionEligibilityRequest,
  assets: readonly Asset[] = [],
): TransitionEligibility {
  return transitionEligibilityIn(buildTransitionBoundaryIndex(timeline, assets), request);
}

/**
 * The transition currently applied at a boundary, read back from timeline state.
 *
 * The counterpart to applying one: "the operation returned success" is not
 * evidence that a transition exists, targets the right pair of clips, and has the
 * duration that was asked for. This reads the committed state so that claim can
 * be checked rather than assumed.
 *
 * @returns The transition's kind and duration, or `null` if none is there.
 */
export function readTransitionAt(
  timeline: Timeline,
  boundary: Pick<EditBoundary, 'trackId' | 'toClipId'>,
): { readonly kind: string; readonly durationSeconds: number; readonly fromClipId: string } | null {
  const track = timeline.tracks.find((t) => t.id === boundary.trackId);
  const clip = track?.clips.find((c) => c.id === boundary.toClipId);
  const effect = clip?.effects.find(
    (e) => e.type === 'transition' && e.id === `${boundary.toClipId}__transition`,
  );
  if (effect === undefined) return null;
  const { kind, durationSeconds, fromClipId } = effect.params as {
    kind?: unknown;
    durationSeconds?: unknown;
    fromClipId?: unknown;
  };
  return {
    kind: typeof kind === 'string' ? kind : 'unknown',
    durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : 0,
    fromClipId: typeof fromClipId === 'string' ? fromClipId : '',
  };
}
