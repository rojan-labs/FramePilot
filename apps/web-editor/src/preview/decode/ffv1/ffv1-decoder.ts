/**
 * An FFV1 (versions 3 and 4) decoder for the preview's matte artifacts (BR5.1).
 *
 * A port of `libavcodec/ffv1dec.c` (FFmpeg n8.0) restricted to what a matte artifact stores and
 * the export reads (`render/mattes.py`): 8- and 16-bit gray (`matte.mkv`) and 8-bit RGB with or
 * without alpha (`foreground.mkv`, `bgr0`/`bgra`). Both entropy coders (range with default or
 * custom tables, Golomb-Rice), any slice layout, slice CRCs, and context state carried across
 * non-key frames. Anything else (float remapping, 4:2:0 YUV, other depths) is refused with
 * {@link Ffv1DecodeError}, never approximated: a matte that decodes differently from ffmpeg's
 * would be a wrong picture.
 *
 * The decoder is stateful like ffmpeg's: frames must be fed in decode order from a key frame.
 */
import { MAX_OVERREAD, RangeDecoder, DEFAULT_ONE_STATE } from './range-coder.js';

const CONTEXT_SIZE = 32;
const MAX_QUANT_TABLES = 8;
const MAX_CONTEXT_INPUTS = 5;
const MAX_SLICES = 1024;
const AC_GOLOMB_RICE = 0;
const AC_RANGE_CUSTOM_TAB = 2;
/** `ff_log2_run`. */
const LOG2_RUN = [
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14,
  15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
];

export class Ffv1DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ffv1DecodeError';
  }
}

/** A decoded FFV1 picture in the layout the export's rawvideo read produces. */
export type Ffv1Picture =
  | {
      readonly format: 'gray8';
      readonly width: number;
      readonly height: number;
      readonly data: Uint8Array;
    }
  | {
      readonly format: 'gray16';
      readonly width: number;
      readonly height: number;
      readonly data: Uint16Array;
    }
  /** Interleaved R, G, B (ffmpeg `-pix_fmt rgb24`). */
  | {
      readonly format: 'rgb24';
      readonly width: number;
      readonly height: number;
      readonly data: Uint8Array;
    };

interface VlcState {
  errorSum: number;
  drift: number;
  bias: number;
  count: number;
}

interface PlaneState {
  quantTableIndex: number;
  contextCount: number;
  /** Range coder: `contextCount * 32` adaptive states. */
  states: Uint8Array | null;
  /** Golomb-Rice: one VLC state per context. */
  vlc: VlcState[] | null;
}

interface SliceContext {
  planes: PlaneState[];
  x: number;
  y: number;
  width: number;
  height: number;
  runIndex: number;
  codingMode: number;
  rctBy: number;
  rctRy: number;
  resetContexts: number;
}

/** Big-endian bit reader over `bytes[start, end)` (`GetBitContext`). */
class BitReader {
  private index: number;
  private readonly bitEnd: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    end: number,
  ) {
    this.index = 0;
    this.bitEnd = (end - start) * 8;
  }

  get left(): number {
    return this.bitEnd - this.index;
  }

  /** The next 32 bits without consuming them (zero past the end). */
  private peek32(): number {
    let value = 0;
    const byteIndex = this.index >> 3;
    for (let i = 0; i < 5; i++) {
      const position = this.start + byteIndex + i;
      const inRange = (byteIndex + i) * 8 < this.bitEnd;
      value = value * 256 + (inRange ? (this.bytes[position] ?? 0) : 0);
    }
    // 40 bits are held; drop the bits already consumed in the first byte and the extra tail.
    const shift = 8 - (this.index & 7);
    return Math.floor(value / 2 ** shift) % 2 ** 32;
  }

  read(bits: number): number {
    if (bits === 0) return 0;
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const byte =
        this.index >> 3 < this.bitEnd >> 3 ? this.bytes[this.start + (this.index >> 3)]! : 0;
      value = value * 2 + ((byte >> (7 - (this.index & 7))) & 1);
      this.index++;
    }
    return value;
  }

  skip(bits: number): void {
    this.index += bits;
  }

  /** `get_ur_golomb(gb, k, limit, esc_len)`. */
  urGolomb(k: number, limit: number, escLen: number): number {
    const buf = this.peek32();
    const log = buf === 0 ? 0 : 31 - Math.clz32(buf);
    if (log > 31 - limit) {
      const value = Math.floor(buf / 2 ** (log - k)) + (30 - log) * 2 ** k;
      this.skip(32 + k - log);
      return value >>> 0;
    }
    this.skip(limit);
    return (this.read(escLen) + limit - 1) >>> 0;
  }
}

