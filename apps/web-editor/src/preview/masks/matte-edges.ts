/**
 * Pixel rules for a `matte` mask layer in the preview: the TypeScript twin of
 * `engine/python/framepilot_engine/render/matte_edges.py` (BR5.1).
 *
 * WHY exact: the export evaluates a matte with integer morphology, integer squared distances and
 * float64 elementwise work written in a fixed order, precisely so a twin can reproduce it. The
 * functions below perform the same operations in the same order (`a + (b - a) * t`, taps summed
 * one by one, `rint` ties to even), so the monitor's alpha is the export's alpha to the last bit
 * (`tests/fixtures/mask-raster/matte-clips.json`, `matte-edges.test.ts`).
 *
 * Evaluation order, all in the artifact's SOURCE (display) pixels, then onto the clip's frame:
 * edge shift → clean levels → base expansion/feather on the matte's own 50 % contour → bicubic
 * resample to the decoded picture size (swscale geometry, B = 0, C = 0.6) → the clip's integer
 * crop → the base invert/opacity/mode rules of the stack (`mask-stack.ts`).
 */
import type { MaskLayer } from '@framepilot/timeline-schema';

import {
  applyFalloff,
  gaussianFalloffTable,
  roundHalfEven,
  type MaskFalloff,
} from './mask-raster.js';

/** `edgeMode: 'sharp'` as clean levels (`SHARP_CLEAN_BLACK` / `SHARP_CLEAN_WHITE`). */
export const SHARP_CLEAN_BLACK = 0.25;
export const SHARP_CLEAN_WHITE = 0.75;

/** swscale's SWS_BICUBIC: the Mitchell-Netravali cubic with B = 0, C = 0.6. */
const BICUBIC_B = 0.0;
const BICUBIC_C = 0.6;

export type MatteSamples = Uint8Array | Uint16Array;

/** A clip crop as frame fractions (`Clip.crop`). */
export interface CropFractions {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// --- Edge shift ---------------------------------------------------------------------------

const isqrt = (value: number): number => {
  let root = Math.floor(Math.sqrt(value));
  while (root * root > value) root -= 1;
  while ((root + 1) * (root + 1) <= value) root += 1;
  return root;
};

/**
 * `_disc_morphology`: grey dilation (`grow`) or erosion by the disc `dx² + dy² <= r²`, edges
 * replicated. Row windows are built incrementally, one half-width at a time.
 */
export function discMorphology<T extends MatteSamples | Float64Array>(
  values: T,
  width: number,
  height: number,
  radius: number,
  grow: boolean,
): T {
  if (radius <= 0) return values;
  const pick = grow ? Math.max : Math.min;
  const byWidth = new Map<number, number[]>();
  for (let dy = -radius; dy <= radius; dy += 1) {
    const half = isqrt(radius * radius - dy * dy);
    const list = byWidth.get(half) ?? [];
    list.push(dy);
    byWidth.set(half, list);
  }
  const result = values.slice() as T;
  let window: MatteSamples | Float64Array = values;
  for (let half = 0; half <= radius; half += 1) {
    if (half > 0) {
      const next = new (values.constructor as { new (length: number): T })(width * height);
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < width; x += 1) {
          const left = window[row + Math.max(x - 1, 0)]!;
          const centre = window[row + x]!;
          const right = window[row + Math.min(x + 1, width - 1)]!;
          next[row + x] = pick(pick(left, centre), right);
        }
      }
      window = next;
    }
    for (const dy of byWidth.get(half) ?? []) {
      for (let y = 0; y < height; y += 1) {
        const source = Math.min(Math.max(y + dy, 0), height - 1) * width;
        const row = y * width;
        for (let x = 0; x < width; x += 1) {
          result[row + x] = pick(result[row + x]!, window[source + x]!);
        }
      }
    }
  }
  return result;
}

/** `edge_shift`: the matte as float alpha after shifting its edge by `shiftPx` source pixels. */
export function edgeShift(
  values: MatteSamples,
  width: number,
  height: number,
  maximum: number,
  shiftPx: number,
): Float64Array {
  const magnitude = Math.abs(shiftPx);
  const low = Math.floor(magnitude);
  const high = Math.ceil(magnitude);
  const grow = shiftPx > 0;
  const scale = maximum;
  const lowValues = discMorphology(values, width, height, low, grow);
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = lowValues[i]! / scale;
  if (high === low) return out;
  const highValues = discMorphology(values, width, height, high, grow);
  const fraction = magnitude - low;
  for (let i = 0; i < out.length; i += 1) {
    const lowAlpha = out[i]!;
    const highAlpha = highValues[i]! / scale;
    out[i] = lowAlpha + (highAlpha - lowAlpha) * fraction;
  }
  return out;
}

