/**
 * Pixel decisions per frame-plan layer (PX2.1): the integer half of `compile_timeline`.
 *
 * `framePlanAt` says WHAT the export composites (which layers, which source frame, where they
 * sit in floating point). This module says HOW MANY PIXELS: the size ffmpeg decodes a source at,
 * the integer crop MoviePy slices, the truncated size Pillow resizes to, the truncated position
 * `compute_position` pastes at, and the 8-bit alpha a mask becomes. Each rule is copied from the
 * compiler (`_open_source_reader`, `fitted_decode_size`, `decode_cap_for_clip`, `_apply_crop`,
 * `_attach_mask`, `_place_video_clip`) and MoviePy (`vfx.Resize`, `compute_position`), because a
 * one-pixel difference in any of them moves an edge the parity oracle measures.
 *
 * Pure: no GL, no decoding. `layer-compositor.ts` executes the steps.
 */
import { readAlignment, type FramePlanLayer } from '@framepilot/editor-core';
import type { Asset, Clip } from '@framepilot/timeline-schema';

/** Extra source pixels the export keeps beyond the exact need (`DECODE_CAP_HEADROOM`). */
export const DECODE_CAP_HEADROOM = 1.25;

/** Transform properties the compiler places (`RENDERED_TRANSFORM_PROPERTIES`). */
const RENDERED_TRANSFORM_PROPERTIES = new Set(['scale', 'x', 'y', 'rotation']);
const LEGACY_GEOMETRY_KINDS = new Set(['push', 'zoom', 'slide']);

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export interface PixelRect extends PixelSize {
  readonly x: number;
  readonly y: number;
}

/** How a video source reaches RGB: swscale-scaled to a size, or converted at its own size. */
export type DecodeStep =
  | { readonly kind: 'scaled'; readonly width: number; readonly height: number }
  | { readonly kind: 'native' };

/** One picture layer as integer raster work, in the order the export applies it. */
export interface PictureRasterStep {
  readonly assetId: string;
  readonly assetKind: 'video' | 'image';
  /** Source frame index (video); `null` for a still. */
  readonly frame: number | null;
  /** Video only. */
  readonly decode: DecodeStep;
  /** Integer slice of the decoded picture; `null` keeps it whole. */
  readonly crop: PixelRect | null;
  /** 8-bit mask value the whole layer composites with; `null` = no mask (opaque). */
  readonly alpha8: number | null;
  /** Pillow LANCZOS target; `null` = placed at its own size. */
  readonly resize: PixelSize | null;
  /** Degrees, counter-clockwise as PIL rotates (MoviePy passes the authored angle). */
  readonly rotation: number;
  /** Top-left paste position (may be negative). */
  readonly x: number;
  readonly y: number;
  readonly blendMode: string;
}

/** Python's `int()` on a float. */
const pyInt = (value: number): number => Math.trunc(value);

/** Python's `round()` (banker's rounding) for the even-dimension helpers. */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `fitted_decode_size`: the exact size a static fit decodes at, or `null` (never upscale). */
export function fittedDecodeSize(source: PixelSize, target: PixelSize): PixelSize | null {
  if (source.width <= 0 || source.height <= 0) return null;
  const scale = Math.min(target.width / source.width, target.height / source.height);
  if (scale >= 1) return null;
  return {
    width: Math.max(2, pyRound((source.width * scale) / 2) * 2),
    height: Math.max(2, pyRound((source.height * scale) / 2) * 2),
  };
}

/** `decode_cap_for_clip`. */
export function decodeCapForClip(clip: Clip, target: PixelSize): number | null {
  if (clip.keyframes.length > 0) return null;
  const longest = Math.max(target.width, target.height);
  let fraction = 1;
  if (clip.crop !== undefined)
    fraction = Math.max(1e-3, Math.min(clip.crop.width, clip.crop.height));
  return Math.ceil((longest / fraction) * DECODE_CAP_HEADROOM);
}

