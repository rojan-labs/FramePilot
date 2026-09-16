/**
 * The export's YUV → RGB decode, reproduced (PX2.7 / PX2.1).
 *
 * WHY this exists: the export composites frames that MoviePy reads through an ffmpeg pipe
 * (`-vf scale=W:H -sws_flags bicubic -pix_fmt rgb24`), so every pixel it starts from went
 * through libswscale. Chromium's own `VideoFrame` → texture conversion is a different decoder:
 * PX0.3 measured BT.709 limited range 9/255 away on saturated colours, and the scaled swscale
 * path carries a constant ~2/255 bias of its own (its 8-bit lookup tables round towards black).
 * A preview that trusts Chromium therefore starts every frame a few levels off before any
 * compositing happens, which is below the parity gate on the simplest one-clip timeline
 * (PX4-BASELINE: 37.3 dB). Matching the export means doing what swscale does.
 *
 * Two paths, chosen exactly as swscale chooses them for `yuv420p → rgb24`:
 *
 * - **Scaled** (output size ≠ source size): separable bicubic (B=0, C=0.6) filters built by
 *   `initFilter`, horizontal to 15-bit then vertical inside the packed-RGB writer, chroma kept
 *   at half horizontal resolution (each pair of output pixels shares one chroma sample), and
 *   the 8-bit lookup tables of `ff_yuv2rgb_c_init_tables`. {@link swsFilter} and
 *   {@link swsRgbTables} are line-for-line ports of FFmpeg 6.1 (`libswscale/utils.c`,
 *   `yuv2rgb.c`, `output.c`), checked bit-exact against FFmpeg 6.1 output in `swscale.test.ts`.
 * - **Unscaled** (same size): the x86 SIMD converter (`yuv420_rgb24_ssse3`), whose 16-bit
 *   `pmulhw` arithmetic {@link swsUnscaledCoefficients} reproduces. Checked against the PX0.3 CI
 *   engine measurements (every BT.709 limited patch exact).
 *
 * The GPU executes the same integer arithmetic (`gl/yuv-shaders.ts`); the CPU functions here
 * are its reference and its test oracle.
 */

/** The `AVColorSpace` matrices a decoded `VideoFrame` can report, as swscale indexes them. */
export type SwsMatrix = 'bt709' | 'bt601' | 'smpte240m' | 'bt2020' | 'fcc';

/** `ff_yuv2rgb_coeffs`: `{crv, cbu, cgu, cgv}` in 16.16, full-scale output. */
const YUV2RGB_COEFFS: Readonly<Record<SwsMatrix, readonly [number, number, number, number]>> = {
  bt709: [117489, 138438, 13975, 34925],
  bt601: [104597, 132201, 25675, 53279],
  smpte240m: [117579, 136230, 16907, 35559],
  bt2020: [110013, 140363, 12277, 42626],
  fcc: [104448, 132798, 24759, 53109],
};

/** swscale's default bicubic parameters (`param[0]`, `param[1]` = SWS_PARAM_DEFAULT). */
const BICUBIC_B = 0n;
/** `(int64_t)(0.6 * (1 << 24))`: the double is truncated. */
const BICUBIC_C = 10066329n;
/** `SWS_MAX_REDUCE_CUTOFF`. */
const MAX_REDUCE_CUTOFF = 0.002;
/** Horizontal/vertical `filterAlign` on x86 with MMX (the CI and desktop-Intel export host). */
export const SWS_HORIZONTAL_FILTER_ALIGN = 4;
export const SWS_VERTICAL_FILTER_ALIGN = 2;
/** Default chroma/luma sample position, in 1/256 of a luma sample from the left edge. */
const CENTRED_POSITION = 128;

/** Fixed-point unit of a horizontal filter (15-bit output) and of a vertical one. */
export const SWS_HORIZONTAL_ONE = 1 << 14;
export const SWS_VERTICAL_ONE = 1 << 12;