// --- Clean levels -------------------------------------------------------------------------

type MatteMask = Extract<MaskLayer, { kind: 'matte' }>;

/** `clean_levels`: finesse clean black/white, else the edge mode's. */
export function cleanLevels(mask: MatteMask): readonly [number, number] {
  const black = mask.finesse.cleanBlack;
  const white = mask.finesse.cleanWhite;
  if (black === 0.0 && white === 1.0 && mask.edgeMode === 'sharp') {
    return [SHARP_CLEAN_BLACK, SHARP_CLEAN_WHITE];
  }
  return [black, white];
}

/** `apply_clean_levels`, in place. */
export function applyCleanLevels(alpha: Float64Array, black: number, white: number): Float64Array {
  if (black === 0.0 && white === 1.0) return alpha;
  if (white <= black) {
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = alpha[i]! >= black ? 1.0 : 0.0;
    return alpha;
  }
  const span = white - black;
  for (let i = 0; i < alpha.length; i += 1) {
    const scaled = (alpha[i]! - black) / span;
    alpha[i] = Math.min(Math.max(scaled, 0.0), 1.0);
  }
  return alpha;
}

// --- Distance feather ---------------------------------------------------------------------

/** `_row_distance`: column distance to the nearest feature pixel in the row, capped. */
function rowDistance(features: Uint8Array, width: number, height: number, cap: number): Int32Array {
  const out = new Int32Array(width * height);
  const far = width + cap + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let before = -far;
    for (let x = 0; x < width; x += 1) {
      if (features[row + x]) before = x;
      out[row + x] = x - before;
    }
    let after = width + far;
    for (let x = width - 1; x >= 0; x -= 1) {
      if (features[row + x]) after = x;
      out[row + x] = Math.min(Math.min(out[row + x]!, after - x), cap);
    }
  }
  return out;
}

/** `_bounded_distance`: Euclidean distance to the nearest feature centre, capped at `cap`. */
function boundedDistance(
  features: Uint8Array,
  width: number,
  height: number,
  cap: number,
): Float64Array {
  const row = rowDistance(features, width, height, cap);
  const squared = new Float64Array(width * height);
  for (let i = 0; i < squared.length; i += 1) squared[i] = row[i]! * row[i]!;
  const best = squared.slice();
  const capped = cap * cap;
  for (let dy = 1; dy <= cap; dy += 1) {
    if (dy >= height) continue;
    const extra = dy * dy;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width;
      const belowRow = y + dy < height ? (y + dy) * width : -1;
      const aboveRow = y - dy >= 0 ? (y - dy) * width : -1;
      for (let x = 0; x < width; x += 1) {
        const below = belowRow >= 0 ? squared[belowRow + x]! + extra : capped;
        const above = aboveRow >= 0 ? squared[aboveRow + x]! + extra : capped;
        best[rowStart + x] = Math.min(best[rowStart + x]!, Math.min(below, above));
      }
    }
  }
  const distance = new Float64Array(width * height);
  for (let i = 0; i < distance.length; i += 1) distance[i] = Math.sqrt(Math.min(best[i]!, capped));
  return distance;
}

export interface MatteFeather {
  readonly expansion: number;
  readonly featherInner: number;
  readonly featherOuter: number;
  readonly falloff: MaskFalloff;
}

/** `distance_feather`: redraw the matte's 50 % contour with the shape rasteriser's formula. */
export function distanceFeather(
  alpha: Float64Array,
  width: number,
  height: number,
  { expansion, featherInner, featherOuter, falloff }: MatteFeather,
): Float64Array {
  if (expansion === 0.0 && featherInner === 0.0 && featherOuter === 0.0) return alpha;
  const inside = new Uint8Array(width * height);
  const outside = new Uint8Array(width * height);
  for (let i = 0; i < inside.length; i += 1) {
    inside[i] = alpha[i]! >= 0.5 ? 1 : 0;
    outside[i] = 1 - inside[i]!;
  }
  const widest = Math.max(featherOuter + expansion, featherInner - expansion, 0.0);
  const cap = Math.ceil(widest) + 2;
  const toInside = boundedDistance(inside, width, height, cap);
  const toOutside = boundedDistance(outside, width, height, cap);
  const total = featherInner + featherOuter;
  const table = falloff === 'gaussian' ? gaussianFalloffTable() : new Float64Array(0);
  const out = new Float64Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    const signed = inside[i] ? 0.5 - toOutside[i]! : toInside[i]! - 0.5;
    const shifted = signed - expansion;
    const x = total <= 0.0 ? 0.5 - shifted : (featherOuter - shifted) / total;
    const clamped = Math.min(Math.max(x, 0.0), 1.0);
    out[i] = applyFalloff(clamped, falloff, table);
  }
  return out;
}

