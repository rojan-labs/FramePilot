/**
 * The transform-track artifact: what a mask's `tracking` field points at, and how a tracked
 * mask's geometry is moved by it (MK7.1, plan 10 "Tracking").
 *
 * A track is one 3x3 per SOURCE FRAME, stored in a digest-pinned, project-owned file
 * (`<project>/.framepilot-derived/tracks/<key>/track.json`), never as thousands of inline
 * keyframes: a two-minute roto track is 3 600 matrices, and a project file is not a place to
 * put them. The mask keeps only `{ key, sha256 }`, so a track that was changed outside
 * FramePilot is caught rather than silently rendered.
 *
 * The transform is applied **on top of** the mask's own animation, to the mask's control points
 * BEFORE they are flattened (plan 10, "Rasteriser" rule 5): warping the rasterised image would
 * blur the edge the whole mask stack exists to keep exact. So this module hands out a point
 * warp, and the engine (`render/tracks.py`) and the preview apply it to the same numbers in the
 * same order.
 *
 * **Units.** Everything here is display-corrected source pixels — the same space the mask's
 * geometry is stored in (ADR 0178, MK1.9) — so a track and the mask it drives never need a
 * conversion between them. Normalized worker output is converted once, where the track is built.
 *
 * **Determinism.** Reading a transform is an integer index lookup plus nine multiplies, two
 * adds and one divide on float64, in a fixed order, so TypeScript and Python produce the same
 * bits. Nothing here uses `hypot`, `pow` or a reduction whose summation order a runtime may
 * choose. `tests/fixtures/mask-track/` pins it across the two implementations.
 */

/** The only artifact version this build writes or reads. */
export const TRACK_ARTIFACT_VERSION = 1;

/** Largest `track.json` any reader will accept; an honest one is ~120 bytes per frame. */
export const TRACK_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/** Values the renderers do arithmetic on must stay well inside float64 integers. */
const VALUE_BOUND = 2 ** 52;

/** Most frames one track may cover (~5.5 h at 60 fps); bounds an untrusted file's cost. */
const MAX_FRAMES = 1_200_000;

/** Most tracked points a `point-cloud` track may carry, matching the mask vertex budget. */
export const TRACK_MAX_POINTS = 512;

/** A row-major 3x3, nine numbers. */
export type TrackMatrix = readonly number[];

/** The identity transform: the mask sits exactly where its own animation puts it. */
export const TRACK_IDENTITY: TrackMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** How a track was measured. Mirrors `MaskTrackingMethodSchema`. */
export type TrackMethod = 'position' | 'position-scale-rotation' | 'perspective' | 'point-cloud';

export const TRACK_METHODS: readonly TrackMethod[] = [
  'position',
  'position-scale-rotation',
  'perspective',
  'point-cloud',
];

/**
 * Per-vertex positions for a `point-cloud` track.
 *
 * `reference` holds `count` x/y pairs at the reference frame; `frames` holds the same pairs for
 * every tracked frame, frame-major. A path mask driven by one of these moves vertex `i` — and
 * both of its tangents — by `frames[i] - reference[i]`, which is exact for a non-rigid shape and
 * needs no displacement field.
 */
export interface TrackPoints {
  readonly count: number;
  readonly reference: readonly number[];
  readonly frames: readonly number[];
}

/** A parsed, bounds-checked `track.json`. */
export interface TrackArtifact {
  readonly version: number;
  readonly method: TrackMethod;
  /** Source stream time base, `[numerator, denominator]` seconds per tick. */
  readonly timeBase: readonly [number, number];
  /** The pts that is source second zero. */
  readonly originPts: number;
  /** Decode-order source frame of tracked frame 0. */
  readonly firstFrame: number;
  /** Strictly increasing source pts, one per tracked frame. */
  readonly pts: readonly number[];
  /** Nine numbers per tracked frame, row-major, display-corrected source pixels. */
  readonly transforms: readonly number[];
  /** Measured confidence per tracked frame, 0..1. */
  readonly confidence: readonly number[];
  /** Present only on a `point-cloud` track. */
  readonly points?: TrackPoints;
}

export class TrackArtifactError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TrackArtifactError';
  }
}

