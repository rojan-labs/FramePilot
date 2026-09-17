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
    expect(gradient?.refusal?.task).toBe('MK8');
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
