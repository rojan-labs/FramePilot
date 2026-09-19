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
  legacySpec,
  pythonReprLength,
  stackAlphaAt,
  stackReadsPicture,
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

interface FrameClipCase {
  id: string;
  clip: unknown;
  media: { width: number; height: number } | null;
  frame: [number, number];
  placement: [number, number, number, number, number];
  expected: { width: number; height: number; time: number; alpha: string | null }[];
}

const frameClips = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'frame-clips.json'), 'utf8'),
) as { cases: FrameClipCase[] };

describe('frame-space clip masks (MK9.1, float64-exact vs the export)', () => {
  it('reproduces every placement, size and time of frame-clips.json', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const vectorCase of frameClips.cases) {
      const stack = clipMaskStack(parseClip(vectorCase.clip), vectorCase.media)!;
      expect(stack.refusal, vectorCase.id).toBeNull();
      const [resizedW, resizedH, rotation, x, y] = vectorCase.placement;
      for (const expected of vectorCase.expected) {
        const placement = {
          placement: {
            localWidth: expected.width,
            localHeight: expected.height,
            width: resizedW,
            height: resizedH,
            rotation,
            x,
            y,
          },
          frameWidth: vectorCase.frame[0],
          frameHeight: vectorCase.frame[1],
        };
        const actual = digest(
          stackAlphaAt(
            stack,
            { kind: 'alpha' },
            expected.width,
            expected.height,
            expected.time,
            null,
            placement,
          ),
        );
        if (actual !== expected.alpha) {
          mismatches.push(
            `${vectorCase.id} @${expected.width}x${expected.height} t=${expected.time}`,
          );
        }
        checked += 1;
      }
    }
    expect(mismatches.join('\n')).toBe('');
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('keys the cached raster by where the picture lands, and skips it with no placement', () => {
    const vectorCase = frameClips.cases.find((c) => c.id === 'frame-clip/rect-fills-frame')!;
    const stack = clipMaskStack(parseClip(vectorCase.clip), vectorCase.media)!;
    const cache = new MaskStackRasterCache();
    const at = (x: number) => ({
      placement: { localWidth: 64, localHeight: 36, width: 64, height: 36, rotation: 0, x, y: 0 },
      frameWidth: 64,
      frameHeight: 36,
    });
    const first = cache.raster(stack, { kind: 'alpha' }, 64, 36, 0, null, at(0));
    expect(cache.raster(stack, { kind: 'alpha' }, 64, 36, 0.5, null, at(0))).toBe(first);
    expect(cache.raster(stack, { kind: 'alpha' }, 64, 36, 0, null, at(8))).not.toBe(first);
    expect(cache.raster(stack, { kind: 'alpha' }, 64, 36, 0)).toBeNull();
  });
});

