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
import {
  affectsWipe,
  blurRadiusAt,
  transitionFromClip,
  wipeAxis,
  wipeEdge,
  wipeProgressAt,
  wipeSoftness,
} from '../transition-envelope.js';
import { clipMaskStack, type ClipMaskStack, type MaskPreviewRefusal } from '../masks/mask-stack.js';
import {
  resolveTransitionParamsFor,
  type ResolvedTransition,
} from '../transitions/transition-engine.js';

/** Extra source pixels the export keeps beyond the exact need (`DECODE_CAP_HEADROOM`). */
export const DECODE_CAP_HEADROOM = 1.25;

/** Transform properties the compiler places (`RENDERED_TRANSFORM_PROPERTIES`). */
const RENDERED_TRANSFORM_PROPERTIES = new Set(['scale', 'x', 'y', 'rotation']);
const LEGACY_GEOMETRY_KINDS = new Set(['push', 'zoom', 'slide']);
/** `LEGACY_KINDS` of `frame_plan.py`: the pre-catalog envelope path. */
const LEGACY_KINDS = new Set([
  'cut',
  'fade',
  'cross-dissolve',
  'push',
  'slide',
  'zoom',
  'blur',
  'wipe',
]);

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
  /**
   * `_attach_mask`'s opacity (keyframes × legacy fade), `null` when the clip has no mask.
   * Composited as the truncated 8-bit value.
   */
  readonly opacity: number | null;
  /**
   * The clip's schema-v22 mask stacks (alpha and effect targets) and the clip-relative time
   * they are evaluated at, `null` when the clip has none or they cannot be previewed. The
   * compositor rasterises them at the cropped picture's size with the export's own algorithm
   * (`masks/mask-stack.ts`).
   */
  readonly mask: LayerMaskStack | null;
  /** Why the clip's masks are not drawn (the export refuses the same stack); shown on the monitor. */
  readonly maskRefusal: MaskPreviewRefusal | null;
  /** The clip's effect id for each entry of {@link effects} (effect-target masks key on it). */
  readonly effectIds: readonly (string | null)[];
  /**
   * A legacy `blur` transition's Pillow GaussianBlur radius at this frame (0 = none), applied to
   * the cropped, graded picture before its mask (`_apply_transition_blur`).
   */
  readonly blurRadius: number;
  /** A legacy wipe's band across the layer's own width or height, `null` when not wiping. */
  readonly wipe: LayerWipe | null;
  /** Live catalog transition halves, applied after the mask in export order (out, then in). */
  readonly transitions: readonly LayerTransition[];
  /** Pillow LANCZOS target; `null` = placed at its own size. */
  readonly resize: PixelSize | null;
  /** Degrees, counter-clockwise as PIL rotates (MoviePy passes the authored angle). */
  readonly rotation: number;
  /** Top-left paste position (may be negative). */
  readonly x: number;
  readonly y: number;
  readonly blendMode: string;
  /** Per-clip picture effects in export order (`color_grade`, then `lut`). */
  readonly effects: FramePlanLayer['effects'];
}

export interface LayerMaskStack {
  readonly stack: ClipMaskStack;
  /** Seconds from the clip's start (the stack maps it to the asset source clock). */
  readonly clipTime: number;
}

export interface LayerWipe {
  readonly axis: 'x' | 'y';
  readonly inverted: boolean;
  /** Frame fraction of the edge (`wipe_edge(progress, feather)`). */
  readonly edge: number;
  readonly feather: number;
}