function fail(message: string): never {
  throw new TrackArtifactError(message);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= VALUE_BOUND;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numbers(value: unknown, what: string): readonly number[] {
  if (!Array.isArray(value)) fail(`track.json ${what} must be a list of numbers.`);
  for (const entry of value as readonly unknown[]) {
    if (!isFiniteNumber(entry)) fail(`track.json ${what} must be a list of finite numbers.`);
  }
  return value as readonly number[];
}

/**
 * Validate a `track.json` document.
 *
 * Every bound is checked before anything is indexed, because this file is read from disk and a
 * project folder is not a trusted input (BR4.12): a malformed length, a non-increasing pts or a
 * value outside float64's integer range refuses here rather than producing a wrong frame.
 *
 * @throws TrackArtifactError with a remedy-shaped message and no varying magnitude.
 */
export function parseTrackArtifact(document: unknown): TrackArtifact {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    fail('track.json must be an object.');
  }
  const raw = document as Record<string, unknown>;
  if (raw['version'] !== TRACK_ARTIFACT_VERSION) {
    fail('track.json was written by a different version of FramePilot. Track the mask again.');
  }
  const method = raw['method'];
  if (typeof method !== 'string' || !TRACK_METHODS.includes(method as TrackMethod)) {
    fail('track.json names a tracking method this version does not know.');
  }
  const timeBase = raw['timeBase'];
  if (
    !Array.isArray(timeBase) ||
    timeBase.length !== 2 ||
    !isInteger(timeBase[0]) ||
    !isInteger(timeBase[1]) ||
    (timeBase[0] as number) <= 0 ||
    (timeBase[1] as number) <= 0
  ) {
    fail('track.json timeBase must be two positive integers.');
  }
  const originPts = raw['originPts'];
  const firstFrame = raw['firstFrame'];
  if (!isInteger(originPts)) fail('track.json originPts must be an integer.');
  if (!isInteger(firstFrame) || firstFrame < 0) {
    fail('track.json firstFrame must be a non-negative integer.');
  }
  const pts = raw['pts'];
  if (!Array.isArray(pts) || pts.length === 0 || pts.length > MAX_FRAMES) {
    fail('track.json pts must be a non-empty list of integers.');
  }
  for (const value of pts as readonly unknown[]) {
    if (!isInteger(value)) fail('track.json pts must be a non-empty list of integers.');
  }
  for (let index = 1; index < pts.length; index += 1) {
    if ((pts[index] as number) <= (pts[index - 1] as number)) {
      fail('track.json pts must be strictly increasing.');
    }
  }
  const count = pts.length;
  const transforms = numbers(raw['transforms'], 'transforms');
  if (transforms.length !== count * 9) {
    fail('track.json must hold one 3x3 transform for every tracked frame.');
  }
  const confidence = numbers(raw['confidence'], 'confidence');
  if (confidence.length !== count) {
    fail('track.json must hold one confidence for every tracked frame.');
  }
  for (const value of confidence) {
    if (value < 0 || value > 1) fail('track.json confidence must be between 0 and 1.');
  }
  const artifact: TrackArtifact = {
    version: TRACK_ARTIFACT_VERSION,
    method: method as TrackMethod,
    timeBase: [timeBase[0] as number, timeBase[1] as number],
    originPts,
    firstFrame,
    pts: pts as readonly number[],
    transforms,
    confidence,
    ...parsePoints(raw['points'], method as TrackMethod, count),
  };
  return artifact;
}

function parsePoints(
  value: unknown,
  method: TrackMethod,
  frames: number,
): { points?: TrackPoints } {
  if (value === undefined || value === null) {
    if (method === 'point-cloud') {
      fail('track.json for a shape track must hold its tracked points.');
    }
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value))
    fail('track.json points must be an object.');
  const raw = value as Record<string, unknown>;
  const count = raw['count'];
  if (!isInteger(count) || count <= 0 || count > TRACK_MAX_POINTS) {
    fail('track.json points count is out of range.');
  }
  const reference = numbers(raw['reference'], 'points reference');
  const positions = numbers(raw['frames'], 'points frames');
  if (reference.length !== count * 2) {
    fail('track.json must hold one reference position for every tracked point.');
  }
  if (positions.length !== count * 2 * frames) {
    fail('track.json must hold every tracked point on every tracked frame.');
  }
  return { points: { count, reference, frames: positions } };
}

/**
 * The artifact as the exact bytes that are hashed and written.
 *
 * Key order is fixed and `JSON.stringify` writes shortest round-tripping doubles, so the same
 * track always produces the same digest on every platform.
 */
export function serializeTrackArtifact(artifact: TrackArtifact): string {
  const ordered: Record<string, unknown> = {
    version: TRACK_ARTIFACT_VERSION,
    method: artifact.method,
    timeBase: [artifact.timeBase[0], artifact.timeBase[1]],
    originPts: artifact.originPts,
    firstFrame: artifact.firstFrame,
    pts: artifact.pts,
    transforms: artifact.transforms,
    confidence: artifact.confidence,
  };
  if (artifact.points !== undefined) {
    ordered['points'] = {
      count: artifact.points.count,
      reference: artifact.points.reference,
      frames: artifact.points.frames,
    };
  }
  return JSON.stringify(ordered);
}

