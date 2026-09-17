/**
 * A minimal Matroska reader for matte artifacts (BR5.1): one video track, frames in file order.
 *
 * WHY not `mp4box`: a matte artifact's masters are FFV1 in Matroska (`matte.mkv`,
 * `foreground.mkv`), and the preview reads them by range so a long 4K foreground (gigabytes) is
 * never held whole. Frame `i` is the `i`-th block of the track in file order, which is how the
 * export counts matte frames (`render/mattes.py`: "matte frame `i` is the `i`-th decoded
 * frame"). FFV1 has no reordering, so file order is decode order.
 *
 * Indexing: when the file's Cues address every frame (the pack writes intra-only FFV1, one cue
 * per frame) the index comes from the Cues alone; otherwise the clusters are walked header by
 * header. Laced blocks and unknown-size clusters are refused (no muxer we read writes them).
 */
import type { ByteRangeReader } from '../demux/mp4-demuxer.js';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
} as const;

const VIDEO_TRACK_TYPE = 1;
/** Bytes read per head/index window. */
const WINDOW_BYTES = 256 * 1024;
/** Largest element header (4-byte id + 8-byte size) plus a block header. */
const HEADER_PROBE_BYTES = 32;

export class MatroskaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatroskaError';
  }
}

export interface MatroskaVideoTrack {
  readonly number: number;
  readonly codecId: string;
  readonly codecPrivate: Uint8Array | null;
  readonly width: number;
  readonly height: number;
}

/** Where one frame's coded bytes are. */
export interface MatroskaFrame {
  readonly offset: number;
  readonly size: number;
  readonly keyframe: boolean;
}

interface ElementHeader {
  readonly id: number;
  /** `null` for an unknown size. */
  readonly size: number | null;
  readonly headerLength: number;
}

function readVint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    allOnes = allOnes && byte === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function parseHeader(bytes: Uint8Array, at: number): ElementHeader | null {
  const id = readVint(bytes, at, true);
  if (id === null || id.length > 4) return null;
  const size = readVint(bytes, at + id.length, false);
  if (size === null) return null;
  return {
    id: id.value,
    size: size.unknown ? null : size.value,
    headerLength: id.length + size.length,
  };
}

function readUint(bytes: Uint8Array, at: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i]!;
  return value;
}

/** Children of a master element held entirely in `bytes[start, end)`. */
function* children(
  bytes: Uint8Array,
  start: number,
  end: number,
): Generator<ElementHeader & { readonly at: number }> {
  let at = start;
  while (at < end) {
    const header = parseHeader(bytes, at);
    if (header === null || header.size === null) return;
    yield { ...header, at };
    at += header.headerLength + header.size;
  }
}

/** A byte reader that keeps a few recent windows (index walks read many small headers). */
class WindowedReader {
  private readonly windows = new Map<number, Uint8Array>();

  constructor(private readonly reader: ByteRangeReader) {}

  get size(): number {
    return this.reader.size;
  }

  /** `bytes[start, end)`, clamped to the file. */
  async read(start: number, end: number): Promise<Uint8Array> {
    const stop = Math.min(end, this.reader.size);
    if (stop <= start) return new Uint8Array(0);
    if (stop - start > WINDOW_BYTES) return new Uint8Array(await this.reader.read(start, stop));
    const windowStart = Math.floor(start / WINDOW_BYTES) * WINDOW_BYTES;
    if (stop <= windowStart + WINDOW_BYTES) {
      const window = await this.window(windowStart);
      return window.subarray(start - windowStart, stop - windowStart);
    }
    return new Uint8Array(await this.reader.read(start, stop));
  }

  private async window(windowStart: number): Promise<Uint8Array> {
    const cached = this.windows.get(windowStart);
    if (cached !== undefined) return cached;
    const bytes = new Uint8Array(
      await this.reader.read(windowStart, Math.min(this.reader.size, windowStart + WINDOW_BYTES)),
    );
    if (this.windows.size >= 8) this.windows.delete(this.windows.keys().next().value!);
    this.windows.set(windowStart, bytes);
    return bytes;
  }
}

export class MatroskaVideoIndex {
  private constructor(
    private readonly bytes: WindowedReader,
    readonly track: MatroskaVideoTrack,
    private readonly frames: readonly MatroskaFrame[],
  ) {}

  /** Frames in file order. */
  get frameCount(): number {
    return this.frames.length;
  }

  frame(index: number): MatroskaFrame | undefined {
    return this.frames[index];
  }