const midPred = (a: number, b: number, c: number): number => {
  if (a > b) {
    if (c > b) return c > a ? a : c;
    return b;
  }
  if (b > c) return c > a ? c : a;
  return b;
};

/** `fold(diff, bits)`. */
const fold = (diff: number, bits: number): number => {
  const shift = 32 - bits;
  return (diff << shift) >> shift;
};

/** `av_crc` with `AV_CRC_32_IEEE` as FFmpeg evaluates it on a little-endian host. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = (c << 1) ^ (0x04c11db7 & (c >> 31));
    c >>>= 0;
    table[i] =
      ((c & 0xff) << 24) | (((c >>> 8) & 0xff) << 16) | (((c >>> 16) & 0xff) << 8) | (c >>> 24);
  }
  return table;
})();

function crc32(crc: number, bytes: Uint8Array, start: number, end: number): number {
  let value = crc >>> 0;
  for (let i = start; i < end; i++)
    value = (CRC_TABLE[(value ^ bytes[i]!) & 0xff]! ^ (value >>> 8)) >>> 0;
  return value;
}

const ceilLog2 = (value: number): number => (value <= 1 ? 0 : 32 - Math.clz32(value - 1));

/** What the global header (`CodecPrivate`) declares. */
export interface Ffv1StreamInfo {
  readonly version: number;
  readonly microVersion: number;
  readonly coder: 'golomb' | 'range-default' | 'range-custom';
  readonly colorspace: 0 | 1;
  readonly bitsPerRawSample: number;
  readonly transparency: boolean;
  readonly slices: number;
  readonly ec: number;
}

export class Ffv1Decoder {
  private version = 0;
  private microVersion = 0;
  private combinedVersion = 0;
  private ac = 0;
  private readonly stateTransition = new Uint8Array(256);
  private colorspace = 0;
  private bitsPerRawSample = 8;
  private chromaPlanes = 0;
  private transparency = 0;
  private planeCount = 0;
  private numHSlices = 1;
  private numVSlices = 1;
  private quantTableCount = 0;
  private readonly quantTables: Int16Array[][] = [];
  private readonly contextCount: number[] = [];
  private readonly initialStates: (Uint8Array | null)[] = [];
  private ec = 0;
  private crcRef = 0;
  private flt = 0;
  private keyFrameOk = false;
  private readonly slices: SliceContext[] = [];
  private readonly lineA: Int16Array;
  private readonly lineB: Int16Array;
  private readonly rgbLines: Int16Array[];

  /**
   * @param width - Coded width (Matroska `PixelWidth`).
   * @param height - Coded height.
   * @param extradata - The global header (Matroska `CodecPrivate`).
   * @throws Ffv1DecodeError for a version, layout or format this decoder does not read.
   */
  constructor(
    readonly width: number,
    readonly height: number,
    extradata: Uint8Array,
  ) {
    if (!(width > 0 && height > 0)) throw new Ffv1DecodeError('FFV1 stream has no picture size.');
    this.readExtraHeader(extradata);
    const maxSlices = this.numHSlices * this.numVSlices;
    for (let i = 0; i < maxSlices; i++) {
      const sx = i % this.numHSlices;
      const sy = Math.floor(i / this.numHSlices);
      const xs = this.sliceCoord(width, sx, this.numHSlices);
      const ys = this.sliceCoord(height, sy, this.numVSlices);
      this.slices.push({
        planes: [0, 1, 2, 3].map(() => ({
          quantTableIndex: 0,
          contextCount: 0,
          states: null,
          vlc: null,
        })),
        x: xs,
        y: ys,
        width: this.sliceCoord(width, sx + 1, this.numHSlices) - xs,
        height: this.sliceCoord(height, sy + 1, this.numVSlices) - ys,
        runIndex: 0,
        codingMode: 0,
        rctBy: 1,
        rctRy: 1,
        resetContexts: 0,
      });
    }
    this.lineA = new Int16Array(width + 6);
    this.lineB = new Int16Array(width + 6);
    this.rgbLines = Array.from({ length: 8 }, () => new Int16Array(width + 6));
  }

