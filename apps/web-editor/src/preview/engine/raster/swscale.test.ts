import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  swsFilter,
  swsMatrixOf,
  swsScaleToRgb24,
  swsUnscaledCoefficients,
  swsUnscaledTablesToRgb24,
  swsUnscaledToRgb,
  swsUnscaledToRgb24,
  SWS_HORIZONTAL_FILTER_ALIGN,
  SWS_HORIZONTAL_ONE,
  type SwsMatrix,
} from './swscale.js';

interface GoldenCase {
  srcWidth: number;
  srcHeight: number;
  dstWidth: number;
  dstHeight: number;
  matrix: 'bt709' | 'bt601';
  range: 'tv' | 'pc';
  y: string;
  u: string;
  v: string;
  rgb: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(HERE, '__fixtures__', 'swscale-golden.json'), 'utf8'),
) as { cases: GoldenCase[] };
const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

describe('swscale scaled path (FFmpeg 6.1 golden, bit exact)', () => {
  for (const c of golden.cases) {
    it(`${c.srcWidth}x${c.srcHeight} -> ${c.dstWidth}x${c.dstHeight} ${c.matrix} ${c.range}`, () => {
      const rgb = swsScaleToRgb24(
        {
          width: c.srcWidth,
          height: c.srcHeight,
          y: bytes(c.y),
          u: bytes(c.u),
          v: bytes(c.v),
        },
        c.dstWidth,
        c.dstHeight,
        c.matrix,
        c.range === 'pc',
      );
      const expected = bytes(c.rgb);
      let mismatches = 0;
      for (let i = 0; i < expected.length; i++) if (rgb[i] !== expected[i]) mismatches++;
      expect(mismatches).toBe(0);
    });
  }

  it('builds normalised filters whose taps stay inside the source', () => {
    const filter = swsFilter(1920, 1280, SWS_HORIZONTAL_ONE, SWS_HORIZONTAL_FILTER_ALIGN);
    expect(filter.size % SWS_HORIZONTAL_FILTER_ALIGN).toBe(0);
    for (let i = 0; i < filter.dstSize; i++) {
      let sum = 0;
      for (let j = 0; j < filter.size; j++) sum += filter.coefficients[i * filter.size + j]!;
      expect(Math.abs(sum - SWS_HORIZONTAL_ONE)).toBeLessThanOrEqual(1);
      expect(filter.positions[i]).toBeGreaterThanOrEqual(0);
      expect(filter.positions[i]! + filter.size).toBeLessThanOrEqual(1920);
    }
  });
});

describe('swscale unscaled path (x86 SIMD arithmetic)', () => {
  // PX0.3, CI run 35140382484: BT.709 limited 4:2:0 patches (Y, U, V as FFmpeg 6.1 encodes the
  // authored RGB) and the RGB the export's frame_grab decoded for them.
  const BT709_LIMITED: readonly [[number, number, number], [number, number, number]][] = [
    [
      [180, 128, 128],
      [190, 190, 190],
    ],
    [
      [168, 44, 136],
      [190, 188, 0],
    ],
    [
      [145, 147, 44],
      [0, 189, 190],
    ],
    [
      [133, 63, 52],
      [0, 189, 0],
    ],
    [
      [63, 193, 204],
      [190, 0, 191],
    ],
    [
      [51, 109, 212],
      [190, 0, 0],
    ],
    [
      [28, 212, 120],
      [0, 0, 190],
    ],
    [
      [63, 102, 240],
      [254, 0, 0],
    ],
    [
      [126, 128, 128],
      [128, 128, 128],
    ],
    [
      [171, 109, 152],
      [223, 171, 139],
    ],
    [
      [30, 128, 128],
      [16, 16, 16],
    ],
    [
      [218, 128, 128],
      [235, 235, 235],
    ],
  ];
  it('reproduces the export engine on every BT.709 limited PX0.3 patch', () => {
    const coefficients = swsUnscaledCoefficients('bt709', false);
    for (const [[y, u, v], rgb] of BT709_LIMITED) {
      expect(swsUnscaledToRgb(coefficients, y, u, v)).toEqual(rgb);
    }
  });

  it('keeps full-range black and white exact', () => {
    for (const matrix of ['bt709', 'bt601'] as SwsMatrix[]) {
      const coefficients = swsUnscaledCoefficients(matrix, true);
      expect(swsUnscaledToRgb(coefficients, 0, 128, 128)).toEqual([0, 0, 0]);
      expect(swsUnscaledToRgb(coefficients, 255, 128, 128)).toEqual([255, 255, 255]);
    }
  });

  it('maps WebCodecs matrix names to swscale coefficients (untagged is BT.601)', () => {
    expect(swsMatrixOf('bt709')).toBe('bt709');
    expect(swsMatrixOf('smpte170m')).toBe('bt601');
    expect(swsMatrixOf('bt470bg')).toBe('bt601');
    expect(swsMatrixOf(null)).toBe('bt601');
  });
});

describe('swscale unscaled path (C converter of the macOS arm64 export host, MK6.4)', () => {
  interface UnscaledGolden {
    width: number;
    height: number;
    matrix: SwsMatrix;
    range: 'tv' | 'pc';
    y: string;
    u: string;
    v: string;
    rgb: string;
  }
  const arm64 = JSON.parse(
    readFileSync(join(HERE, '__fixtures__', 'swscale-unscaled-arm64-golden.json'), 'utf8'),
  ) as { cases: UnscaledGolden[] };

  for (const c of arm64.cases) {
    it(`${c.width}x${c.height} ${c.matrix} ${c.range} is bit exact`, () => {
      const rgb = swsUnscaledTablesToRgb24(
        { width: c.width, height: c.height, y: bytes(c.y), u: bytes(c.u), v: bytes(c.v) },
        c.matrix,
        c.range === 'pc',
      );
      const expected = bytes(c.rgb);
      let mismatches = 0;
      for (let i = 0; i < expected.length; i++) if (rgb[i] !== expected[i]) mismatches++;
      expect(mismatches).toBe(0);
    });
  }

  it('differs from the SIMD arithmetic, so the host has to be known', () => {
    const c = arm64.cases[0]!;
    const frame = { width: c.width, height: c.height, y: bytes(c.y), u: bytes(c.u), v: bytes(c.v) };
    const tables = swsUnscaledTablesToRgb24(frame, c.matrix, c.range === 'pc');
    const simd = swsUnscaledToRgb24(frame, c.matrix, c.range === 'pc');
    let differing = 0;
    for (let i = 0; i < tables.length; i++) if (tables[i] !== simd[i]) differing++;
    expect(differing).toBeGreaterThan(0);
  });
});