  /** The key frame at or before `index` (FFV1 carries coder state across non-key frames). */
  keyframeAtOrBefore(index: number): number {
    for (let i = Math.min(index, this.frames.length - 1); i >= 0; i--) {
      if (this.frames[i]!.keyframe) return i;
    }
    throw new MatroskaError('No key frame precedes the requested frame.');
  }

  async readFrame(index: number): Promise<Uint8Array> {
    const frame = this.frames[index];
    if (frame === undefined) throw new MatroskaError(`Frame ${index} is outside the file.`);
    return this.bytes.read(frame.offset, frame.offset + frame.size);
  }

  /**
   * Index a Matroska file's first video track.
   *
   * @param reader - Range reads over the file.
   * @param expectedFrames - Frames the artifact declares; the Cues are trusted only when they
   *   address exactly this many frames of the track.
   * @throws MatroskaError for a file without a readable video track or with a layout it refuses.
   */
  static async open(
    reader: ByteRangeReader,
    expectedFrames: number | null,
  ): Promise<MatroskaVideoIndex> {
    const bytes = new WindowedReader(reader);
    const head = await bytes.read(0, Math.min(reader.size, WINDOW_BYTES));
    const ebml = parseHeader(head, 0);
    if (ebml === null || ebml.id !== ID.EBML || ebml.size === null) {
      throw new MatroskaError('Not a Matroska file.');
    }
    const segmentAt = ebml.headerLength + ebml.size;
    const segmentHead = await bytes.read(segmentAt, segmentAt + HEADER_PROBE_BYTES);
    const segment = parseHeader(segmentHead, 0);
    if (segment === null || segment.id !== ID.Segment)
      throw new MatroskaError('Matroska segment is missing.');
    const segmentData = segmentAt + segment.headerLength;
    const segmentEnd =
      segment.size === null ? reader.size : Math.min(reader.size, segmentData + segment.size);

    let track: MatroskaVideoTrack | null = null;
    let cuesAt: number | null = null;
    let firstCluster: number | null = null;
    let at = segmentData;
    // Top-level elements before the first cluster: SeekHead, Info, Tracks, Tags, Void, ...
    while (at < segmentEnd && firstCluster === null) {
      const probe = await bytes.read(at, at + HEADER_PROBE_BYTES);
      const header = parseHeader(probe, 0);
      if (header === null) throw new MatroskaError('Matroska element header is unreadable.');
      if (header.id === ID.Cluster) {
        firstCluster = at;
        break;
      }
      if (header.size === null)
        throw new MatroskaError('Unknown-size Matroska elements are not supported.');
      const dataStart = at + header.headerLength;
      if (header.id === ID.Tracks) {
        const data = await bytes.read(dataStart, dataStart + header.size);
        track = parseTracks(data);
      } else if (header.id === ID.SeekHead) {
        const data = await bytes.read(dataStart, dataStart + header.size);
        for (const seek of children(data, 0, data.length)) {
          if (seek.id !== ID.Seek || seek.size === null) continue;
          let seekId = 0;
          let position = -1;
          for (const field of children(
            data,
            seek.at + seek.headerLength,
            seek.at + seek.headerLength + seek.size,
          )) {
            const fieldData = field.at + field.headerLength;
            if (field.id === ID.SeekID) seekId = readUint(data, fieldData, field.size!);
            if (field.id === ID.SeekPosition) position = readUint(data, fieldData, field.size!);
          }
          if (seekId === ID.Cues && position >= 0) cuesAt = segmentData + position;
        }
      } else if (header.id === ID.Cues) {
        cuesAt = at;
      }
      at = dataStart + header.size;
    }
    if (track === null) throw new MatroskaError('Matroska file has no video track.');
    if (firstCluster === null) throw new MatroskaError('Matroska file has no frames.');

    let frames: MatroskaFrame[] | null = null;
    if (cuesAt !== null && expectedFrames !== null) {
      frames = await framesFromCues(bytes, cuesAt, segmentData, track.number, expectedFrames);
    }
    frames ??= await framesByWalking(bytes, firstCluster, segmentEnd, track.number);
    return new MatroskaVideoIndex(bytes, track, frames);
  }
}

