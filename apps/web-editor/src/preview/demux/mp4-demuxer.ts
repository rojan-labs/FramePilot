/**
 * MP4 demuxer for the P0 WebCodecs feasibility spike (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md). Wraps `mp4box` to turn a whole,
 * already-fetched proxy file into an in-memory sample table of
 * `EncodedVideoChunk`s ready for `VideoDecoder`.
 *
 * Deliberately NOT streaming: FramePilot's proxies are single-digit MB (P-1
 * proxy spec), so this fetches the whole file and extracts every sample up
 * front rather than using mp4box's progressive/`seek()` machinery meant for
 * network streaming. Seeking is then decoder-only against this table (see
 * `nearestKeyframeIndexAtOrBefore`) — no re-demuxing on scrub.
 *
 * API shapes below were verified empirically against mp4box@2.4.1's actual
 * runtime behavior (not just its docs, which lag the current API in places —
 * e.g. `onError` takes `(module, message)`, and `Sample.is_sync` — not the
 * README's documented `is_rap` — is what v2.4.1 actually sets).
 */
import { MP4BoxBuffer, createFile, DataStream, Endianness, type Sample } from 'mp4box';

export interface DemuxedSampleTable {
  config: VideoDecoderConfig;
  /** DECODE-order encoded chunks — the order they must be fed to
   * `VideoDecoder`. For P-1 proxies (`-bf 0`) decode order equals presentation
   * order; for arbitrary user footage (B-frames) it does not, which is why
   * every consumer-facing index below is a PRESENTATION index and the
   * translation arrays exist. */
  chunks: EncodedVideoChunk[];
  /** Presentation-order timestamps (µs), ascending. Index p is "the p-th frame
   * as displayed" — the frame index every engine/seek API speaks in. Exact
   * per-sample values, so VFR footage maps correctly (no CFR division). */
  presentationTimestampsUs: number[];
  /** decodeIndexByPresentation[p] = index into `chunks` (decode order) of
   * presentation frame p. Identity for `-bf 0` sources. */
  decodeIndexByPresentation: number[];
  /** decodeThroughByPresentation[p] = the highest decode index that must be
   * fed for every presentation frame ≤ p to come out of the decoder
   * (prefix-max of `decodeIndexByPresentation` — with B-frames a displayed
   * frame can depend on a later-decoded reference). */
  decodeThroughByPresentation: number[];
  /** PRESENTATION indices of keyframes, ascending (seek: decode from the
   * nearest one at-or-before the target). */
  keyframePresentationIndices: number[];
  /** Typical duration of one frame in microseconds (first sample's duration) —
   * a display-step fallback only; exact times live in
   * `presentationTimestampsUs`. */
  frameDurationUs: number;
  /**
   * `timescale / first sample duration`: the nominal rate the export's reader indexes frames
   * by (`int(fps * t)`). Exact for the constant-rate proxies (e.g. 15360 / 512 = 30).
   */
  frameRate: number;
}

/** One demuxed sample as a plain object — the mp4box-facing half of this
 * module, kept independent of the browser-only `EncodedVideoChunk`
 * constructor so it's unit-testable with a real fixture under plain Node
 * (which has mp4box but, unlike a browser, no WebCodecs globals). */
