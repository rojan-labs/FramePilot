/**
 * Canvas snapping (revamp Phase 3).
 *
 * When you drag a clip on the canvas, the positions that matter are the ones a
 * composition is built from: dead centre, flush to an edge, and on a rule-of-thirds
 * line. Landing on those by hand is fiddly and the result is usually off by a few
 * pixels — invisible in the monitor, visible in the export. So the drag is pulled
 * onto them, and a guide is drawn to say *which* alignment it found (a snap you
 * cannot see is indistinguishable from the drag being laggy).
 *
 * Pure and per-axis: X and Y snap independently, which is what lets a clip sit
 * centred horizontally while flush to the bottom edge. No DOM, no React, no pointer
 * events — the geometry is decided here against numbers.
 *
 * **Coordinate convention** matches the engine's transform (PRD §6.3): an offset is
 * PROJECT-canvas pixels of the box's centre away from the frame's centre, so 0 is
 * centred. The clip fills the frame at `scale` 1, so its on-screen size along an
 * axis is `frameSize * scale`.
 *
 * **What is deliberately NOT snapped to:** other elements. This compositor has one
 * picture segment active at a time, so there are no sibling pictures on the canvas
 * to align against; text overlays are a separate layer with their own editor.
 * Offering an "align to other element" target with nothing to align to would be a
 * guide that never appears.
 */

/** Which kind of alignment a snap found — drives how the guide is drawn. */
export type SnapKind = 'center' | 'third' | 'edge';

/** The result of snapping one axis. */
export interface AxisSnap {
  /** The offset to use: snapped when a target was in range, else the input. */
  readonly offset: number;
  /**
   * Where to draw the guide, as a 0..1 fraction along this axis of the frame, or
   * `null` when nothing snapped. A fraction (not pixels) so the overlay needs no
   * measuring — it is a `left`/`top` percentage.
   */
  readonly guide: number | null;
  /** The alignment found, or `null` when nothing snapped. */
  readonly kind: SnapKind | null;
}

/** One candidate alignment, resolved to the offset that achieves it. */
interface Candidate {
  readonly offset: number;
  readonly guide: number;
  readonly kind: SnapKind;
}

/** No snap — the input offset, untouched. */
const noSnap = (offset: number): AxisSnap => ({ offset, guide: null, kind: null });

/**
 * The offsets that align the box to something worth aligning to, along one axis.
 *
 * Ordered centre → thirds → edges, which is also the tie-break order: at equal
 * distance the stronger compositional alignment wins, so a small clip near the
 * middle prefers "centred" over "on the left third".
 */
function candidates(boxSize: number, frameSize: number): readonly Candidate[] {
  const half = frameSize / 2;
  return [
    // Box centre on the frame centre.
    { offset: 0, guide: 0.5, kind: 'center' },
    // Box centre on a rule-of-thirds line. frameSize/3 − frameSize/2 = −frameSize/6.
    { offset: -frameSize / 6, guide: 1 / 3, kind: 'third' },
    { offset: frameSize / 6, guide: 2 / 3, kind: 'third' },
    // Box's leading edge flush to the frame's leading edge, and trailing to trailing.
    { offset: boxSize / 2 - half, guide: 0, kind: 'edge' },
    { offset: half - boxSize / 2, guide: 1, kind: 'edge' },
  ];
}

/**
 * Pull `offset` onto the nearest alignment within `toleranceP` project pixels.
 *
 * @param offset - Current offset (project px of the box centre from frame centre).
 * @param boxSize - The box's size along this axis, in project px.
 * @param frameSize - The frame's size along this axis, in project px.
 * @param toleranceP - How close the offset must come, in project px.
 * @returns The snapped offset plus the guide to draw, or the input plus nulls.
 */
export function snapAxis(
  offset: number,
  boxSize: number,
  frameSize: number,
  toleranceP: number,
): AxisSnap {
  // A degenerate frame has no geometry to align to; a negative tolerance disables
  // snapping entirely (the caller's way of saying "the defeat key is held").
  if (!(frameSize > 0) || !(toleranceP >= 0)) return noSnap(offset);
  let best: Candidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates(boxSize, frameSize)) {
    const distance = Math.abs(candidate.offset - offset);
    // Strictly-less keeps the declaration order as the tie-break: at equal
    // distance, centre beats a third, which beats an edge.
    if (distance <= toleranceP && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best === null
    ? noSnap(offset)
    : { offset: best.offset, guide: best.guide, kind: best.kind };
}

/** The transform slice snapping acts on. */
export interface SnappableTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** A snapped transform plus the guides to draw for it. */
export interface SnapResult {
  readonly values: SnappableTransform;
  /** Vertical guide (a fraction of the frame WIDTH), from the X-axis snap. */
  readonly guideX: number | null;
  /** Horizontal guide (a fraction of the frame HEIGHT), from the Y-axis snap. */
  readonly guideY: number | null;
}

/**
 * Snap a whole transform's position, leaving `scale` alone.
 *
 * Scale is not snapped: the compositional targets here are all positional, and a
 * magnet on scale would fight the corner handles for no benefit — there is no
 * "correct" zoom the way there is a correct centre.
 *
 * The box size is derived from `scale`, so the edge targets track the zoom: a clip
 * scaled to 50 % goes flush to the left edge at a different offset than one at 100 %.
 */
export function snapTransform(
  values: SnappableTransform,
  resolution: { readonly width: number; readonly height: number },
  toleranceP: number,
): SnapResult {
  const boxWidth = resolution.width * values.scale;
  const boxHeight = resolution.height * values.scale;
  const x = snapAxis(values.x, boxWidth, resolution.width, toleranceP);
  const y = snapAxis(values.y, boxHeight, resolution.height, toleranceP);
  return {
    values: { scale: values.scale, x: x.offset, y: y.offset },
    guideX: x.guide,
    guideY: y.guide,
  };
}

/**
 * Rotation snapping: whole increments of `stepDeg`, used when the constrain
 * modifier is held on the rotation handle.
 *
 * Separate from position snapping and never automatic — free rotation is the
 * default because a deliberate 7° tilt is a legitimate look, and a magnet that
 * silently rounded it to 0 would make the handle feel broken.
 */
export function snapRotation(degrees: number, stepDeg: number): number {
  if (!(stepDeg > 0)) return degrees;
  return Math.round(degrees / stepDeg) * stepDeg;
}

/** Normalize a rotation into (−180, 180] so the readout never shows 725°. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}