  get info(): Ffv1StreamInfo {
    return {
      version: this.version,
      microVersion: this.microVersion,
      coder:
        this.ac === AC_GOLOMB_RICE
          ? 'golomb'
          : this.ac === AC_RANGE_CUSTOM_TAB
            ? 'range-custom'
            : 'range-default',
      colorspace: this.colorspace as 0 | 1,
      bitsPerRawSample: this.bitsPerRawSample,
      transparency: this.transparency === 1,
      slices: this.numHSlices * this.numVSlices,
      ec: this.ec,
    };
  }

  /** The picture format {@link decode} produces. */
  get format(): Ffv1Picture['format'] {
    if (this.colorspace === 1) return 'rgb24';
    return this.bitsPerRawSample === 16 ? 'gray16' : 'gray8';
  }

  // --- global header ------------------------------------------------------------------------

  private readQuantTable(c: RangeDecoder, table: Int16Array, scale: number): number {
    const state = new Uint8Array(CONTEXT_SIZE).fill(128);
    let v = 0;
    let i = 0;
    for (v = 0; i < 128; v++) {
      const len = c.symbol(state, 0, false) + 1;
      if (len > 128 - i || len <= 0) throw new Ffv1DecodeError('FFV1 quant table is invalid.');
      for (let n = 0; n < len; n++) table[i++] = scale * v;
    }
    for (i = 1; i < 128; i++) table[256 - i] = -table[i]!;
    table[128] = -table[127]!;
    return 2 * v - 1;
  }

  private readQuantTables(c: RangeDecoder): { tables: Int16Array[]; contexts: number } {
    const tables: Int16Array[] = [];
    let contexts = 1;
    for (let i = 0; i < MAX_CONTEXT_INPUTS; i++) {
      const table = new Int16Array(256);
      contexts *= this.readQuantTable(c, table, contexts);
      tables.push(table);
      if (contexts > 32768) throw new Ffv1DecodeError('FFV1 context count is out of range.');
    }
    return { tables, contexts: (contexts + 1) >> 1 };
  }

