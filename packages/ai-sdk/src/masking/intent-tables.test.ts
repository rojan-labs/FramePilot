import { describe, expect, it } from 'vitest';
import { COLOR_GRADE_PARAMETER_CONTRACTS, DEFAULT_CLIP_BLUR_AMOUNT } from '@framepilot/editor-core';
import {
  MASK_EFFECT_INTENTS,
  growStepPx,
  hideMarginPx,
  matteEdgeFor,
  purposeShape,
  resolveEffectIntent,
  shapeEdgeFor,
} from './intent-tables.js';

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };

describe('mask intent tables', () => {
  it('scales an edge with the picture so the look is resolution independent', () => {
    expect(shapeEdgeFor('exact', HD)).toEqual({ featherOuterPx: 0 });
    expect(shapeEdgeFor('soft', UHD).featherOuterPx).toBeCloseTo(
      2 * shapeEdgeFor('soft', HD).featherOuterPx,
    );
    expect(shapeEdgeFor('very_soft', HD).featherOuterPx).toBeGreaterThan(
      shapeEdgeFor('soft', HD).featherOuterPx,
    );
  });

  it('maps a matte edge onto the pack edge mode, adding blur only for very soft', () => {
    expect(matteEdgeFor('exact', HD)).toEqual({ edgeMode: 'sharp', blurPx: 0 });
    expect(matteEdgeFor('soft', HD)).toEqual({ edgeMode: 'smooth', blurPx: 0 });
    expect(matteEdgeFor('very_soft', HD).blurPx).toBeGreaterThan(0);
  });

  it('moves the edge by equal and opposite steps', () => {
    expect(growStepPx('looser', HD)).toBeGreaterThan(0);
    expect(growStepPx('tighter', HD)).toBe(-growStepPx('looser', HD));
    expect(hideMarginPx(HD)).toBeGreaterThan(0);
  });

  it('inverts only a hide mask', () => {
    expect(purposeShape('hide')).toEqual({ invert: true });
    expect(purposeShape('cutout')).toEqual({ invert: false });
    expect(purposeShape('effect')).toEqual({ invert: false });
  });

  it('resolves every grade intent to parameters the grade contract admits', () => {
    for (const intent of ['brighten', 'darken', 'desaturate'] as const) {
      const resolved = resolveEffectIntent(intent);
      if (!resolved.ok) throw new Error(resolved.message);
      for (const [name, value] of Object.entries(resolved.effect.params)) {
        const contract = COLOR_GRADE_PARAMETER_CONTRACTS[name];
        expect(contract, name).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(contract!.min);
        expect(value).toBeLessThanOrEqual(contract!.max);
      }
    }
  });

  it('refuses the intent that has no renderer on a clip mask, with a remedy', () => {
    const resolved = resolveEffectIntent('grade_match_to');
    expect(resolved).toMatchObject({ ok: false, code: 'effect_intent_unsupported' });
    if (!resolved.ok) expect(resolved.message).toMatch(/nothing was changed/);
  });

  it('hides with the clip blur at its default strength (E2E.4)', () => {
    expect(resolveEffectIntent('blur_to_hide')).toEqual({
      ok: true,
      effect: { type: 'blur', params: { amount: DEFAULT_CLIP_BLUR_AMOUNT } },
    });
    expect(MASK_EFFECT_INTENTS).toContain('blur_to_hide');
  });
});