/** One direction of a swscale filter: `size` taps per output sample starting at `positions`. */
export interface SwsFilter {
  readonly srcSize: number;
  readonly dstSize: number;
  readonly size: number;
  /** First source sample per output sample. */
  readonly positions: Int32Array;
  /** `dstSize × size` integer coefficients summing (about) to `one`. */
  readonly coefficients: Int32Array;
}

/** C's `/` on integers: truncation towards zero. */
function tdiv(a: bigint, b: bigint): bigint {
  return a / b;
}

/** `av_log2` (0 for 0). */
function avLog2(value: number): number {
  return value > 0 ? 31 - Math.clz32(value) : 0;
}

/** `(((int64_t)src << 16) + (dst >> 1)) / dst`: the step between output samples in source units. */
export function swsIncrement(srcSize: number, dstSize: number): number {
  return Math.floor((srcSize * 65536 + (dstSize >> 1)) / dstSize);
}

/** `ROUNDED_DIV`. */
function roundedDiv(a: bigint, b: bigint): bigint {
  return a >= 0n ? tdiv(a + (b >> 1n), b) : tdiv(a - (b >> 1n), b);
}

const filterCache = new Map<string, SwsFilter>();

/**
 * `initFilter` for `SWS_BICUBIC`, centred positions, no src/dst vectors.
 *
 * @param srcSize - Source samples along this axis.
 * @param dstSize - Output samples along this axis.
 * @param one - {@link SWS_HORIZONTAL_ONE} or {@link SWS_VERTICAL_ONE}.
 * @param filterAlign - {@link SWS_HORIZONTAL_FILTER_ALIGN} or {@link SWS_VERTICAL_FILTER_ALIGN}.
 * @returns The integer filter swscale builds (memoised: sizes repeat every frame).
 */
export function swsFilter(
  srcSize: number,
  dstSize: number,
  one: number,
  filterAlign: number,
): SwsFilter {
  const key = `${srcSize}:${dstSize}:${one}:${filterAlign}`;
  const cached = filterCache.get(key);
  if (cached) return cached;
  const built = buildSwsFilter(srcSize, dstSize, one, filterAlign);
  filterCache.set(key, built);
  return built;
}