  private readExtraHeader(extradata: Uint8Array): void {
    if (extradata.length < 4) throw new Ffv1DecodeError('FFV1 global header is missing.');
    const c = new RangeDecoder(extradata, 0, extradata.length);
    const state = new Uint8Array(CONTEXT_SIZE).fill(128);
    this.version = c.symbol(state, 0, false);
    if (this.version < 3 || this.version > 4) {
      throw new Ffv1DecodeError(`FFV1 version ${this.version} is not supported (3 or 4).`);
    }
    this.combinedVersion = this.version << 16;
    c.end -= 4;
    this.microVersion = c.symbol(state, 0, false);
    if (this.microVersion < 0 || this.microVersion > 65535) {
      throw new Ffv1DecodeError('FFV1 micro version is invalid.');
    }
    this.combinedVersion += this.microVersion;
    this.ac = c.symbol(state, 0, false);
    if (this.ac === AC_RANGE_CUSTOM_TAB) {
      for (let i = 1; i < 256; i++) {
        this.stateTransition[i] = (c.symbol(state, 0, true) + c.oneState[i]!) & 0xff;
      }
    } else {
      for (let i = 1; i < 256; i++) this.stateTransition[i] = DEFAULT_ONE_STATE[i]!;
    }
    this.colorspace = c.symbol(state, 0, false);
    this.bitsPerRawSample = c.symbol(state, 0, false);
    this.chromaPlanes = c.bit(state, 0);
    const chromaH = c.symbol(state, 0, false);
    const chromaV = c.symbol(state, 0, false);
    this.transparency = c.bit(state, 0);
    this.planeCount = 1 + (this.chromaPlanes || this.version < 4 ? 1 : 0) + this.transparency;
    this.numHSlices = 1 + c.symbol(state, 0, false);
    this.numVSlices = 1 + c.symbol(state, 0, false);
    if (
      this.numHSlices > this.width ||
      this.numVSlices > this.height ||
      this.numHSlices * this.numVSlices > MAX_SLICES
    ) {
      throw new Ffv1DecodeError('FFV1 slice layout is invalid.');
    }
    this.quantTableCount = c.symbol(state, 0, false);
    if (this.quantTableCount <= 0 || this.quantTableCount > MAX_QUANT_TABLES) {
      throw new Ffv1DecodeError('FFV1 quant table count is invalid.');
    }
    for (let i = 0; i < this.quantTableCount; i++) {
      const { tables, contexts } = this.readQuantTables(c);
      this.quantTables.push(tables);
      this.contextCount.push(contexts);
    }
    const state2 = Array.from({ length: CONTEXT_SIZE }, () =>
      new Uint8Array(CONTEXT_SIZE).fill(128),
    );
    for (let i = 0; i < this.quantTableCount; i++) {
      const contexts = this.contextCount[i]!;
      const initial = new Uint8Array(contexts * CONTEXT_SIZE).fill(128);
      if (c.bit(state, 0)) {
        for (let j = 0; j < contexts; j++) {
          for (let k = 0; k < CONTEXT_SIZE; k++) {
            const pred = j ? initial[(j - 1) * CONTEXT_SIZE + k]! : 128;
            initial[j * CONTEXT_SIZE + k] = (pred + c.symbol(state2[k]!, 0, true)) & 0xff;
          }
        }
      }
      this.initialStates.push(initial);
    }
    this.ec = c.symbol(state, 0, false);
    if (this.ec >= 2) this.crcRef = 0x7a8c4079;
    if (this.combinedVersion >= 0x30003) c.symbol(state, 0, false); // intra flag
    if (this.combinedVersion >= 0x40004) this.flt = c.symbol(state, 0, false);
    if (crc32(this.crcRef, extradata, 0, extradata.length) !== this.crcRef >>> 0) {
      throw new Ffv1DecodeError('FFV1 global header CRC does not match.');
    }
    // `ff_ffv1_parse_header`: the pixel formats a matte artifact uses.
    if (chromaH !== 0 || chromaV !== 0 || (this.colorspace === 0 && this.chromaPlanes)) {
      throw new Ffv1DecodeError('FFV1 YUV streams are not matte artifacts.');
    }
    // `flt` only changes the pixel format of 16- and 32-bit streams (`ff_ffv1_parse_header`).
    if (this.flt && this.bitsPerRawSample > 8) {
      throw new Ffv1DecodeError('FFV1 float streams are not supported.');
    }
    if (this.colorspace === 0) {
      if (this.transparency || (this.bitsPerRawSample > 8 && this.bitsPerRawSample !== 16)) {
        throw new Ffv1DecodeError('Only 8- and 16-bit gray FFV1 mattes are supported.');
      }
    } else if (this.colorspace === 1) {
      if (this.bitsPerRawSample > 8) {
        throw new Ffv1DecodeError('Only 8-bit RGB FFV1 foregrounds are supported.');
      }
    } else {
      throw new Ffv1DecodeError('FFV1 colorspace is not supported.');
    }
    if (this.bitsPerRawSample === 0) this.bitsPerRawSample = 8;
  }

  /** `ff_slice_coord`. */
  private sliceCoord(size: number, index: number, count: number): number {
    if (this.combinedVersion <= 0x40002) return Math.floor((size * index) / count);
    const mpw = 1;
    const aligned = size;
    let coordinate = Math.floor((2 * aligned * index + count * mpw) / (2 * count * mpw)) * mpw;
    if (coordinate === aligned) coordinate = size;
    return coordinate;
  }

  // --- frames -------------------------------------------------------------------------------

