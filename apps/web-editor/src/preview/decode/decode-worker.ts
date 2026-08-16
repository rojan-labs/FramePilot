/**
 * Decode worker for the WebCodecs preview (plan PREVIEW-WEBCODECS-COMPOSITOR.md).
 * Demux + `VideoDecoder` live here, off the main thread; presentation (canvas
 * draw, audio clock) stays on main; decoded `VideoFrame`s are transferred back
 * via `postMessage`.
 *
 * One `DecoderSession` per loaded source; sessions are independent so
 * multi-source EDLs decode without cross-source interference.
 *
 * ## Streaming continuation (the "0-lag" decode pipeline)
 *
 * The original spike reset + reconfigured + re-decoded from the nearest
 * keyframe + `flush()`ed on EVERY `decodeRange` call — even a playback
 * continuation contiguous with the previous window. That cost
 * `O(GOP + window)` decodes plus a full pipeline stall per 8-frame window;
 * tolerable on gop=15 proxies, catastrophic on real user footage (GOP 30–60,
 * 4K). This session instead keeps ONE decoder streaming: a contiguous
 * continuation just feeds the next chunks (no reset, no flush, no keyframe
 * prefix) — `O(window)` amortized, the same design every production NLE uses.
 * Only a true seek (non-contiguous range) reconfigures; `flush()` happens only
 * at end-of-table (a legitimate stream end) or as a stall fallback.
 *
 * All indices in the protocol are PRESENTATION indices ("the p-th frame as
 * displayed"); the session translates to decode order internally via the
 * demuxed table, so B-frame footage decodes correctly.
 */
import {
  demuxAllVideoSamples,
  nearestKeyframeIndexAtOrBefore,
  presentationIndexAtOrBefore,
  type DemuxedSampleTable,
} from '../demux/mp4-demuxer.js';

export interface LoadSourceRequest {
  type: 'load';
  requestId: number;
  sourceId: string;
  url: string;
}

export interface DecodeRangeRequest {
  type: 'decodeRange';
  requestId: number;
  sourceId: string;
  /** Inclusive PRESENTATION-index range to have decoded output for. */
  fromChunkIndex: number;
  toChunkIndex: number;
}

export interface StatsRequest {
  type: 'stats';
  requestId: number;
  sourceId: string;
}

export interface UnloadSourceRequest {
  type: 'unload';
  requestId: number;
  sourceId: string;
}

export type WorkerRequest =
  | LoadSourceRequest
  | DecodeRangeRequest
  | StatsRequest
  | UnloadSourceRequest;

export interface LoadedResponse {
  type: 'loaded';
  requestId: number;
  sourceId: string;
  frameCount: number;
  frameDurationUs: number;
  /** Exact presentation-order timestamps (µs) — the engine maps time↔frame
   * with these (VFR-correct), never by dividing by `frameDurationUs`. */
  presentationTimestampsUs: number[];
  codec: string;
  /** The fetched file bytes, TRANSFERRED back to the main thread once the
   * demux has copied what it needs (EncodedVideoChunk copies sample data at
   * construction). Main uses them for `decodeAudioData` — the file is read
   * from disk/network exactly once, not once per consumer. */
  fileBytes: ArrayBuffer;
}

export interface UnloadedResponse {
  type: 'unloaded';
  requestId: number;
  sourceId: string;
}

export interface DecodedFrameMessage {
  type: 'frame';
  requestId: number;
  sourceId: string;
  /** PRESENTATION index of this frame. */
  chunkIndex: number;
  frame: VideoFrame; // transferred
  decodeStartedAtMs: number;
}

export interface RangeDoneResponse {
  type: 'rangeDone';
  requestId: number;
  sourceId: string;
  decodeDurationMs: number;
  reconfigured: boolean;
}

export interface StatsResponse {
  type: 'stats';
  requestId: number;
  sourceId: string;
  /** Number of times this source's decoder was reset+reconfigured — with the
   * streaming session this counts TRUE SEEKS only, not playback windows. */
  reconfigureCount: number;
}

export interface ErrorResponse {
  type: 'error';
  requestId: number;
  message: string;
}

export type WorkerResponse =
  | LoadedResponse
  | UnloadedResponse
  | DecodedFrameMessage
  | RangeDoneResponse
  | StatsResponse
  | ErrorResponse;

interface PostMessageTarget {
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}