/** `_open_source_reader`'s capped decode size, or `null` when the source already fits. */
export function cappedDecodeSize(source: PixelSize, cap: number | null): PixelSize | null {
  if (cap === null) return null;
  const longest = Math.max(source.width, source.height);
  if (longest <= cap) return null;
  const scale = cap / longest;
  return {
    width: Math.max(2, pyRound((source.width * scale) / 2) * 2),
    height: Math.max(2, pyRound((source.height * scale) / 2) * 2),
  };
}

function hasTransitionEffect(clip: Clip): boolean {
  return clip.effects.some((effect) => effect.type === 'transition');
}

function hasRenderedTransform(clip: Clip): boolean {
  return clip.keyframes.some((keyframe) => RENDERED_TRANSFORM_PROPERTIES.has(keyframe.property));
}

/** The compiler's `static_fit`: nothing animated, cropped or transitioning. */
export function isStaticFit(clip: Clip): boolean {
  return (
    clip.keyframes.length === 0 &&
    clip.crop === undefined &&
    !hasRenderedTransform(clip) &&
    !hasTransitionEffect(clip)
  );
}

/** The decode step the export uses for a video clip (or an under-layer of it). */
export function decodeStepFor(
  clip: Clip,
  source: PixelSize,
  target: PixelSize,
  role: FramePlanLayer['role'],
): DecodeStep {
  // `_underlay_layer` opens the neighbour with the export's own `max_decode_dimension` (None).
  if (role === 'underlay') return { kind: 'native' };
  if (isStaticFit(clip)) {
    const exact = fittedDecodeSize(source, target);
    return exact === null ? { kind: 'native' } : { kind: 'scaled', ...exact };
  }
  const capped = cappedDecodeSize(source, decodeCapForClip(clip, target));
  return capped === null ? { kind: 'native' } : { kind: 'scaled', ...capped };
}