  /**
   * Decode one packet (one frame).
   *
   * @throws Ffv1DecodeError for a corrupt packet, a CRC mismatch, or a non-key frame without
   *   a key frame before it. A damaged slice is an error, not a concealed picture.
   */
  decode(packet: Uint8Array): Ffv1Picture {
    const header = new RangeDecoder(packet, 0, packet.length);
    const keyState = new Uint8Array([128]);
    const keyFrame = header.bit(keyState, 0) === 1;
    if (keyFrame) {
      this.keyFrameOk = false;
    } else if (!this.keyFrameOk) {
      throw new Ffv1DecodeError('An FFV1 non-key frame was decoded without its key frame.');
    }
    const trailer = 3 + (this.ec ? 5 : 0);
    let sliceCount = 0;
    for (let p = packet.length; sliceCount < MAX_SLICES && trailer < p; sliceCount++) {
      const size =
        (packet[p - trailer]! << 16) | (packet[p - trailer + 1]! << 8) | packet[p - trailer + 2]!;
      if (size + trailer > p) break;
      p -= size + trailer;
    }
    if (sliceCount <= 0 || sliceCount > this.slices.length) {
      throw new Ffv1DecodeError('FFV1 frame has an invalid slice count.');
    }
    if (keyFrame) this.keyFrameOk = true;

    const pixels = this.width * this.height;
    const out =
      this.format === 'gray16'
        ? new Uint16Array(pixels)
        : new Uint8Array(this.format === 'rgb24' ? pixels * 3 : pixels);
    const coders: RangeDecoder[] = new Array<RangeDecoder>(sliceCount);
    let bufEnd = packet.length;
    for (let i = sliceCount - 1; i >= 0; i--) {
      const size =
        (packet[bufEnd - trailer]! << 16) |
        (packet[bufEnd - trailer + 1]! << 8) |
        packet[bufEnd - trailer + 2]!;
      const length = size + trailer;
      if (length > bufEnd) throw new Ffv1DecodeError('FFV1 slice pointer chain is broken.');
      const position = i ? bufEnd - length : 0;
      bufEnd -= length;
      if (
        this.ec &&
        crc32(this.crcRef, packet, position, position + length) !== this.crcRef >>> 0
      ) {
        throw new Ffv1DecodeError('FFV1 slice CRC does not match.');
      }
      if (i) {
        coders[i] = new RangeDecoder(packet, position, position + length);
      } else {
        const coder = header.clone();
        coder.end = position + length;
        coders[i] = coder;
      }
    }
    for (let i = 0; i < sliceCount; i++) {
      this.decodeSlice(this.slices[i]!, coders[i]!, packet, keyFrame, out);
    }
    if (this.format === 'gray16') {
      return { format: 'gray16', width: this.width, height: this.height, data: out as Uint16Array };
    }
    return {
      format: this.format,
      width: this.width,
      height: this.height,
      data: out as Uint8Array,
    } as Ffv1Picture;
  }

  private initSliceState(slice: SliceContext, c: RangeDecoder): void {
    for (let j = 0; j < this.planeCount; j++) {
      const plane = slice.planes[j]!;
      if (this.ac !== AC_GOLOMB_RICE) {
        if (plane.states === null) plane.states = new Uint8Array(plane.contextCount * CONTEXT_SIZE);
      } else if (plane.vlc === null) {
        plane.vlc = Array.from({ length: plane.contextCount }, () => ({
          errorSum: 4,
          drift: 0,
          bias: 0,
          count: 1,
        }));
      }
    }
    if (this.ac === AC_RANGE_CUSTOM_TAB) c.setTransitions(this.stateTransition);
  }

  private clearSliceState(slice: SliceContext): void {
    for (let i = 0; i < this.planeCount; i++) {
      const plane = slice.planes[i]!;
      if (this.ac !== AC_GOLOMB_RICE) {
        plane.states!.set(
          this.initialStates[plane.quantTableIndex]!.subarray(0, plane.contextCount * CONTEXT_SIZE),
        );
      } else {
        for (const vlc of plane.vlc!) {
          vlc.drift = 0;
          vlc.errorSum = 4;
          vlc.bias = 0;
          vlc.count = 1;
        }
      }
    }
  }

