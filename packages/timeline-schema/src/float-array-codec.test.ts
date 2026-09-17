import { describe, expect, it } from 'vitest';
import {
  decodeFloat64Array,
  encodeFloat64Array,
  FLOAT64_ARRAY_PREFIX,
} from './float-array-codec.js';
import { MaskPathKeyframeSchema } from './index.js';

describe('f64le number array codec (MK4.6)', () => {
  it('round-trips every double bit for bit, including -0, extremes and sub-pixel values', () => {
    const values = [
      0,
      -0,
      1,
      -2.5,
      812.3700000000001,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      1e-300,
      0.1 + 0.2,
    ];
    const decoded = decodeFloat64Array(encodeFloat64Array(values))!;
    expect(decoded).toHaveLength(values.length);
    decoded.forEach((value, index) => expect(Object.is(value, values[index])).toBe(true));
  });

  it('matches the Python struct packing (little-endian float64)', () => {
    expect(encodeFloat64Array([1, -2])).toBe(`${FLOAT64_ARRAY_PREFIX}AAAAAAAA8D8AAAAAAAAAwA==`);
  });

  it('the browser implementation agrees with Node for every padding length', () => {
    for (const values of [[], [1], [1, -2], [3.25, Number.MAX_VALUE, -0], [0.1, 0.2, 0.3, 0.4]]) {
      const text = encodeFloat64Array(values, true);
      expect(text).toBe(encodeFloat64Array(values));
      expect(decodeFloat64Array(text, true)).toEqual(values);
    }
  });

  it('refuses strings that are not whole encoded doubles', () => {
    expect(decodeFloat64Array('f64le:AAAA')).toBeNull();
    expect(decodeFloat64Array('nope')).toBeNull();
    expect(decodeFloat64Array('f64le:!!!!')).toBeNull();
    expect(decodeFloat64Array('f64le:')).toEqual([]);
  });

  it('path keyframes accept the encoded form and decode it to plain arrays', () => {
    const parsed = MaskPathKeyframeSchema.parse({
      id: 'k',
      sourceTime: 0,
      points: encodeFloat64Array([1, 2, 0, 0, 0, 0]),
      vertexTypes: [0],
      featherPx: encodeFloat64Array([3]),
    });
    expect(parsed.points).toEqual([1, 2, 0, 0, 0, 0]);
    expect(parsed.featherPx).toEqual([3]);
    expect(() =>
      MaskPathKeyframeSchema.parse({
        id: 'k',
        sourceTime: 0,
        points: 'f64le:AAAA',
        vertexTypes: [0],
      }),
    ).toThrow();
    expect(() =>
      MaskPathKeyframeSchema.parse({
        id: 'k',
        sourceTime: 0,
        points: [0, 0, 0, 0, 0, 0],
        vertexTypes: [0],
        featherPx: encodeFloat64Array([-1]),
      }),
    ).toThrow();
  });
});