function parseTracks(data: Uint8Array): MatroskaVideoTrack | null {
  for (const entry of children(data, 0, data.length)) {
    if (entry.id !== ID.TrackEntry || entry.size === null) continue;
    let number = 0;
    let type = 0;
    let codecId = '';
    let codecPrivate: Uint8Array | null = null;
    let width = 0;
    let height = 0;
    const start = entry.at + entry.headerLength;
    for (const field of children(data, start, start + entry.size)) {
      const fieldData = field.at + field.headerLength;
      const size = field.size!;
      if (field.id === ID.TrackNumber) number = readUint(data, fieldData, size);
      else if (field.id === ID.TrackType) type = readUint(data, fieldData, size);
      else if (field.id === ID.CodecID)
        codecId = new TextDecoder().decode(data.subarray(fieldData, fieldData + size));
      else if (field.id === ID.CodecPrivate) codecPrivate = data.slice(fieldData, fieldData + size);
      else if (field.id === ID.Video) {
        for (const video of children(data, fieldData, fieldData + size)) {
          const videoData = video.at + video.headerLength;
          if (video.id === ID.PixelWidth) width = readUint(data, videoData, video.size!);
          if (video.id === ID.PixelHeight) height = readUint(data, videoData, video.size!);
        }
      }
    }
    if (type === VIDEO_TRACK_TYPE) {
      const unwrapped = unwrapVfw(codecId, codecPrivate);
      return { number, ...unwrapped, width, height };
    }
  }
  return null;
}

/** `BITMAPINFOHEADER`, which a `V_MS/VFW/FOURCC` track's `CodecPrivate` starts with. */
const VFW_HEADER_BYTES = 40;
/** Offset of `biCompression` (the FourCC) inside it. */
const VFW_FOURCC_AT = 16;

/**
 * A `V_MS/VFW/FOURCC` track read as its native codec.
 *
 * Matroska carries FFV1 either natively (`V_FFV1`) or wrapped in a Video-for-Windows header,
 * and which one a file has is the muxer's choice, not the pack's: FFmpeg only gained the native
 * CodecID for FFV1 in a recent release, so the same `ffv1` encode writes `V_MS/VFW/FOURCC` on an
 * older ffmpeg (the CI runner's) and `V_FFV1` on a newer one (a developer's). The export's reader
 * is ffmpeg, which takes both, so the monitor takes both too: the FourCC names the codec and the
 * bytes after the `BITMAPINFOHEADER` are the codec's global header.
 */
function unwrapVfw(
  codecId: string,
  codecPrivate: Uint8Array | null,
): { codecId: string; codecPrivate: Uint8Array | null } {
  if (codecId !== 'V_MS/VFW/FOURCC' || codecPrivate === null) return { codecId, codecPrivate };
  if (codecPrivate.length < VFW_HEADER_BYTES) return { codecId, codecPrivate: null };
  const fourcc = String.fromCharCode(
    ...codecPrivate.subarray(VFW_FOURCC_AT, VFW_FOURCC_AT + 4),
  ).toUpperCase();
  if (fourcc !== 'FFV1') return { codecId, codecPrivate };
  const extradata = codecPrivate.subarray(VFW_HEADER_BYTES);
  return { codecId: 'V_FFV1', codecPrivate: extradata.length > 0 ? extradata.slice() : null };
}

/** Parse a block's header at `bytes[0..]`; returns where its frame data starts. */
function blockPayload(
  bytes: Uint8Array,
  trackNumber: number,
  simple: boolean,
): { dataOffset: number; keyframe: boolean } | null {
  const track = readVint(bytes, 0, false);
  if (track === null || track.value !== trackNumber) return null;
  const flags = bytes[track.length + 2];
  if (flags === undefined) return null;
  if ((flags & 0x06) !== 0) throw new MatroskaError('Laced Matroska blocks are not supported.');
  return { dataOffset: track.length + 3, keyframe: simple ? (flags & 0x80) !== 0 : true };
}

/** A frame from the element at `at` (a SimpleBlock or BlockGroup), or `null` for another track. */
async function frameAt(
  bytes: WindowedReader,
  at: number,
  trackNumber: number,
): Promise<MatroskaFrame | null> {
  const probe = await bytes.read(at, at + HEADER_PROBE_BYTES);
  const header = parseHeader(probe, 0);
  if (header === null || header.size === null)
    throw new MatroskaError('Matroska block is unreadable.');
  if (header.id === ID.SimpleBlock) {
    const payload = blockPayload(probe.subarray(header.headerLength), trackNumber, true);
    if (payload === null) return null;
    const offset = at + header.headerLength + payload.dataOffset;
    return { offset, size: header.size - payload.dataOffset, keyframe: payload.keyframe };
  }
  if (header.id === ID.BlockGroup) {
    const group = await bytes.read(
      at + header.headerLength,
      at + header.headerLength + header.size,
    );
    let keyframe = true;
    let found: { at: number; size: number } | null = null;
    for (const child of children(group, 0, group.length)) {
      if (child.id === ID.Block) found = { at: child.at + child.headerLength, size: child.size! };
      // A ReferenceBlock (0xFB) marks a non-key frame.
      if (child.id === 0xfb) keyframe = false;
    }
    if (found === null) return null;
    const payload = blockPayload(group.subarray(found.at), trackNumber, false);
    if (payload === null) return null;
    return {
      offset: at + header.headerLength + found.at + payload.dataOffset,
      size: found.size - payload.dataOffset,
      keyframe,
    };
  }
  return null;
}