type Post = (message: WorkerResponse, transfer: Transferable[]) => void;

/** How many chunks past the strictly-needed decode-through bound we are
 * willing to feed to dislodge a decoder that is withholding output (some
 * hardware decoders buffer a few frames regardless of `optimizeForLatency`).
 * Each overfed chunk can add at most one stashed (held, unclosed) VideoFrame,
 * so this bounds the stash's pressure on Chromium's output-frame pool. */
const STALL_OVERFEED_MAX = 8;

/** How long to wait for decoder output before escalating (overfeed, then
 * flush). Generous vs. real decode times (~1–2 ms/frame HW) so it only fires
 * on a genuinely stalled pipeline, while still bounding worst-case latency. */
const OUTPUT_STALL_TIMEOUT_MS = 50;

class DecoderSession {
  /** One decoder for the lifetime of this session — reused via reset() +
   * configure() across every seek, never replaced. Creating a fresh
   * VideoDecoder per seek leaked decoder instances and silently exhausted
   * Chrome's concurrent hardware-decoder limit (gate #5). */
  private decoder: VideoDecoder | undefined;
  private table: DemuxedSampleTable | undefined;
  private reconfigureCount = 0;

  // -- Streaming state (valid while `streamActive`) --------------------------
  /** True while the decoder is mid-stream: configured, fed a contiguous run of
   * decode-order chunks since the last configure, and NOT flushed. Only then
   * can the next contiguous request skip the reseek. */
  private streamActive = false;
  /** Next decode-order chunk index to feed. */
  private feedCursor = 0;
  /** Highest presentation index observed from the decoder this stream. */
  private lastOutputPresentation = -1;
  /** Last presentation index the previous decodeRange call served — the next
   * call is a continuation iff its `from` is exactly this + 1. */
  private lastServedTo = -1;
  /** Decoded frames beyond the current request's range (stall-overfeed
   * products) held for the NEXT contiguous request. Keyed by presentation
   * index; closed on reseek/dispose so they can never leak. */
  private readonly stash = new Map<number, VideoFrame>();

  // -- Current-call fields read by the constructor-bound output callback -----
  private currentRequestId = 0;
  private currentDecodeStartedAtMs = 0;
  private currentFrom = 0;
  private currentTo = -1;

  /** Resolvers woken on every decoder output (progress signal for the
   * await-outputs loop). */
  private outputWaiters: (() => void)[] = [];