/**
 * The tracked frame that answers asset source second `sourceSeconds`.
 *
 * Outside the tracked range the nearest end holds, exactly as a keyframe holds before the first
 * and after the last: a mask must not jump back to untracked geometry because the picture ran a
 * frame past what was tracked. Inside it, the frame whose pts is nearest wins, ties to the
 * earlier frame, so both implementations pick the same one without comparing floats for equality.
 */
export function trackFrameIndexAt(artifact: TrackArtifact, sourceSeconds: number): number {
  const ticks = artifact.originPts + (sourceSeconds * artifact.timeBase[1]) / artifact.timeBase[0];
  const { pts } = artifact;
  if (ticks <= pts[0]!) return 0;
  const last = pts.length - 1;
  if (ticks >= pts[last]!) return last;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (pts[middle]! <= ticks) low = middle;
    else high = middle;
  }
  // Ties (exactly halfway) go to `low`: `<=` keeps the earlier frame.
  return ticks - pts[low]! <= pts[high]! - ticks ? low : high;
}

/** The nine numbers of tracked frame `index`. */
export function trackMatrixAt(artifact: TrackArtifact, index: number): TrackMatrix {
  const base = index * 9;
  return artifact.transforms.slice(base, base + 9);
}

/** The transform at an asset source instant. */
export function trackTransformAt(artifact: TrackArtifact, sourceSeconds: number): TrackMatrix {
  return trackMatrixAt(artifact, trackFrameIndexAt(artifact, sourceSeconds));
}

/** Measured confidence at an asset source instant. */
export function trackConfidenceAt(artifact: TrackArtifact, sourceSeconds: number): number {
  return artifact.confidence[trackFrameIndexAt(artifact, sourceSeconds)]!;
}

/** Asset source seconds of tracked frame `index`. */
export function trackSourceSeconds(artifact: TrackArtifact, index: number): number {
  return (
    ((artifact.pts[index]! - artifact.originPts) * artifact.timeBase[0]) / artifact.timeBase[1]
  );
}

/**
 * Project one point through a 3x3.
 *
 * A denominator at or below zero would mirror the point through the plane's horizon, which is
 * never a real measurement of a mask that stayed in frame; the point is left where it was, so a
 * degenerate frame shows the untracked mask instead of a fold.
 */
export function trackWarpPoint(
  matrix: TrackMatrix,
  x: number,
  y: number,
): readonly [number, number] {
  const w = matrix[6]! * x + matrix[7]! * y + matrix[8]!;
  if (!(w > 1e-9) && !(w < -1e-9)) return [x, y];
  const px = (matrix[0]! * x + matrix[1]! * y + matrix[2]!) / w;
  const py = (matrix[3]! * x + matrix[4]! * y + matrix[5]!) / w;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return [x, y];
  return [px, py];
}

/**
 * The per-vertex displacement a `point-cloud` track puts on vertex `vertex`.
 *
 * Returns `[0, 0]` for a track that does not carry points or a vertex it never tracked, so a
 * mask whose vertex count changed after tracking degrades to its own animation rather than
 * tearing.
 */
export function trackPointDelta(
  artifact: TrackArtifact,
  index: number,
  vertex: number,
): readonly [number, number] {
  const points = artifact.points;
  if (points === undefined || vertex < 0 || vertex >= points.count) return [0, 0];
  const base = (index * points.count + vertex) * 2;
  return [
    points.frames[base]! - points.reference[vertex * 2]!,
    points.frames[base + 1]! - points.reference[vertex * 2 + 1]!,
  ];
}

/**
 * The point warp for one instant: what the engine and the preview both apply to a mask's control
 * points before flattening.
 *
 * For every method but `point-cloud` this is the frame's 3x3. A `point-cloud` track warps each
 * vertex by its own measured displacement; `vertex` is the index of the vertex the control point
 * belongs to (a tangent moves with its vertex), and `-1` means "no vertex", which falls back to
 * the frame's 3x3 so a rectangle or ellipse is never left behind.
 */
export function trackWarpAt(
  artifact: TrackArtifact,
  sourceSeconds: number,
): (x: number, y: number, vertex: number) => readonly [number, number] {
  const index = trackFrameIndexAt(artifact, sourceSeconds);
  const matrix = trackMatrixAt(artifact, index);
  if (artifact.method !== 'point-cloud' || artifact.points === undefined) {
    return (x, y) => trackWarpPoint(matrix, x, y);
  }
  return (x, y, vertex) => {
    if (vertex < 0) return trackWarpPoint(matrix, x, y);
    const delta = trackPointDelta(artifact, index, vertex);
    return [x + delta[0], y + delta[1]];
  };
}