async function framesFromCues(
  bytes: WindowedReader,
  cuesAt: number,
  segmentData: number,
  trackNumber: number,
  expectedFrames: number,
): Promise<MatroskaFrame[] | null> {
  const probe = await bytes.read(cuesAt, cuesAt + HEADER_PROBE_BYTES);
  const header = parseHeader(probe, 0);
  if (header === null || header.id !== ID.Cues || header.size === null) return null;
  const data = await bytes.read(
    cuesAt + header.headerLength,
    cuesAt + header.headerLength + header.size,
  );
  const positions: { cluster: number; relative: number }[] = [];
  for (const point of children(data, 0, data.length)) {
    if (point.id !== ID.CuePoint || point.size === null) continue;
    const start = point.at + point.headerLength;
    for (const field of children(data, start, start + point.size)) {
      if (field.id !== ID.CueTrackPositions || field.size === null) continue;
      let cueTrack = 0;
      let cluster = -1;
      let relative = -1;
      const fieldStart = field.at + field.headerLength;
      for (const value of children(data, fieldStart, fieldStart + field.size)) {
        const valueData = value.at + value.headerLength;
        if (value.id === ID.CueTrack) cueTrack = readUint(data, valueData, value.size!);
        if (value.id === ID.CueClusterPosition) cluster = readUint(data, valueData, value.size!);
        if (value.id === ID.CueRelativePosition) relative = readUint(data, valueData, value.size!);
      }
      if (cueTrack !== trackNumber) continue;
      if (cluster < 0 || relative < 0) return null;
      positions.push({ cluster: segmentData + cluster, relative });
    }
  }
  if (positions.length !== expectedFrames) return null;
  positions.sort((a, b) => a.cluster - b.cluster || a.relative - b.relative);
  const clusterData = new Map<number, number>();
  const frames: MatroskaFrame[] = [];
  for (const position of positions) {
    let dataStart = clusterData.get(position.cluster);
    if (dataStart === undefined) {
      const clusterProbe = await bytes.read(
        position.cluster,
        position.cluster + HEADER_PROBE_BYTES,
      );
      const cluster = parseHeader(clusterProbe, 0);
      if (cluster === null || cluster.id !== ID.Cluster) return null;
      dataStart = position.cluster + cluster.headerLength;
      clusterData.set(position.cluster, dataStart);
    }
    const frame = await frameAt(bytes, dataStart + position.relative, trackNumber);
    if (frame === null || !frame.keyframe) return null;
    frames.push(frame);
  }
  return frames;
}

async function framesByWalking(
  bytes: WindowedReader,
  firstCluster: number,
  segmentEnd: number,
  trackNumber: number,
): Promise<MatroskaFrame[]> {
  const frames: MatroskaFrame[] = [];
  let at = firstCluster;
  while (at < segmentEnd) {
    const probe = await bytes.read(at, at + HEADER_PROBE_BYTES);
    const header = parseHeader(probe, 0);
    if (header === null) break;
    if (header.size === null)
      throw new MatroskaError('Unknown-size Matroska clusters are not supported.');
    if (header.id === ID.Cluster) {
      let child = at + header.headerLength;
      const end = child + header.size;
      while (child < end) {
        const childProbe = await bytes.read(child, child + HEADER_PROBE_BYTES);
        const childHeader = parseHeader(childProbe, 0);
        if (childHeader === null || childHeader.size === null) {
          throw new MatroskaError('Matroska cluster is unreadable.');
        }
        if (childHeader.id === ID.SimpleBlock || childHeader.id === ID.BlockGroup) {
          const frame = await frameAt(bytes, child, trackNumber);
          if (frame !== null) frames.push(frame);
        }
        child += childHeader.headerLength + childHeader.size;
      }
    }
    at += header.headerLength + header.size;
  }
  return frames;
}
