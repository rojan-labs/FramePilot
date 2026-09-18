/**
 * MK6.1/MK6.3: the preview's key qualifier reproduces the export's alpha on colour charts in
 * BT.601 and BT.709, full and limited range (`tests/fixtures/mask-key/charts.json`, written by
 * `engine/python/tests/key_mask_vectors.py`).
 *
 * This is the CPU half of the gate — the twin the eyedropper uses, measured in float64. The
 * shader the monitor actually runs is measured on a real GPU by the `mask-key-parity` Playwright
 * spec; this file is the cheap gate that catches a formula drifting, and the reference that spec
 * compares against when a GPU is unavailable.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyMaskSchema } from '@framepilot/timeline-schema';

import {
  MASK_BOX_FRAGMENT,
  MASK_DENOISE_FRAGMENT,
  MASK_DESPILL_FRAGMENT,
  MASK_KEY_FRAGMENT,
  MASK_LEVELS_FRAGMENT,
  MASK_MIX_ALPHA_FRAGMENT,
  MASK_MORPH_FRAGMENT,
  MAX_KEY_MORPH_PX,
  MAX_KEY_RANGES,
  MAX_KEY_SAMPLES,
  despillingKeys,
  keyAlphaAt,
  keyExceedsPass,
  keyMorphExceedsPass,
  keyUniforms,
  type KeyMask,
} from './key-mask';

const REPO = path.resolve(__dirname, '../../../../..');

interface Charts {
  charts: { matrix: string; range: string; colours: [number, number, number][] }[];
  cases: {
    mask: unknown;
    expected: { matrix: string; range: string; alpha8: number[] }[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-key', 'charts.json'), 'utf8'),
) as Charts;

/** The byte the stack quantises this alpha to (`quantize_alpha`, round-half-even). */
function quantize(alpha: number): number {
  const scaled = Math.min(1, Math.max(0, alpha)) * 255;
  const low = Math.floor(scaled);
  const fraction = scaled - low;
  if (fraction > 0.5) return low + 1;
  if (fraction < 0.5) return low;
  return low % 2 === 0 ? low : low + 1;
}

const parse = (raw: unknown): KeyMask => KeyMaskSchema.parse(raw) as KeyMask;

describe('key qualifier vs the export, on colour charts', () => {
  it('matches the engine byte for byte in every encoding', () => {
    const chartByKey = new Map(
      vectors.charts.map((chart) => [`${chart.matrix}/${chart.range}`, chart.colours]),
    );
    const worst: { where: string; delta: number } = { where: 'none', delta: 0 };
    let checked = 0;
    for (const vectorCase of vectors.cases) {
      const mask = parse(vectorCase.mask);
      const uniforms = keyUniforms(mask, mask.opacity);
      for (const expected of vectorCase.expected) {
        const colours = chartByKey.get(`${expected.matrix}/${expected.range}`)!;
        colours.forEach((colour, index) => {
          const alpha = keyAlphaAt(uniforms, colour[0] / 255, colour[1] / 255, colour[2] / 255);
          const delta = Math.abs(quantize(alpha) - expected.alpha8[index]!);
          if (delta > worst.delta) {
            worst.delta = delta;
            worst.where = `${mask.id} ${expected.matrix}/${expected.range} patch ${String(index)}`;
          }
          checked += 1;
        });
      }
    }
    // The CPU twin runs the same float64 arithmetic, so the gate here is exact, not 1/255.
    expect(`${worst.where} delta ${String(worst.delta)}`).toBe('none delta 0');
    expect(checked).toBe(vectors.cases.length * 4 * vectors.charts[0]!.colours.length);
  });

  it('covers both matrices and both ranges', () => {
    expect(vectors.charts.map((chart) => `${chart.matrix}/${chart.range}`).sort()).toEqual([
      'bt601/full',
      'bt601/limited',
      'bt709/full',
      'bt709/limited',
    ]);
  });
});

