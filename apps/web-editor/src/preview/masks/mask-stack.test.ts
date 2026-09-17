/**
 * MK3.2: the preview evaluates a clip's mask stack to the same float64 bytes the export attaches
 * (`tests/fixtures/mask-raster/stack-clips.json`, written by `pnpm mask-raster:vectors`), and
 * refuses what the export refuses with a visible reason.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClipSchema, type Clip } from '@framepilot/timeline-schema';

import { setPillowFloatContraction } from './legacy-mask';
import {
  MaskStackRasterCache,
  clipMaskStack,
  pythonReprLength,
  stackAlphaAt,
  type MaskStackTarget,
} from './mask-stack';

const REPO = path.resolve(__dirname, '../../../../..');

interface ClipCase {
  id: string;
  clip: unknown;
  media: { width: number; height: number } | null;
  effects?: string[];
  expected: ({ width: number; height: number; time: number; alpha: string | null } & Record<
    string,
    unknown
  >)[];
}

const document = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'stack-clips.json'), 'utf8'),
) as { cases: ClipCase[] };

const digest = (alpha: Float64Array | null): string | null =>
  alpha === null
    ? null
    : createHash('sha256')
        .update(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.byteLength))
        .digest('hex');

const parseClip = (raw: unknown): Clip => ClipSchema.parse(raw);

afterEach(() => setPillowFloatContraction(false));

describe('mask stack vectors (float64-exact vs the export)', () => {
  it.each([false, true])(
    'reproduces every clip at every size and time (contract=%s)',
    (contract) => {
      setPillowFloatContraction(contract);
      const mismatches: string[] = [];
      let checked = 0;
      for (const vectorCase of document.cases) {
        const clip = parseClip(vectorCase.clip);
        const stack = clipMaskStack(clip, vectorCase.media);
        expect(stack?.refusal ?? null, vectorCase.id).toBeNull();
        for (const expected of vectorCase.expected) {
          const targets: [string, MaskStackTarget][] = [
            ['alpha', { kind: 'alpha' }],
            ...(vectorCase.effects ?? []).map((effectId): [string, MaskStackTarget] => [
              `effect:${effectId}`,
              { kind: 'effect', effectId },
            ]),
          ];
          for (const [field, target] of targets) {
            const actual = digest(
              stackAlphaAt(stack!, target, expected.width, expected.height, expected.time),
            );
            if (actual !== expected[field]) {
              mismatches.push(
                `${vectorCase.id} ${field} @${expected.width}x${expected.height} t=${expected.time}`,
              );
            }
            checked += 1;
          }
        }
      }
      expect(mismatches.join('\n')).toBe('');
      expect(checked).toBeGreaterThanOrEqual(100);
    },
  );

  it('caches a static stack and hands the compositor its exact bytes', () => {
    const vectorCase = document.cases.find((c) => c.id === 'stack/mode-subtract')!;
    const stack = clipMaskStack(parseClip(vectorCase.clip), vectorCase.media)!;
    const cache = new MaskStackRasterCache();
    const first = cache.raster(stack, { kind: 'alpha' }, 406, 720, 0);
    expect(cache.raster(stack, { kind: 'alpha' }, 406, 720, 1.5)).toBe(first);
    const float = stackAlphaAt(stack, { kind: 'alpha' }, 406, 720, 0)!;
    expect(first?.scale).toBe(1);
    expect(Array.from(first!.alpha8.slice(0, 4000))).toEqual(
      Array.from(float.slice(0, 4000), (a) => Math.round(a * 255)),
    );
  });

  it('keeps a lone legacy mask as Pillow bytes times its opacity', () => {
    const vectorCase = document.cases.find(
      (c) => c.id === 'migrated/feathered-inverted-rectangle',
    )!;
    const stack = clipMaskStack(parseClip(vectorCase.clip), vectorCase.media)!;
    const raster = new MaskStackRasterCache().raster(stack, { kind: 'alpha' }, 320, 240, 0)!;
    const float = stackAlphaAt(stack, { kind: 'alpha' }, 320, 240, 0)!;
    expect(raster.scale).toBe(0.7);
    for (let i = 0; i < float.length; i += 997) {
      expect(Math.abs((raster.alpha8[i]! / 255) * raster.scale - float[i]!)).toBeLessThan(1e-12);
    }
  });
});

describe('mask stack refusals', () => {
  const base = {
    id: 'c',
    assetId: 'a',
    trackId: 'v',
    start: 0,
    end: 2,
    sourceStart: 0,
    sourceEnd: 2,
    effects: [],
    keyframes: [],
  };
  const media = { width: 1920, height: 1080 };
  const refusalOf = (mask: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    clipMaskStack(parseClip({ ...base, ...extra, masks: [mask] }), media)?.refusal ?? null;

  it.each([
    [{ id: 'k', kind: 'key', model: 'hsl' }, 'MK6'],
    [{ id: 'l', kind: 'linear', originX: 0, originY: 0, angle: 0, softnessPx: 0 }, 'MK8'],
    [{ id: 'r', kind: 'rectangle', cx: 10, cy: 10, width: 5, height: 5, space: 'frame' }, 'MK9'],
  ])('names the task that ships %j', (mask, task) => {
    let refused;
    try {
      refused = refusalOf(mask);
    } catch {
      // A kind whose schema needs more fields than this test supplies is covered by its own suite.
      return;
    }
    expect(refused?.task).toBe(task);
    expect(refused?.message).toMatch(/^Mask not previewed yet/);
  });

  it('refuses a pixel mask on unmeasured media and a missing effect target', () => {
    const rect = { id: 'r', kind: 'rectangle', cx: 10, cy: 10, width: 5, height: 5 };
    expect(
      clipMaskStack(parseClip({ ...base, masks: [rect] }), undefined)?.refusal?.message,
    ).toMatch(/Measure this media first/);
    expect(refusalOf({ ...rect, target: { kind: 'effect', effectId: 'gone' } })?.message).toMatch(
      /Retarget/,
    );
  });

  it('draws nothing for a disabled stack', () => {
    expect(
      clipMaskStack(
        parseClip({
          ...base,
          masks: [
            { id: 'r', kind: 'rectangle', enabled: false, cx: 1, cy: 1, width: 1, height: 1 },
          ],
        }),
        media,
      ),
    ).toBeNull();
  });
});

describe('pythonReprLength', () => {
  it.each([
    [0.2, '0.2'],
    [0.19999999999999998, '0.19999999999999998'],
    [1.0, '1.0'],
    [1234.5, '1234.5'],
    [1e-5, '1e-05'],
    [0.0001, '0.0001'],
    [1.5e16, '1.5e+16'],
    [-3.25, '-3.25'],
    [1e22, '1e+22'],
  ])('measures %s like repr', (value, repr) => {
    expect(pythonReprLength(value)).toBe(repr.length);
  });
});