  /** Serializes decodeRange calls: the engine's pump and an external seek can
   * both be in flight; interleaving their feeds would corrupt the stream. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sourceId: string,
    private readonly post: Post,
  ) {}

  async load(url: string): Promise<{
    frameCount: number;
    frameDurationUs: number;
    presentationTimestampsUs: number[];
    codec: string;
    fileBytes: ArrayBuffer;
  }> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    this.table = await demuxAllVideoSamples(arrayBuffer);
    return {
      frameCount: this.table.presentationTimestampsUs.length,
      frameDurationUs: this.table.frameDurationUs,
      presentationTimestampsUs: this.table.presentationTimestampsUs,
      codec: this.table.config.codec,
      fileBytes: arrayBuffer,
    };
  }

  decodeRange(
    requestId: number,
    fromPresentation: number,
    toPresentation: number,
  ): Promise<{ decodeDurationMs: number; reconfigured: boolean }> {
    const run = this.queue.then(() =>
      this.decodeRangeSerialized(requestId, fromPresentation, toPresentation),
    );
    // Keep the queue alive past a rejection so a failed call doesn't wedge
    // every subsequent one; the failure still propagates to THIS caller.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async decodeRangeSerialized(
    requestId: number,
    fromPresentation: number,
    toPresentation: number,
  ): Promise<{ decodeDurationMs: number; reconfigured: boolean }> {
    const table = this.table;
    if (!table) throw new Error(`Source ${this.sourceId} not loaded.`);

    const startedAt = performance.now();
    this.currentRequestId = requestId;
    this.currentDecodeStartedAtMs = startedAt;
    this.currentFrom = fromPresentation;
    this.currentTo = toPresentation;

    const continuation =
      this.streamActive &&
      this.decoder !== undefined &&
      this.decoder.state === 'configured' &&
      fromPresentation === this.lastServedTo + 1;

    if (!continuation) {
      this.reseek(table, fromPresentation);
    }

    // Serve any stashed frames (produced by a previous call's stall-overfeed)
    // that fall in this range — posted FIRST so the main thread receives
    // frames in presentation order.
    for (let p = fromPresentation; p <= toPresentation; p++) {
      const stashed = this.stash.get(p);
      if (!stashed) continue;
      this.stash.delete(p);
      this.post(
        {
          type: 'frame',
          requestId,
          sourceId: this.sourceId,
          chunkIndex: p,
          frame: stashed,
          decodeStartedAtMs: startedAt,
        },
        [stashed],
      );
    }

    await this.feedAndAwait(table, toPresentation);

    this.lastServedTo = toPresentation;
    return { decodeDurationMs: performance.now() - startedAt, reconfigured: !continuation };
  }

  /** Abandon the current stream (a true seek): drop stashed frames, reset and
   * reconfigure the decoder, and aim the feed cursor at the nearest keyframe
   * at-or-before the target presentation index. */
  private reseek(table: DemuxedSampleTable, fromPresentation: number): void {
    this.closeStash();
    const keyframePresentation = nearestKeyframeIndexAtOrBefore(
      table.keyframePresentationIndices,
      fromPresentation,
    );
    const keyframeDecodeIndex = table.decodeIndexByPresentation[keyframePresentation];
    if (keyframeDecodeIndex === undefined) {
      throw new Error(`No decode index for keyframe presentation ${keyframePresentation}.`);
    }
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new VideoDecoder({
        output: (frame) => this.handleOutput(frame),
        error: (err) => {
          this.streamActive = false;
          this.wakeOutputWaiters();
          this.post(
            {
              type: 'error',
              requestId: this.currentRequestId,
              message: `decoder error: ${err.message}`,
            },
            [],
          );
        },
      });
    } else {
      this.decoder.reset();
    }
    this.decoder.configure(table.config);
    this.reconfigureCount++;
    this.feedCursor = keyframeDecodeIndex;
    this.lastOutputPresentation = -1;
    this.streamActive = true;
  }

  /**
   * Feed the decode-order chunks required for every presentation frame ≤
   * `toPresentation`, then await their outputs. Escalation if the decoder
   * withholds output: overfeed up to {@link STALL_OVERFEED_MAX} extra chunks
   * (products beyond the range are stashed for the next call), and as a last
   * resort `flush()` (which forcibly drains the pipeline but ends the stream —
   * the next call reseeks).
   */
  private async feedAndAwait(table: DemuxedSampleTable, toPresentation: number): Promise<void> {
    const decoder = this.decoder;
    if (!decoder) throw new Error('feedAndAwait without a configured decoder.');
    const feedTarget = table.decodeThroughByPresentation[toPresentation];
    if (feedTarget === undefined) {
      throw new Error(
        `Presentation index ${toPresentation} out of range for source ${this.sourceId}.`,
      );
    }

    this.feedThrough(table, feedTarget);

    let overfed = 0;
    let consecutiveStalledWaits = 0;
    while (this.lastOutputPresentation < toPresentation && this.streamActive) {
      // decodeQueueSize === 0 → every fed chunk was consumed, yet the target
      // frame hasn't come out: the decoder is withholding it pending more
      // input (hardware pipelining) — escalate immediately, no timeout wait.
      // Repeated timed-out waits with input still queued means the pipeline
      // is wedged — escalate the same way rather than waiting forever.
      const stalled = decoder.decodeQueueSize === 0 || consecutiveStalledWaits >= 3;
      if (stalled && this.feedCursor < table.chunks.length && overfed < STALL_OVERFEED_MAX) {
        this.feedThrough(table, this.feedCursor); // dislodge with ONE more chunk
        overfed++;
        consecutiveStalledWaits = 0;
        continue;
      }
      if (stalled) {
        // End of table, or overfeed exhausted: drain by flushing. This is the
        // normal stream end at the last frames of a source, and the safety
        // net for a pathological decoder; either way the stream is over.
        this.streamActive = false;
        await decoder.flush();
        continue;
      }
      // Input still queued — decode is in progress; wait for the next output
      // (the timeout is only a safety net against a wedged pipeline).
      const progressed = await this.awaitOutputProgress();
      consecutiveStalledWaits = progressed ? 0 : consecutiveStalledWaits + 1;
    }
  }

  /** Feed decode-order chunks `[feedCursor .. throughDecodeIndex]`. */
  private feedThrough(table: DemuxedSampleTable, throughDecodeIndex: number): void {
    const decoder = this.decoder;
    if (!decoder) return;
    while (this.feedCursor <= throughDecodeIndex && this.feedCursor < table.chunks.length) {
      const chunk = table.chunks[this.feedCursor];
      if (!chunk) throw new Error(`Chunk ${this.feedCursor} missing for source ${this.sourceId}.`);
      decoder.decode(chunk);
      this.feedCursor++;
    }
  }

  /** Resolve on the next decoder output (true) or on the stall timeout
   * (false). The timeout only bounds the WAIT; it never abandons frames. */
  private awaitOutputProgress(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), OUTPUT_STALL_TIMEOUT_MS);
      this.outputWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private wakeOutputWaiters(): void {
    const waiters = this.outputWaiters;
    this.outputWaiters = [];
    for (const wake of waiters) wake();
  }

  stats(): { reconfigureCount: number } {
    return { reconfigureCount: this.reconfigureCount };
  }

  dispose(): void {
    this.closeStash();
    this.streamActive = false;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
    this.wakeOutputWaiters();
  }

  private closeStash(): void {
    for (const frame of this.stash.values()) frame.close();
    this.stash.clear();
  }

  private handleOutput(frame: VideoFrame): void {
    const table = this.table;
    if (!table) {
      frame.close();
      return;
    }
    // Chunk timestamps are copied verbatim onto output frames, so this lookup
    // is an exact match — the binary search just avoids a Map allocation.
    const presentation = presentationIndexAtOrBefore(
      table.presentationTimestampsUs,
      frame.timestamp,
    );
    this.lastOutputPresentation = presentation;
    if (presentation < this.currentFrom) {
      // Keyframe-prefix frame decoded only to reach the seek target — close
      // here rather than transfer it for main to immediately discard.
      frame.close();
    } else if (presentation <= this.currentTo) {
      this.post(
        {
          type: 'frame',
          requestId: this.currentRequestId,
          sourceId: this.sourceId,
          chunkIndex: presentation,
          frame,
          decodeStartedAtMs: this.currentDecodeStartedAtMs,
        },
        [frame],
      );
    } else {
      // Beyond the current range (stall-overfeed product): hold for the next
      // contiguous request instead of discarding a decoded frame.
      this.stash.set(presentation, frame);
    }
    this.wakeOutputWaiters();
  }
}

