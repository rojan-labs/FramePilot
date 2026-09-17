/**
 * Strict reader for the 8-bit grayscale PNGs a matte job takes as correction inputs.
 *
 * WHY hand-written: the renderer hands main a brush stroke or a locked alpha as PNG bytes,
 * and main must (a) refuse anything that is not exactly a small 8-bit gray image of the
 * artifact's size before it touches the project, and (b) hash the DECODED pixels so a locked
 * frame can be proven bit-identical to what the worker wrote. Both need the pixels, the repo
 * adds no image dependency to the main process, and the subset is tiny: colour type 0, bit
 * depth 8, no interlace, the five standard filters, zlib from Node.
 *
 * Brush masks use keep = 255, remove = 0, untouched = 128 (plan 03); locked frames are alpha.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Encoded bytes one input PNG may be. An 8K gray frame of noise deflates to about this. */
export const MATTE_INPUT_PNG_MAX_BYTES = 64 * 1024 * 1024;
const MAX_SIDE = 8192;
/** Brush masks may hold only these three values. */
export const BRUSH_VALUES = new Set([0, 128, 255]);

export class MattePngError extends Error {
  public constructor(
    message: string,
    public readonly code: 'invalid_png' | 'wrong_size' = 'invalid_png',
  ) {
    super(message);
    this.name = 'MattePngError';
  }
}

export interface GrayPng {
  readonly width: number;
  readonly height: number;
  /** Row-major 8-bit pixels, `width * height` bytes. */
  readonly pixels: Buffer;
}

export interface DecodeGrayPngOptions {
  /** Refuse at the header, before any pixel data is inflated, unless the size matches (BR4.12 L2). */
  readonly expectedWidth?: number;
  readonly expectedHeight?: number;
}

/**
 * Decode an 8-bit, non-interlaced grayscale PNG, refusing every other shape.
 *
 * Strict on purpose (BR4.12 L2): every chunk's CRC must match, only IHDR, IDAT and IEND may appear
 * (no ancillary chunks), nothing may follow IEND, and an expected size is checked at IHDR so an
 * oversized image is refused before it is inflated.
 */
export function decodeGrayPng(bytes: Uint8Array, options: DecodeGrayPngOptions = {}): GrayPng {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.byteLength > MATTE_INPUT_PNG_MAX_BYTES) throw new MattePngError('PNG is too large.');
  if (data.byteLength < 8 || !data.subarray(0, 8).equals(SIGNATURE)) {
    throw new MattePngError('Not a PNG file.');
  }
  let offset = 8;
  let header: { width: number; height: number } | undefined;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset + 12 <= data.byteLength) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.byteLength) throw new MattePngError('PNG chunk is truncated.');
    const body = data.subarray(start, end);
    if (crc32(data.subarray(offset + 4, end)) !== data.readUInt32BE(end)) {
      throw new MattePngError('PNG chunk checksum does not match.');
    }
    if (type === 'IHDR') {
      if (header !== undefined || length !== 13) throw new MattePngError('PNG header is invalid.');
      const width = body.readUInt32BE(0);
      const height = body.readUInt32BE(4);
      const [bitDepth, colourType, compression, filter, interlace] = body.subarray(8, 13);
      if (width === 0 || height === 0 || width > MAX_SIDE || height > MAX_SIDE) {
        throw new MattePngError('PNG dimensions are out of bounds.');
      }
      if (bitDepth !== 8 || colourType !== 0 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new MattePngError('PNG must be 8-bit grayscale without interlace.');
      }
      if (
        (options.expectedWidth !== undefined && width !== options.expectedWidth) ||
        (options.expectedHeight !== undefined && height !== options.expectedHeight)
      ) {
        throw new MattePngError('PNG is not the size of the matte it belongs to.', 'wrong_size');
      }
      header = { width, height };
    } else if (type === 'IDAT') {
      if (header === undefined) throw new MattePngError('PNG data precedes its header.');
      idat.push(body);
    } else if (type === 'IEND') {
      ended = true;
      offset = end + 4;
      break;
    } else {
      // Ancillary or unknown chunks are not part of a correction mask; the host stores a
      // canonical re-encode, so refusing them loses nothing.
      throw new MattePngError('PNG carries a chunk a correction mask does not use.');
    }
    offset = end + 4;
  }
  if (ended && offset !== data.byteLength) throw new MattePngError('PNG has data after its end.');
  if (header === undefined || !ended || idat.length === 0) {
    throw new MattePngError('PNG is incomplete.');
  }
  const { width, height } = header;
  const rowBytes = width + 1;
  let raw: Buffer;
  try {
    // maxOutputLength bounds a decompression bomb to exactly the image's own size.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: rowBytes * height });
  } catch {
    throw new MattePngError('PNG pixel data is corrupt or larger than its header says.');
  }
  if (raw.byteLength !== rowBytes * height) throw new MattePngError('PNG pixel data is truncated.');
  return { width, height, pixels: unfilter(raw, width, height) };
}

/** sha256 of decoded pixels: comparable with ffmpeg's `framehash` of a `gray` frame. */
export function grayPixelSha256(image: GrayPng): string {
  return createHash('sha256').update(image.pixels).digest('hex');
}

/**
 * Encode 8-bit gray pixels as a PNG (filter 0). The host writes lock inputs taken from a
 * verified matte frame with it, so the stored lock decodes to exactly those bytes.
 */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_SIDE || height > MAX_SIDE || pixels.byteLength !== width * height) {
    throw new MattePngError('Pixel buffer does not match the PNG dimensions.');
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    Buffer.from(pixels.buffer, pixels.byteOffset + row * width, width).copy(raw, row * (width + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One PNG chunk with its length and CRC (exported for building test inputs). */
export function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.byteLength, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function unfilter(raw: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height);
  for (let row = 0; row < height; row += 1) {
    const filterType = raw[row * (width + 1)];
    const source = row * (width + 1) + 1;
    const target = row * width;
    for (let column = 0; column < width; column += 1) {
      const value = raw[source + column]!;
      const left = column > 0 ? out[target + column - 1]! : 0;
      const up = row > 0 ? out[target - width + column]! : 0;
      const upLeft = row > 0 && column > 0 ? out[target - width + column - 1]! : 0;
      let predicted: number;
      switch (filterType) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: predicted = paeth(left, up, upLeft); break;
        default: throw new MattePngError('PNG uses an unknown row filter.');
      }
      out[target + column] = (value + predicted) & 0xff;
    }
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}
