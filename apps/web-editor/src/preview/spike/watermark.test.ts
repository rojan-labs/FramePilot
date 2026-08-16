import { describe, expect, it } from 'vitest';
import {
  WATERMARK_BITS,
  WATERMARK_STRIP_WIDTH,
  decodeWatermarkFrameIndex,
  encodeWatermarkStrip,
} from './watermark.js';

describe('watermark codec', () => {
  it('round-trips 0, the max 16-bit index, and every power-of-two bit', () => {
    const indices = [0, 65535, ...Array.from({ length: WATERMARK_BITS }, (_, bit) => 1 << bit)];
    for (const frameIndex of indices) {
      const strip = encodeWatermarkStrip(frameIndex);
      expect(decodeWatermarkFrameIndex(strip, WATERMARK_STRIP_WIDTH)).toBe(frameIndex);
    }
  });

  it('round-trips every index in a representative range', () => {
    for (let frameIndex = 0; frameIndex < 2000; frameIndex++) {
      const strip = encodeWatermarkStrip(frameIndex);
      expect(decodeWatermarkFrameIndex(strip, WATERMARK_STRIP_WIDTH)).toBe(frameIndex);
    }
  });

  it('is robust to a wider row than the strip (caller read a bigger region)', () => {
    const frameIndex = 4242;
    const rowWidth = WATERMARK_STRIP_WIDTH * 2;
    const wide = new Uint8ClampedArray(rowWidth * 32 * 4);
    const narrow = encodeWatermarkStrip(frameIndex);
    for (let y = 0; y < 32; y++) {
      const srcRow = narrow.subarray(
        y * WATERMARK_STRIP_WIDTH * 4,
        (y + 1) * WATERMARK_STRIP_WIDTH * 4,
      );
      wide.set(srcRow, y * rowWidth * 4);
    }
    expect(decodeWatermarkFrameIndex(wide, rowWidth)).toBe(frameIndex);
  });

  it('tolerates compression noise away from block centers (thresholds correctly)', () => {
    const frameIndex = 777;
    const strip = encodeWatermarkStrip(frameIndex);
    // Corrupt every block's edge pixels (simulating ringing) but leave centers intact.
    for (let bit = 0; bit < WATERMARK_BITS; bit++) {
      const x0 = bit * 32;
      for (let x = x0; x < x0 + 4; x++) {
        const idx = (0 * WATERMARK_STRIP_WIDTH + x) * 4;
        strip[idx] = 128;
        strip[idx + 1] = 128;
        strip[idx + 2] = 128;
      }
    }
    expect(decodeWatermarkFrameIndex(strip, WATERMARK_STRIP_WIDTH)).toBe(frameIndex);
  });
});
