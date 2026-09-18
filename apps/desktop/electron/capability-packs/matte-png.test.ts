import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BRUSH_EDGE,
  BRUSH_KEEP,
  BRUSH_REMOVE,
  BRUSH_UNTOUCHED,
  BRUSH_VALUES,
  decodeGrayPng,
  encodeGrayPng,
  grayPixelSha256,
  MattePngError,
  pngChunk,
} from './matte-png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function header(width: number, height: number, bitDepth = 8, colourType = 0): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body[8] = bitDepth;
  body[9] = colourType;
  return pngChunk('IHDR', body);
}

function png(width: number, height: number, raw: Buffer, extra: Buffer[] = [], ihdr = header(width, height)): Buffer {
  return Buffer.concat([SIGNATURE, ihdr, ...extra, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

describe('matte PNG inputs', () => {
  it('round-trips 8-bit gray pixels and hashes the decoded bytes', () => {
    const pixels = Uint8Array.from({ length: 12 }, (_, index) => [0, 128, 255][index % 3]!);
    const decoded = decodeGrayPng(encodeGrayPng(4, 3, pixels));
    expect(decoded).toMatchObject({ width: 4, height: 3 });
    expect([...decoded.pixels]).toEqual([...pixels]);
    expect(grayPixelSha256(decoded)).toBe(createHash('sha256').update(pixels).digest('hex'));
  });

  it('defines exactly four brush values, edge among them (BR6.10)', () => {
    expect([...BRUSH_VALUES].sort((a, b) => a - b)).toEqual([0, 64, 128, 255]);
    expect({ BRUSH_KEEP, BRUSH_REMOVE, BRUSH_EDGE, BRUSH_UNTOUCHED }).toEqual({
      BRUSH_KEEP: 255,
      BRUSH_REMOVE: 0,
      BRUSH_EDGE: 64,
      BRUSH_UNTOUCHED: 128,
    });
    // An edge stroke round-trips through the strict reader and the canonical re-encode.
    const pixels = Uint8Array.from([0, 64, 128, 255, 64, 64, 128, 128]);
    const decoded = decodeGrayPng(encodeGrayPng(4, 2, pixels), { expectedWidth: 4, expectedHeight: 2 });
    expect([...decoded.pixels]).toEqual([...pixels]);
  });

  it('undoes sub, up, average and paeth row filters', () => {
    // Rows filtered 1 (sub), 4 (paeth), 2 (up), 3 (average).
    const raw = Buffer.from([1, 10, 10, 10, 4, 30, 10, 10, 2, 1, 1, 1, 3, 1, 1, 1]);
    expect([...decodeGrayPng(png(3, 4, raw)).pixels]).toEqual([10, 20, 30, 40, 50, 60, 41, 51, 61, 21, 37, 50]);
  });

  it('refuses colour, 16-bit, bombs, truncation and non-PNG bytes', () => {
    const raw = Buffer.alloc(2 * 3);
    expect(() => decodeGrayPng(png(2, 2, raw, [], header(2, 2, 8, 2)))).toThrow(MattePngError);
    expect(() => decodeGrayPng(png(2, 2, raw, [], header(2, 2, 16, 0)))).toThrow(/8-bit grayscale/);
    expect(() => decodeGrayPng(png(2, 2, Buffer.alloc(10_000_000)))).toThrow(/corrupt or larger/);
    const valid = encodeGrayPng(8, 8, new Uint8Array(64));
    expect(() => decodeGrayPng(valid.subarray(0, valid.byteLength - 20))).toThrow(MattePngError);
    expect(() => decodeGrayPng(Buffer.from('GIF89a'))).toThrow(/Not a PNG/);
  });

  describe('strict structure (BR4.12 L2)', () => {
    const valid = () => encodeGrayPng(4, 4, new Uint8Array(16));

    it('refuses a bad chunk checksum', () => {
      const bytes = valid();
      bytes[bytes.byteLength - 1] = (bytes[bytes.byteLength - 1] ?? 0) ^ 0xff;
      expect(() => decodeGrayPng(bytes)).toThrow(/checksum/);
    });

    it('refuses ancillary chunks, a duplicate header and data after IEND', () => {
      const raw = Buffer.alloc(5 * 4);
      expect(() => decodeGrayPng(png(4, 4, raw, [pngChunk('tEXt', Buffer.from('Comment\0hello'))]))).toThrow(/does not use/);
      expect(() => decodeGrayPng(png(4, 4, raw, [header(4, 4)]))).toThrow(/header is invalid/);
      expect(() => decodeGrayPng(Buffer.concat([valid(), Buffer.from('trailing')]))).toThrow(/after its end/);
    });

    it('refuses the wrong size at the header, before inflating a bomb', () => {
      const bomb = png(8192, 8192, Buffer.alloc(1), [], header(8192, 8192));
      const started = Date.now();
      expect(() => decodeGrayPng(bomb, { expectedWidth: 64, expectedHeight: 36 })).toThrow(expect.objectContaining({ code: 'wrong_size' }));
      expect(Date.now() - started).toBeLessThan(100);
    });
  });
});
