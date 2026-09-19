/**
 * Turning tracker measurements into a transform track (MK7.1/MK7.2, host policy).
 *
 * A Capability Pack worker measures and nothing else (`policy.py`: "the worker stays a
 * measurement device"). Everything judgemental — which motion model the editor asked for, how a
 * measured homography becomes that model, what counts as low confidence, which ranges go on the
 * review list — lives here, in the host, for the reasons `track-samples.ts` already states: it
 * has to be versioned with the project rather than with a downloadable binary, and it is the step
 * where a measurement becomes an edit.
 *
 * The four methods of plan 10 are one measurement constrained four ways, not four trackers:
 *
 * | method                   | what the mask may do                                  |
 * | ------------------------ | ----------------------------------------------------- |
 * | `position`               | translate                                             |
 * | `position-scale-rotation`| translate, scale uniformly, rotate (a similarity)     |
 * | `perspective`            | the full planar homography                            |
 * | `point-cloud`            | each vertex moves on its own measured path            |
 *
 * Constraining rather than running a weaker tracker is deliberate: the planar tracker fits its
 * homography from up to 120 RANSAC-filtered correspondences, so even a position-only track is
 * measured from the whole patch instead of one pixel, and the **residual** between the requested
 * model and the measured one becomes an honest per-frame error the review list can use.
 */
import {
  TRACK_ARTIFACT_VERSION,
  TRACK_MAX_POINTS,
  TRACK_IDENTITY,
  trackWarpPoint,
  type TrackArtifact,
  type TrackMatrix,
  type TrackMethod,
  type TrackPoints,
} from './mask-track.js';
import {
  displayCorrectedSize,
  normalizeQuarterTurn,
  type SourcePictureGeometry,
} from './mask-geometry.js';

/** A point in display-corrected source pixels. */
export interface TrackPoint {
  readonly x: number;
  readonly y: number;
}

/** Below this the frame goes on the review list as low confidence. */
export const TRACK_FLAG_CONFIDENCE = 0.5;

/**
 * Model residual, in display-corrected source pixels, at or above which a frame is flagged
 * however confident the tracker was.
 *
 * Half the `06` "no frame worse than 2 px" ceiling, so a frame that is drifting towards the gate
 * is on the review list before it breaks it (the ≥ 99.5 % detection-recall gate).
 */
export const TRACK_FLAG_RESIDUAL_PX = 1;

// --- 3x3 algebra ------------------------------------------------------------------------

/** `left · right`, row-major, in a fixed multiply/add order. */
export function multiply3x3(left: TrackMatrix, right: TrackMatrix): TrackMatrix {
  const out = new Array<number>(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] =
        left[row * 3]! * right[column]! +
        left[row * 3 + 1]! * right[3 + column]! +
        left[row * 3 + 2]! * right[6 + column]!;
    }
  }
  return out;
}

/** The inverse, or `undefined` for a matrix too near singular to invert honestly. */
export function invert3x3(matrix: TrackMatrix): TrackMatrix | undefined {
  const [a, b, c, d, e, f, g, h, i] = matrix as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const cofactor0 = e * i - f * h;
  const cofactor1 = f * g - d * i;
  const cofactor2 = d * h - e * g;
  const determinant = a * cofactor0 + b * cofactor1 + c * cofactor2;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  const out = [
    cofactor0,
    c * h - b * i,
    b * f - c * e,
    cofactor1,
    a * i - c * g,
    c * d - a * f,
    cofactor2,
    b * g - a * h,
    a * e - b * d,
  ].map((value) => value / determinant);
  return out;
}

/** A translation as a 3x3. */
export function translation3x3(dx: number, dy: number): TrackMatrix {
  return [1, 0, dx, 0, 1, dy, 0, 0, 1];
}

