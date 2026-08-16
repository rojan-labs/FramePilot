/**
 * Watermark codec for the P0 WebCodecs feasibility spike (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md). Decodes the 16-bit binary frame-index
 * watermark burned into the spike's test fixtures by
 * `tests/e2e/fixtures/preview-spike/gen-proxy.mjs` — the two MUST agree on
 * the block layout below, since this is the ground-truth signal the
 * cut-continuity gate checks against (read off the *canvas* pixels, not
 * VideoFrame timestamps, so it proves what was actually presented).
 *
 * Spec: 16 blocks, BLOCK_PX x BLOCK_PX each, left to right starting at
 * (0, 0). Block `bit` is pure white iff bit `bit` of the 0-based frame index
 * is set, else pure black. Full-luma blocks (not text) so a luma threshold
 * is robust to yuv420 chroma subsampling and lossy compression.
 */

export const WATERMARK_BLOCK_PX = 32;
export const WATERMARK_BITS = 16;
/** Pixel width of the region a caller must read back (`getImageData`) to decode. */
export const WATERMARK_STRIP_WIDTH = WATERMARK_BLOCK_PX * WATERMARK_BITS;
export const WATERMARK_STRIP_HEIGHT = WATERMARK_BLOCK_PX;

const LUMA_THRESHOLD = 128;

/**
 * Decode the frame index from an RGBA pixel buffer covering at least the
 * `WATERMARK_STRIP_WIDTH` x `WATERMARK_STRIP_HEIGHT` watermark region.
 *
 * @param pixels RGBA bytes, row-major, as returned by `ImageData.data`.
 * @param rowWidthPx The full row width in pixels the buffer was read at
 *   (may exceed `WATERMARK_STRIP_WIDTH` if the caller read a wider strip).
 * @returns The decoded 0-65535 frame index.
 */
export function decodeWatermarkFrameIndex(pixels: Uint8ClampedArray, rowWidthPx: number): number {
  let frameIndex = 0;
  for (let bit = 0; bit < WATERMARK_BITS; bit++) {
    // Sample the block center so compression ringing at block edges can't flip a bit.
    const sampleX = bit * WATERMARK_BLOCK_PX + WATERMARK_BLOCK_PX / 2;
    const sampleY = WATERMARK_BLOCK_PX / 2;
    const idx = (sampleY * rowWidthPx + sampleX) * 4;
    const luma = pixels[idx] ?? 0;
    if (luma >= LUMA_THRESHOLD) {
      frameIndex |= 1 << bit;
    }
  }
  return frameIndex;
}

/**
 * Reference encoder mirroring `gen-proxy.mjs`'s `paintFrame` — used only by
 * tests to verify the decoder against a known-correct block pattern without
 * needing a real decoded video frame.
 */
export function encodeWatermarkStrip(frameIndex: number): Uint8ClampedArray {
  const strip = new Uint8ClampedArray(WATERMARK_STRIP_WIDTH * WATERMARK_STRIP_HEIGHT * 4);
  for (let bit = 0; bit < WATERMARK_BITS; bit++) {
    const on = (frameIndex >> bit) & 1;
    const val = on ? 255 : 0;
    const x0 = bit * WATERMARK_BLOCK_PX;
    for (let y = 0; y < WATERMARK_BLOCK_PX; y++) {
      for (let x = x0; x < x0 + WATERMARK_BLOCK_PX; x++) {
        const idx = (y * WATERMARK_STRIP_WIDTH + x) * 4;
        strip[idx] = val;
        strip[idx + 1] = val;
        strip[idx + 2] = val;
        strip[idx + 3] = 255;
      }
    }
  }
  return strip;
}