  private readSliceHeader(slice: SliceContext, c: RangeDecoder): void {
    const state = new Uint8Array(CONTEXT_SIZE).fill(128);
    const sx = c.symbol(state, 0, false);
    const sy = c.symbol(state, 0, false);
    const sw = c.symbol(state, 0, false) + 1;
    const sh = c.symbol(state, 0, false) + 1;
    if (
      sx < 0 ||
      sy < 0 ||
      sw <= 0 ||
      sh <= 0 ||
      sx > this.numHSlices - sw ||
      sy > this.numVSlices - sh
    ) {
      throw new Ffv1DecodeError('FFV1 slice header is invalid.');
    }
    slice.x = this.sliceCoord(this.width, sx, this.numHSlices);
    slice.y = this.sliceCoord(this.height, sy, this.numVSlices);
    slice.width = this.sliceCoord(this.width, sx + sw, this.numHSlices) - slice.x;
    slice.height = this.sliceCoord(this.height, sy + sh, this.numVSlices) - slice.y;
    for (let i = 0; i < this.planeCount; i++) {
      const plane = slice.planes[i]!;
      const index = c.symbol(state, 0, false);
      if (index < 0 || index >= this.quantTableCount) {
        throw new Ffv1DecodeError('FFV1 quant table index is out of range.');
      }
      plane.quantTableIndex = index;
      const contexts = this.contextCount[index]!;
      if (plane.contextCount < contexts) {
        plane.states = null;
        plane.vlc = null;
      }
      plane.contextCount = contexts;
    }
    c.symbol(state, 0, false); // picture structure
    c.symbol(state, 0, false); // sample aspect ratio
    c.symbol(state, 0, false);
    if (this.version > 3) {
      slice.resetContexts = c.bit(state, 0);
      slice.codingMode = c.symbol(state, 0, false);
      if (slice.codingMode !== 1 && this.colorspace === 1) {
        slice.rctBy = c.symbol(state, 0, false);
        slice.rctRy = c.symbol(state, 0, false);
        if (slice.rctBy + slice.rctRy > 4)
          throw new Ffv1DecodeError('FFV1 RCT coefficients are out of range.');
      }
      if (this.combinedVersion >= 0x40004 && c.symbol(state, 0, false) !== 0) {
        throw new Ffv1DecodeError('FFV1 remapped slices are not supported.');
      }
    }
  }

  private decodeSlice(
    slice: SliceContext,
    c: RangeDecoder,
    packet: Uint8Array,
    keyFrame: boolean,
    out: Uint8Array | Uint16Array,
  ): void {
    slice.rctBy = 1;
    slice.rctRy = 1;
    slice.resetContexts = 0;
    slice.codingMode = 0;
    this.initSliceState(slice, c);
    this.readSliceHeader(slice, c);
    this.initSliceState(slice, c);
    if (keyFrame || slice.resetContexts) this.clearSliceState(slice);

    // `int ac = f->ac || sc->slice_coding_mode == 1;`
    const ac = this.ac !== AC_GOLOMB_RICE || slice.codingMode === 1 ? 1 : 0;
    let bits: BitReader | null = null;
    if (ac === AC_GOLOMB_RICE) {
      if (this.combinedVersion >= 0x30002) c.bitWithFreshState(129);
      const acBytes = c.pos - c.start - 1;
      bits = new BitReader(packet, c.start + acBytes, c.end);
    }
    if (this.colorspace === 0) {
      this.decodePlane(slice, c, bits, out, ac);
    } else {
      this.decodeRgb(slice, c, bits, out as Uint8Array, ac);
    }
    if (ac !== AC_GOLOMB_RICE) {
      c.bitWithFreshState(129);
      const remaining = c.end - c.pos - 2 - (this.ec ? 5 : 0);
      if (remaining !== 0) throw new Ffv1DecodeError('FFV1 slice ends at the wrong byte.');
    }
  }

  private decodePlane(
    slice: SliceContext,
    c: RangeDecoder,
    bits: BitReader | null,
    out: Uint8Array | Uint16Array,
    ac: number,
  ): void {
    const w = slice.width;
    const depth = this.bitsPerRawSample <= 8 ? 8 : this.bitsPerRawSample;
    let previous = this.lineA;
    let current = this.lineB;
    previous.fill(0, 0, w + 6);
    current.fill(0, 0, w + 6);
    slice.runIndex = 0;
    for (let y = 0; y < slice.height; y++) {
      const swap = previous;
      previous = current;
      current = swap;
      current[3 - 1] = previous[3]!;
      previous[3 + w] = previous[3 + w - 1]!;
      this.decodeLine(slice, c, bits, w, current, previous, 0, depth, ac);
      const row = (slice.y + y) * this.width + slice.x;
      // `set` converts Int16 → Uint16/Uint8 modulo 2^16/2^8, the same as `& 0xffff` and the
      // byte store the per-sample loops did, in one native copy.
      out.set(current.subarray(3, 3 + w), row);
    }
  }