describe('the finesse shaders', () => {
  it('are structurally closed and bound to the pass limit', () => {
    for (const source of [
      MASK_DENOISE_FRAGMENT,
      MASK_MORPH_FRAGMENT,
      MASK_MIX_ALPHA_FRAGMENT,
      MASK_BOX_FRAGMENT,
      MASK_LEVELS_FRAGMENT,
    ]) {
      expect(source.startsWith('#version 300 es')).toBe(true);
      expect(source.split('{').length).toBe(source.split('}').length);
    }
    expect(MASK_MORPH_FRAGMENT).toContain(String(MAX_KEY_MORPH_PX));
  });

  it('flags a morphology radius no single pass can carry', () => {
    const base = {
      id: 'k',
      kind: 'key',
      model: 'hsl',
      ranges: [{ channel: 'hue', low: 0.2, high: 0.4 }],
    };
    expect(keyMorphExceedsPass(parse({ ...base, finesse: { blurPx: 40 } }))).toBe(false);
    expect(keyMorphExceedsPass(parse({ ...base, finesse: { morphOpenPx: 20 } }))).toBe(true);
    expect(keyMorphExceedsPass(parse({ ...base, finesse: { shrinkGrowPx: -20 } }))).toBe(true);
    expect(keyMorphExceedsPass(parse({ ...base, finesse: { morphClosePx: 16 } }))).toBe(false);
  });
});

describe('the shader and the twin stay in step', () => {
  it('declares every uniform the packer fills', () => {
    for (const name of [
      'u_sampled',
      'u_rangeCount',
      'u_ranges',
      'u_sampleCount',
      'u_samples',
      'u_tolerance',
      'u_shadow',
      'u_picture',
    ]) {
      expect(MASK_KEY_FRAGMENT).toContain(`uniform`);
      expect(MASK_KEY_FRAGMENT.includes(`${name};`) || MASK_KEY_FRAGMENT.includes(`${name}[`)).toBe(
        true,
      );
    }
  });

  it('sizes its arrays to the packer, and is structurally closed', () => {
    expect(MASK_KEY_FRAGMENT).toContain(`u_ranges[${String(MAX_KEY_RANGES)}]`);
    expect(MASK_KEY_FRAGMENT).toContain(`u_samples[${String(MAX_KEY_SAMPLES)}]`);
    for (const source of [MASK_KEY_FRAGMENT, MASK_DESPILL_FRAGMENT]) {
      expect(source.startsWith('#version 300 es')).toBe(true);
      const open = source.split('{').length;
      const close = source.split('}').length;
      expect(open).toBe(close);
    }
  });
});

describe('packing a key for one pass', () => {
  const base = {
    id: 'k',
    kind: 'key',
    model: 'hsl',
    ranges: [{ channel: 'hue', low: 0.2, high: 0.4, softness: 0.05 }],
  };

  it('adds the mask softness to every range and indexes the channel', () => {
    const mask = parse({ ...base, softness: 0.1 });
    const uniforms = keyUniforms(mask, 1);
    expect(uniforms.rangeCount).toBe(1);
    expect(uniforms.ranges[2]).toBeCloseTo(0.15, 6);
    expect(uniforms.ranges[3]).toBe(0);
  });

  it('carries samples only for the 3d model, and ranges only for the others', () => {
    const sampled = parse({
      id: 'k',
      kind: 'key',
      model: '3d',
      samples3d: [[0, 1, 0]],
      ranges: [{ channel: 'hue', low: 0, high: 1 }],
    });
    const packed = keyUniforms(sampled, 1);
    expect(packed.sampled).toBe(1);
    expect(packed.sampleCount).toBe(1);
    expect(packed.rangeCount).toBe(0);
    expect(keyUniforms(parse(base), 1).sampleCount).toBe(0);
  });

  it('flags a key with more ranges or samples than one pass holds', () => {
    expect(keyExceedsPass(parse(base))).toBe(false);
    const many = parse({
      ...base,
      model: '3d',
      samples3d: Array.from({ length: MAX_KEY_SAMPLES + 1 }, () => [0, 0.5, 0]),
    });
    expect(keyExceedsPass(many)).toBe(true);
  });

  it('clamps opacity into the pass', () => {
    expect(keyUniforms(parse(base), 2).opacity).toBe(1);
    expect(keyUniforms(parse(base), -1).opacity).toBe(0);
  });
});

describe('which keys despill', () => {
  const key = (over: Record<string, unknown>): KeyMask =>
    parse({ id: 'k', kind: 'key', model: 'hsl', ...over });

  it('finds them on both targets, and skips the ones set to none', () => {
    const green = key({ despill: 'green' });
    const plain = key({ id: 'p' });
    const limited = key({ id: 'l', despill: 'blue' });
    const stack = {
      alpha: [green, plain],
      byEffect: new Map([['grade', [limited]]]),
    };
    expect(despillingKeys(stack).map((mask) => mask.id)).toEqual(['k', 'l']);
    expect(despillingKeys(null)).toEqual([]);
  });
});
