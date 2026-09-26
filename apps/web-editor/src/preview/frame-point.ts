/**
 * A point on the program monitor's picture (plan/elements 02 §3): a sticker or shape dropped on
 * the monitor lands at the playhead, centred where it was dropped.
 *
 * The monitor's `.preview-frame` is the picture itself: sized to contain the project's aspect in
 * the stage (so a 9:16 project in a 16:9 monitor is the narrow box between the letterbox bars),
 * and scaled and translated by the monitor's zoom and the mask tools' pan. Its bounding box —
 * the same box the on-canvas transform handles measure — is therefore where the frame is on
 * screen, whatever the letterbox, zoom or pan. Everything here is arithmetic on that box.
 */

/** A point on the picture as fractions of the frame's width and height, from its top-left. */
export interface FramePoint {
  readonly x: number;
  readonly y: number;
}

/** The displayed frame's box on screen, as `getBoundingClientRect` reports it. */
export interface FrameRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Two decimals: tidy numbers in the project file, far finer than a pixel on any frame. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Where on the picture a client point falls, clamped to the picture: a drop in the letterbox, or
 * just past an edge, lands on the nearest edge rather than off the frame, where it would export
 * as nothing.
 *
 * @param client - The pointer, in client (viewport) pixels, as a drag event reports it.
 * @param frame - The displayed frame's box, from the monitor's `.preview-frame`.
 * @returns The point, or `null` when the frame has no size yet (not laid out).
 */
export function clientPointToFrame(
  client: { readonly x: number; readonly y: number },
  frame: FrameRect,
): FramePoint | null {
  if (!(frame.width > 0) || !(frame.height > 0)) return null;
  if (!Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
  return {
    x: clamp01((client.x - frame.left) / frame.width),
    y: clamp01((client.y - frame.top) / frame.height),
  };
}

/**
 * A shape's `at`: its box centre (or a line's reference point) as a percent of each axis — the
 * units `presetShapeParams` and `addShapePatch` take.
 */
export function shapeAtForFramePoint(point: FramePoint): { x: number; y: number } {
  return { x: round2(point.x * 100), y: round2(point.y * 100) };
}

/**
 * A sticker's `offset`: its centre in canvas pixels from the frame's centre — the units the
 * on-canvas handles write and `addStickerPatch` takes.
 *
 * @param resolution - The project's frame, in canvas pixels.
 */
export function stickerOffsetForFramePoint(
  point: FramePoint,
  resolution: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  return {
    x: round2((point.x - 0.5) * resolution.width),
    y: round2((point.y - 0.5) * resolution.height),
  };
}