// --- Onto the clip's frame ----------------------------------------------------------------

/** `_crop_slices`: MoviePy's `vfx.Crop` on fractions of the frame, `int()` of each edge. */
export function cropSlices(
  crop: CropFractions | null | undefined,
  width: number,
  height: number,
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  if (crop === null || crop === undefined) return { x0: 0, y0: 0, x1: width, y1: height };
  const clampIndex = (value: number, size: number): number => Math.min(Math.max(value, 0), size);
  return {
    x0: clampIndex(Math.trunc(crop.x * width), width),
    y0: clampIndex(Math.trunc(crop.y * height), height),
    x1: clampIndex(Math.trunc((crop.x + crop.width) * width), width),
    y1: clampIndex(Math.trunc((crop.y + crop.height) * height), height),
  };
}

const cubicWeight = (x: number): number => {
  const ax = Math.abs(x);
  const b = BICUBIC_B;
  const c = BICUBIC_C;
  const near =
    (((12.0 - 9.0 * b - 6.0 * c) * ax + (-18.0 + 12.0 * b + 6.0 * c)) * ax * ax + (6.0 - 2.0 * b)) /
    6.0;
  const far =
    ((((-b - 6.0 * c) * ax + (6.0 * b + 30.0 * c)) * ax + (-12.0 * b - 48.0 * c)) * ax +
      (8.0 * b + 24.0 * c)) /
    6.0;
  return ax < 1.0 ? near : ax < 2.0 ? far : 0.0;
};

/** `resample_taps`: per output index, clamped source indices and normalised weights. */
export function resampleTaps(
  source: number,
  size: number,
): { readonly taps: number; readonly indices: Int32Array; readonly weights: Float64Array } {
  const scale = source / size;
  const stretch = Math.max(scale, 1.0);
  const taps = 2 * Math.ceil(2.0 * stretch);
  const indices = new Int32Array(size * taps);
  const weights = new Float64Array(size * taps);
  for (let i = 0; i < size; i += 1) {
    const centre = (i + 0.5) * scale - 0.5;
    const first = Math.floor(centre - 2.0 * stretch) + 1;
    let total = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const position = first + tap;
      const weight = cubicWeight((position - centre) / stretch);
      weights[i * taps + tap] = weight;
      total = tap === 0 ? weight : total + weight;
      indices[i * taps + tap] = Math.min(Math.max(position, 0), source - 1);
    }
    for (let tap = 0; tap < taps; tap += 1)
      weights[i * taps + tap] = weights[i * taps + tap]! / total;
  }
  return { taps, indices, weights };
}

/** A float plane, `channels` per pixel, rows top first. */
export interface FloatPlane {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Float64Array;
}

