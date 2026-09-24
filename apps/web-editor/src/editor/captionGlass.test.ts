import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROSTED_BOX,
  NO_BOX,
  boxForKind,
  boxKind,
  hexAlpha,
  hexRgb,
  withHexAlpha,
} from './captionGlass.js';

describe('caption glass helpers', () => {
  it('reads and writes hex alpha', () => {
    expect(hexAlpha('#ffffff')).toBe(1);
    expect(hexAlpha('#00000080')).toBeCloseTo(128 / 255);
    expect(hexAlpha('rgb(0 0 0 / 50%)')).toBe(1);
    expect(hexRgb('#FFD60A80')).toBe('#ffd60a');
    expect(withHexAlpha('#ffd60a', 0.5)).toBe('#ffd60a80');
    expect(withHexAlpha('#ffd60a33', 1)).toBe('#ffd60aff');
    expect(withHexAlpha('#000000', 2)).toBe('#000000ff');
  });

  it('classifies a box by what it draws', () => {
    expect(boxKind(undefined)).toBe('none');
    expect(boxKind(NO_BOX)).toBe('none');
    expect(boxKind({ color: '#000000b3' })).toBe('solid');
    expect(boxKind({ color: '#00000000', borderColor: '#ffffff', borderWidth: 1 })).toBe('solid');
    expect(boxKind(DEFAULT_FROSTED_BOX)).toBe('frosted');
  });

  it('keeps a tuned shape when switching between solid and frosted', () => {
    const tuned = { color: '#00000066', radius: 0.8, paddingX: 0.9, paddingY: 0.4 };
    const frosted = boxForKind('frosted', tuned);
    expect(frosted).toMatchObject({
      radius: 0.8,
      paddingX: 0.9,
      paddingY: 0.4,
      color: '#00000066',
    });
    expect(frosted.blur).toBeGreaterThan(0);
    const solid = boxForKind('solid', frosted);
    expect(solid.blur).toBeUndefined();
    expect(solid).toMatchObject({ radius: 0.8, paddingX: 0.9 });
    expect(boxForKind('none', frosted)).toEqual(NO_BOX);
  });

  it('does not frost behind an opaque tint that would hide the glass', () => {
    expect(boxForKind('frosted', { color: '#000000' }).color).toBe(DEFAULT_FROSTED_BOX.color);
  });
});
