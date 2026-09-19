/**
 * Reviewing a track, and fixing it (MK7.3, plan 10 "Tracking → Review").
 *
 * The tracker reports a confidence per frame and the host penalises it by the model residual
 * (`mask-track-solve.ts`), so "where is this track wrong?" is already a measured number rather
 * than an opinion. This module turns that number into the two things the editor works with:
 *
 * 1. **The review list**, shared with mattes (`MaskReview`: flagged ranges, approved ranges,
 *    locked instants), so tracking and background removal are one list to step through rather
 *    than two panels that each know half the problem.
 * 2. **Constraint frames.** The editor fixes the mask on a bad frame; that frame becomes a hard
 *    constraint, and the track is re-measured outwards from it in both directions until
 *    confidence recovers. The constraint is exact by construction: the re-measured segment is
 *    anchored ON the constraint frame, so its transform there is the identity and the mask's own
 *    (corrected) geometry is what renders — the `06` gate "constraint frames 100 % exact after
 *    any re-track" is a property of the anchoring, not something a tolerance has to catch.
 *
 * A re-track therefore produces SEGMENTS, one per constraint, which {@link mergeTrackSegments}
 * joins into the single artifact both renderers read. Each frame takes its transform from the
 * segment whose constraint is nearest, so a frame is always measured from the closest thing the
 * editor confirmed.
 */
import {
  TRACK_ARTIFACT_VERSION,
  trackFrameIndexAt,
  type TrackArtifact,
  type TrackMethod,
} from './mask-track.js';
import { TRACK_FLAG_CONFIDENCE, flaggedTrackRanges, type TrackRange } from './mask-track-solve.js';

/** Review state as the schema stores it (`MaskReviewSchema`), shared with mattes. */
export interface TrackReview {
  readonly flagged: readonly TrackRange[];
  readonly approved: readonly TrackRange[];
  readonly locked: readonly number[];
}

/**
 * The review state a freshly measured track starts with.
 *
 * Nothing is approved and nothing is locked yet: a track the editor has not looked at is not
 * "verified", and a confident track simply has an empty flagged list, which is what the Inspector
 * shows as Verified. Ranges the editor already approved are carried over when they no longer
 * intersect anything flagged, so re-tracking one bad stretch does not throw away the review work
 * done on the rest.
 */
export function trackReviewFor(
  artifact: TrackArtifact,
  previous?: TrackReview,
  floor: number = TRACK_FLAG_CONFIDENCE,
): TrackReview {
  const flagged = flaggedTrackRanges(artifact, floor);
  const approved = (previous?.approved ?? []).filter(
    (range) => !flagged.some((bad) => overlaps(range, bad)),
  );
  return { flagged, approved, locked: [...(previous?.locked ?? [])].sort((a, b) => a - b) };
}

function overlaps(left: TrackRange, right: TrackRange): boolean {
  return left.start < right.end && right.start < left.end;
}

/** Whether every frame of the track now clears the confidence floor. */
export function trackIsVerified(review: TrackReview): boolean {
  return review.flagged.length === 0;
}

/**
 * Add a constraint at `sourceTime`, keeping the list sorted and free of duplicates.
 *
 * A constraint is a source instant, not a frame index, because that is the clock a mask's
 * keyframes already use: trimming, slipping or re-speeding the clip must not move the frame the
 * editor confirmed.
 */
export function withConstraint(
  constraints: readonly { readonly sourceTime: number }[],
  sourceTime: number,
  tolerance = 1e-9,
): readonly { readonly sourceTime: number }[] {
  if (constraints.some((entry) => Math.abs(entry.sourceTime - sourceTime) <= tolerance)) {
    return constraints;
  }
  return [...constraints, { sourceTime }].sort((left, right) => left.sourceTime - right.sourceTime);
}

/** One measurement a re-track has to run. */
export interface RetrackSegment {
  /** The constraint this segment is anchored on, in source seconds. */
  readonly sourceTime: number;
  readonly referenceFrame: number;
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly reverse: boolean;
}

export interface RetrackPlanInput {
  readonly artifact: TrackArtifact;
  /** Source instants the editor has confirmed, in any order. */
  readonly constraints: readonly { readonly sourceTime: number }[];
  /** The clip's source frame range, half-open, on the track's frame grid. */
  readonly firstFrame: number;
  readonly lastFrameExclusive: number;
  readonly floor?: number;
}

