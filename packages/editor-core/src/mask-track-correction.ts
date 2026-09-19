/**
 * Correcting a tracked mask on one frame (MK7.7, plan 10 "Tracking → Review").
 *
 * Both renderers draw a tracked mask as `T(t) · G(t)`: the mask's own animation `G`, then the
 * track `T` on top of it (`render/tracks.py`, `preview/masks/mask-stack.ts`). A correction is
 * what an editor does on a frame the tracker got wrong: put the mask where it belongs ON THE
 * SCREEN. This module turns that into the keyframe `G` needs — relative to the tracked motion,
 * `K = T(c)⁻¹ · D` — so the renderers keep composing exactly as before and show `D` there.
 *
 * The correction holds over the stretch the re-track re-measures from it (the flagged range it
 * sits in): `retrackPlan` measures from the constraint outwards to where confidence recovers,
 * and `anchorOnConstraint` continues each of those frames from `T(c)`. Over that stretch `G`
 * must be `K` for `T'(f) · G(f)` to be the corrected mask carried by the measured motion; on
 * every other frame the old animation is untouched. So the correction is three hold keyframes:
 * the old value just before the stretch, `K` from its start, and the old value again where it
 * ends.
 */
import type { TrackStateAt } from './mask-track-review.js';
import { trackWarpPoint, type TrackMatrix } from './mask-track.js';
import type { MaskGeometry, PathMaskGeometry } from './mask-commands.js';

/** Largest departure from a similarity (relative) a rectangle or ellipse can be corrected under. */
const SIMILARITY_TOLERANCE = 1e-9;

/** Why a correction cannot be expressed relative to the track. */
export type UntrackRefusal = 'perspective_shape' | 'degenerate';

/**
 * The geometry the editor put on the screen at one instant, taken back through the track there.
 *
 * A path is exact under any track: each vertex and each tangent end is carried back through the
 * inverse transform (a shape track: the vertex's own displacement is subtracted). A rectangle or
 * an ellipse is exact only under a similarity (the position and position+scale+rotation
 * methods): under perspective its tracked outline is no longer a rectangle, so it has no
 * rectangle to be the correction of.
 *
 * @returns The geometry in the mask's own (untracked) space, or why it cannot be.
 */
export function untrackGeometry(
  geometry: MaskGeometry,
  track: TrackStateAt,
): MaskGeometry | UntrackRefusal {
  if (geometry.kind === 'path') return untrackPath(geometry, track);
  const similarity = similarityOf(track.matrix);
  if (similarity === null) return 'perspective_shape';
  const inverse = invert(track.matrix);
  if (inverse === null) return 'degenerate';
  const [cx, cy] = trackWarpPoint(inverse, geometry.cx, geometry.cy);
  const rotation = geometry.rotation - similarity.degrees;
  if (geometry.kind === 'rectangle') {
    return {
      ...geometry,
      cx,
      cy,
      width: geometry.width / similarity.scale,
      height: geometry.height / similarity.scale,
      rotation,
    };
  }
  return {
    ...geometry,
    cx,
    cy,
    rx: geometry.rx / similarity.scale,
    ry: geometry.ry / similarity.scale,
    rotation,
  };
}

/**
 * The geometry a tracked mask shows ON THE SCREEN at one instant: its own geometry there moved
 * by the track, exactly as the renderers move its control points — the inverse of
 * {@link untrackGeometry}, so the monitor can put its handles where the mask is drawn.
 *
 * @returns The on-screen geometry, or `null` when a rectangle or ellipse is not a rectangle or
 *   an ellipse on screen (a perspective track), where the monitor keeps its own geometry.
 */
export function trackGeometry(geometry: MaskGeometry, track: TrackStateAt): MaskGeometry | null {
  if (geometry.kind === 'path') {
    const deltas = track.pointDeltas;
    return {
      kind: 'path',
      vertices: geometry.vertices.map((vertex, index) => {
        if (deltas !== undefined) {
          return {
            ...vertex,
            x: vertex.x + (deltas[index * 2] ?? 0),
            y: vertex.y + (deltas[index * 2 + 1] ?? 0),
          };
        }
        const [x, y] = trackWarpPoint(track.matrix, vertex.x, vertex.y);
        const [inX, inY] = trackWarpPoint(
          track.matrix,
          vertex.x + vertex.inX,
          vertex.y + vertex.inY,
        );
        const [outX, outY] = trackWarpPoint(
          track.matrix,
          vertex.x + vertex.outX,
          vertex.y + vertex.outY,
        );
        return { ...vertex, x, y, inX: inX - x, inY: inY - y, outX: outX - x, outY: outY - y };
      }),
    };
  }
  const similarity = similarityOf(track.matrix);
  if (similarity === null) return null;
  const [cx, cy] = trackWarpPoint(track.matrix, geometry.cx, geometry.cy);
  const rotation = geometry.rotation + similarity.degrees;
  if (geometry.kind === 'rectangle') {
    return {
      ...geometry,
      cx,
      cy,
      width: geometry.width * similarity.scale,
      height: geometry.height * similarity.scale,
      rotation,
    };
  }
  return {
    ...geometry,
    cx,
    cy,
    rx: geometry.rx * similarity.scale,
    ry: geometry.ry * similarity.scale,
    rotation,
  };
}