/** `_resample_axis`: bicubic along one axis, clamped to `[0, ceiling]`; identity when equal. */
function resampleAxis(
  plane: FloatPlane,
  size: number,
  horizontal: boolean,
  ceiling: number,
): FloatPlane {
  const source = horizontal ? plane.width : plane.height;
  if (source === size) return plane;
  const { taps, indices, weights } = resampleTaps(source, size);
  const width = horizontal ? size : plane.width;
  const height = horizontal ? plane.height : size;
  const channels = plane.channels;
  const src = plane.data;
  const out = new Float64Array(width * height * channels);
  if (horizontal) {
    for (let y = 0; y < height; y += 1) {
      const srcRow = y * plane.width;
      const outRow = y * width;
      for (let x = 0; x < width; x += 1) {
        const base = x * taps;
        for (let ch = 0; ch < channels; ch += 1) {
          let acc = src[(srcRow + indices[base]!) * channels + ch]! * weights[base]!;
          for (let tap = 1; tap < taps; tap += 1) {
            acc =
              acc + src[(srcRow + indices[base + tap]!) * channels + ch]! * weights[base + tap]!;
          }
          out[(outRow + x) * channels + ch] = Math.min(Math.max(acc, 0.0), ceiling);
        }
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const base = y * taps;
      const outRow = y * width;
      for (let x = 0; x < width; x += 1) {
        for (let ch = 0; ch < channels; ch += 1) {
          let acc = src[(indices[base]! * plane.width + x) * channels + ch]! * weights[base]!;
          for (let tap = 1; tap < taps; tap += 1) {
            acc =
              acc +
              src[(indices[base + tap]! * plane.width + x) * channels + ch]! * weights[base + tap]!;
          }
          out[(outRow + x) * channels + ch] = Math.min(Math.max(acc, 0.0), ceiling);
        }
      }
    }
  }
  return { width, height, channels, data: out };
}

/** `resample`: rows first (horizontal pass), then columns, as swscale filters. */
export function resample(
  plane: FloatPlane,
  width: number,
  height: number,
  ceiling: number,
): FloatPlane {
  return resampleAxis(resampleAxis(plane, width, true, ceiling), height, false, ceiling);
}

/**
 * `to_frame`: a display-space artifact plane taken through the picture's own path onto its
 * frame: resampled to the decoded size, cropped by the same integer slices, then (only if the
 * crop still disagrees with the frame) resampled to it.
 */
export function toFrame(
  plane: FloatPlane,
  crop: CropFractions | null | undefined,
  width: number,
  height: number,
  decodedWidth: number,
  decodedHeight: number,
  ceiling = 1.0,
): FloatPlane {
  const decoded = resample(plane, decodedWidth, decodedHeight, ceiling);
  const { x0, y0, x1, y1 } = cropSlices(crop, decodedWidth, decodedHeight);
  const cropW = Math.max(0, x1 - x0);
  const cropH = Math.max(0, y1 - y0);
  const channels = decoded.channels;
  let cropped: FloatPlane = decoded;
  if (x0 !== 0 || y0 !== 0 || cropW !== decoded.width || cropH !== decoded.height) {
    const data = new Float64Array(cropW * cropH * channels);
    for (let y = 0; y < cropH; y += 1) {
      const from = ((y0 + y) * decoded.width + x0) * channels;
      data.set(decoded.data.subarray(from, from + cropW * channels), y * cropW * channels);
    }
    cropped = { width: cropW, height: cropH, channels, data };
  }
  return resample(cropped, width, height, ceiling);
}

// --- A matte layer --------------------------------------------------------------------------

/**
 * `render/matte_tier.py`'s quantisation: a band weight in [0, 1] is stored as
 * `round(weight * 65535)`, a premultiplied colour in [0, 255] as `round(colour * 257)`.
 */
export const TIER_WEIGHT_SCALE = 65535;
export const TIER_COLOUR_SCALE = 257;
/** PX5.8: `ALPHA_SCALE`: a resampled alpha in [0, 1] is stored as `round(alpha * 65535)`. */
export const TIER_ALPHA_SCALE = 65535;

/**
 * PX5.8: a matte frame's alpha from the monitor tier (`alpha.mkv`), already at the decoded size:
 * `resample(samples / maximum)`, 16-bit, as one `width × 2·height` byte plane (the high-byte
 * rows, then the low-byte rows).
 */
export interface MatteAlphaPlane {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The 16-bit value of a tier alpha plane at pixel `index`. */
export function tierAlphaValue(plane: MatteAlphaPlane, index: number): number {
  return (plane.data[index]! << 8) | plane.data[plane.width * plane.height + index]!;
}

/** A matte layer's source-resolution edge controls at one instant (feathers clamped at 0). */
export interface MatteSourceControls {
  readonly levels: readonly [number, number];
  readonly finesse: MaskFinesseValues;
  readonly shiftPx: number;
  readonly feather: Pick<MatteFeather, 'expansion' | 'featherInner' | 'featherOuter'>;
}

/**
 * PX5.8, `source_chain_is_identity` of `render/matte_tier.py`: whether every step `matte_alpha`
 * runs at SOURCE resolution returns its input, so `to_frame` of the chain is `to_frame` of the
 * samples, which the tier's alpha plane holds at the decoded size. Each condition is the one
 * under which that step is the identity: edge shift exactly 0; denoise, open, close and blur
 * <= 0; clean levels (0, 1) after {@link cleanLevels} (`sharp` supplies 0.25 / 0.75, so it never
 * qualifies); shrink/grow and in/out ratio exactly 0; expansion and both (clamped) feathers 0.
 */
export function sourceChainIsIdentity({
  levels,
  finesse,
  shiftPx,
  feather,
}: MatteSourceControls): boolean {
  return (
    shiftPx === 0 &&
    finesse.denoise <= 0 &&
    levels[0] === 0 &&
    levels[1] === 1 &&
    finesse.morphOpenPx <= 0 &&
    finesse.morphClosePx <= 0 &&
    finesse.shrinkGrowPx === 0 &&
    finesse.blurPx <= 0 &&
    finesse.inOutRatio === 0 &&
    feather.expansion === 0 &&
    feather.featherInner === 0 &&
    feather.featherOuter === 0
  );
}

/**
 * PX5.8: whether {@link sourceChainIsIdentity} holds for `mask` at EVERY instant: its finesse
 * and edge mode qualify and none of its edge shift, expansion or feathers is non-zero or
 * keyframed. What the monitor decides to decode by; a keyframed control that passes through 0
 * is judged per instant when drawing, but its frames always carry the source-size alpha.
 */
export function matteAlphaTierable(mask: MatteMask): boolean {
  const keyframed = new Set(mask.keyframes.map((keyframe) => keyframe.property as string));
  const still = (name: 'edgeShiftPx' | 'expansionPx' | 'featherInnerPx' | 'featherOuterPx') =>
    !keyframed.has(name);
  return (
    still('edgeShiftPx') &&
    still('expansionPx') &&
    still('featherInnerPx') &&
    still('featherOuterPx') &&
    sourceChainIsIdentity({
      levels: cleanLevels(mask),
      finesse: mask.finesse,
      shiftPx: mask.edgeShiftPx,
      feather: {
        expansion: mask.expansionPx,
        featherInner: Math.max(mask.featherInnerPx, 0),
        featherOuter: Math.max(mask.featherOuterPx, 0),
      },
    })
  );
}

/**
 * PX5.3: a matte frame's decontamination planes from the artifact's monitor tier, already at the
 * decoded size (`resample` of the band weight and the band-premultiplied foreground, quantised
 * to 16 bits). As `render/matte_tier.py` stores them: one `width × 8·height` byte plane, rows
 * top first, each 16-bit plane as its high-byte rows then its low-byte rows, in the order
 * weight, R, G, B ({@link tierPlaneValue}).
 */
export interface MattePlanes {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * The 16-bit value of plane `plane` (0 weight, 1 R, 2 G, 3 B) at pixel `index` of a tier frame.
 */
export function tierPlaneValue(planes: MattePlanes, plane: number, index: number): number {
  const pixels = planes.width * planes.height;
  return (
    (planes.data[2 * plane * pixels + index]! << 8) | planes.data[(2 * plane + 1) * pixels + index]!
  );
}

/** One decoded matte frame at the artifact's source (display) resolution. */
export interface MatteFrameData {
  /** Identity for caches: artifact key and matte frame index. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** 255 for `gray`, 65535 for `gray16le`. */
  readonly maximum: number;
  /**
   * The source-size samples; `null` when only the tier's {@link alphaPlane} was decoded
   * (PX5.8: every mask reading the frame takes the plane, so the 4K alpha is not decoded).
   */
  readonly alpha: MatteSamples | null;
  /** Interleaved RGB, when the mask decontaminates (always with {@link alpha}). */
  readonly foreground: Uint8Array | null;
  /**
   * PX5.3: the monitor tier's planes for this frame, when the artifact has a tier. They stand in
   * for {@link foreground} only where the picture was decoded at their size.
   */
  readonly planes?: MattePlanes | null;
  /**
   * PX5.8: the monitor tier's alpha plane for this frame. It stands in for {@link alpha} where
   * the picture was decoded at its size and the mask's source chain is the identity.
   */
  readonly alphaPlane?: MatteAlphaPlane | null;
}

/** Whether `frame`'s tier alpha plane is at the size its picture was decoded at (PX5.8). */
export function alphaPlaneFits(
  frame: MatteFrameData,
  decodedWidth: number,
  decodedHeight: number,
): frame is MatteFrameData & { readonly alphaPlane: MatteAlphaPlane } {
  const plane = frame.alphaPlane ?? null;
  return plane !== null && plane.width === decodedWidth && plane.height === decodedHeight;
}

/** Whether `frame`'s tier planes are at the size its picture was decoded at. */
export function planesFit(
  frame: MatteFrameData,
  decodedWidth: number,
  decodedHeight: number,
): frame is MatteFrameData & { readonly planes: MattePlanes } {
  const planes = frame.planes ?? null;
  return planes !== null && planes.width === decodedWidth && planes.height === decodedHeight;
}

/**
 * The matte's alpha on the clip's frame before invert/opacity (`matte_alpha` up to `to_frame`).
 *
 * @param finesse - The mask's finesse group (MK6.2).
 * @param shiftPx - `edgeShiftPx` at the instant.
 * @param feather - The base expansion/feathers at the instant (feathers clamped at 0).
 */
export function matteFrameAlpha(
  frame: MatteFrameData,
  levels: readonly [number, number],
  finesse: MaskFinesseValues,
  shiftPx: number,
  feather: MatteFeather,
  crop: CropFractions | null | undefined,
  width: number,
  height: number,
  decodedWidth: number,
  decodedHeight: number,
): Float64Array {
  // PX5.8: an identity source chain is `to_frame` of the samples, which the tier holds at the
  // decoded size: only the crop (and a frame resample for a crop that disagrees) is left.
  if (
    sourceChainIsIdentity({ levels, finesse, shiftPx, feather }) &&
    alphaPlaneFits(frame, decodedWidth, decodedHeight)
  ) {
    const plane = frame.alphaPlane;
    const values = new Float64Array(plane.width * plane.height);
    for (let i = 0; i < values.length; i += 1) {
      values[i] = tierAlphaValue(plane, i) / TIER_ALPHA_SCALE;
    }
    return toFrame(
      { width: plane.width, height: plane.height, channels: 1, data: values },
      crop,
      width,
      height,
      plane.width,
      plane.height,
    ).data;
  }
  if (frame.alpha === null) {
    throw new Error('A matte frame without its samples was drawn with a chain the tier cannot.');
  }
  let alpha = edgeShift(frame.alpha, frame.width, frame.height, frame.maximum, shiftPx);
  // MK6.2: the finesse group sits between the artifact's own edge shift and the mask's base
  // expansion/feather, as `matte_alpha` orders them.
  alpha = applyFinesse(alpha, frame.width, frame.height, finesse, levels);
  alpha = distanceFeather(alpha, frame.width, frame.height, feather);
  return toFrame(
    { width: frame.width, height: frame.height, channels: 1, data: alpha },
    crop,
    width,
    height,
    decodedWidth,
    decodedHeight,
  ).data;
}

/**
 * `decontaminate`: replace the picture's colour inside the matte's soft band with the
 * foreground estimate, in place: `out = rint(picture + (colour - picture * weight))`.
 *
 * @param picture - The cropped picture, `channels` bytes per pixel (RGB first; alpha untouched).
 */
export function decontaminate(
  picture: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  frame: MatteFrameData,
  crop: CropFractions | null | undefined,
  decodedWidth: number,
  decodedHeight: number,
): void {
  const foreground = frame.foreground;
  if (foreground === null) return;
  if (frame.alpha === null) throw new Error('A decontaminating matte frame has no samples.');
  const samples = frame.alpha;
  const pixels = frame.width * frame.height;
  const band = new Float64Array(pixels);
  const premultiplied = new Float64Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const value = samples[i]!;
    const inBand = value > 0 && value < frame.maximum ? 1.0 : 0.0;
    band[i] = inBand;
    premultiplied[i * 3] = foreground[i * 3]! * inBand;
    premultiplied[i * 3 + 1] = foreground[i * 3 + 1]! * inBand;
    premultiplied[i * 3 + 2] = foreground[i * 3 + 2]! * inBand;
  }
  const weight = toFrame(
    { width: frame.width, height: frame.height, channels: 1, data: band },
    crop,
    width,
    height,
    decodedWidth,
    decodedHeight,
  ).data;
  const colour = toFrame(
    { width: frame.width, height: frame.height, channels: 3, data: premultiplied },
    crop,
    width,
    height,
    decodedWidth,
    decodedHeight,
    255.0,
  ).data;
  for (let i = 0; i < width * height; i += 1) {
    const w = weight[i]!;
    for (let ch = 0; ch < 3; ch += 1) {
      const base = picture[i * channels + ch]!;
      const mixed = base + (colour[i * 3 + ch]! - base * w);
      picture[i * channels + ch] = Math.min(Math.max(roundHalfEven(mixed), 0), 255);
    }
  }
}

/**
 * {@link decontaminate} from the monitor tier's planes (PX5.3): the same mix, with the weight and
 * colour planes read from the tier instead of resampled from the masters. The planes are at the
 * decoded size, so `toFrame`'s resample to it is the identity and only the crop (and, for a crop
 * that disagrees with the frame, the second resample) remains.
 *
 * The CPU twin of the GPU tier pass, for a GPU without float targets.
 */
export function decontaminateFromPlanes(
  picture: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  planes: MattePlanes,
  crop: CropFractions | null | undefined,
): void {
  const pixels = planes.width * planes.height;
  const weightPlane = new Float64Array(pixels);
  const colourPlane = new Float64Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    weightPlane[i] = tierPlaneValue(planes, 0, i) / TIER_WEIGHT_SCALE;
    for (let ch = 0; ch < 3; ch += 1) {
      colourPlane[i * 3 + ch] = tierPlaneValue(planes, ch + 1, i) / TIER_COLOUR_SCALE;
    }
  }
  const at = (data: Float64Array, count: number, ceiling: number): Float64Array =>
    toFrame(
      { width: planes.width, height: planes.height, channels: count, data },
      crop,
      width,
      height,
      planes.width,
      planes.height,
      ceiling,
    ).data;
  const weight = at(weightPlane, 1, 1.0);
  const colour = at(colourPlane, 3, 255.0);
  for (let i = 0; i < width * height; i += 1) {
    const w = weight[i]!;
    for (let ch = 0; ch < 3; ch += 1) {
      const base = picture[i * channels + ch]!;
      const mixed = base + (colour[i * 3 + ch]! - base * w);
      picture[i * channels + ch] = Math.min(Math.max(roundHalfEven(mixed), 0), 255);
    }
  }
}

// --- The matte finesse group (MK6.2) ----------------------------------------------------------
//
// The TypeScript twin of `render/matte_edges.py`'s finesse chain, byte for byte. One clean-up
// chain shared by every kind whose alpha is a RASTER — `matte`, `key` and, when it ships,
// `layer` — in the order a matte artist works in:
//
//   denoise → clean black → clean white → morph open → morph close → shrink/grow → blur →
//   in/out ratio
//
// Denoising after the levels would re-introduce the haze they removed, and blurring before the
// morphology would smear the specks the morphology deletes; the order is what makes each
// control do what its name says.

/** `_clamped_index`: the index `offset` away, replicating at the edges. */
function clampedIndex(length: number, offset: number): Int32Array {
  const indices = new Int32Array(length);
  for (let i = 0; i < length; i += 1) indices[i] = Math.min(Math.max(i + offset, 0), length - 1);
  return indices;
}

/** `denoise`: blend toward the 3x3 box mean by `amount`; edges replicate. */
export function denoise(
  alpha: Float64Array,
  width: number,
  height: number,
  amount: number,
): Float64Array {
  if (amount <= 0) return alpha;
  const strength = Math.min(amount, 1);
  const rows = new Float64Array(width * height);
  const left = clampedIndex(width, -1);
  const right = clampedIndex(width, 1);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      rows[row + x] = alpha[row + left[x]!]! + alpha[row + x]! + alpha[row + right[x]!]!;
    }
  }
  const up = clampedIndex(height, -1);
  const down = clampedIndex(height, 1);
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const above = up[y]! * width;
    const below = down[y]! * width;
    for (let x = 0; x < width; x += 1) {
      const mean = (rows[above + x]! + rows[row + x]! + rows[below + x]!) / 9;
      const value = alpha[row + x]!;
      out[row + x] = value + (mean - value) * strength;
    }
  }
  return out;
}

