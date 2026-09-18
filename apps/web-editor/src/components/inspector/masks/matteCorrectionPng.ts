/**
 * Encode a brush correction as the 8-bit grayscale PNG the host accepts (BR6.5, plan 03).
 *
 * The host's reader is strict on purpose (`matte-png.ts`): colour type 0, 8 bits, no ancillary
 * chunks, the artifact's exact size, and only the three defined values — **keep = 255, remove = 0,
 * untouched = 128**. A canvas `toBlob('image/png')` produces an RGBA PNG, which that reader
 * refuses, so the bytes are built here instead of being taken from the browser.
 *
 * Deflate comes from `CompressionStream`, which the desktop runtime has, so this adds no
 * dependency. If it is missing the encoder refuses rather than emitting a stored-block PNG that
 * would quietly differ from what the host re-encodes.
 */

/** The only values a correction PNG may carry (`BRUSH_VALUES` in the host's reader). */
export const BRUSH_KEEP = 255;
export const BRUSH_REMOVE = 0;
export const BRUSH_UNTOUCHED = 128;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This build cannot save a brush fix: compression is unavailable.');
  }
  // A ReadableStream rather than `Blob.stream()`: the source is already bytes, and this avoids
  // depending on a Blob implementation detail.
  const source = new ReadableStream({
    start(controller: ReadableStreamDefaultController<BufferSource>) {
      controller.enqueue(bytes as BufferSource);
      controller.close();
    },
  });
  const chunks: Uint8Array[] = [];
  const reader = (
    source.pipeThrough(new CompressionStream('deflate')) as ReadableStream<Uint8Array>
  ).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Wrap 8-bit grayscale pixels in a PNG the host's reader accepts.
 *
 * @param gray - `width * height` bytes, row-major, each 0, 128 or 255.
 * @param width - Picture width in pixels; must match the artifact.
 * @param height - Picture height in pixels.
 * @returns The PNG bytes.
 */
export async function encodeGrayPng(
  gray: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (gray.length !== width * height) {
    throw new Error(
      `A correction mask must be ${String(width)}×${String(height)} pixels; got ${String(gray.length)} bytes.`,
    );
  }
  // One filter byte (0 = None) per row, so the bytes the host re-encodes are exactly these.
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: grayscale
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', await deflate(raw));
  const iend = chunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(PNG_SIGNATURE.length + ihdr.length + idat.length + iend.length);
  let offset = 0;
  for (const part of [PNG_SIGNATURE, ihdr, idat, iend]) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One brush stroke in artifact (source) pixels. */
export interface CorrectionStroke {
  readonly kind: 'keep' | 'remove';
  readonly radiusPx: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/**
 * Paint strokes into a grayscale buffer: keep = 255, remove = 0, everything else untouched.
 *
 * Drawn here rather than on a canvas because a canvas would antialias, and a value between the
 * three the host allows is refused — an antialiased edge would fail the whole save.
 */
export function paintCorrection(
  strokes: readonly CorrectionStroke[],
  width: number,
  height: number,
): Uint8Array {
  const gray = new Uint8Array(width * height).fill(BRUSH_UNTOUCHED);
  const dot = (cx: number, cy: number, radius: number, value: number): void => {
    const r = Math.max(1, radius);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) gray[y * width + x] = value;
      }
    }
  };
  for (const stroke of strokes) {
    const value = stroke.kind === 'keep' ? BRUSH_KEEP : BRUSH_REMOVE;
    let previous: { x: number; y: number } | null = null;
    for (const point of stroke.points) {
      if (previous !== null) {
        // Interpolate along the segment so a fast drag does not leave gaps between samples.
        const steps = Math.ceil(
          Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(1, stroke.radiusPx / 2),
        );
        for (let step = 1; step < steps; step += 1) {
          dot(
            previous.x + ((point.x - previous.x) * step) / steps,
            previous.y + ((point.y - previous.y) * step) / steps,
            stroke.radiusPx,
            value,
          );
        }
      }
      dot(point.x, point.y, stroke.radiusPx, value);
      previous = point;
    }
  }
  return gray;
}