/** `vfx.Crop` on a `width × height` frame: float bounds, `int()` slicing, numpy clamping. */
export function cropRect(clip: Clip, decoded: PixelSize): PixelRect | null {
  const crop = clip.crop;
  if (crop === undefined) return null;
  const clampTo = (value: number, size: number): number => Math.min(Math.max(value, 0), size);
  const x1 = clampTo(pyInt(crop.x * decoded.width), decoded.width);
  const y1 = clampTo(pyInt(crop.y * decoded.height), decoded.height);
  const x2 = clampTo(pyInt((crop.x + crop.width) * decoded.width), decoded.width);
  const y2 = clampTo(pyInt((crop.y + crop.height) * decoded.height), decoded.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/** Whether `_attach_mask` wraps this clip in a mask at all (v21 opacity/fade/wipe inputs). */
function attachesOpacityMask(clip: Clip, layer: FramePlanLayer): boolean {
  const opacityAnimated = clip.keyframes.some((keyframe) => keyframe.property === 'opacity');
  const legacyFade = layer.transitions.some(
    (t) => t.path === 'legacy' && (t.kind === 'fade' || t.kind === 'cross-dissolve'),
  );
  return opacityAnimated || legacyFade || layer.opacity < 1;
}

/**
 * Integer raster work for one picture layer of the plan.
 *
 * @param layer - A `picture` layer of `framePlanAt` computed at `target`.
 * @param clip - The clip the layer is drawn from (the neighbour, for an under-layer).
 * @param asset - Its asset; `media.width/height` is the decoded storage size.
 * @param target - The frame being composited, in pixels.
 * @param sourceSize - The source's decoded size when known (a still's natural size, a video's
 *   visible size); falls back to `asset.media`.
 * @returns `null` when the layer cannot be placed (no measurable size, or an empty crop).
 */
export function pictureRasterStep(
  layer: FramePlanLayer,
  clip: Clip,
  asset: Asset,
  target: PixelSize,
  sourceSize?: PixelSize,
): PictureRasterStep | null {
  const source = layer.source;
  const geometry = layer.geometry;
  if (source === null || geometry === null) return null;
  const size: PixelSize | null =
    sourceSize ??
    (asset.media?.width && asset.media.height
      ? { width: asset.media.width, height: asset.media.height }
      : null);
  if (size === null || size.width <= 0 || size.height <= 0) return null;

  const isVideo = source.assetKind === 'video';
  const decode: DecodeStep = isVideo
    ? decodeStepFor(clip, size, target, layer.role)
    : { kind: 'native' };
  const decoded = decode.kind === 'scaled' ? decode : size;
  // A still is placed without its crop (the plan's own quirk note), and so is its mask.
  const crop = isVideo ? cropRect(clip, decoded) : null;
  const placed: PixelSize = crop ?? decoded;
  if (placed.width <= 0 || placed.height <= 0) return null;

  const alpha8 =
    isVideo && layer.role === 'clip' && attachesOpacityMask(clip, layer)
      ? pyInt(255 * Math.min(1, Math.max(0, layer.opacity)))
      : null;

  const base = Math.min(target.width / placed.width, target.height / placed.height);
  // The plan's `scale` is its own base × the authored scale × a geometry transition's zoom; the
  // compiler's base comes from the integer-cropped decoded size, so recover the factor.
  const authoredScale = geometry.baseScale === 0 ? 1 : geometry.scale / geometry.baseScale;
  const keyframes = layer.role === 'underlay' ? [] : clip.keyframes;
  const transformed = keyframes.some((keyframe) =>
    RENDERED_TRANSFORM_PROPERTIES.has(keyframe.property),
  );
  const geometryTransition = layer.transitions.some(
    (t) => t.path === 'legacy' && LEGACY_GEOMETRY_KINDS.has(t.kind),
  );
  const hasGeometryTransitionEffect =
    layer.role === 'clip' && legacyGeometryTransition(clip) && !transformed;

  let resize: PixelSize | null;
  let x: number;
  let y: number;
  if (!transformed && !geometryTransition && !hasGeometryTransitionEffect) {
    resize =
      base === 1
        ? null
        : { width: pyInt(base * placed.width), height: pyInt(base * placed.height) };
    // Pillow returns a copy for a same-size resize.
    if (resize !== null && resize.width === placed.width && resize.height === placed.height) {
      resize = null;
    }
    const w = resize?.width ?? placed.width;
    const h = resize?.height ?? placed.height;
    x = pyInt((target.width - w) / 2);
    y = pyInt((target.height - h) / 2);
  } else {
    const scale = base * authoredScale;
    resize = { width: pyInt(scale * placed.width), height: pyInt(scale * placed.height) };
    if (resize.width === placed.width && resize.height === placed.height) resize = null;
    // `layer_position_at` keeps float sizes: centre + offset − float width / 2.
    x = pyInt(geometry.anchorX - (placed.width * scale) / 2);
    y = pyInt(geometry.anchorY - (placed.height * scale) / 2);
  }
  if (resize !== null && (resize.width <= 0 || resize.height <= 0)) return null;

  return {
    assetId: source.assetId,
    assetKind: isVideo ? 'video' : 'image',
    frame: isVideo ? source.frame : null,
    decode,
    crop,
    alpha8,
    resize,
    rotation: keyframes.some((keyframe) => keyframe.property === 'rotation')
      ? geometry.rotation
      : 0,
    x,
    y,
    blendMode: layer.blendMode,
  };
}

/**
 * Whether a clip's legacy transition changes geometry at all (push/zoom/slide on the legacy
 * path). The compiler takes the animated placement branch for the whole clip in that case,
 * even after the ramp has finished.
 */
function legacyGeometryTransition(clip: Clip): boolean {
  const effect = clip.effects.find((candidate) => candidate.type === 'transition');
  if (effect === undefined || effect.params.disabled === true) return false;
  const kind = typeof effect.params.kind === 'string' ? effect.params.kind : '';
  return readAlignment(effect.params) === 'start' && LEGACY_GEOMETRY_KINDS.has(kind);
}
