/**
 * MK5.2: the preview evaluates an effect layer's frame-space mask stack to the same float64
 * bytes the export mixes the adjustment by (`tests/fixtures/mask-raster/frame-layers.json`,
 * written by `pnpm mask-raster:vectors`), and refuses what the export refuses.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EffectLayerSchema, type EffectLayer } from '@framepilot/timeline-schema';

import { FrameMaskRasterCache, effectLayerMaskStack, frameStackAlphaAt } from './frame-masks';

const REPO = path.resolve(__dirname, '../../../../..');

interface LayerCase {
  id: string;
  layer: unknown;
  expected: { width: number; height: number; localTime: number; alpha: string }[];
}

const document = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'frame-layers.json'), 'utf8'),
) as { cases: LayerCase[] };

const digest = (alpha: Float64Array): string =>
  createHash('sha256')
    .update(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.byteLength))
    .digest('hex');

const parse = (raw: unknown): EffectLayer => EffectLayerSchema.parse(raw);

/** A frame-space rectangle mask, with `over` applied on top. */
const rectangle = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm1',
  kind: 'rectangle',
  space: 'frame',
  cx: 100,
  cy: 60,
  width: 80,
  height: 40,
  ...over,
});

const layerWith = (masks: readonly Record<string, unknown>[]): EffectLayer =>
  parse({
    id: 'fx',
    effectId: 'soft-veil',
    kind: 'blur-gaussian',
    start: 0,
    end: 2,
    params: {},
    keyframes: [],
    masks,
  });