function buildSwsFilter(
  srcSize: number,
  dstSize: number,
  oneNumber: number,
  filterAlignIn: number,
): SwsFilter {
  if (srcSize < 1 || dstSize < 1) {
    throw new RangeError(`swsFilter needs positive sizes, got ${srcSize} -> ${dstSize}.`);
  }
  const xInc = swsIncrement(srcSize, dstSize);
  const fone = 1n << BigInt(54 - Math.min(avLog2(Math.floor(srcSize / dstSize)), 8));
  const one = BigInt(oneNumber);
  const srcPos = BigInt(CENTRED_POSITION);
  const dstPos = BigInt(CENTRED_POSITION);

  let filterSize: number;
  let filter: bigint[][];
  const positions: number[] = [];

  if (Math.abs(xInc - 0x10000) < 10) {
    filterSize = 1;
    filter = [];
    for (let i = 0; i < dstSize; i++) {
      filter.push([fone]);
      positions.push(i);
    }
  } else {
    const sizeFactor = 4;
    filterSize =
      xInc <= 1 << 16
        ? 1 + sizeFactor
        : 1 + Math.trunc((sizeFactor * srcSize + dstSize - 1) / dstSize);
    filterSize = Math.max(Math.min(filterSize, srcSize - 2), 1);
    const inc = BigInt(xInc);
    let xDstInSrc = ((dstPos * inc) >> 7n) - ((srcPos * 0x10000n) >> 7n);
    const divisor = (1n << 54n) / fone;
    filter = [];
    for (let i = 0; i < dstSize; i++) {
      let xx = tdiv(xDstInSrc - BigInt(filterSize - 2) * (1n << 16n), 1n << 17n);
      positions.push(Number(xx));
      const row: bigint[] = [];
      for (let j = 0; j < filterSize; j++) {
        let distance = xx * (1n << 17n) - xDstInSrc;
        if (distance < 0n) distance = -distance;
        let d = distance << 13n;
        if (xInc > 1 << 16) d = tdiv(d * BigInt(dstSize), BigInt(srcSize));
        let coeff: bigint;
        if (d >= 1n << 31n) {
          coeff = 0n;
        } else {
          const dd = (d * d) >> 30n;
          const ddd = (dd * d) >> 30n;
          if (d < 1n << 30n) {
            coeff =
              (12n * (1n << 24n) - 9n * BICUBIC_B - 6n * BICUBIC_C) * ddd +
              (-18n * (1n << 24n) + 12n * BICUBIC_B + 6n * BICUBIC_C) * dd +
              (6n * (1n << 24n) - 2n * BICUBIC_B) * (1n << 30n);
          } else {
            coeff =
              (-BICUBIC_B - 6n * BICUBIC_C) * ddd +
              (6n * BICUBIC_B + 30n * BICUBIC_C) * dd +
              (-12n * BICUBIC_B - 48n * BICUBIC_C) * d +
              (8n * BICUBIC_B + 24n * BICUBIC_C) * (1n << 30n);
          }
          coeff = tdiv(coeff, divisor);
        }
        row.push(coeff);
        xx++;
      }
      filter.push(row);
      xDstInSrc += 2n * inc;
    }
  }

  // Step 1: drop near-zero taps (shift left) and measure the trailing ones.
  const cutoff = MAX_REDUCE_CUTOFF * Number(fone);
  let minFilterSize = 0;
  for (let i = dstSize - 1; i >= 0; i--) {
    const row = filter[i]!;
    let min = filterSize;
    let cut = 0n;
    for (let j = 0; j < filterSize; j++) {
      const first = row[0]!;
      cut += first < 0n ? -first : first;
      if (Number(cut) > cutoff) break;
      if (i < dstSize - 1 && positions[i]! >= positions[i + 1]!) break;
      row.shift();
      row.push(0n);
      positions[i]!++;
    }
    cut = 0n;
    for (let j = filterSize - 1; j > 0; j--) {
      const tap = row[j]!;
      cut += tap < 0n ? -tap : tap;
      if (Number(cut) > cutoff) break;
      min--;
    }
    if (min > minFilterSize) minFilterSize = min;
  }
  let filterAlign = filterAlignIn;
  // x86 MMX: "special case for unscaled vertical filtering".
  if (minFilterSize === 1 && filterAlign === 2) filterAlign = 1;
  const outSize = (minFilterSize + (filterAlign - 1)) & ~(filterAlign - 1);

  // Step 2: resize rows, then fix borders.
  const rows: bigint[][] = filter.map((row) =>
    Array.from({ length: outSize }, (_, j) => (j < filterSize ? row[j]! : 0n)),
  );
  for (let i = 0; i < dstSize; i++) {
    const row = rows[i]!;
    if (positions[i]! < 0) {
      for (let j = 1; j < outSize; j++) {
        const left = Math.max(j + positions[i]!, 0);
        row[left] = row[left]! + row[j]!;
        row[j] = 0n;
      }
      positions[i] = 0;
    }
    if (positions[i]! + outSize > srcSize) {
      const shift = positions[i]! + Math.min(outSize - srcSize, 0);
      let acc = 0n;
      for (let j = outSize - 1; j >= 0; j--) {
        if (positions[i]! + j >= srcSize) {
          acc += row[j]!;
          row[j] = 0n;
        }
      }
      for (let j = outSize - 1; j >= 0; j--) {
        row[j] = j < shift ? 0n : row[j - shift]!;
      }
      positions[i]! -= shift;
      const last = srcSize - 1 - positions[i]!;
      row[last] = row[last]! + acc;
    }
  }

  // Normalise with error diffusion into `one`.
  const coefficients = new Int32Array(dstSize * outSize);
  for (let i = 0; i < dstSize; i++) {
    const row = rows[i]!;
    let sum = 0n;
    for (const tap of row) sum += tap;
    sum = tdiv(sum + one / 2n, one);
    if (sum === 0n) sum = 1n;
    let error = 0n;
    for (let j = 0; j < outSize; j++) {
      const value = row[j]! + error;
      const intValue = roundedDiv(value, sum);
      coefficients[i * outSize + j] = Number(intValue);
      error = value - intValue * sum;
    }
  }
  return {
    srcSize,
    dstSize,
    size: outSize,
    positions: Int32Array.from(positions),
    coefficients,
  };
}