  private decodeRgb(
    slice: SliceContext,
    c: RangeDecoder,
    bitReader: BitReader | null,
    out: Uint8Array,
    ac: number,
  ): void {
    const w = slice.width;
    const planes = 3 + this.transparency;
    // `ff_ffv1_compute_bits_per_plane` for 8-bit samples without remapping.
    const bits = [8, 8, 8, 8];
    let offset = 0;
    if (slice.codingMode === 0) {
      offset = 256;
      bits[0] = 8;
      bits[1] = ceilLog2(512);
      bits[2] = ceilLog2(512);
      if (this.combinedVersion < 0x40008) {
        bits[0]!++;
        if (this.transparency) bits[3]!++;
      }
    }
    const effectiveAc = slice.codingMode === 1 ? 1 : ac;
    const lines = this.rgbLines;
    for (const line of lines) line.fill(0, 0, w + 6);
    const previous: Int16Array[] = [lines[0]!, lines[2]!, lines[4]!, lines[6]!];
    const current: Int16Array[] = [lines[1]!, lines[3]!, lines[5]!, lines[7]!];
    slice.runIndex = 0;
    for (let y = 0; y < slice.height; y++) {
      for (let p = 0; p < planes; p++) {
        const swap = previous[p]!;
        previous[p] = current[p]!;
        current[p] = swap;
        const cur = current[p]!;
        const prev = previous[p]!;
        cur[3 - 1] = prev[3]!;
        prev[3 + w] = prev[3 + w - 1]!;
        this.decodeLine(slice, c, bitReader, w, cur, prev, (p + 1) >> 1, bits[p]!, effectiveAc);
      }
      const row = ((slice.y + y) * this.width + slice.x) * 3;
      const gLine = current[0]!;
      const bLine = current[1]!;
      const rLine = current[2]!;
      for (let x = 0; x < w; x++) {
        let g = gLine[3 + x]!;
        let b = bLine[3 + x]!;
        let r = rLine[3 + x]!;
        if (slice.codingMode !== 1) {
          b -= offset;
          r -= offset;
          g -= (b * slice.rctBy + r * slice.rctRy) >> 2;
          b += g;
          r += g;
        }
        // The packed 0RGB32 write keeps the low byte of each component.
        out[row + x * 3] = r & 0xff;
        out[row + x * 3 + 1] = g & 0xff;
        out[row + x * 3 + 2] = b & 0xff;
      }
    }
  }

