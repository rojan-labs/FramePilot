/**
 * One matte artifact file (`matte.mkv` or `foreground.mkv`) decoded in the decode worker (BR5.1).
 *
 * WHY here: picture decode already lives in this worker behind one decoder pool, and a matte is
 * decoded like a picture: by frame, forward from a key frame, with a bounded number of live
 * decoders. The session indexes the Matroska file once (`matroska-demuxer.ts`), reads frames by
 * range, and keeps its FFV1 decoder positioned so contiguous playback decodes each frame once.
 * The pool may take the decoder back; the next request then restarts from a key frame.
 */
import type { ByteRangeReader } from '../demux/mp4-demuxer.js';
import type { DecoderPool, PooledDecoderHolder } from './decoder-pool.js';
import { Ffv1Decoder, type Ffv1Picture } from './ffv1/ffv1-decoder.js';
import { MatroskaVideoIndex } from './matroska-demuxer.js';

/** Bytes of the first probe: enough for a small artifact's whole head and index. */
const PROBE_BYTES = 256 * 1024;

export interface MatteFileInfo {
  readonly width: number;
  readonly height: number;
  readonly format: Ffv1Picture['format'];
  readonly frameCount: number;
}

/**
 * A byte reader over `url`: range reads when the server honours them, else the whole body
 * (a static route that ignores `Range`, as the parity oracle's media route does).
 */
export async function openByteSource(url: string): Promise<ByteRangeReader> {
  const probe = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } });
  if (!probe.ok) throw new Error(`Matte file request failed: ${probe.status}.`);
  const total = Number(/\/(\d+)$/.exec(probe.headers.get('Content-Range') ?? '')?.[1] ?? NaN);
  if (probe.status === 206 && Number.isFinite(total)) {
    const head = new Uint8Array(await probe.arrayBuffer());
    return {
      size: total,
      async read(start: number, end: number): Promise<ArrayBuffer> {
        if (end <= head.length) return head.slice(start, end).buffer;
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
        if (response.status !== 206) {
          throw new Error(`Matte file range read returned ${response.status}, expected 206.`);
        }
        return response.arrayBuffer();
      },
    };
  }
  const whole = new Uint8Array(await probe.arrayBuffer());
  return {
    size: whole.length,
    read: (start: number, end: number) => Promise.resolve(whole.slice(start, end).buffer),
  };
}

export class MatteDecodeSession implements PooledDecoderHolder {
  busy = false;
  private index: MatroskaVideoIndex | null = null;
  private decoder: Ffv1Decoder | null = null;
  /** The frame the decoder can decode next without restarting (-1: none). */
  private nextFrame = -1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pool: DecoderPool<PooledDecoderHolder>,
    private readonly openReader: (url: string) => Promise<ByteRangeReader> = openByteSource,
  ) {}

  /**
   * Index the file and read its global header.
   *
   * @param expectedFrames - `frames.json`'s frame count (trusts the Cues only when they agree).
   * @throws MatroskaError / Ffv1DecodeError for a file the preview cannot read exactly.
   */
  async load(url: string, expectedFrames: number | null): Promise<MatteFileInfo> {
    const index = await MatroskaVideoIndex.open(await this.openReader(url), expectedFrames);
    if (index.track.codecId !== 'V_FFV1' || index.track.codecPrivate === null) {
      throw new Error('Matte file is not FFV1.');
    }
    // Parse the global header now, so a format the preview cannot read fails at load.
    const probe = new Ffv1Decoder(index.track.width, index.track.height, index.track.codecPrivate);
    this.index = index;
    return {
      width: index.track.width,
      height: index.track.height,
      format: probe.format,
      frameCount: index.frameCount,
    };
  }

  /** Decode frame `frame` (file order), serialised with every other request on this file. */
  decode(frame: number): Promise<Ffv1Picture> {
    const run = this.queue.then(async () => {
      this.busy = true;
      try {
        return await this.decodeSerialized(frame);
      } finally {
        this.busy = false;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async decodeSerialized(frame: number): Promise<Ffv1Picture> {
    const index = this.index;
    if (index === null) throw new Error('Matte file is not loaded.');
    if (frame < 0 || frame >= index.frameCount) {
      throw new Error(`Matte frame ${frame} is outside the file.`);
    }
    const key = index.keyframeAtOrBefore(frame);
    let from = key;
    if (this.decoder !== null && this.nextFrame > key && this.nextFrame <= frame) {
      from = this.nextFrame;
      this.pool.touch(this);
    } else {
      this.pool.admit(this);
      this.decoder = new Ffv1Decoder(
        index.track.width,
        index.track.height,
        index.track.codecPrivate!,
      );
    }
    const decoder = this.decoder!;
    let picture: Ffv1Picture | null = null;
    for (let i = from; i <= frame; i += 1) {
      try {
        picture = decoder.decode(await index.readFrame(i));
      } catch (error) {
        this.nextFrame = -1;
        this.decoder = null;
        throw error;
      }
      this.nextFrame = i + 1;
    }
    return picture!;
  }

  releaseDecoder(): void {
    this.decoder = null;
    this.nextFrame = -1;
  }

  dispose(): void {
    this.pool.forget(this);
    this.releaseDecoder();
    this.index = null;
  }
}