/** `_morphology_at`: dilate (`grow`) or erode by a disc, mixing the two integer radii. */
function morphologyAt(
  alpha: Float64Array,
  width: number,
  height: number,
  radius: number,
  grow: boolean,
): Float64Array {
  const magnitude = Math.abs(radius);
  if (magnitude <= 0) return alpha;
  const low = Math.floor(magnitude);
  const high = Math.ceil(magnitude);
  const lowAlpha = discMorphology(alpha, width, height, low, grow);
  if (high === low) return lowAlpha;
  const highAlpha = discMorphology(alpha, width, height, high, grow);
  const fraction = magnitude - low;
  const out = new Float64Array(alpha.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = lowAlpha[i]! + (highAlpha[i]! - lowAlpha[i]!) * fraction;
  }
  return out;
}

/** `morph_open`: erode then dilate — deletes specks outside the subject. */
export function morphOpen(
  alpha: Float64Array,
  width: number,
  height: number,
  radius: number,
): Float64Array {
  if (radius <= 0) return alpha;
  return morphologyAt(
    morphologyAt(alpha, width, height, radius, false),
    width,
    height,
    radius,
    true,
  );
}

/** `morph_close`: dilate then erode — fills pinholes inside it. */
export function morphClose(
  alpha: Float64Array,
  width: number,
  height: number,
  radius: number,
): Float64Array {
  if (radius <= 0) return alpha;
  return morphologyAt(
    morphologyAt(alpha, width, height, radius, true),
    width,
    height,
    radius,
    false,
  );
}