export interface RawChunkInit {
  type: 'key' | 'delta';
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

/**
 * Demux every video sample out of a whole MP4 `ArrayBuffer` in one pass.
 *
 * @param source The full file contents (e.g. from `fetch(...).arrayBuffer()`).
 * @param chunkFactory Wraps a `RawChunkInit` into an `EncodedVideoChunk`.
 *   Defaults to the real constructor; tests inject a fake to exercise the
 *   mp4box-facing demux/avcC-extraction logic under plain Node, where
 *   `EncodedVideoChunk` does not exist.
 * @throws {Error} If there is no video track, or its codec has neither an
 *   `avcC` nor `hvcC` configuration box (unsupported codec for this spike).
 */
export function demuxAllVideoSamples(
  source: ArrayBuffer,
  chunkFactory: (init: RawChunkInit) => EncodedVideoChunk = (init) => new EncodedVideoChunk(init),
): Promise<DemuxedSampleTable> {
  return new Promise((resolve, reject) => {
    const file = createFile();
    /** Raw decode-order sample inits — chunks are constructed only AFTER all
     * samples are in, so timestamps can first be normalized to a 0-based
     * presentation clock (see below). */
    const rawInits: RawChunkInit[] = [];
    /** Per decode-order chunk: presentation timestamp (µs) + keyframe flag,
     * kept to build the presentation-order translation arrays afterwards. */
    const sampleMeta: { ctsUs: number; isSync: boolean }[] = [];
    let config: VideoDecoderConfig | undefined;
    let frameDurationUs: number | undefined;
    let frameRate: number | undefined;

    file.onError = (module, message) => {
      reject(new Error(`mp4box demux error in ${module}: ${message}`));
    };

    file.onReady = (info) => {
      const track = info.videoTracks[0];
      if (!track) {
        reject(new Error('No video track found in proxy.'));
        return;
      }
      if (!track.video) {
        reject(new Error(`Video track ${track.id} has no video geometry.`));
        return;
      }
      const { width: codedWidth, height: codedHeight } = track.video;

      file.onSamples = (_trackId, _user, samples) => {
        for (const sample of samples) {
          if (!config) {
            config = buildVideoDecoderConfig(track.codec, codedWidth, codedHeight, sample);
          }
          if (!sample.data) {
            reject(new Error(`Sample ${sample.number} has no data.`));
            return;
          }
          if (frameDurationUs === undefined) {
            frameDurationUs = Math.round((sample.duration * 1_000_000) / sample.timescale);
            frameRate = sample.duration > 0 ? sample.timescale / sample.duration : 0;
          }
          const ctsUs = Math.round((sample.cts * 1_000_000) / sample.timescale);
          sampleMeta.push({ ctsUs, isSync: Boolean(sample.is_sync) });
          rawInits.push({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: ctsUs,
            duration: Math.round((sample.duration * 1_000_000) / sample.timescale),
            data: sample.data,
          });
        }
      };
      file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      file.start();
    };

    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(source, 0));
    file.flush();

    if (!config || frameDurationUs === undefined) {
      reject(new Error('No video samples were extracted from the proxy.'));
      return;
    }
    // Normalize to a 0-based presentation clock: B-frame encoders shift every
    // composition timestamp by the reorder delay (e.g. x264 `-bf 2` puts the
    // first DISPLAYED frame at cts = 2 frames, not 0), so "source time 0"
    // would otherwise fall before the first frame and every in/out point
    // would map ~2 frames early. Subtracting the minimum cts re-anchors both
    // the tables AND the chunk timestamps (which the decoder copies verbatim
    // onto output frames, keeping the output↔table lookup consistent).
    const minCtsUs = Math.min(...sampleMeta.map((m) => m.ctsUs));
    const chunks = rawInits.map((init) =>
      chunkFactory({ ...init, timestamp: init.timestamp - minCtsUs }),
    );
    const normalizedMeta = sampleMeta.map((m) => ({ ctsUs: m.ctsUs - minCtsUs, isSync: m.isSync }));
    resolve({
      config,
      chunks,
      frameDurationUs,
      frameRate: frameRate ?? 0,
      ...buildPresentationTables(normalizedMeta),
    });
  });
}

/**
 * Build the presentation-order views over a decode-order sample list: sort by
 * presentation timestamp, then derive the decode-index translation, the
 * prefix-max "decode through" bound (a displayed frame can depend on a
 * later-decoded reference when B-frames are present), and the keyframes'
 * presentation positions. Pure and exported for unit tests — this arithmetic
 * is exactly what must never be wrong for arbitrary (B-frame/VFR) footage.
 */
export function buildPresentationTables(
  sampleMeta: readonly { ctsUs: number; isSync: boolean }[],
): Pick<
  DemuxedSampleTable,
  | 'presentationTimestampsUs'
  | 'decodeIndexByPresentation'
  | 'decodeThroughByPresentation'
  | 'keyframePresentationIndices'
