/**
 * The monitor's edge style rule (MK9.2): the bounded separable distance is exact, the shadow
 * offset rounds like `np.rint`, and the CPU composite leaves the picture's own pixels alone.
 * Byte parity with the engine is pinned by `edge-styles.json` (MK9.3).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FramePlanEdgeStyle } from '@framepilot/editor-core';
import {
  applyEdgeStylesCpu,
  edgeDistanceField,
  edgeReach,
  edgeShift,
  roundHalfEven,
} from './edge-styles';

function bruteForce(inside: Uint8Array, width: number, height: number, reach: number) {
  const out = new Float64Array(width * height).fill(Infinity);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = Infinity;
      for (let v = 0; v < height; v += 1) {
        for (let u = 0; u < width; u += 1) {
          if (inside[v * width + u] === 1) best = Math.min(best, (u - x) ** 2 + (v - y) ** 2);
        }
      }
      if (best <= reach * reach) out[y * width + x] = Math.sqrt(best);
    }
  }
  return out;
}

describe('edge styles on the monitor', () => {
  it('finds the exact distance within the reach', () => {
    const width = 19;
    const height = 13;
    let seed = 11;
    const inside = new Uint8Array(width * height).map(() => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 > 0.92 ? 1 : 0;
    });
    for (const reach of [1, 3, 30]) {
      expect(Array.from(edgeDistanceField(inside, width, height, reach))).toEqual(
        Array.from(bruteForce(inside, width, height, reach)),
      );
    }
  });

  it('rounds a shadow offset half to even and bounds the search by the style', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5].map(roundHalfEven)).toEqual([0, 2, 2, 0, -2]);
    const shadow = {
      kind: 'shadow' as const,
      params: { offsetXPx: 5, offsetYPx: -3, softnessPx: 4, red: 0, green: 0, blue: 0, opacity: 1 },
    };
    expect(edgeShift(shadow, 0.5)).toEqual([2, -2]);
    expect(edgeReach(shadow, 0.5)).toBe(3);
  });

  it('draws an outline outside the cut-out and keeps the subject', () => {
    const size = 20;
    const stack = new Float64Array(size * size);
    for (let y = 8; y < 12; y += 1) for (let x = 8; x < 12; x += 1) stack[y * size + x] = 1;
    const rgb = new Uint8Array(size * size * 3);
    for (let i = 0; i < size * size; i += 1) rgb[i * 3] = 200;
    const out = applyEdgeStylesCpu(
      rgb,
      stack,
      stack,
      size,
      size,
      [
        {
          kind: 'stroke',
          params: { widthPx: 2, red: 0, green: 0, blue: 255, opacity: 1 },
        },
      ],
      1,
      1,
    );
    const at = (x: number, y: number) => y * size + x;
    expect(Array.from(out.rgb.slice(at(9, 9) * 3, at(9, 9) * 3 + 3))).toEqual([200, 0, 0]);
    expect(Array.from(out.rgb.slice(at(12, 9) * 3, at(12, 9) * 3 + 3))).toEqual([0, 0, 255]);
    expect(out.alpha[at(12, 9)]).toBe(1);
    expect(out.alpha[at(16, 9)]).toBe(0);
  });
});

interface EdgeVectors {
  size: { width: number; height: number };
  picture: string;
  stack: string;
  cases: {
    id: string;
    scale: number;
    opacity: number;
    styles: FramePlanEdgeStyle[];
    expected: { rgb: string; alpha: string };
  }[];
}

const vectors = JSON.parse(
  readFileSync(
    path.join(
      path.resolve(__dirname, '../../../../..'),
      'tests/fixtures/mask-raster/edge-styles.json',
    ),
    'utf8',
  ),
) as EdgeVectors;

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('edge style vectors (MK9.3, byte-exact vs the export)', () => {
  it.each(vectors.cases.map((c) => [c.id, c] as const))('%s', (_id, vectorCase) => {
    const { width, height } = vectors.size;
    const picture = new Uint8Array(Buffer.from(vectors.picture, 'base64'));
    const levels = new Uint8Array(Buffer.from(vectors.stack, 'base64'));
    const stack = Float64Array.from(levels, (level) => level / 255.0);
    const alpha = Float64Array.from(stack, (value) => value * 0.9);
    const out = applyEdgeStylesCpu(
      picture,
      alpha,
      stack,
      width,
      height,
      vectorCase.styles,
      vectorCase.scale,
      vectorCase.opacity,
    );
    expect(sha(out.rgb)).toBe(vectorCase.expected.rgb);
    expect(sha(new Uint8Array(out.alpha.buffer))).toBe(vectorCase.expected.alpha);
  });
});