export interface LayerTransition {
  readonly role: 'in' | 'out';
  readonly transition: ResolvedTransition;
  /** Eased progress, from the frame plan. */
  readonly eased: number;
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

/** The compiler's `_even`: nearest even integer (Python `round`), at least 2. */
const even = (value: number): number => Math.max(2, pyRound(value / 2) * 2);

/** `fitted_decode_size`: the exact size a static fit decodes at, or `null` (never upscale). */
export function fittedDecodeSize(source: PixelSize, target: PixelSize): PixelSize | null {
  if (source.width <= 0 || source.height <= 0) return null;
  const scale = Math.min(target.width / source.width, target.height / source.height);
  if (scale >= 1) return null;
  return { width: even(source.width * scale), height: even(source.height * scale) };
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

/**
 * `_open_source_reader`'s decode size for a `source` (storage pixels, already turned upright)
 * with pixel aspect ratio `par`, or `null` when ffmpeg decodes it as stored. The ratio stretches
 * storage width, which is the upright height of a quarter-turned source (PX2.11).
 */
export function readerDecodeSize(
  source: PixelSize,
  cap: number | null,
  fitTarget: PixelSize | null,
  par = 1,
  rotation = 0,
): PixelSize | null {
  const quarterTurn = Math.abs(rotation) % 180 === 90;
  const display = quarterTurn
    ? { width: source.width, height: source.height * par }
    : { width: source.width * par, height: source.height };
  const anamorphic = par !== 1;
  if (fitTarget !== null) {
    const exact = fittedDecodeSize(display, fitTarget);
    if (exact !== null) return exact;
    return anamorphic ? { width: even(display.width), height: even(display.height) } : null;
  }
  const longest = Math.max(display.width, display.height);
  if (cap === null || longest <= cap) {
    return anamorphic ? { width: even(display.width), height: even(display.height) } : null;
  }
  const scale = cap / longest;
  return { width: even(display.width * scale), height: even(display.height * scale) };
}

/** `_open_source_reader`'s capped decode size for square pixels (kept for callers and tests). */
export function cappedDecodeSize(source: PixelSize, cap: number | null): PixelSize | null {
  return cap === null ? null : readerDecodeSize(source, cap, null, 1);
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
  par = 1,
  rotation = 0,
): DecodeStep {
  // `_underlay_layer` opens the neighbour with the export's own `max_decode_dimension` (None).
  const size =
    role === 'underlay'
      ? readerDecodeSize(source, null, null, par, rotation)
      : isStaticFit(clip)
        ? readerDecodeSize(source, null, target, par, rotation)
        : readerDecodeSize(source, decodeCapForClip(clip, target), null, par, rotation);
  return size === null ? { kind: 'native' } : { kind: 'scaled', ...size };
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
    ? decodeStepFor(
        clip,
        size,
        target,
        layer.role,
        asset.media?.pixelAspectRatio ?? 1,
        asset.media?.rotation ?? 0,
      )
    : { kind: 'native' };
  const decoded = decode.kind === 'scaled' ? decode : size;
  // A still is placed without its crop (the plan's own quirk note), and so is its mask.
  const crop = isVideo ? cropRect(clip, decoded) : null;
  const placed: PixelSize = crop ?? decoded;
  if (placed.width <= 0 || placed.height <= 0) return null;

  const legacy = isVideo && layer.role === 'clip' ? legacyEnvelope(clip) : null;
  const wiping = legacy !== null && affectsWipe(legacy);
  // Only a video clip draws its stack: stills are placed without crop or mask (the export's rule).
  const stack = isVideo && layer.role === 'clip' ? clipMaskStack(clip, asset.media) : null;
  const drawable = stack !== null && stack.refusal === null ? stack : null;
  const mask: LayerMaskStack | null =
    drawable === null ? null : { stack: drawable, clipTime: layer.localTime };
  const alphaStack = drawable !== null && drawable.alpha.length > 0;
  const opacity =
    isVideo && layer.role === 'clip' && (attachesOpacityMask(clip, layer) || wiping || alphaStack)
      ? Math.min(1, Math.max(0, layer.opacity))
      : null;
  const blurRadius =
    legacy !== null && legacy.kind === 'blur'
      ? blurRadiusAt(legacy, layer.localTime, Math.min(placed.width, placed.height))
      : 0;
  let wipe: LayerWipe | null = null;
  if (wiping && legacy !== null) {
    const [axis, inverted] = wipeAxis(legacy);
    const feather = wipeSoftness(legacy);
    wipe = {
      axis,
      inverted,
      edge: wipeEdge(wipeProgressAt(legacy, layer.localTime), feather),
      feather,
    };
  }
  const transitions: LayerTransition[] = [];
  if (isVideo && layer.role === 'clip') {
    for (const state of layer.transitions) {
      if (state.path !== 'catalog') continue;
      const effect = clip.effects.find(
        (candidate) => candidate.type === (state.role === 'in' ? 'transition' : 'transition_out'),
      );
      const resolved = effect ? resolveTransitionParamsFor(effect.params ?? {}) : null;
      if (resolved === null || resolved.disabled || resolved.isCut) continue;
      transitions.push({ role: state.role, transition: resolved, eased: state.eased });
    }
    // The compiler walks the outgoing half first.
    transitions.sort((a, b) => (a.role === b.role ? 0 : a.role === 'out' ? -1 : 1));
  }

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
    opacity,
    mask: alphaStack || (drawable?.byEffect.size ?? 0) > 0 ? mask : null,
    maskRefusal: stack?.refusal ?? null,
    effectIds: layer.effects.map(
      (planned) => clip.effects.find((effect) => effect.type === planned.type)?.id ?? null,
    ),
    blurRadius,
    wipe,
    transitions,
    resize,
    rotation: keyframes.some((keyframe) => keyframe.property === 'rotation')
      ? geometry.rotation
      : 0,
    x,
    y,
    blendMode: layer.blendMode,
    effects: layer.effects,
  };
}

/** The clip's `transition` envelope when it takes the legacy compiler path, else `null`. */
function legacyEnvelope(clip: Clip) {
  const effect = clip.effects.find((candidate) => candidate.type === 'transition');
  if (effect === undefined || effect.params.disabled === true) return null;
  const kind = typeof effect.params.kind === 'string' ? effect.params.kind : '';
  if (!LEGACY_KINDS.has(kind) || readAlignment(effect.params) !== 'start') return null;
  return transitionFromClip(clip);
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

/**
 * A text overlay's raster placed as `_compile_text_clip` places it: `fit_to_frame=False` (base
 * scale 1) around the layout centre, the clip's own transform applied when it animates.
 *
 * @param layer - A `text` layer of `framePlanAt` computed at `target`.
 * @param clip - The text clip.
 * @param raster - The rasterised overlay size.
 * @param centre - The layout centre (`xPercent`/`yPercent` of the frame).
 */
export function textRasterStep(
  layer: FramePlanLayer,
  clip: Clip,
  raster: PixelSize,
  centre: { readonly x: number; readonly y: number },
): PictureRasterStep | null {
  const geometry = layer.geometry;
  if (geometry === null || raster.width <= 0 || raster.height <= 0) return null;
  const transformed = clip.keyframes.some((keyframe) =>
    RENDERED_TRANSFORM_PROPERTIES.has(keyframe.property),
  );
  let resize: PixelSize | null = null;
  let x: number;
  let y: number;
  if (!transformed) {
    x = pyInt(centre.x - raster.width / 2);
    y = pyInt(centre.y - raster.height / 2);
  } else {
    const scale = geometry.scale;
    const width = pyInt(scale * raster.width);
    const height = pyInt(scale * raster.height);
    if (width <= 0 || height <= 0) return null;
    if (width !== raster.width || height !== raster.height) resize = { width, height };
    x = pyInt(geometry.anchorX - (raster.width * scale) / 2);
    y = pyInt(geometry.anchorY - (raster.height * scale) / 2);
  }
  return {
    assetId: `text:${clip.id}`,
    assetKind: 'image',
    frame: null,
    decode: { kind: 'native' },
    crop: null,
    opacity: null,
    mask: null,
    maskRefusal: null,
    effectIds: [],
    blurRadius: 0,
    wipe: null,
    transitions: [],
    resize,
    rotation: clip.keyframes.some((keyframe) => keyframe.property === 'rotation')
      ? geometry.rotation
      : 0,
    x,
    y,
    blendMode: layer.blendMode,
    effects: [],
  };
}