/**
 * Which ranges a re-track measures, given the constraints the editor has set.
 *
 * Each constraint owns the frames that are nearer to it than to any other constraint, and is
 * measured outwards in both directions — so a constraint in the middle of a bad stretch produces
 * two runs, and the frames between two constraints are always measured from the closer one.
 *
 * Only stretches that need it are re-measured: a constraint whose whole neighbourhood already
 * clears the floor produces no run at all, so fixing one frame does not re-track the clip.
 *
 * And a run stops where confidence does come back (plan 10: "re-runs from it in both directions
 * until it meets confidence again"): each direction measures from the constraint to the end of
 * the first low-confidence stretch it meets, not to the clip edge. Before MK7.5 a run went on to
 * the neighbour midpoint or the edge and replaced frames the first track already had right —
 * measured on real texture, one constraint inside an occlusion re-measured up to 85 good frames
 * and made 112 of them worse than before.
 */
export function retrackPlan(input: RetrackPlanInput): readonly RetrackSegment[] {
  const { artifact, firstFrame, lastFrameExclusive } = input;
  const floor = input.floor ?? TRACK_FLAG_CONFIDENCE;
  const anchors = [...input.constraints]
    .map((entry) => ({
      sourceTime: entry.sourceTime,
      frame: artifact.firstFrame + trackFrameIndexAt(artifact, entry.sourceTime),
    }))
    .filter((anchor) => anchor.frame >= firstFrame && anchor.frame < lastFrameExclusive)
    .sort((left, right) => left.frame - right.frame);
  const segments: RetrackSegment[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    const previous = anchors[index - 1];
    const next = anchors[index + 1];
    // The midpoint between neighbouring constraints: every frame belongs to its nearest one.
    const low =
      previous === undefined ? firstFrame : Math.ceil((previous.frame + anchor.frame) / 2);
    const high =
      next === undefined ? lastFrameExclusive : Math.ceil((anchor.frame + next.frame) / 2);
    const forwardEnd = stretchEndAfter(artifact, anchor.frame, high, floor);
    // A run of just the constraint frame is still a run: it is what makes that frame exact
    // (identity on the editor's corrected geometry). Skipping it left a one-frame flagged range
    // on its old, wrong transform.
    if (forwardEnd !== undefined && forwardEnd - anchor.frame >= 1) {
      segments.push({
        sourceTime: anchor.sourceTime,
        referenceFrame: anchor.frame,
        firstFrame: anchor.frame,
        lastFrameExclusive: forwardEnd,
        reverse: false,
      });
    }
    const backwardStart = stretchStartBefore(artifact, anchor.frame, low, floor);
    if (backwardStart !== undefined && anchor.frame + 1 - backwardStart > 1) {
      segments.push({
        sourceTime: anchor.sourceTime,
        referenceFrame: anchor.frame,
        firstFrame: backwardStart,
        lastFrameExclusive: anchor.frame + 1,
        reverse: true,
      });
    }
  }
  return segments;
}

function isLow(artifact: TrackArtifact, frame: number, floor: number): boolean {
  const index = frame - artifact.firstFrame;
  if (index < 0 || index >= artifact.confidence.length) return false;
  return artifact.confidence[index]! < floor;
}

/**
 * Walking forwards from `anchor` (inclusive) up to `high` (exclusive): the frame just past the
 * first low-confidence stretch met, or `undefined` when nothing in reach is low.
 */
function stretchEndAfter(
  artifact: TrackArtifact,
  anchor: number,
  high: number,
  floor: number,
): number | undefined {
  let frame = anchor;
  while (frame < high && !isLow(artifact, frame, floor)) frame += 1;
  if (frame >= high) return undefined;
  while (frame < high && isLow(artifact, frame, floor)) frame += 1;
  return frame;
}

/**
 * Walking backwards from `anchor` (inclusive) down to `low` (inclusive): the first frame of the
 * first low-confidence stretch met, or `undefined` when nothing in reach is low.
 */