> {
  const order = sampleMeta.map((_, decodeIndex) => decodeIndex);
  order.sort((a, b) => {
    const metaA = sampleMeta[a];
    const metaB = sampleMeta[b];
    return (metaA?.ctsUs ?? 0) - (metaB?.ctsUs ?? 0);
  });

  const presentationTimestampsUs: number[] = [];
  const decodeIndexByPresentation: number[] = [];
  const decodeThroughByPresentation: number[] = [];
  const keyframePresentationIndices: number[] = [];
  let maxDecodeIndexSoFar = -1;
  order.forEach((decodeIndex, presentationIndex) => {
    const meta = sampleMeta[decodeIndex];
    if (!meta) return;
    presentationTimestampsUs.push(meta.ctsUs);
    decodeIndexByPresentation.push(decodeIndex);
    maxDecodeIndexSoFar = Math.max(maxDecodeIndexSoFar, decodeIndex);
    decodeThroughByPresentation.push(maxDecodeIndexSoFar);
    if (meta.isSync) keyframePresentationIndices.push(presentationIndex);
  });
  return {
    presentationTimestampsUs,
    decodeIndexByPresentation,
    decodeThroughByPresentation,
    keyframePresentationIndices,
  };
}

/**
 * Binary search: the largest presentation index whose timestamp is at or
 * before `timeUs` (clamped to 0 for a time before the first frame). This is
 * the exact VFR-correct "which frame is showing at time t" mapping — the CFR
 * `round(t / frameDuration)` it replaces mis-indexed variable-frame-rate and
 * B-frame footage.
 */