/** The integer parameters of swscale's scaled-path lookup tables (`ff_yuv2rgb_c_init_tables`). */
export interface SwsRgbTables {
  /** Index offsets into `y_table` per chroma value: `base + ((c * coeff) >> 16)`. */
  readonly crv: number;
  readonly cbu: number;
  readonly cgu: number;
  readonly cgv: number;
  readonly yOffset: number;
  /** `y_table[i] = clip8((yb + i * cy + 0x8000) >> 16)`. */
  readonly cy: number;
  readonly yb: number;
}

/**
 * Integer parameters of the scaled path's RGB lookup tables.
 *
 * @param matrix - The source's colour matrix (unspecified sources are BT.601 in swscale).
 * @param fullRange - `true` for JPEG/full range, `false` for limited (MPEG) range.
 */
export function swsRgbTables(matrix: SwsMatrix, fullRange: boolean): SwsRgbTables {
  const [c0, c1, c2, c3] = YUV2RGB_COEFFS[matrix];
  let crv = BigInt(c0);
  let cbu = BigInt(c1);
  let cgu = -BigInt(c2);
  let cgv = -BigInt(c3);
  let cy = 1n << 16n;
  let oy = 0n;
  if (!fullRange) {
    cy = tdiv(cy * 255n, 219n);
    oy = 16n << 16n;
  } else {
    crv = tdiv(crv * 224n, 255n);
    cbu = tdiv(cbu * 224n, 255n);
    cgu = tdiv(cgu * 224n, 255n);
    cgv = tdiv(cgv * 224n, 255n);
  }
  // contrast = saturation = 1 << 16, brightness = 0: the multiplications are identities.
  const byCy = (value: bigint): bigint => tdiv(value * (1n << 16n) + 0x8000n, cy);
  crv = byCy(crv);
  cbu = byCy(cbu);
  cgu = byCy(cgu);
  cgv = byCy(cgv);
  return {
    crv: Number(crv),
    cbu: Number(cbu),
    cgu: Number(cgu),
    cgv: Number(cgv),
    yOffset: (fullRange ? 384 : 326) + 512,
    cy: Number(cy),
    yb: Number(-(384n << 16n) - 512n * cy - oy),
  };
}

/** `y_table[index]`. */
function yTable(tables: SwsRgbTables, index: number): number {
  const value = Math.floor((tables.yb + index * tables.cy + 0x8000) / 65536);
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

const clip8 = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value);

/**
 * One scaled-path pixel: 8-bit Y, U, V (after the vertical filter) to RGB via the tables.
 * Mirrors `yuv2rgb_X_c_template` + `yuv2rgb_write` for RGB24.
 */
export function swsTableToRgb(
  tables: SwsRgbTables,
  y: number,
  uIn: number,
  vIn: number,
): [number, number, number] {
  const u = clip8(uIn);
  const v = clip8(vIn);
  const shr16 = (value: number): number => Math.floor(value / 65536);
  const shr9 = (value: number): number => Math.floor(value / 512);
  const r = tables.yOffset - shr9(tables.crv) + shr16(v * tables.crv) + y;
  const b = tables.yOffset - shr9(tables.cbu) + shr16(u * tables.cbu) + y;
  const g =
    tables.yOffset -
    shr9(tables.cgu) +
    shr16(u * tables.cgu) -
    shr9(tables.cgv) +
    shr16(v * tables.cgv) +
    y;
  return [yTable(tables, r), yTable(tables, g), yTable(tables, b)];
}