/** A scale about the origin as a 3x3. */
function scale3x3(sx: number, sy: number): TrackMatrix {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

/**
 * Coded (storage) pixels → display-corrected source pixels, as a 3x3.
 *
 * The matrix twin of {@link codedToDisplay}: the PAR stretch and the quarter turn that make the
 * space a mask is drawn in. A track measured on decoded frames has to pass through it before it
 * can move mask geometry, or anamorphic and rotated phone footage would track sideways.
 */
export function codedToDisplayMatrix(geometry: SourcePictureGeometry): TrackMatrix {
  const par = geometry.pixelAspectRatio ?? 1;
  const width = geometry.codedWidth * par;
  const height = geometry.codedHeight;
  switch (normalizeQuarterTurn(geometry.rotationDegrees)) {
    case 0:
      return [par, 0, 0, 0, 1, 0, 0, 0, 1];
    case 90:
      return [0, -1, height, par, 0, 0, 0, 0, 1];
    case 180:
      return [-par, 0, width, 0, -1, height, 0, 0, 1];
    case 270:
      return [0, 1, 0, -par, 0, width, 0, 0, 1];
  }
}

/**
 * A worker's normalized-frame homography as a display-corrected source-pixel one.
 *
 * `H_display = C · S · H_normalized · S⁻¹ · C⁻¹`, with `S` scaling normalized coordinates up to
 * coded pixels and `C` the display correction. Both conversions are exact similarities, so a
 * pure translation stays a pure translation and a rigid rotation stays rigid.
 */
export function normalizedToDisplayMatrix(
  normalized: TrackMatrix,
  geometry: SourcePictureGeometry,
): TrackMatrix | undefined {
  const scale = scale3x3(geometry.codedWidth, geometry.codedHeight);
  const inverseScale = scale3x3(1 / geometry.codedWidth, 1 / geometry.codedHeight);
  const correction = codedToDisplayMatrix(geometry);
  const inverseCorrection = invert3x3(correction);
  if (inverseCorrection === undefined) return undefined;
  return multiply3x3(
    multiply3x3(correction, multiply3x3(scale, normalized)),
    multiply3x3(inverseScale, inverseCorrection),
  );
}

// --- Constraining a measurement to the requested model -----------------------------------

/**
 * The four sample points a model is fitted over: the corners of the mask's bounding box at the
 * reference frame. Fitting over the region the editor actually masked (rather than the whole
 * frame) is what makes a constrained model right where it matters.
 */
export function modelQuad(box: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): readonly TrackPoint[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

/**
 * Constrain a measured homography to `method` over `quad`.
 *
 * `position` keeps the mean displacement of the quad; `position-scale-rotation` is the
 * least-squares similarity (Umeyama with uniform scale) from the quad to its image, which is the
 * closest rigid-plus-uniform-scale motion to what was measured; `perspective` and `point-cloud`
 * keep the homography as measured.
 *
 * @returns The constrained transform, in the same space as `homography`.
 */
export function constrainTransform(
  homography: TrackMatrix,
  method: TrackMethod,
  quad: readonly TrackPoint[],
): TrackMatrix {
  if (method === 'perspective' || method === 'point-cloud') return homography;
  const mapped = quad.map((point) => trackWarpPoint(homography, point.x, point.y));
  const count = quad.length;
  let sourceX = 0;
  let sourceY = 0;
  let targetX = 0;
  let targetY = 0;
  for (let index = 0; index < count; index += 1) {
    sourceX += quad[index]!.x;
    sourceY += quad[index]!.y;
    targetX += mapped[index]![0];
    targetY += mapped[index]![1];
  }
  sourceX /= count;
  sourceY /= count;
  targetX /= count;
  targetY /= count;
  if (method === 'position') return translation3x3(targetX - sourceX, targetY - sourceY);
  // Umeyama with uniform scale: `a` is the rotation-carrying dot product, `b` its cross product,
  // and `variance` the source spread. Both sums run in index order so the result is reproducible.
  let a = 0;
  let b = 0;
  let variance = 0;
  for (let index = 0; index < count; index += 1) {
    const sx = quad[index]!.x - sourceX;
    const sy = quad[index]!.y - sourceY;
    const tx = mapped[index]![0] - targetX;
    const ty = mapped[index]![1] - targetY;
    a += sx * tx + sy * ty;
    b += sx * ty - sy * tx;
    variance += sx * sx + sy * sy;
  }
  if (!(variance > 0)) return translation3x3(targetX - sourceX, targetY - sourceY);
  const cos = a / variance;
  const sin = b / variance;
  return [
    cos,
    -sin,
    targetX - (cos * sourceX - sin * sourceY),
    sin,
    cos,
    targetY - (sin * sourceX + cos * sourceY),
    0,
    0,
    1,
  ];
}

/**
 * The largest distance, over `quad`, between where `measured` puts a corner and where `model`
 * does — the price of constraining the measurement, in pixels.
 *
 * This is the number that makes a `position` track on a rotating subject honest: the mask still
 * follows the subject's centre, and every frame whose rotation the model cannot express is on
 * the review list instead of quietly wrong.
 */
export function modelResidualPixels(
  measured: TrackMatrix,
  model: TrackMatrix,
  quad: readonly TrackPoint[],
): number {
  let worst = 0;
  for (const point of quad) {
    const target = trackWarpPoint(measured, point.x, point.y);
    const fitted = trackWarpPoint(model, point.x, point.y);
    const dx = target[0] - fitted[0];
    const dy = target[1] - fitted[1];
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > worst) worst = distance;
  }
  return worst;
}

// --- Building the artifact ----------------------------------------------------------------

/** One frame as the worker measured it, already converted out of normalized coordinates. */
export interface MeasuredTrackFrame {
  /** Decode-order source frame. */
  readonly frame: number;
  /** Source pts of that frame. */
  readonly pts: number;
  /** The measured planar homography in display-corrected source pixels, reference → this frame. */
  readonly homography: TrackMatrix;
  /** The tracker's own confidence, 0..1. */
  readonly confidence: number;
  /** Per-vertex positions, display-corrected source pixels, for a shape track. */
  readonly points?: readonly TrackPoint[];
}

export interface BuildTrackArtifactInput {
  readonly method: TrackMethod;
  readonly timeBase: readonly [number, number];
  readonly originPts: number;
  /** Measured frames, any order; sorted here by pts. */
  readonly frames: readonly MeasuredTrackFrame[];
  /** The frame the mask's own geometry belongs to: its transform is exactly the identity. */
  readonly referenceFrame: number;
  /** Where the model is fitted — the mask's bounding box at the reference frame. */
  readonly quad: readonly TrackPoint[];
  /** Vertex positions at the reference frame, for a shape track. */
  readonly referencePoints?: readonly TrackPoint[];
}

export class TrackSolveError extends Error {
  public constructor(
    public readonly code:
      'no_frames' | 'reference_missing' | 'degenerate' | 'points_mismatch' | 'too_many_points',
    message: string,
  ) {
    super(message);
    this.name = 'TrackSolveError';
  }
}

/**
 * Measured frames → a transform track anchored at the reference frame.
 *
 * The worker anchors its homographies to the FIRST frame it decoded, which is the reference only
 * for a forward track. Re-anchoring here (`H_i · H_ref⁻¹`) is what makes backward, one-frame and
 * to-the-edge tracks the same object as a forward one: whatever the worker measured from, the
 * artifact says "identity at the frame the mask was drawn on".
 *
 * @throws TrackSolveError when the measurement cannot honestly produce a track.
 */
export function buildTrackArtifact(input: BuildTrackArtifactInput): {
  readonly artifact: TrackArtifact;
  readonly residualPx: readonly number[];
} {
  const frames = [...input.frames].sort((left, right) => left.pts - right.pts);
  if (frames.length === 0) {
    throw new TrackSolveError('no_frames', 'The tracker measured no frames of this range.');
  }
  const reference = frames.find((frame) => frame.frame === input.referenceFrame);
  if (reference === undefined) {
    throw new TrackSolveError(
      'reference_missing',
      'The tracked range does not include the frame the mask was drawn on.',
    );
  }
  const inverseReference = invert3x3(reference.homography);
  if (inverseReference === undefined) {
    throw new TrackSolveError(
      'degenerate',
      'The tracker could not measure the frame the mask was drawn on. Move the playhead to a clearer frame and track again.',
    );
  }
  const transforms: number[] = [];
  const confidence: number[] = [];
  const residualPx: number[] = [];
  const pts: number[] = [];
  const positions: number[] = [];
  const pointCount = input.referencePoints?.length ?? 0;
  if (pointCount > TRACK_MAX_POINTS) {
    throw new TrackSolveError(
      'too_many_points',
      'A shape track follows more points than one mask may carry. Simplify the path, or track it with the perspective method.',
    );
  }
  for (const frame of frames) {
    const anchored = multiply3x3(frame.homography, inverseReference);
    const model = constrainTransform(anchored, input.method, input.quad);
    const residual = modelResidualPixels(anchored, model, input.quad);
    pts.push(frame.pts);
    transforms.push(...model);
    residualPx.push(residual);
    confidence.push(confidenceOf(frame.confidence, residual));
    if (input.method !== 'point-cloud') continue;
    const measured = frame.points ?? [];
    if (measured.length !== pointCount) {
      throw new TrackSolveError(
        'points_mismatch',
        'The tracker returned a different number of points than the path has vertices. Track the mask again.',
      );
    }
    for (const point of measured) positions.push(point.x, point.y);
  }
  const points: TrackPoints | undefined =
    input.method === 'point-cloud'
      ? {
          count: pointCount,
          reference: (input.referencePoints ?? []).flatMap((point) => [point.x, point.y]),
          frames: positions,
        }
      : undefined;
  const artifact: TrackArtifact = {
    version: TRACK_ARTIFACT_VERSION,
    method: input.method,
    timeBase: input.timeBase,
    originPts: input.originPts,
    firstFrame: frames[0]!.frame,
    pts,
    transforms,
    confidence,
    ...(points === undefined ? {} : { points }),
  };
  return { artifact, residualPx };
}

/**
 * Measured confidence penalised by the model residual.
 *
 * A tracker that is sure about a motion the chosen model cannot express is not evidence that the
 * mask is in the right place, so the residual has to reach the stored number the review list
 * reads; the penalty is linear and reaches zero at twice the flag residual, the `06` ceiling.
 */
function confidenceOf(measured: number, residualPx: number): number {
  const clamped = measured < 0 ? 0 : measured > 1 ? 1 : measured;
  const penalty = 1 - residualPx / (2 * TRACK_FLAG_RESIDUAL_PX);
  const factor = penalty < 0 ? 0 : penalty > 1 ? 1 : penalty;
  return clamped * factor;
}

/** A source-time range, seconds on the asset clock. */
export interface TrackRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The contiguous source-time ranges whose confidence is under the floor — what goes on the
 * shared review list (MK7.3).
 *
 * Ranges are half-open on the frame grid and merged, so a flicker of three bad frames is one row
 * the editor can step through rather than three.
 */
export function flaggedTrackRanges(
  artifact: TrackArtifact,
  floor: number = TRACK_FLAG_CONFIDENCE,
): readonly TrackRange[] {
  const ranges: TrackRange[] = [];
  const seconds = (index: number): number =>
    ((artifact.pts[index]! - artifact.originPts) * artifact.timeBase[0]) / artifact.timeBase[1];
  let start: number | undefined;
  for (let index = 0; index < artifact.confidence.length; index += 1) {
    const low = artifact.confidence[index]! < floor;
    if (low && start === undefined) start = index;
    if (!low && start !== undefined) {
      ranges.push({ start: seconds(start), end: seconds(index) });
      start = undefined;
    }
  }
  if (start !== undefined) {
    const last = artifact.confidence.length - 1;
    ranges.push({ start: seconds(start), end: seconds(last) });
  }
  return ranges;
}

/** The display-corrected size a track's geometry is expressed in. */
export function trackDisplaySize(geometry: SourcePictureGeometry): {
  readonly width: number;
  readonly height: number;
} {
  return displayCorrectedSize(geometry);
}

/** The identity track transform, for callers that need a neutral value. */
export const TRACK_NEUTRAL: TrackMatrix = TRACK_IDENTITY;