/** `shrink_grow`: move the whole edge out (+) or in (−). */
export function shrinkGrow(
  alpha: Float64Array,
  width: number,
  height: number,
  pixels: number,
): Float64Array {
  if (pixels === 0) return alpha;
  return morphologyAt(alpha, width, height, Math.abs(pixels), pixels > 0);
}

/** `_box_pass`: one separable box blur of integer `radius`, summed in index order. */
function boxPass(alpha: Float64Array, width: number, height: number, radius: number): Float64Array {
  if (radius <= 0) return alpha;
  const horizontal = alpha.slice();
  for (let offset = 1; offset <= radius; offset += 1) {
    const left = clampedIndex(width, -offset);
    const right = clampedIndex(width, offset);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        horizontal[row + x] = horizontal[row + x]! + alpha[row + left[x]!]!;
      }
      for (let x = 0; x < width; x += 1) {
        horizontal[row + x] = horizontal[row + x]! + alpha[row + right[x]!]!;
      }
    }
  }
  const divisor = 2 * radius + 1;
  for (let i = 0; i < horizontal.length; i += 1) horizontal[i] = horizontal[i]! / divisor;
  const vertical = horizontal.slice();
  for (let offset = 1; offset <= radius; offset += 1) {
    const up = clampedIndex(height, -offset);
    const down = clampedIndex(height, offset);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      const above = up[y]! * width;
      for (let x = 0; x < width; x += 1) {
        vertical[row + x] = vertical[row + x]! + horizontal[above + x]!;
      }
    }
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      const below = down[y]! * width;
      for (let x = 0; x < width; x += 1) {
        vertical[row + x] = vertical[row + x]! + horizontal[below + x]!;
      }
    }
  }
  for (let i = 0; i < vertical.length; i += 1) vertical[i] = vertical[i]! / divisor;
  return vertical;
}

