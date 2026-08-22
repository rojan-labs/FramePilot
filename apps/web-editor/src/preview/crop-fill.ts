/**
 * Crop, as the render actually performs it — the arithmetic both monitors need.
 *
 * ## The divergence this closes
 *
 * The engine crops a clip and then scales the CROPPED picture to fit the canvas
 * (`_apply_crop` → `_place_video_clip` in `render/compiler.py`), so a 9:16 slice of a 16:9
 * source fills a 9:16 frame edge to edge. Both monitors instead masked the crop in place over
 * a letterboxed full frame: the same project showed a small picture floating in black on
 * screen and a full-bleed one on export.
 *
 * That is the wrong direction for the render-vs-preview rule to fail in. What the editor saw
 * was strictly worse than what would ship, so both the editor and the agent were pushed to
 * "fix" something that was already correct. In the captured run the editor reported "the
 * actual clips are minimized … with extremely many black spaces around", and the agent then
 * wrote compensating scale keyframes (3.2×, then 1.78×) into the project — which the render
 * applies ON TOP of its own fill scale, so a preview artefact became real over-zoom.
 */

/** A normalized crop rectangle (fractions of the source frame). */
export interface CropRectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle in pixels — either a source region or a destination on the canvas. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a cropped source region is read from, and where it lands on the frame. */
export interface CropFillPlacement {
  readonly source: PixelRect;
  readonly destination: PixelRect;
}

/**
 * Map a crop rect onto the frame exactly as the render does: crop the source, then scale the
 * cropped region to FIT the frame (its aspect preserved) and centre it.
 *
 * "Fit, then centre" is the engine's `_place_video_clip`, not a cover: a crop whose aspect
 * does not match the frame's legitimately leaves a margin, and inventing a cover here would
 * show pixels the export drops. What it must never do is scale the crop as though it were
 * still the whole frame, which is what produced the floating-in-black monitor.
 *
 * @param sourceWidth - Decoded source width in pixels.
 * @param sourceHeight - Decoded source height in pixels.
 * @param frameWidth - Canvas/frame width in pixels.
 * @param frameHeight - Canvas/frame height in pixels.
 * @param crop - The clip's crop rect, in source fractions.
 * @returns The source region to read and the destination rect to draw it into.
 */
export function cropFillPlacement(
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
  crop: CropRectLike,
): CropFillPlacement {
  const sw = Math.max(1, sourceWidth * crop.width);
  const sh = Math.max(1, sourceHeight * crop.height);
  const scale = Math.min(frameWidth / sw, frameHeight / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  return {
    source: { x: sourceWidth * crop.x, y: sourceHeight * crop.y, width: sw, height: sh },
    destination: {
      x: (frameWidth - dw) / 2,
      y: (frameHeight - dh) / 2,
      width: dw,
      height: dh,
    },
  };
}

/**
 * `object-position` for a cropped element drawn with `object-fit: cover`, as percentages.
 *
 * The DOM monitor has no source dimensions to work with — it styles a `<video>` before its
 * metadata is necessarily known — but it does not need them. Under `cover` the visible window
 * already has the frame's aspect; all that remains is choosing WHICH part of the source it
 * shows, and that is pure crop-space arithmetic: aligning the crop's centre with the frame's
 * centre means offsetting by `x / (1 - width)` of the available travel.
 *
 * Exact when the crop's aspect matches the frame's — the case the vertical-reframe workflow
 * produces by construction (`width = target/source`, full height). When it does not match, the
 * window is a little wider or taller than the crop asked for; the picture still fills the
 * frame, and the render stays the authority for the exact edges.
 *
 * @returns `[x%, y%]` for `object-position`.
 */
export function cropObjectPosition(crop: CropRectLike): readonly [number, number] {
  const travelX = 1 - crop.width;
  const travelY = 1 - crop.height;
  const x = travelX <= 1e-6 ? 50 : (crop.x / travelX) * 100;
  const y = travelY <= 1e-6 ? 50 : (crop.y / travelY) * 100;
  return [clampPercent(x), clampPercent(y)];
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}
