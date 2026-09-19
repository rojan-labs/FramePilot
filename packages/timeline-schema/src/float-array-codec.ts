/**
 * Exact binary text form for long number arrays in `project.fp.json` (MK4.6).
 *
 * A rotoscoped path mask is six numbers per vertex per keyframe (ADR 0178). Written as decimal
 * JSON, 1,000 keyframes of 200 vertices take ~120 ms just to format the 1.2 million numbers,
 * which alone breaks the 250 ms save budget (plan 06). Written as their IEEE-754 bytes in
 * base64, they take a few milliseconds, the file is ~45% smaller, and every value survives
 * bit for bit (decimal round-trips too, but only through the slow shortest-form formatting).
 *
 * The form is `f64le:<base64 of little-endian float64 bytes>`. It is a FILE encoding only: the
 * schema decodes it on parse, so every in-memory project, operation, renderer and the agent
 * still see plain number arrays. The Python loader decodes the same prefix.
 */

/** Prefix of an encoded array. */
export const FLOAT64_ARRAY_PREFIX = 'f64le:';

const BYTES_PER_FLOAT64 = 8;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

interface NodeBufferLike {
  from(
    data: ArrayBuffer | string,
    encoding?: string,
  ): {
    toString(encoding: string): string;
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
  };
}

/** Node's Buffer when present (desktop main, engine tooling); the browser uses the fallback. */
const nodeBuffer = (globalThis as { Buffer?: NodeBufferLike }).Buffer;

/** Whether the platform stores float64 little-endian (every platform FramePilot ships on). */
const LITTLE_ENDIAN = new Uint8Array(new Float64Array([1]).buffer)[7] === 0x3f;

function bytesOf(values: readonly number[]): Uint8Array {
  const floats = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 1) floats[index] = values[index]!;
  const bytes = new Uint8Array(floats.buffer);
  if (LITTLE_ENDIAN) return bytes;
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FLOAT64) {
    bytes.subarray(offset, offset + BYTES_PER_FLOAT64).reverse();
  }
  return bytes;
}

function base64Encode(bytes: Uint8Array, portable: boolean): string {
  if (nodeBuffer !== undefined && !portable) {
    return nodeBuffer.from(bytes.buffer as ArrayBuffer).toString('base64');
  }
  const parts: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    chunk +=
      BASE64_ALPHABET[(triple >> 18) & 63]! +
      BASE64_ALPHABET[(triple >> 12) & 63]! +
      (b === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63]!) +
      (c === undefined ? '=' : BASE64_ALPHABET[triple & 63]!);
    if (chunk.length >= 65536) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

function base64Decode(text: string, portable: boolean): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  if (nodeBuffer !== undefined && !portable) {
    const decoded = nodeBuffer.from(text, 'base64');
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength).slice();
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  const lookup = (char: string): number => BASE64_ALPHABET.indexOf(char);
  let out = 0;
  for (let index = 0; index < text.length; index += 4) {
    const triple =
      (lookup(text[index]!) << 18) |
      (lookup(text[index + 1]!) << 12) |
      ((text[index + 2] === '=' ? 0 : lookup(text[index + 2]!)) << 6) |
      (text[index + 3] === '=' ? 0 : lookup(text[index + 3]!));
    if (out < bytes.length) bytes[out++] = (triple >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (triple >> 8) & 255;
    if (out < bytes.length) bytes[out++] = triple & 255;
  }
  return bytes;
}

/**
 * Encode numbers as `f64le:<base64>`. Exact for every finite double (and -0).
 *
 * @param portable - Use the browser implementation even where Node's Buffer exists (tests).
 */
export function encodeFloat64Array(values: readonly number[], portable = false): string {
  return FLOAT64_ARRAY_PREFIX + base64Encode(bytesOf(values), portable);
}

/**
 * Decode an `f64le:` string, or `null` when it is not one (wrong prefix, bad base64, or a
 * byte count that is not whole doubles).
 */
export function decodeFloat64Array(text: string, portable = false): number[] | null {
  if (!text.startsWith(FLOAT64_ARRAY_PREFIX)) return null;
  const bytes = base64Decode(text.slice(FLOAT64_ARRAY_PREFIX.length), portable);
  if (bytes === null || bytes.length % BYTES_PER_FLOAT64 !== 0) return null;
  if (!LITTLE_ENDIAN) {
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FLOAT64) {
      bytes.subarray(offset, offset + BYTES_PER_FLOAT64).reverse();
    }
  }
  return Array.from(
    new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / BYTES_PER_FLOAT64),
  );
}