const sessions = new Map<string, DecoderSession>();

function post(message: WorkerResponse, transfer: Transferable[]): void {
  (self as unknown as PostMessageTarget).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      const session = new DecoderSession(request.sourceId, post);
      sessions.get(request.sourceId)?.dispose();
      sessions.set(request.sourceId, session);
      const { frameCount, frameDurationUs, presentationTimestampsUs, codec, fileBytes } =
        await session.load(request.url);
      post(
        {
          type: 'loaded',
          requestId: request.requestId,
          sourceId: request.sourceId,
          frameCount,
          frameDurationUs,
          presentationTimestampsUs,
          codec,
          fileBytes,
        },
        [fileBytes],
      );
    } else if (request.type === 'unload') {
      sessions.get(request.sourceId)?.dispose();
      sessions.delete(request.sourceId);
      post({ type: 'unloaded', requestId: request.requestId, sourceId: request.sourceId }, []);
    } else if (request.type === 'decodeRange') {
      const session = sessions.get(request.sourceId);
      if (!session) throw new Error(`Source ${request.sourceId} not loaded.`);
      const { decodeDurationMs, reconfigured } = await session.decodeRange(
        request.requestId,
        request.fromChunkIndex,
        request.toChunkIndex,
      );
      post(
        {
          type: 'rangeDone',
          requestId: request.requestId,
          sourceId: request.sourceId,
          decodeDurationMs,
          reconfigured,
        },
        [],
      );
    } else if (request.type === 'stats') {
      const session = sessions.get(request.sourceId);
      if (!session) throw new Error(`Source ${request.sourceId} not loaded.`);
      const { reconfigureCount } = session.stats();
      post(
        {
          type: 'stats',
          requestId: request.requestId,
          sourceId: request.sourceId,
          reconfigureCount,
        },
        [],
      );
    }
  } catch (err) {
    post(
      {
        type: 'error',
        requestId: request.requestId,
        message: err instanceof Error ? err.message : String(err),
      },
      [],
    );
  }
};