export function presentationIndexAtOrBefore(
  presentationTimestampsUs: readonly number[],
  timeUs: number,
): number {
  let lo = 0;
  let hi = presentationTimestampsUs.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = presentationTimestampsUs[mid];
    if (value !== undefined && value <= timeUs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Extract the avcC/hvcC configuration-box bytes required by
 * `VideoDecoderConfig.description`, from the first sample's description box.
 * The box is serialized whole (`box.write(stream)`) then the 8-byte box
 * header (4-byte size + 4-byte fourcc) is stripped, leaving exactly the
 * codec-specific-config payload WebCodecs expects.
 */
function buildVideoDecoderConfig(
  codec: string,
  codedWidth: number,
  codedHeight: number,
  firstSample: Sample,
): VideoDecoderConfig {
  const description = firstSample.description as {
    avcC?: { write(stream: DataStream): void };
    hvcC?: { write(stream: DataStream): void };
  };
  const configBox = description.avcC ?? description.hvcC;
  if (!configBox) {
    throw new Error(
      `No avcC/hvcC configuration box on codec ${codec} — unsupported codec for this spike.`,
    );
  }
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  configBox.write(stream);
  // Bound by the stream's virtual byteLength, not the (possibly over-allocated)
  // underlying buffer's — DataStream grows its backing buffer geometrically and
  // isn't guaranteed to trim it back to the exact written size.
  const descriptionBytes = new Uint8Array(stream.buffer.slice(8, stream.byteLength));

  return {
    codec,
    codedWidth,
    codedHeight,
    description: descriptionBytes,
    optimizeForLatency: true,
    hardwareAcceleration: 'no-preference',
  };
}

/**
 * Binary search for the last keyframe chunk index at or before
 * `targetChunkIndex` — the decode-from point for a seek to `targetChunkIndex`
 * (decode every chunk from the returned index through the target, in order).
 *
 * @param keyframeChunkIndices Ascending indices into the chunk table
 *   (`DemuxedSampleTable.keyframeChunkIndices`).
 * @param targetChunkIndex The chunk index being sought to.
 * @returns The nearest keyframe chunk index at or before the target.
 * @throws {Error} If `keyframeChunkIndices` is empty, or `targetChunkIndex`
 *   is before the first keyframe (no runway to decode from).
 */
export function nearestKeyframeIndexAtOrBefore(
  keyframeChunkIndices: readonly number[],
  targetChunkIndex: number,
): number {
  const first = keyframeChunkIndices[0];
  if (first === undefined) {
    throw new Error('No keyframes available to seek from.');
  }
  if (targetChunkIndex < first) {
    throw new Error(`Target chunk ${targetChunkIndex} is before the first keyframe (${first}).`);
  }
  let lo = 0;
  let hi = keyframeChunkIndices.length - 1;
  let best = first;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = keyframeChunkIndices[mid];
    if (value !== undefined && value <= targetChunkIndex) {
      best = value;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Random access to a media file's bytes (a `fetch` with `Range`, or an in-memory buffer). */
export interface ByteRangeReader {
  readonly size: number;
  /** Bytes `[start, end)`. */
  read(start: number, end: number): Promise<ArrayBuffer>;
}

/** One sample's location in the file, in decode order (PX2.6). */
export interface SampleLocation {
  readonly offset: number;
  readonly size: number;
  readonly type: 'key' | 'delta';
  /** Normalised presentation timestamp (µs), as {@link DemuxedSampleTable} chunks carry. */
  readonly timestamp: number;
  readonly duration: number;
}

/** A sample table whose sample bytes stay in the file until a decode needs them. */
export interface StreamedSampleTable extends Omit<DemuxedSampleTable, 'chunks'> {
  readonly samples: readonly SampleLocation[];
}

/** How much of the file one parse step reads while looking for `moov`. */
const STREAM_PARSE_STEP_BYTES = 4 * 1024 * 1024;

/**
 * Parse only the sample tables of an MP4 through range reads (PX2.6): `ftyp`/`moov` are read,
 * `mdat` is skipped, so opening a feature-length camera original costs its index, not its size.
 *
 * @throws Error when there is no video track or no decodable codec configuration.
 */
export async function demuxSampleTableStreaming(
  reader: ByteRangeReader,
): Promise<StreamedSampleTable> {
  const file = createFile();
  let failure: Error | null = null;
  let ready = false;
  file.onError = (module, message) => {
    failure = new Error(`mp4box demux error in ${module}: ${message}`);
  };
  file.onReady = () => {
    ready = true;
  };
  let position = 0;
  while (!ready && failure === null && position < reader.size) {
    const end = Math.min(reader.size, position + STREAM_PARSE_STEP_BYTES);
    const bytes = await reader.read(position, end);
    const next = file.appendBuffer(
      MP4BoxBuffer.fromArrayBuffer(bytes, position),
      end >= reader.size,
    );
    position = next > position ? next : end;
  }
  if (!ready) file.flush();
  if (failure !== null) throw failure;
  const info = file.getInfo();
  const track = info.videoTracks[0];
  if (!track?.video) throw new Error('No video track found in media.');
  const samples = file.getTrackSamplesInfo(track.id);
  const first = samples[0];
  if (!first) throw new Error('No video samples were found in the media.');
  const config = buildVideoDecoderConfig(track.codec, track.video.width, track.video.height, first);
  const meta = samples.map((sample) => ({
    ctsUs: Math.round((sample.cts * 1_000_000) / sample.timescale),
    isSync: Boolean(sample.is_sync),
  }));
  const minCtsUs = Math.min(...meta.map((m) => m.ctsUs));
  const normalizedMeta = meta.map((m) => ({ ctsUs: m.ctsUs - minCtsUs, isSync: m.isSync }));
  return {
    config,
    frameDurationUs: Math.round((first.duration * 1_000_000) / first.timescale),
    frameRate: first.duration > 0 ? first.timescale / first.duration : 0,
    samples: samples.map((sample, index) => ({
      offset: sample.offset,
      size: sample.size,
      type: sample.is_sync ? 'key' : 'delta',
      timestamp: normalizedMeta[index]!.ctsUs,
      duration: Math.round((sample.duration * 1_000_000) / sample.timescale),
    })),
    ...buildPresentationTables(normalizedMeta),
  };
}
