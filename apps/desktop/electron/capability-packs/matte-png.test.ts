import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeGrayPng, encodeGrayPng, grayPixelSha256, MattePngError } from './matte-png.js';
import { createHash } from 'node:crypto';

describe('matte PNG inputs', () => {
  it('round-trips 8-bit gray pixels and hashes the decoded bytes', () => {
    const pixels = Uint8Array.from({ length: 12 }, (_, index) => [0, 128, 255][index % 3]!);
    const decoded = decodeGrayPng(encodeGrayPng(4, 3, pixels));
    expect(decoded).toMatchObject({ width: 4, height: 3 });
    expect([...decoded.pixels]).toEqual([...pixels]);
    expect(grayPixelSha256(decoded)).toBe(createHash('sha256').update(pixels).digest('hex'));
  });

  it('undoes sub, up, average and paeth row filters', () => {
    // Rows filtered 1 (sub), 4 (paeth), 2 (up), 3 (average).
    const raw = Buffer.from([1, 10, 10, 10, 4, 30, 10, 10, 2, 1, 1, 1, 3, 1, 1, 1]);
    const png = replaceIdat(encodeGrayPng(3, 4, new Uint8Array(12)), deflateSync(raw));
    expect([...decodeGrayPng(png).pixels]).toEqual([10, 20, 30, 40, 50, 60, 41, 51, 61, 21, 37, 50]);
  });

  it('refuses colour, 16-bit, bombs, truncation and non-PNG bytes', () => {
    const header = (colourType: number, bitDepth = 8) => {
      const png = encodeGrayPng(2, 2, new Uint8Array(4));
      const copy = Buffer.from(png);
      copy[8 + 8 + 8] = bitDepth;
      copy[8 + 8 + 9] = colourType;
      return copy;
    };
    expect(() => decodeGrayPng(header(2))).toThrow(MattePngError);
    expect(() => decodeGrayPng(header(0, 16))).toThrow(/8-bit grayscale/);
    const bomb = replaceIdat(encodeGrayPng(2, 2, new Uint8Array(4)), deflateSync(Buffer.alloc(10_000_000)));
    expect(() => decodeGrayPng(bomb)).toThrow(/corrupt or larger/);
    const png = encodeGrayPng(8, 8, new Uint8Array(64));
    expect(() => decodeGrayPng(png.subarray(0, png.byteLength - 20))).toThrow(MattePngError);
    expect(() => decodeGrayPng(Buffer.from('GIF89a'))).toThrow(/Not a PNG/);
  });
});

function replaceIdat(png: Buffer, data: Buffer): Buffer {
  const start = png.indexOf(Buffer.from('IDAT', 'latin1')) - 4;
  const length = png.readUInt32BE(start);
  const before = png.subarray(0, start);
  const after = png.subarray(start + 12 + length);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.byteLength, 0);
  const typed = Buffer.concat([Buffer.from('IDAT', 'latin1'), data]);
  // CRC is not checked by the reader (zlib's adler32 guards the payload); keep a placeholder.
  return Buffer.concat([before, size, typed, Buffer.alloc(4), after]);
}