function untrackPath(
  geometry: PathMaskGeometry,
  track: TrackStateAt,
): PathMaskGeometry | 'degenerate' {
  const deltas = track.pointDeltas;
  if (deltas !== undefined) {
    // A shape track moves each vertex — and both of its tangents — by its own displacement.
    return {
      kind: 'path',
      vertices: geometry.vertices.map((vertex, index) => ({
        ...vertex,
        x: vertex.x - (deltas[index * 2] ?? 0),
        y: vertex.y - (deltas[index * 2 + 1] ?? 0),
      })),
    };
  }
  const inverse = invert(track.matrix);
  if (inverse === null) return 'degenerate';
  return {
    kind: 'path',
    vertices: geometry.vertices.map((vertex) => {
      // Tangents are offsets from their vertex, so each end is carried back at its absolute
      // position and turned back into an offset — the exact inverse of `warp_path`.
      const [x, y] = trackWarpPoint(inverse, vertex.x, vertex.y);
      const [inX, inY] = trackWarpPoint(inverse, vertex.x + vertex.inX, vertex.y + vertex.inY);
      const [outX, outY] = trackWarpPoint(inverse, vertex.x + vertex.outX, vertex.y + vertex.outY);
      return { ...vertex, x, y, inX: inX - x, inY: inY - y, outX: outX - x, outY: outY - y };
    }),
  };
}

/** A 3x3's scale and rotation when it is a similarity (no shear, no perspective), else null. */
function similarityOf(matrix: TrackMatrix): { scale: number; degrees: number } | null {
  const [a, b, , c, d, , g, h, w] = matrix as readonly number[];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  const scale = Math.hypot(a, c);
  if (!(scale > 0) || w === undefined || !(Math.abs(w) > 0)) return null;
  const tolerance = SIMILARITY_TOLERANCE * Math.max(1, scale);
  if (
    Math.abs(g ?? 0) > tolerance ||
    Math.abs(h ?? 0) > tolerance ||
    Math.abs(a - d) > tolerance ||
    Math.abs(b + c) > tolerance ||
    Math.abs(w - 1) > tolerance
  ) {
    return null;
  }
  return { scale, degrees: (Math.atan2(c, a) * 180) / Math.PI };
}

/** The inverse of a 3x3, or null when it has none. */
function invert(matrix: TrackMatrix): TrackMatrix | null {
  const at = (index: number): number => matrix[index] ?? Number.NaN;
  const [a, b, c, d, e, f, g, h, i] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(at) as [
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
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return [
    A / determinant,
    -(b * i - c * h) / determinant,
    (b * f - c * e) / determinant,
    B / determinant,
    (a * i - c * g) / determinant,
    -(a * f - c * d) / determinant,
    C / determinant,
    -(a * h - b * g) / determinant,
    (a * e - b * d) / determinant,
  ];
}

/** The stretch, source seconds, a correction at one instant holds over. */
export interface CorrectionSpan {
  /** The last instant BEFORE the stretch that keeps the old animation, if there is one. */
  readonly before: number | null;
  /** First instant of the stretch: the correction holds from here… */
  readonly start: number;
  /** …up to here, exclusive, where the old animation resumes. */
  readonly end: number;
}

/**
 * Where a correction at `sourceTime` applies: the flagged range it falls in, which is exactly
 * what `retrackPlan` re-measures from that constraint, or the one frame it is on.
 *
 * @param flagged - The mask's review list (`tracking.review.flagged`), source seconds, each
 *   `end` the first frame that recovered.
 * @param frameSeconds - The track's frame duration; 0 when unknown.
 */
export function correctionSpan(
  flagged: readonly { readonly start: number; readonly end: number }[],
  sourceTime: number,
  frameSeconds: number,
): CorrectionSpan {
  const range = flagged.find(
    (candidate) => candidate.start <= sourceTime && sourceTime < candidate.end,
  );
  const start = range?.start ?? sourceTime;
  const end = range === undefined ? sourceTime + frameSeconds : range.end;
  const before = frameSeconds > 0 && start - frameSeconds >= 0 ? start - frameSeconds : null;
  return { before, start, end: end > start ? end : start + frameSeconds };
}
