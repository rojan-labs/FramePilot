import { describe, expect, it } from 'vitest';
import { packFp16, unpackFp16 } from './packed-vector.js';

describe('packed fp16 vectors', () => {
  it('round-trips within half precision, including subnormals and signs', () => {
    const vector = [0, -0.5, 0.25, 1, -1, 0.0001, 0.7071, 65504];
    const decoded = unpackFp16(packFp16(vector));
    vector.forEach((value, index) => {
      expect(decoded[index]).toBeCloseTo(value, 3);
    });
  });

  it('decodes the bytes the Python worker writes (struct "<e")', () => {
    // 1.0 = 0x3C00, -2.0 = 0xC000, 0.5 = 0x3800, little-endian.
    expect(
      unpackFp16(Buffer.from([0x00, 0x3c, 0x00, 0xc0, 0x00, 0x38]).toString('base64')),
    ).toEqual([1, -2, 0.5]);
  });

  it('refuses a payload that is not whole halves, empty, or non-finite', () => {
    expect(() => unpackFp16(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(/whole number/);
    expect(() => unpackFp16('')).toThrow(/whole number/);
    expect(() => unpackFp16(Buffer.from([0x00, 0x7c]).toString('base64'))).toThrow(/non-finite/);
    expect(() => packFp16([Number.NaN])).toThrow(/non-finite/);
  });
});