function stretchStartBefore(
  artifact: TrackArtifact,
  anchor: number,
  low: number,
  floor: number,
): number | undefined {
  let frame = anchor;
  while (frame >= low && !isLow(artifact, frame, floor)) frame -= 1;
  if (frame < low) return undefined;
  while (frame >= low && isLow(artifact, frame, floor)) frame -= 1;
  return frame + 1;
}

/** A measured segment and the constraint frame it is anchored on. */
export interface TrackSegment {
  readonly artifact: TrackArtifact;
  /** The frame whose transform is the identity in this segment. */
  readonly referenceFrame: number;
}

export class TrackMergeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TrackMergeError';
  }
}

/**
 * Join measured segments into the one artifact both renderers read.
 *
 * A frame present in several segments is taken from the segment whose reference frame is
 * nearest (ties to the earlier reference), so every frame is measured from the closest thing the
 * editor confirmed. Segments must agree about the method, the time base and the origin — they
 * are measurements of the same media, and a mismatch is a caller bug, not something to average.
 *
 * `point-cloud` segments keep their own points; the merged track's point count is the one they
 * share, and a segment that disagrees is refused rather than padded.
 *
 * @throws TrackMergeError when the segments cannot describe one track.
 */
export function mergeTrackSegments(segments: readonly TrackSegment[]): TrackArtifact {
  if (segments.length === 0) throw new TrackMergeError('A track needs at least one measurement.');
  const [first] = segments as readonly [TrackSegment, ...TrackSegment[]];
  const method: TrackMethod = first.artifact.method;
  const pointCount = first.artifact.points?.count;
  for (const segment of segments) {
    const { artifact } = segment;
    if (
      artifact.method !== method ||
      artifact.timeBase[0] !== first.artifact.timeBase[0] ||
      artifact.timeBase[1] !== first.artifact.timeBase[1] ||
      artifact.originPts !== first.artifact.originPts ||
      artifact.points?.count !== pointCount
    ) {
      throw new TrackMergeError('These measurements do not describe one track.');
    }
  }
  /** Per pts: the winning segment and its index within it. */
  const chosen = new Map<number, { segment: TrackSegment; index: number; distance: number }>();
  for (const segment of segments) {
    const { artifact } = segment;
    for (let index = 0; index < artifact.pts.length; index += 1) {
      const frame = artifact.firstFrame + index;
      const distance = Math.abs(frame - segment.referenceFrame);
      const pts = artifact.pts[index]!;
      const current = chosen.get(pts);
      if (
        current === undefined ||
        distance < current.distance ||
        (distance === current.distance && segment.referenceFrame < current.segment.referenceFrame)
      ) {
        chosen.set(pts, { segment, index, distance });
      }
    }
  }
  const ordered = [...chosen.keys()].sort((left, right) => left - right);
  const transforms: number[] = [];
  const confidence: number[] = [];
  const positions: number[] = [];
  for (const pts of ordered) {
    const { segment, index } = chosen.get(pts)!;
    const { artifact } = segment;
    transforms.push(...artifact.transforms.slice(index * 9, index * 9 + 9));
    confidence.push(artifact.confidence[index]!);
    if (pointCount !== undefined && artifact.points !== undefined) {
      const base = index * pointCount * 2;
      positions.push(...artifact.points.frames.slice(base, base + pointCount * 2));
    }
  }
  // The merged track's first frame is the source frame of its earliest pts, taken from whichever
  // segment measured it, so the frame grid stays contiguous with the segments that produced it.
  const firstFrame = frameOf(segments, ordered[0]!);
  return {
    version: TRACK_ARTIFACT_VERSION,
    method,
    timeBase: first.artifact.timeBase,
    originPts: first.artifact.originPts,
    firstFrame,
    pts: ordered,
    transforms,
    confidence,
    ...(pointCount === undefined
      ? {}
      : {
          points: {
            count: pointCount,
            reference: first.artifact.points!.reference,
            frames: positions,
          },
        }),
  };
}

/** The decode-order source frame a pts belongs to, from whichever segment holds it. */
function frameOf(segments: readonly TrackSegment[], pts: number): number {
  for (const segment of segments) {
    const index = segment.artifact.pts.indexOf(pts);
    if (index >= 0) return segment.artifact.firstFrame + index;
  }
  /* istanbul ignore next - every pts came from a segment */
  return 0;
}