describe('legacy spec (MK2.5)', () => {
  const migrated = document.cases.find(
    (entry) => entry.id === 'migrated/keyframed-ellipse-mid-timeline',
  )!;
  // E2E.5's frame 144 at 30 fps: 0.7999999999999998 s into a clip that starts at 4 s, where v21
  // drew x = 0.19999999999999996 — the same stored centre as x = 0.2, a pixel apart at 320 wide.
  const t = 144 / 30 - 4;
  const size = { width: 320, height: 240 };

  it('draws the stored v21 fraction the centre alone cannot tell apart', () => {
    const clip = parseClip(migrated.clip);
    const mask = clip.masks![0] as Parameters<typeof legacySpec>[0];
    const s = clip.sourceStart + t;
    expect(legacySpec(mask, clip, size, s).x).toBe(0.19999999999999996);
    const { legacySpec: _stored, ...withoutSpec } = mask;
    expect(legacySpec(withoutSpec as typeof mask, clip, size, s).x).toBe(0.2);
  });

  it('falls back to recovery once the geometry no longer matches the stored spec', () => {
    const raw = JSON.parse(JSON.stringify(migrated.clip)) as {
      masks: { cx?: number; keyframes: { property: string; value: number }[] }[];
    };
    for (const keyframe of raw.masks[0]!.keyframes) {
      if (keyframe.property === 'cx') keyframe.value += 10;
    }
    const clip = parseClip(raw);
    const mask = clip.masks![0] as Parameters<typeof legacySpec>[0];
    const x = legacySpec(mask, clip, size, clip.sourceStart + t).x;
    expect(x).not.toBe(0.19999999999999996);
    expect(x).toBeCloseTo(0.2 + 10 / 320, 12);
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
    [{ id: 'k', kind: 'key', model: 'hsl', space: 'frame' }, /only shapes, splits, bands/],
    [
      {
        id: 'r',
        kind: 'rectangle',
        cx: 10,
        cy: 10,
        width: 5,
        height: 5,
        space: 'frame',
        tracking: {
          artifact: { key: '0'.repeat(64), sha256: '0'.repeat(64) },
          method: 'position',
          referenceSourceTime: 0,
        },
      },
      /a track follows the picture/,
    ],
  ])('refuses a frame-space mask that follows the picture (MK9.1) %j', (mask, message) => {
    const refused = refusalOf(mask);
    expect(refused?.task ?? null).toBeNull();
    expect(refused?.message).toMatch(message);
  });

  it('draws a frame-space shape without a measured media size', () => {
    const stack = clipMaskStack(
      parseClip({
        ...base,
        masks: [
          { id: 'r', kind: 'rectangle', cx: 10, cy: 10, width: 5, height: 5, space: 'frame' },
        ],
      }),
      null,
    );
    expect(stack?.refusal ?? null).toBeNull();
  });

  it('draws split, band and gradient masks (MK8.1), and refuses a gradient with edge controls', () => {
    const drawn = [
      { id: 'l', kind: 'linear', originX: 960, originY: 540, angle: 30, softnessPx: 4 },
      {
        id: 'b',
        kind: 'band',
        originX: 960,
        originY: 540,
        angle: 0,
        widthPx: 200,
        mode: 'subtract',
      },
      {
        id: 'g',
        kind: 'gradient',
        shape: 'radial',
        startX: 960,
        startY: 540,
        endX: 1400,
        endY: 540,
        mode: 'intersect',
      },
    ];
    const stack = clipMaskStack(parseClip({ ...base, masks: drawn }), media);
    expect(stack?.refusal ?? null).toBeNull();
    const alpha = stackAlphaAt(stack!, { kind: 'alpha' }, 48, 27, 0);
    expect(alpha).not.toBeNull();
    expect(alpha!.some((value) => value > 0 && value < 1)).toBe(true);
    const feathered = refusalOf({
      id: 'g',
      kind: 'gradient',
      shape: 'linear',
      startX: 0,
      startY: 0,
      endX: 10,
      endY: 0,
      featherOuterPx: 4,
    });
    expect(feathered?.task).toBeNull();
    expect(feathered?.message).toMatch(/no edge to grow or soften/);
  });

  it('does not refuse a track matte; the compositor builds it from its source (MK8.2)', () => {
    const stack = clipMaskStack(
      parseClip({
        ...base,
        masks: [{ id: 'y', kind: 'layer', source: { kind: 'clip', clipId: 'x' }, channel: 'luma' }],
      }),
      media,
    );
    expect(stack?.refusal ?? null).toBeNull();
    expect(new MaskStackRasterCache().raster(stack!, { kind: 'alpha' }, 16, 16, 0)).toBeNull();
    expect(
      refusalOf({ id: 'y', kind: 'layer', source: { kind: 'clip', clipId: 'x' }, expansionPx: 2 })
        ?.message,
    ).toMatch(/takes its edge from its source/);
  });

  it('does not refuse a key — the compositor qualifies it from the picture (MK6.1)', () => {
    const stack = clipMaskStack(
      parseClip({ ...base, masks: [{ id: 'k', kind: 'key', model: 'hsl' }] }),
      media,
    );
    expect(stack?.refusal ?? null).toBeNull();
    expect(stackReadsPicture(stack?.alpha ?? [])).toBe(true);
    // The CPU cache draws nothing for it: the stack is built by the GPU passes instead.
    expect(new MaskStackRasterCache().raster(stack!, { kind: 'alpha' }, 16, 16, 0)).toBeNull();
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