/** `blur`: three box passes of `round(radius / 3)`, the cheap gaussian both sides agree on. */
export function blurAlpha(
  alpha: Float64Array,
  width: number,
  height: number,
  radius: number,
): Float64Array {
  if (radius <= 0) return alpha;
  const box = Math.max(1, Math.round(radius / 3));
  return boxPass(
    boxPass(boxPass(alpha, width, height, box), width, height, box),
    width,
    height,
    box,
  );
}

/** `in_out_ratio`: move the 50% crossing out (+) or in (−), keeping 0 and 1 fixed. */
export function inOutRatio(alpha: Float64Array, ratio: number): Float64Array {
  if (ratio === 0) return alpha;
  const clamped = Math.min(1, Math.max(-1, ratio));
  const mid = 0.5 - clamped * 0.5;
  const out = new Float64Array(alpha.length);
  if (mid <= 0) {
    for (let i = 0; i < out.length; i += 1) out[i] = alpha[i]! > 0 ? 1 : 0;
    return out;
  }
  if (mid >= 1) {
    for (let i = 0; i < out.length; i += 1) out[i] = alpha[i]! >= 1 ? 1 : 0;
    return out;
  }
  for (let i = 0; i < out.length; i += 1) {
    const value = alpha[i]!;
    const mapped = value <= mid ? (value * 0.5) / mid : 0.5 + ((value - mid) * 0.5) / (1 - mid);
    out[i] = Math.min(1, Math.max(0, mapped));
  }
  return out;
}

