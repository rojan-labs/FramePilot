/** A swatch's spoken name: the palette's own words, and a hue and a shade for any other colour. */
import { describe, expect, it } from 'vitest';
import { colourName } from './colour-name.js';

describe('colourName', () => {
  it('names the palette colours as a person would', () => {
    expect(
      ['#FFD400', '#FF3B30', '#FFFFFF', '#0A84FF', '#34C759', '#111111'].map(colourName),
    ).toEqual(['Yellow', 'Red', 'White', 'Blue', 'Green', 'Black']);
  });

  it('names any other colour by its hue and how light it is', () => {
    expect(colourName('#123456')).toBe('Dark blue');
    expect(colourName('#FF8800')).toBe('Orange');
    expect(colourName('#FFB3D9')).toBe('Light pink');
    expect(colourName('#7A3DB8')).toBe('Purple');
    expect(colourName('#808080')).toBe('Grey');
    expect(colourName('#1A1A1A')).toBe('Black');
  });

  it('reads lower-case hex too, and says nothing it cannot read', () => {
    expect(colourName('#ff3b30')).toBe('Red');
    expect(colourName('not a colour')).toBe('Colour');
  });
});
