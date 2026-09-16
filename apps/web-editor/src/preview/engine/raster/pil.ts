/**
 * The export's Pillow arithmetic, reproduced (PX2.1).
 *
 * MoviePy resizes a placed layer with `Image.resize(size, LANCZOS)` (`vfx.Resize`) and
 * composites layers with `Image.paste` / `Image.alpha_composite` (`VideoClip.compose_on`). A
 * preview that resamples with the browser's bilinear `drawImage` and blends in floating point
 * lands a few levels away at every edge and every translucent pixel, which is exactly where the
 * parity oracle looks. These are ports of Pillow's `libImaging/Resample.c` (8 bpc path) and
 * `AlphaComposite.c`, checked bit-exact against Pillow in `pil.test.ts`; the GPU runs the same
 * integer arithmetic from the coefficient tables built here.
 */

/** Pillow's `PRECISION_BITS` for 8-bit resampling. */
export const PIL_PRECISION_BITS = 22;

export type PilFilter = 'lanczos' | 'bicubic' | 'bilinear';

const SUPPORT: Readonly<Record<PilFilter, number>> = { lanczos: 3, bicubic: 2, bilinear: 1 };

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = x * Math.PI;
  return Math.sin(px) / px;
}

function filterAt(filter: PilFilter, xIn: number): number {
  if (filter === 'lanczos') return -3 <= xIn && xIn < 3 ? sinc(xIn) * sinc(xIn / 3) : 0;
  const x = Math.abs(xIn);
  if (filter === 'bilinear') return x < 1 ? 1 - x : 0;
  const a = -0.5;
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

/** One axis of a Pillow resample: per output sample, the first source sample and tap count. */
export interface PilCoefficients {
  readonly inSize: number;
  readonly outSize: number;
  /** Maximum taps per output sample. */
  readonly ksize: number;
  /** `outSize × 2`: `[xmin, count]`. */
  readonly bounds: Int32Array;
  /** `outSize × ksize` fixed-point weights (`PIL_PRECISION_BITS`). */
  readonly weights: Int32Array;
}

const coefficientCache = new Map<string, PilCoefficients>();

/**
 * `precompute_coeffs` + `normalize_coeffs_8bpc` for the default box `(0, inSize)`.
 *
 * @param inSize - Source samples along the axis.
 * @param outSize - Output samples along the axis.
 * @param filter - Pillow resampling filter; MoviePy uses `lanczos`.
 */
export function pilCoefficients(
  inSize: number,
  outSize: number,
  filter: PilFilter = 'lanczos',
): PilCoefficients {
  const key = `${inSize}:${outSize}:${filter}`;
  const cached = coefficientCache.get(key);
  if (cached) return cached;
  if (inSize < 1 || outSize < 1) {
    throw new RangeError(`pilCoefficients needs positive sizes, got ${inSize} -> ${outSize}.`);
  }
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = SUPPORT[filter] * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const weights = new Int32Array(outSize * ksize);
  const inverse = 1 / filterscale;
  const scratch = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let total = 0;
    for (let x = 0; x < xmax; x++) {
      const w = filterAt(filter, (x + xmin - center + 0.5) * inverse);
      scratch[x] = w;
      total += w;
    }
    for (let x = 0; x < ksize; x++) {
      let w = x < xmax ? scratch[x]! : 0;
      if (x < xmax && total !== 0) w /= total;
      weights[xx * ksize + x] =
        w < 0
          ? Math.trunc(-0.5 + w * (1 << PIL_PRECISION_BITS))
          : Math.trunc(0.5 + w * (1 << PIL_PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  const built = { inSize, outSize, ksize, bounds, weights };
  coefficientCache.set(key, built);
  return built;
}

/** `clip8(ss)`: `ss >> PRECISION_BITS`, clamped. */
function clip8(sum: number): number {
  const value = Math.floor(sum / (1 << PIL_PRECISION_BITS));
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function resampleAxis(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  coefficients: PilCoefficients,
  horizontal: boolean,
): Uint8Array {
  const outWidth = horizontal ? coefficients.outSize : width;
  const outHeight = horizontal ? height : coefficients.outSize;
  const out = new Uint8Array(outWidth * outHeight * channels);
  const half = 1 << (PIL_PRECISION_BITS - 1);
  for (let yy = 0; yy < outHeight; yy++) {
    for (let xx = 0; xx < outWidth; xx++) {
      const index = horizontal ? xx : yy;
      const min = coefficients.bounds[index * 2]!;
      const count = coefficients.bounds[index * 2 + 1]!;
      for (let c = 0; c < channels; c++) {
        let sum = half;
        for (let k = 0; k < count; k++) {
          const sx = horizontal ? min + k : xx;
          const sy = horizontal ? yy : min + k;
          sum +=
            pixels[(sy * width + sx) * channels + c]! *
            coefficients.weights[index * coefficients.ksize + k]!;
        }
        out[(yy * outWidth + xx) * channels + c] = clip8(sum);
      }
    }
  }
  return out;
}

/**
 * CPU reference of `Image.resize((outWidth, outHeight), filter)` for `L` and `RGB` images:
 * horizontal pass first when the width changes, then vertical, each clipped to 8 bits.
 */
export function pilResize(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  outWidth: number,
  outHeight: number,
  filter: PilFilter = 'lanczos',
): Uint8Array {
  let current = pixels;
  let currentWidth = width;
  if (outWidth !== width) {
    current = resampleAxis(
      current,
      width,
      height,
      channels,
      pilCoefficients(width, outWidth, filter),
      true,
    );
    currentWidth = outWidth;
  }
  if (outHeight !== height) {
    current = resampleAxis(
      current,
      currentWidth,
      height,
      channels,
      pilCoefficients(height, outHeight, filter),
      false,
    );
  }
  return current === pixels ? pixels.slice() : current;
}

/** `SHIFTFORDIV255`. */
const shiftForDiv255 = (a: number): number => ((a >>> 8) + a) >>> 8;

/**
 * `ImagingAlphaComposite` for one RGBA pixel (`Image.alpha_composite(dst, src)`).
 *
 * @returns The composited `[r, g, b, a]`.
 */
export function pilAlphaComposite(
  dst: readonly [number, number, number, number],
  src: readonly [number, number, number, number],
): [number, number, number, number] {
  const srcA = src[3];
  if (srcA === 0) return [dst[0], dst[1], dst[2], dst[3]];
  const blend = dst[3] * (255 - srcA);
  const outA255 = srcA * 255 + blend;
  const coef1 = Math.floor((srcA * 255 * 255 * 128) / outA255);
  const coef2 = 255 * 128 - coef1;
  const channel = (s: number, d: number): number =>
    shiftForDiv255(s * coef1 + d * coef2 + (0x80 << 7)) >>> 7;
  return [
    channel(src[0], dst[0]),
    channel(src[1], dst[1]),
    channel(src[2], dst[2]),
    shiftForDiv255(outA255 + 0x80),
  ];
}

/** Python's `round(x, 15)` for the matrix entries Pillow rounds. */
const round15 = (value: number): number => Number(value.toFixed(15));

/**
 * The inverse affine matrix `Image.rotate(degrees, expand=False)` samples with, or `null` when
 * Pillow returns the image unchanged (a multiple of 360°).
 *
 * MoviePy's `Rotate` reduces the angle modulo 360 first. Right angles on a non-square image and
 * 180° take Pillow's transpose shortcut, which the affine map with `round(cos, 15)` reproduces
 * exactly at pixel centres.
 */
export function pilRotationMatrix(
  degrees: number,
  width: number,
  height: number,
): [number, number, number, number, number, number] | null {
  const angleDegrees = ((degrees % 360) + 360) % 360;
  if (angleDegrees === 0) return null;
  const angle = -(angleDegrees * Math.PI) / 180;
  const m = [
    round15(Math.cos(angle)),
    round15(Math.sin(angle)),
    0,
    round15(-Math.sin(angle)),
    round15(Math.cos(angle)),
    0,
  ];
  const cx = width / 2;
  const cy = height / 2;
  const [a, b, , d, e] = m as [number, number, number, number, number, number];
  m[2] = a * -cx + b * -cy + 0 + cx;
  m[5] = d * -cx + e * -cy + 0 + cy;
  return m as [number, number, number, number, number, number];
}
