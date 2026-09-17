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
export function discMorphology(
  values: MatteSamples,
  width: number,
  height: number,
  radius: number,
  grow: boolean,
): MatteSamples {
  if (radius <= 0) return values;
  const pick = grow ? Math.max : Math.min;
  const byWidth = new Map<number, number[]>();
  for (let dy = -radius; dy <= radius; dy += 1) {
    const half = isqrt(radius * radius - dy * dy);
    const list = byWidth.get(half) ?? [];
    list.push(dy);
    byWidth.set(half, list);
  }
  const result = values.slice();
  let window: MatteSamples = values;
  for (let half = 0; half <= radius; half += 1) {
    if (half > 0) {
      const next = new (values.constructor as { new (length: number): MatteSamples })(
        width * height,
      );
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

/** One decoded matte frame at the artifact's source (display) resolution. */
export interface MatteFrameData {
  /** Identity for caches: artifact key and matte frame index. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** 255 for `gray`, 65535 for `gray16le`. */
  readonly maximum: number;
  readonly alpha: MatteSamples;
  /** Interleaved RGB, when the mask decontaminates. */
  readonly foreground: Uint8Array | null;
}

/**
 * The matte's alpha on the clip's frame before invert/opacity (`matte_alpha` up to `to_frame`).
 *
 * @param shiftPx - `edgeShiftPx` at the instant.
 * @param feather - The base expansion/feathers at the instant (feathers clamped at 0).
 */
export function matteFrameAlpha(
  frame: MatteFrameData,
  levels: readonly [number, number],
  shiftPx: number,
  feather: MatteFeather,
  crop: CropFractions | null | undefined,
  width: number,
  height: number,
  decodedWidth: number,
  decodedHeight: number,
): Float64Array {
  let alpha = edgeShift(frame.alpha, frame.width, frame.height, frame.maximum, shiftPx);
  alpha = applyCleanLevels(alpha, levels[0], levels[1]);
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
  const pixels = frame.width * frame.height;
  const band = new Float64Array(pixels);
  const premultiplied = new Float64Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const value = frame.alpha[i]!;
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
