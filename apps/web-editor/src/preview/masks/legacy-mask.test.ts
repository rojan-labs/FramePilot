/**
 * The `gaussian-legacy` port reproduces Pillow byte for byte
 * (`tests/fixtures/mask-raster/legacy.json`, written by `pnpm mask-raster:vectors`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { legacyMaskPixels, type LegacyMaskSpec } from './legacy-mask';

const REPO = path.resolve(__dirname, '../../../../..');

interface LegacyDocument {
  cases: {
    id: string;
    spec: Partial<LegacyMaskSpec> & { points?: [number, number][] };
    expected: { width: number; height: number; pixels: string }[];
  }[];
}

const document = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'legacy.json'), 'utf8'),
) as LegacyDocument;

function specOf(raw: LegacyDocument['cases'][number]['spec']): LegacyMaskSpec {
  return {
    shape: raw.shape ?? 'rectangle',
    x: raw.x ?? 0,
    y: raw.y ?? 0,
    width: raw.width ?? 1,
    height: raw.height ?? 1,
    feather: raw.feather ?? 0,
    opacity: 1,
    invert: false,
    points: raw.points ?? [],
  };
}

describe('legacy mask (Pillow draw + GaussianBlur)', () => {
  // The stored cases avoid exact `.5` edge crossings, so Pillow draws them identically with and
  // without floating-point contraction; both modes must reproduce every byte.
  it.each([false, true])(
    'reproduces every stored case at every resolution (contract=%s)',
    (contract) => {
      const mismatches: string[] = [];
      let checked = 0;
      for (const vectorCase of document.cases) {
        for (const expected of vectorCase.expected) {
          const actual = legacyMaskPixels(
            specOf(vectorCase.spec),
            expected.width,
            expected.height,
            {
              contract,
            },
          );
          const stored = Buffer.from(expected.pixels, 'base64');
          let differing = 0;
          for (let i = 0; i < stored.length; i += 1) if (stored[i] !== actual[i]) differing += 1;
          if (differing > 0 || stored.length !== actual.length) {
            mismatches.push(
              `${vectorCase.id} @${expected.width}x${expected.height}: ${differing} px`,
            );
          }
          checked += 1;
        }
      }
      expect(mismatches).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(18 * 4);
    },
  );

  it('follows the host Pillow at an exact half-pixel edge crossing', () => {
    // Edge (38, 67) -> (-19, 9) meets row 38 at x = 38 - 29 * fround(57 / 58): 9.5 in two
    // rounded float steps (Linux, Windows) and 9.499999 fused (macOS arm64), so column 9 is
    // filled only where Pillow was built with contraction.
    const spec = specOf({
      shape: 'polygon',
      points: [
        [-0.3, 0.2],
        [1.2, 0.35],
        [0.6, 1.4],
      ],
    });
    const at = (contract: boolean): number =>
      legacyMaskPixels(spec, 64, 48, { contract })[38 * 64 + 9]!;
    expect(at(false)).toBe(0);
    expect(at(true)).toBe(255);
  });
});
