import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  pilAlphaComposite,
  pilBoxBlurLine,
  pilGaussianBoxRadius,
  pilCoefficients,
  pilResize,
  pilRotationMatrix,
  PIL_PRECISION_BITS,
} from './pil.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'pil-golden.json'), 'utf8')) as {
  resize: {
    width: number;
    height: number;
    outWidth: number;
    outHeight: number;
    channels: number;
    pixels: string;
    resized: string;
  }[];
  alphaComposite: { dst: string; src: string; out: string; count: number };
};
const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

describe('Pillow LANCZOS resize (golden, bit exact)', () => {
  for (const c of golden.resize) {
    it(`${c.channels === 3 ? 'RGB' : 'L'} ${c.width}x${c.height} -> ${c.outWidth}x${c.outHeight}`, () => {
      const out = pilResize(
        bytes(c.pixels),
        c.width,
        c.height,
        c.channels,
        c.outWidth,
        c.outHeight,
      );
      expect([...out]).toEqual([...bytes(c.resized)]);
    });
  }

  it('normalises every row of weights to one', () => {
    const coefficients = pilCoefficients(1920, 1280);
    for (let i = 0; i < coefficients.outSize; i++) {
      let sum = 0;
      for (let k = 0; k < coefficients.ksize; k++)
        sum += coefficients.weights[i * coefficients.ksize + k]!;
      expect(Math.abs(sum - (1 << PIL_PRECISION_BITS))).toBeLessThan(coefficients.ksize);
    }
  });
});

describe('Pillow alpha_composite (golden, bit exact)', () => {
  it('matches Image.alpha_composite pixel for pixel', () => {
    const { dst, src, out, count } = golden.alphaComposite;
    const d = bytes(dst);
    const s = bytes(src);
    const expected = bytes(out);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      expect(
        pilAlphaComposite(
          [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!],
          [s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!],
        ),
      ).toEqual([expected[o], expected[o + 1], expected[o + 2], expected[o + 3]]);
    }
  });
});

describe('Pillow rotate matrix', () => {
  it('is the identity (null) for whole turns and maps pixel centres through a half turn', () => {
    expect(pilRotationMatrix(360, 10, 6)).toBeNull();
    const m = pilRotationMatrix(180, 10, 6)!;
    const map = (x: number, y: number): [number, number] => [
      m[0] * x + m[1] * y + m[2],
      m[3] * x + m[4] * y + m[5],
    ];
    expect(map(0.5, 0.5)).toEqual([9.5, 5.5]);
  });
});

describe('Pillow GaussianBlur (extended box, golden)', () => {
  const blurGolden = JSON.parse(
    readFileSync(join(HERE, '__fixtures__', 'pil-gaussian-golden.json'), 'utf8'),
  ) as { input: string; width: number; blurred: Record<string, string> };
  it.each(Object.keys(blurGolden.blurred))('radius %s on one RGB row', (radiusText) => {
    const input = bytes(blurGolden.input);
    const width = blurGolden.width;
    const boxRadius = pilGaussianBoxRadius(Number(radiusText));
    const out = new Uint8Array(input.length);
    for (let c = 0; c < 3; c++) {
      let line: Uint8Array = Uint8Array.from({ length: width }, (_, x) => input[x * 3 + c]!);
      for (let pass = 0; pass < 3; pass++) line = pilBoxBlurLine(line, boxRadius);
      // The vertical passes over a single row: every tap clamps to that row.
      for (let pass = 0; pass < 3; pass++) {
        line = Uint8Array.from(line, (v) => pilBoxBlurLine(Uint8Array.of(v), boxRadius)[0]!);
      }
      line.forEach((v, x) => (out[x * 3 + c] = v));
    }
    expect([...out]).toEqual([...bytes(blurGolden.blurred[radiusText]!)]);
  });
});