  /**
   * `decode_line`: one row of one plane into `current[3..3+w)`, predicting from `previous`.
   * Both buffers carry three samples of padding either side, as ffmpeg's do.
   */
  private decodeLine(
    slice: SliceContext,
    c: RangeDecoder,
    bits: BitReader | null,
    w: number,
    current: Int16Array,
    previous: Int16Array,
    planeIndex: number,
    depth: number,
    ac: number,
  ): void {
    const plane = slice.planes[planeIndex]!;
    const table = this.quantTables[plane.quantTableIndex]!;
    const q0 = table[0]!;
    const q1 = table[1]!;
    const q2 = table[2]!;
    const q3 = table[3]!;
    const q4 = table[4]!;
    const fiveInputs = q3[127] !== 0 || q4[127] !== 0;
    const mask = depth >= 32 ? 0xffffffff : (1 << depth) - 1;
    if (depth === 0) {
      current.fill(0, 3, 3 + w);
      return;
    }
    this.checkInputEnd(c, bits, ac);
    if (slice.codingMode === 1) {
      const fresh = new Uint8Array(1);
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let i = 0; i < depth; i++) {
          fresh[0] = 128;
          v += v + c.bit(fresh, 0);
        }
        current[3 + x] = v;
      }
      return;
    }
    const states = plane.states;
    let runCount = 0;
    let runMode = 0;
    let runIndex = slice.runIndex;
    for (let x = 0; x < w; x++) {
      if (!(x & 1023)) this.checkInputEnd(c, bits, ac);
      const i = 3 + x;
      const LT = previous[i - 1]!;
      const T = previous[i]!;
      const RT = previous[i + 1]!;
      const L = current[i - 1]!;
      let context = q0[(L - LT) & 0xff]! + q1[(LT - T) & 0xff]! + q2[(T - RT) & 0xff]!;
      if (fiveInputs) {
        const TT = current[i]!;
        const LL = current[i - 2]!;
        context += q3[(LL - L) & 0xff]! + q4[(TT - T) & 0xff]!;
      }
      let sign = false;
      if (context < 0) {
        context = -context;
        sign = true;
      }
      let diff: number;
      if (ac !== AC_GOLOMB_RICE) {
        if (context >= plane.contextCount)
          throw new Ffv1DecodeError('FFV1 context is out of range.');
        diff = c.symbol(states!, context * CONTEXT_SIZE, true);
      } else {
        const reader = bits!;
        if (context === 0 && runMode === 0) runMode = 1;
        if (runMode) {
          if (runCount === 0 && runMode === 1) {
            if (reader.read(1)) {
              runCount = 1 << LOG2_RUN[runIndex]!;
              if (x + runCount <= w) runIndex++;
            } else {
              runCount = LOG2_RUN[runIndex] ? reader.read(LOG2_RUN[runIndex]!) : 0;
              if (runIndex) runIndex--;
              runMode = 2;
            }
          }
          if (current[3 + x - 1] === previous[3 + x - 1]) {
            // A run over a row that repeats the one above: one block copy of the samples the
            // per-sample loop `while (runCount > 1 && w - x > 1)` would copy (PX5.3: a matte is
            // mostly such runs, and the loop was most of its decode time).
            const span = Math.min(runCount - 1, w - x - 1);
            if (span > 0) {
              current.set(previous.subarray(3 + x, 3 + x + span), 3 + x);
              x += span;
              runCount -= span;
            }
          } else {
            while (runCount > 1 && w - x > 1) {
              const j = 3 + x;
              current[j] = midPred(
                current[j - 1]!,
                current[j - 1]! + previous[j]! - previous[j - 1]!,
                previous[j]!,
              );
              x++;
              runCount--;
            }
          }
          runCount--;
          if (runCount < 0) {
            runMode = 0;
            runCount = 0;
            diff = this.vlcSymbol(reader, plane.vlc![context]!, depth);
            if (diff >= 0) diff++;
          } else {
            diff = 0;
          }
        } else {
          diff = this.vlcSymbol(reader, plane.vlc![context]!, depth);
        }
      }
      if (sign) diff = -diff;
      const j = 3 + x;
      const left = current[j - 1]!;
      const top = previous[j]!;
      const prediction = midPred(left, left + top - previous[j - 1]!, top);
      current[j] = (prediction + diff) & mask;
    }
    slice.runIndex = runIndex;
  }

  private checkInputEnd(c: RangeDecoder, bits: BitReader | null, ac: number): void {
    if (ac !== AC_GOLOMB_RICE) {
      if (c.overread > MAX_OVERREAD) throw new Ffv1DecodeError('FFV1 slice data ended early.');
    } else if (bits!.left < 1) {
      throw new Ffv1DecodeError('FFV1 slice data ended early.');
    }
  }

  /** `get_vlc_symbol` + `update_vlc_state`. */
  private vlcSymbol(reader: BitReader, state: VlcState, depth: number): number {
    let i = state.count;
    let k = 0;
    while (i < state.errorSum) {
      k++;
      i += i;
    }
    if (k > depth) k = depth;
    const u = reader.urGolomb(k, 12, depth);
    let v = ((u >>> 1) ^ -(u & 1)) | 0;
    if (2 * state.drift + state.count < 0) v = ~v;
    const result = fold(v + state.bias, depth);
    // update_vlc_state
    let drift = state.drift;
    let count = state.count;
    state.errorSum = (state.errorSum + Math.abs(v)) >>> 0;
    drift += v;
    if (count === 128) {
      count >>= 1;
      drift >>= 1;
      state.errorSum = state.errorSum >>> 1;
    }
    count++;
    if (drift <= -count) {
      state.bias = Math.max(state.bias - 1, -128);
      drift = Math.max(drift + count, -count + 1);
    } else if (drift > 0) {
      state.bias = Math.min(state.bias + 1, 127);
      drift = Math.min(drift - count, 0);
    }
    state.drift = (drift << 16) >> 16;
    state.count = count & 0xff;
    return result;
  }
}