/** Planar 8-bit 4:2:0 frame (`I420`): luma `width × height`, chroma halved (rounded up). */
export interface I420Frame {
  readonly width: number;
  readonly height: number;
  readonly y: Uint8Array;
  readonly u: Uint8Array;
  readonly v: Uint8Array;
}

/** `hScale8To15_c`. */
function horizontalTo15(
  plane: Uint8Array,
  width: number,
  height: number,
  filter: SwsFilter,
): Int32Array {
  const out = new Int32Array(filter.dstSize * height);
  for (let row = 0; row < height; row++) {
    const base = row * width;
    for (let i = 0; i < filter.dstSize; i++) {
      let value = 0;
      const start = filter.positions[i]!;
      for (let j = 0; j < filter.size; j++) {
        value += plane[base + start + j]! * filter.coefficients[i * filter.size + j]!;
      }
      out[row * filter.dstSize + i] = Math.min(value >> 7, 32767);
    }
  }
  return out;
}

/**
 * CPU reference of the scaled path (`scale=W:H:flags=bicubic`, `yuv420p → rgb24`).
 *
 * @returns Packed RGB, `dstWidth × dstHeight × 3`.
 */
export function swsScaleToRgb24(
  frame: I420Frame,
  dstWidth: number,
  dstHeight: number,
  matrix: SwsMatrix,
  fullRange: boolean,
): Uint8Array {
  const chromaWidth = (frame.width + 1) >> 1;
  const chromaHeight = (frame.height + 1) >> 1;
  const chromaDstWidth = (dstWidth + 1) >> 1;
  const lumaH = swsFilter(frame.width, dstWidth, SWS_HORIZONTAL_ONE, SWS_HORIZONTAL_FILTER_ALIGN);
  const chromaH = swsFilter(
    chromaWidth,
    chromaDstWidth,
    SWS_HORIZONTAL_ONE,
    SWS_HORIZONTAL_FILTER_ALIGN,
  );
  const lumaV = swsFilter(frame.height, dstHeight, SWS_VERTICAL_ONE, SWS_VERTICAL_FILTER_ALIGN);
  const chromaV = swsFilter(chromaHeight, dstHeight, SWS_VERTICAL_ONE, SWS_VERTICAL_FILTER_ALIGN);
  const yLines = horizontalTo15(frame.y, frame.width, frame.height, lumaH);
  const uLines = horizontalTo15(frame.u, chromaWidth, chromaHeight, chromaH);
  const vLines = horizontalTo15(frame.v, chromaWidth, chromaHeight, chromaH);
  const tables = swsRgbTables(matrix, fullRange);
  const out = new Uint8Array(dstWidth * dstHeight * 3);
  for (let row = 0; row < dstHeight; row++) {
    for (let x = 0; x < dstWidth; x++) {
      let y = 1 << 18;
      for (let j = 0; j < lumaV.size; j++) {
        y +=
          yLines[(lumaV.positions[row]! + j) * dstWidth + x]! *
          lumaV.coefficients[row * lumaV.size + j]!;
      }
      const cx = x >> 1;
      let u = 1 << 18;
      let v = 1 << 18;
      for (let j = 0; j < chromaV.size; j++) {
        const line = (chromaV.positions[row]! + j) * chromaDstWidth + cx;
        const coefficient = chromaV.coefficients[row * chromaV.size + j]!;
        u += uLines[line]! * coefficient;
        v += vLines[line]! * coefficient;
      }
      const [r, g, b] = swsTableToRgb(tables, y >> 19, u >> 19, v >> 19);
      const o = (row * dstWidth + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/** The 16-bit coefficients the x86 unscaled converter multiplies with (`pmulhw`). */
export interface SwsUnscaledCoefficients {
  readonly yCoeff: number;
  readonly yOffset: number;
  readonly vrCoeff: number;
  readonly ubCoeff: number;
  readonly ugCoeff: number;
  readonly vgCoeff: number;
}

/** `roundToInt16`. */
function roundToInt16(value: bigint): number {
  const r = Number((value + (1n << 15n)) >> 16n);
  if (r < -0x7fff) return -0x8000;
  if (r > 0x7fff) return 0x7fff;
  return r;
}

/** The coefficients `ff_yuv2rgb_c_init_tables` stores for the SIMD converters. */
export function swsUnscaledCoefficients(
  matrix: SwsMatrix,
  fullRange: boolean,
): SwsUnscaledCoefficients {
  const [c0, c1, c2, c3] = YUV2RGB_COEFFS[matrix];
  let crv = BigInt(c0);
  let cbu = BigInt(c1);
  let cgu = -BigInt(c2);
  let cgv = -BigInt(c3);
  let cy = 1n << 16n;
  let oy = 0n;
  if (!fullRange) {
    cy = tdiv(cy * 255n, 219n);
    oy = 16n << 16n;
  } else {
    crv = tdiv(crv * 224n, 255n);
    cbu = tdiv(cbu * 224n, 255n);
    cgu = tdiv(cgu * 224n, 255n);
    cgv = tdiv(cgv * 224n, 255n);
  }
  return {
    yCoeff: roundToInt16(cy * (1n << 13n)),
    yOffset: roundToInt16(oy * (1n << 3n)),
    vrCoeff: roundToInt16(crv * (1n << 13n)),
    ubCoeff: roundToInt16(cbu * (1n << 13n)),
    ugCoeff: roundToInt16(cgu * (1n << 13n)),
    vgCoeff: roundToInt16(cgv * (1n << 13n)),
  };
}

/** `pmulhw`: the high 16 bits of a signed 16 × 16 product. */
const pmulhw = (a: number, b: number): number => Math.floor((a * b) / 65536);

/** One unscaled-path pixel (x86 `yuv420_rgb24`). */
export function swsUnscaledToRgb(
  c: SwsUnscaledCoefficients,
  y: number,
  u: number,
  v: number,
): [number, number, number] {
  const luma = pmulhw(Math.max(0, y * 8 - c.yOffset), c.yCoeff);
  const cu = u * 8 - 1024;
  const cv = v * 8 - 1024;
  return [
    clip8(luma + pmulhw(cv, c.vrCoeff)),
    clip8(luma + pmulhw(cu, c.ugCoeff) + pmulhw(cv, c.vgCoeff)),
    clip8(luma + pmulhw(cu, c.ubCoeff)),
  ];
}

/** CPU reference of the unscaled path: nearest (2 × 2 block) chroma, SIMD arithmetic. */
export function swsUnscaledToRgb24(
  frame: I420Frame,
  matrix: SwsMatrix,
  fullRange: boolean,
): Uint8Array {
  const coefficients = swsUnscaledCoefficients(matrix, fullRange);
  const chromaWidth = (frame.width + 1) >> 1;
  const out = new Uint8Array(frame.width * frame.height * 3);
  for (let row = 0; row < frame.height; row++) {
    for (let x = 0; x < frame.width; x++) {
      const chroma = (row >> 1) * chromaWidth + (x >> 1);
      const [r, g, b] = swsUnscaledToRgb(
        coefficients,
        frame.y[row * frame.width + x]!,
        frame.u[chroma]!,
        frame.v[chroma]!,
      );
      const o = (row * frame.width + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/**
 * The swscale matrix for a WebCodecs colour space, as ffmpeg's `scale` filter resolves
 * `in_color_matrix=auto` from the stream's tag (untagged → BT.601 coefficients).
 */
export function swsMatrixOf(matrix: string | null | undefined): SwsMatrix {
  switch (matrix) {
    case 'bt709':
      return 'bt709';
    case 'smpte240m':
      return 'smpte240m';
    case 'bt2020-ncl':
      return 'bt2020';
    default:
      return 'bt601';
  }
}
