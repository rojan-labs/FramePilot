/**
 * Base64 little-endian fp16 vectors: the Capability Pack protocol's `PackedVector` (AM2.5).
 *
 * The Visual Embed worker packs every L2-normalised vector as half floats
 * (`workers/visual-embed/.../protocol.py` `pack_fp16`), which costs about 1e-3 of cosine and halves
 * the line. The desktop host decodes them only to score detection crops against a query.
 */

const HALF_EXPONENT_BIAS = 15;
const HALF_MANTISSA = 1024;
const HALF_MAX = 65504;
const SMALLEST_SUBNORMAL = 2 ** -24;
const SMALLEST_NORMAL = 2 ** -14;

function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * SMALLEST_SUBNORMAL;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / HALF_MANTISSA) * 2 ** (exponent - HALF_EXPONENT_BIAS);
}

function toHalf(value: number): number {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  if (magnitude > HALF_MAX) return sign | 0x7c00;
  if (magnitude < SMALLEST_NORMAL) return sign | Math.round(magnitude / SMALLEST_SUBNORMAL);
  let exponent = Math.floor(Math.log2(magnitude));
  let mantissa = Math.round((magnitude / 2 ** exponent - 1) * HALF_MANTISSA);
  if (mantissa === HALF_MANTISSA) {
    mantissa = 0;
    exponent += 1;
  }
  return sign | ((exponent + HALF_EXPONENT_BIAS) << 10) | mantissa;
}

/**
 * Decode one packed vector.
 *
 * @throws Error when the payload is not a whole number of halves or carries a non-finite
 *   component — a NaN would poison every cosine it touched.
 */
export function unpackFp16(packed: string): number[] {
  const bytes = Buffer.from(packed, 'base64');
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new Error(
      `A packed vector must be a whole number of fp16 components; got ${String(bytes.length)} bytes.`,
    );
  }
  const vector: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const value = fromHalf(bytes.readUInt16LE(offset));
    if (!Number.isFinite(value)) {
      throw new Error(
        `A packed vector carries a non-finite component at index ${String(offset / 2)}.`,
      );
    }
    vector.push(value);
  }
  return vector;
}

/** Encode a finite vector as the protocol does. The inverse of {@link unpackFp16}. */
export function packFp16(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 2);
  vector.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error('Refusing to pack a non-finite vector.');
    bytes.writeUInt16LE(toHalf(value), index * 2);
  });
  return bytes.toString('base64');
}