describe('frame-space mask vectors (float64-exact vs the export)', () => {
  it('reproduces every effect layer at every size and instant', () => {
    let checked = 0;
    for (const vectorCase of document.cases) {
      const stack = effectLayerMaskStack(parse(vectorCase.layer));
      expect(stack?.refusal ?? null, vectorCase.id).toBeNull();
      for (const expected of vectorCase.expected) {
        const alpha = frameStackAlphaAt(
          stack!,
          expected.width,
          expected.height,
          expected.localTime,
        );
        expect(alpha, `${vectorCase.id} @ ${String(expected.localTime)}`).not.toBeNull();
        expect(digest(alpha!), `${vectorCase.id} @ ${String(expected.localTime)}`).toBe(
          expected.alpha,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('frame-space mask refusals', () => {
  it('has no stack when the layer is unmasked or every mask is off', () => {
    expect(effectLayerMaskStack(layerWith([]))).toBeNull();
    expect(effectLayerMaskStack(layerWith([rectangle({ enabled: false })]))).toBeNull();
  });

  it('refuses the kinds whose renderer has not shipped, and names the task', () => {
    const key = effectLayerMaskStack(
      layerWith([{ id: 'm1', kind: 'key', space: 'frame', model: 'hsl' }]),
    );
    expect(key?.refusal?.task).toBe('MK6');
    const gradient = effectLayerMaskStack(
      layerWith([
        {
          id: 'm1',
          kind: 'gradient',
          space: 'frame',
          shape: 'linear',
          startX: 0,
          startY: 0,
          endX: 10,
          endY: 10,
        },
      ]),
    );
    // MK8.1: the analytic kinds draw on an adjustment lane like any shape.
    expect(gradient?.refusal ?? null).toBeNull();
    const matte = effectLayerMaskStack(
      layerWith([
        { id: 'm1', kind: 'layer', space: 'frame', source: { kind: 'track', trackId: 'v' } },
      ]),
    );
    expect(matte?.refusal?.message).toContain('adjustment lane cannot');
  });

  it('refuses a matte, a source-space mask and an effect target on an adjustment lane', () => {
    const sourceSpace = effectLayerMaskStack(layerWith([rectangle({ space: 'source' })]));
    expect(sourceSpace?.refusal?.message).toContain('Redraw it on the lane.');
    const targeted = effectLayerMaskStack(
      layerWith([rectangle({ target: { kind: 'effect', effectId: 'grade' } })]),
    );
    expect(targeted?.refusal?.message).toContain('Retarget it');
  });

  it('refuses the legacy blur feather with the remedy', () => {
    const legacy = effectLayerMaskStack(
      layerWith([rectangle({ featherModel: 'gaussian-legacy' })]),
    );
    expect(legacy?.refusal?.message).toContain('Distance');
  });
});

describe('frame-space raster cache', () => {
  it('returns the stack as 8-bit coverage and reuses a static raster', () => {
    const stack = effectLayerMaskStack(layerWith([rectangle()]))!;
    const cache = new FrameMaskRasterCache();
    const first = cache.raster(stack, 200, 120, 0);
    expect(first).not.toBeNull();
    expect(first!.width).toBe(200);
    expect(first!.scale).toBe(1);
    // Inside the rectangle is opaque, a corner is clear.
    expect(first!.alpha8[60 * 200 + 100]).toBe(255);
    expect(first!.alpha8[0]).toBe(0);
    // A static stack at another instant is the same object, not a redraw.
    expect(cache.raster(stack, 200, 120, 1.25)).toBe(first);
    expect(cache.raster(stack, 100, 60, 0)).not.toBe(first);
  });

  it('draws nothing for a refused stack', () => {
    const refused = effectLayerMaskStack(layerWith([rectangle({ space: 'source' })]))!;
    expect(new FrameMaskRasterCache().raster(refused, 64, 64, 0)).toBeNull();
  });
});

describe('adjustment-lane masks on a monitor frame smaller than the project', () => {
  const PROJECT = { width: 1080, height: 1920 };
  const CANVAS = { width: 720, height: 1280 };
  // Project pixels over the upper right, turned and feathered.
  const stack = effectLayerMaskStack(
    layerWith([
      rectangle({ cx: 810, cy: 480, width: 360, height: 480, rotation: 10, featherOuterPx: 12 }),
    ]),
  )!;

  /** Where `alpha` is over one half, as `[x0, x1, y0, y1]` fractions of a `width`-wide frame. */
  const coveredBox = (
    alpha: Float64Array | null,
    width: number,
    height: number,
  ): [number, number, number, number] | null => {
    if (alpha === null) return null;
    let [x0, x1, y0, y1] = [width, -1, height, -1];
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (alpha[row * width + col]! <= 0.5) continue;
        x0 = Math.min(x0, col);
        x1 = Math.max(x1, col);
        y0 = Math.min(y0, row);
        y1 = Math.max(y1, row);
      }
    }
    return x1 < 0 ? null : [x0 / width, (x1 + 1) / width, y0 / height, (y1 + 1) / height];
  };

  it('draws the project-size mask scaled: the same relative region at the canvas size', () => {
    expect(stack.refusal).toBeNull();
    const full = coveredBox(
      frameStackAlphaAt(stack, PROJECT.width, PROJECT.height, 0),
      PROJECT.width,
      PROJECT.height,
    );
    const reduced = coveredBox(
      frameStackAlphaAt(stack, CANVAS.width, CANVAS.height, 0, PROJECT),
      CANVAS.width,
      CANVAS.height,
    );
    expect(full).not.toBeNull();
    expect(reduced).not.toBeNull();
    reduced!.forEach((edge, index) => {
      expect(Math.abs(edge - full![index]!)).toBeLessThanOrEqual(1 / CANVAS.width + 1e-9);
    });
    // Drawn as canvas pixels (the old monitor), the region lands 1.5x too far right and down.
    const unconverted = coveredBox(
      frameStackAlphaAt(stack, CANVAS.width, CANVAS.height, 0),
      CANVAS.width,
      CANVAS.height,
    );
    expect(unconverted?.[0]).toBeGreaterThan(full![0] + 0.2);
  });

  it('is float64-identical to before when the monitor frame is the project frame', () => {
    const converted = frameStackAlphaAt(stack, PROJECT.width, PROJECT.height, 0, PROJECT)!;
    expect(digest(converted)).toBe(
      digest(frameStackAlphaAt(stack, PROJECT.width, PROJECT.height, 0)!),
    );
  });

  it('keys the cached raster by the geometry frame', () => {
    const cache = new FrameMaskRasterCache();
    const converted = cache.raster(stack, CANVAS.width, CANVAS.height, 0, PROJECT);
    expect(converted).not.toBeNull();
    expect(cache.raster(stack, CANVAS.width, CANVAS.height, 0, PROJECT)).toBe(converted);
    expect(cache.raster(stack, CANVAS.width, CANVAS.height, 0)).not.toBe(converted);
  });
});