/** The finesse controls of a `matte` or `key` mask, already read at the instant. */
export interface MaskFinesseValues {
  readonly denoise: number;
  readonly morphOpenPx: number;
  readonly morphClosePx: number;
  readonly shrinkGrowPx: number;
  readonly blurPx: number;
  readonly inOutRatio: number;
  readonly cleanBlack: number;
  readonly cleanWhite: number;
}

/**
 * `apply_finesse`: the whole group in order, on an alpha already in `[0, 1]`.
 *
 * The input is copied first. `applyCleanLevels` rewrites the array it is handed — which is safe
 * where it was written, because its caller owns a fresh one — and a chain that sometimes passes
 * its input straight through would otherwise edit the caller's alpha behind its back.
 */
export function applyFinesse(
  alpha: Float64Array,
  width: number,
  height: number,
  finesse: MaskFinesseValues,
  levels: readonly [number, number],
): Float64Array {
  let result = denoise(alpha.slice(), width, height, finesse.denoise);
  result = applyCleanLevels(result, levels[0], levels[1]);
  result = morphOpen(result, width, height, finesse.morphOpenPx);
  result = morphClose(result, width, height, finesse.morphClosePx);
  result = shrinkGrow(result, width, height, finesse.shrinkGrowPx);
  result = blurAlpha(result, width, height, finesse.blurPx);
  return inOutRatio(result, finesse.inOutRatio);
}

/** `finesse_is_identity`: whether the group changes nothing, so a caller can skip the chain. */
export function finesseIsIdentity(
  finesse: MaskFinesseValues,
  levels: readonly [number, number],
): boolean {
  return (
    finesse.denoise === 0 &&
    levels[0] === 0 &&
    levels[1] === 1 &&
    finesse.morphOpenPx === 0 &&
    finesse.morphClosePx === 0 &&
    finesse.shrinkGrowPx === 0 &&
    finesse.blurPx === 0 &&
    finesse.inOutRatio === 0
  );
}
