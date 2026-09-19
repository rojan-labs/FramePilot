import { describe, expect, it } from 'vitest';
import type { AnyOperation } from '@framepilot/editor-core';
import {
  UNSOURCED_MASK_GEOMETRY,
  assertMaskGeometrySourced,
  attestMaskGeometry,
  carriesMaskGeometry,
  maskGeometrySourceOf,
  numbersIn,
  geometryNumbersIn,
  numbersWereTyped,
  unsourcedMaskGeometry,
} from './geometry-provenance.js';

const op = (value: Record<string, unknown>): AnyOperation => value as unknown as AnyOperation;

const rectangle = (): AnyOperation =>
  op({
    type: 'add_mask',
    clipId: 'c1',
    mask: { id: 'm1', kind: 'rectangle', cx: 1, cy: 1, width: 2, height: 2 },
  });

describe('carriesMaskGeometry', () => {
  it('names every operation that places, moves or reshapes a mask', () => {
    expect(carriesMaskGeometry(rectangle())).toBe(true);
    expect(
      carriesMaskGeometry(
        op({ type: 'add_effect_layer_mask', layerId: 'l', mask: { kind: 'linear' } }),
      ),
    ).toBe(true);
    expect(
      carriesMaskGeometry(op({ type: 'add_mask', clipId: 'c', mask: { kind: 'matte' } })),
    ).toBe(true);
    expect(carriesMaskGeometry(op({ type: 'set_mask_path', maskId: 'm', keyframe: {} }))).toBe(
      true,
    );
    expect(
      carriesMaskGeometry(op({ type: 'apply_mask_tracking', maskId: 'm', tracking: {} })),
    ).toBe(true);
    expect(carriesMaskGeometry(op({ type: 'paste_masks', clipId: 'c', masks: [] }))).toBe(true);
    expect(carriesMaskGeometry(op({ type: 'update_mask', maskId: 'm', changes: { cx: 4 } }))).toBe(
      true,
    );
    expect(
      carriesMaskGeometry(
        op({ type: 'add_mask_keyframe', maskId: 'm', keyframe: { property: 'cy' } }),
      ),
    ).toBe(true);
  });

  it('leaves coordinate-free edits alone', () => {
    expect(
      carriesMaskGeometry(op({ type: 'add_mask', clipId: 'c', mask: { kind: 'layer' } })),
    ).toBe(false);
    expect(carriesMaskGeometry(op({ type: 'add_mask', clipId: 'c', mask: { kind: 'key' } }))).toBe(
      false,
    );
    expect(
      carriesMaskGeometry(
        op({ type: 'update_mask', maskId: 'm', changes: { invert: true, featherOuterPx: 4 } }),
      ),
    ).toBe(false);
    expect(
      carriesMaskGeometry(
        op({ type: 'add_mask_keyframe', maskId: 'm', keyframe: { property: 'opacity' } }),
      ),
    ).toBe(false);
    expect(carriesMaskGeometry(op({ type: 'remove_mask', clipId: 'c', maskId: 'm' }))).toBe(false);
    expect(carriesMaskGeometry(op({ type: 'trim_clip', clipId: 'c' }))).toBe(false);
  });
});

describe('attestation', () => {
  it('refuses geometry nobody attested, with the one fixed sentence', () => {
    expect(() => assertMaskGeometrySourced([rectangle()])).toThrowError(UNSOURCED_MASK_GEOMETRY);
    expect(UNSOURCED_MASK_GEOMETRY).not.toMatch(/\d/);
  });

  it('admits attested geometry and remembers its source', () => {
    const ops = attestMaskGeometry([rectangle()], { kind: 'candidate', candidateId: 'f12_ab' });
    expect(() => assertMaskGeometrySourced(ops)).not.toThrow();
    expect(maskGeometrySourceOf(ops[0]!)).toEqual({ kind: 'candidate', candidateId: 'f12_ab' });
  });

  it('is about how a shape was produced, not what it looks like', () => {
    attestMaskGeometry([rectangle()], { kind: 'measurement', engine: 'pack@1' });
    // Identical numbers, built elsewhere: still unsourced.
    expect(unsourcedMaskGeometry([rectangle()])).toHaveLength(1);
  });

  it('refuses a batch when any one geometry operation is unsourced', () => {
    const sourced = attestMaskGeometry([rectangle()], { kind: 'user_numbers' });
    expect(unsourcedMaskGeometry([...sourced, rectangle()])).toHaveLength(1);
  });
});

describe('typed numbers', () => {
  it('reads numbers and percentages out of a request', () => {
    expect(numbersIn('a box 20% from the left, 0.5 wide, at -3')).toEqual([20, 0.5, -3]);
    expect(numbersIn('blur the faces')).toEqual([]);
  });

  it('accepts a fraction the editor typed as a percentage', () => {
    expect(numbersWereTyped([0.2, 0.5], [20, 0.5])).toBe(true);
  });

  it('refuses any number the editor did not type', () => {
    expect(numbersWereTyped([0.2, 0.31], [20, 0.5])).toBe(false);
    expect(numbersWereTyped([0.25], [])).toBe(false);
  });
});

describe('numbers bound to geometry in the current request (AM1.6)', () => {
  it('binds a number to a unit written after it', () => {
    expect(geometryNumbersIn('a box 20% from the left, 10% down, 50% wide and 25% tall')).toEqual([
      20, 10, 50, 25,
    ]);
    expect(geometryNumbersIn('blur a 200px square, 30 pixels in')).toEqual([200, 30]);
    expect(geometryNumbersIn('10 percent in from the edge')).toEqual([10]);
  });

  it('binds a number to a shape or position word in its phrase', () => {
    expect(geometryNumbersIn('rectangle at x 0.2, y 0.1, width 0.5, height 0.25')).toEqual([
      0.2, 0.1, 0.5, 0.25,
    ]);
    expect(geometryNumbersIn('x=0.2 y: 0.1')).toEqual([0.2, 0.1]);
    expect(geometryNumbersIn('an ellipse 0.3 wide and 0.4 tall')).toEqual([0.3, 0.4]);
    expect(geometryNumbersIn('radius of about 0.1')).toEqual([0.1]);
    expect(geometryNumbersIn('start 0.25 from the top')).toEqual([0.25]);
  });

  it('binds dimension pairs and a coordinate listed after a bound one', () => {
    expect(geometryNumbersIn('a 400x300 box')).toEqual([400, 300]);
    expect(geometryNumbersIn('mask 20 by 50 in the corner')).toEqual([20, 50]);
    expect(geometryNumbersIn('position 0.2, 0.3')).toEqual([0.2, 0.3]);
  });

  it('refuses coincidental numbers: counts, times and quantities are not coordinates', () => {
    expect(geometryNumbersIn('cut the 20 second intro and give me 50 versions')).toEqual([]);
    expect(geometryNumbersIn('I shot 20 takes; keep take 50 and mask the sign')).toEqual([]);
    expect(geometryNumbersIn('blur the plate at 20 seconds for 50 frames')).toEqual([]);
    expect(geometryNumbersIn('speed it up 2x and mask the car')).toEqual([]);
    expect(geometryNumbersIn('export at 1080p, 4k later')).toEqual([]);
    expect(geometryNumbersIn('mask the 3 people')).toEqual([]);
  });

  it('does not let a listed partner steal a number something else claims', () => {
    expect(geometryNumbersIn('width 0.5, 50 versions please')).toEqual([0.5]);
    expect(geometryNumbersIn('from the left 10 seconds in')).toEqual([]);
  });

  it('a time unit wins over a position word', () => {
    expect(geometryNumbersIn('the top 5 seconds')).toEqual([]);
  });
});
