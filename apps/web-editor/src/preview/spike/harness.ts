/**
 * P0 WebCodecs feasibility spike harness (plan PREVIEW-WEBCODECS-COMPOSITOR.md).
 *
 * Orchestrates the decode worker, a presentation canvas, and the
 * audio-master clock, and exposes `window.__framepilotSpike` — a typed RPC
 * surface Playwright drives via `page.evaluate` (see the spec for why: no
 * console-log parsing, no DOM-blob polling races). Every gate reads its
 * ground truth off the *canvas pixels* (the watermark), never off
 * `VideoFrame.timestamp` bookkeeping, so a bug that corrupts bookkeeping but
 * not presented pixels still fails the gate.
 *
 * This file is spike-only glue (excluded from vitest coverage, see
 * vite.config.ts) — it is expected to shrink or disappear once P1 begins;
 * the modules it wires together (`demux/`, `decode/`, `clock/`) are the
 * parts that survive.
 */
import {
  WATERMARK_STRIP_HEIGHT,
  WATERMARK_STRIP_WIDTH,
  decodeWatermarkFrameIndex,
} from './watermark.js';
import { FrameRing, type Closable } from '../decode/frame-ring.js';
import { AudioMasterClock } from '../clock/audio-clock.js';
import { DecodeWorkerClient } from '../decode/worker-client.js';

export interface SourceSpec {
  id: string;
  url: string;
}

export interface CutReport {
  totalCuts: number;
  totalFramesExpected: number;
  totalFramesPresented: number;
  violations: string[];
  presentedSequenceMonotonic: boolean;
}

export interface SeekSample {
  targetChunkIndex: number;
  latencyMs: number;
  reconfigured: boolean;
}

export interface SeekReport {
  samples: SeekSample[];
  p95LatencyMs: number;
}

export interface ScrubSample {
  latencyMs: number;
}

export interface ScrubReport {
  samples: ScrubSample[];
  p95LatencyMs: number;
}

export interface AvSyncSample {
  ctxNowSec: number;
  driftUs: number;
}

export interface AvSyncReport {
  samples: AvSyncSample[];
  maxAbsDriftUs: number;
  frameDurationUs: number;
  watermarkViolations: string[];
  visibilityInvalidated: boolean;
}

export interface ResourceReport {
  inFlightPeak: number;
  framesCreatedTotal: number;
  framesClosedTotal: number;
  reconfigureCounts: Record<string, number>;
}

export interface LoadedSourceInfo {
  frameCount: number;
  frameDurationUs: number;
  codec: string;
}

interface TaggedFrame extends Closable {
  videoFrame: VideoFrame;
  sourceId: string;
  chunkIndex: number;
}

function percentile(valuesMs: number[], p: number): number {
  if (valuesMs.length === 0) return 0;
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export class SpikeHarness {
  ready = false;

  private readonly client = new DecodeWorkerClient();
  private sources = new Map<string, LoadedSourceInfo>();
  private ctx2d: CanvasRenderingContext2D | undefined;
  private audioClock: AudioMasterClock | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx2d = canvas.getContext('2d') ?? undefined;
    if (!this.ctx2d) throw new Error('Canvas 2D context unavailable.');
  }

  private drawAndReadWatermark(frame: VideoFrame): number {
    const ctx = this.ctx2d;
    if (!ctx) throw new Error('No canvas context.');
    ctx.drawImage(frame, 0, 0);
    const imageData = ctx.getImageData(0, 0, WATERMARK_STRIP_WIDTH, WATERMARK_STRIP_HEIGHT);
    return decodeWatermarkFrameIndex(imageData.data, WATERMARK_STRIP_WIDTH);
  }

  async load(sourceSpecs: SourceSpec[]): Promise<void> {
    for (const spec of sourceSpecs) {
      const response = await this.client.loadSource(spec.id, spec.url);
      this.sources.set(spec.id, {
        frameCount: response.frameCount,
        frameDurationUs: response.frameDurationUs,
        codec: response.codec,
      });
    }
    this.ready = true;
  }

  sourceInfo(sourceId: string): LoadedSourceInfo | undefined {
    return this.sources.get(sourceId);
  }

  /** Gate #1: cut continuity. Builds a deterministic EDL of `spec.cuts`
   * segments alternating between the loaded sources (even cuts start at
   * chunk 0 — the untrimmed case with no pre-roll runway; odd cuts start at
   * a deterministic non-zero offset — the trimmed case), decodes each
   * segment, presents every resulting frame to canvas, and checks the
   * watermark read back matches the expected chunk index exactly once each,
   * in order — zero dropped/repeated/misordered frames. */
  async runCutTest(spec: { cuts: number; segmentFrames: number }): Promise<CutReport> {
    const sourceIds = [...this.sources.keys()];
    if (sourceIds.length < 1) throw new Error('No sources loaded.');
    const violations: string[] = [];
    let totalFramesPresented = 0;
    let totalFramesExpected = 0;
    let monotonic = true;

    for (let cut = 0; cut < spec.cuts; cut++) {
      const sourceId = sourceIds[cut % sourceIds.length];
      if (!sourceId) continue;
      const info = this.sources.get(sourceId);
      if (!info) continue;
      const maxStart = Math.max(0, info.frameCount - spec.segmentFrames);
      // Deterministic pseudo-varied offset, alternating by ROUND (every
      // sourceIds.length cuts) rather than by raw cut parity — with N
      // sources, `cut % 2` and `cut % sourceIds.length` collapse to the same
      // modulus whenever sourceIds.length is 2, which would silently give
      // one source only ever the untrimmed case and the other only ever the
      // trimmed case. P-1's whole motivation is that BOTH cases matter for
      // EVERY source.
      const round = Math.floor(cut / sourceIds.length);
      const startFrame = round % 2 === 0 ? 0 : (cut * 37) % (maxStart + 1);
      const endFrame = Math.min(info.frameCount - 1, startFrame + spec.segmentFrames - 1);
      totalFramesExpected += endFrame - startFrame + 1;

      const { frames } = await this.client.decodeRange(sourceId, startFrame, endFrame);
      let expectedNext = startFrame;
      for (const frameMsg of frames) {
        totalFramesPresented++;
        const watermark = this.drawAndReadWatermark(frameMsg.frame);
        this.client.closeFrame(frameMsg.frame);
        if (frameMsg.chunkIndex !== expectedNext) {
          monotonic = false;
          violations.push(
            `cut ${cut} (${sourceId}): expected chunk ${expectedNext}, worker reported ${frameMsg.chunkIndex}`,
          );
        }
        if (watermark !== frameMsg.chunkIndex) {
          violations.push(
            `cut ${cut} (${sourceId}): chunk ${frameMsg.chunkIndex} watermark read ${watermark} (pixels don't match bookkeeping)`,
          );
        }
        expectedNext++;
      }
      if (frames.length !== endFrame - startFrame + 1) {
        monotonic = false;
        violations.push(
          `cut ${cut} (${sourceId}): expected ${endFrame - startFrame + 1} frames, got ${frames.length}`,
        );
      }
    }

    return {
      totalCuts: spec.cuts,
      totalFramesExpected,
      totalFramesPresented,
      violations,
      presentedSequenceMonotonic: monotonic && violations.length === 0,
    };
  }

  /** Gate #2: cold seek-to-frame latency. Forces a reset+reconfigure+decode
   * on every sample by alternating far-apart targets. */
  async runSeekTest(spec: { seeks: number; sourceId: string }): Promise<SeekReport> {
    const info = this.sources.get(spec.sourceId);
    if (!info) throw new Error(`Source ${spec.sourceId} not loaded.`);
    const samples: SeekSample[] = [];
    for (let i = 0; i < spec.seeks; i++) {
      // Alternate ends of the source so every sample is a genuine cold seek,
      // never a contiguous continuation the decoder could skip reconfiguring.
      const targetChunkIndex =
        i % 2 === 0 ? Math.floor(info.frameCount * 0.75) : Math.floor(info.frameCount * 0.1);
      const { frames, decodeDurationMs, reconfigured } = await this.client.decodeRange(
        spec.sourceId,
        targetChunkIndex,
        targetChunkIndex,
      );
      for (const frameMsg of frames) {
        this.client.closeFrame(frameMsg.frame);
      }
      samples.push({ targetChunkIndex, latencyMs: decodeDurationMs, reconfigured });
    }
    return {
      samples,
      p95LatencyMs: percentile(
        samples.map((s) => s.latencyMs),
        95,
      ),
    };
  }

  /** Gate #3: scrub responsiveness. Simulates a continuous drag as a burst
   * of single-frame seeks at `spec.hz` for `spec.durationMs`. */
  async runScrubTest(spec: {
    sourceId: string;
    durationMs: number;
    hz: number;
  }): Promise<ScrubReport> {
    const info = this.sources.get(spec.sourceId);
    if (!info) throw new Error(`Source ${spec.sourceId} not loaded.`);
    const intervalMs = 1000 / spec.hz;
    const tickCount = Math.round(spec.durationMs / intervalMs);
    const samples: ScrubSample[] = [];
    for (let i = 0; i < tickCount; i++) {
      const targetChunkIndex = Math.floor((i / tickCount) * (info.frameCount - 1));
      const startedAt = performance.now();
      const { frames } = await this.client.decodeRange(
        spec.sourceId,
        targetChunkIndex,
        targetChunkIndex,
      );
      for (const frameMsg of frames) {
        this.drawAndReadWatermark(frameMsg.frame);
        this.client.closeFrame(frameMsg.frame);
      }
      samples.push({ latencyMs: performance.now() - startedAt });
    }
    return {
      samples,
      p95LatencyMs: percentile(
        samples.map((s) => s.latencyMs),
        95,
      ),
    };
  }

  /** Resume the AudioContext — must be called from a real user gesture (a
   * click) in browsers that enforce the autoplay policy; the Playwright spec
   * either clicks a Start button or launches with the policy disabled. */
  async startAudio(): Promise<void> {
    const ctx = new AudioContext();
    this.audioClock = new AudioMasterClock(ctx);
    await this.audioClock.start();
  }

  /** Gate #4: A/V sync. Builds `spec.cuts` equal-length segments spanning
   * `spec.seconds` total, alternating sources, decodes each source's audio
   * track whole via `decodeAudioData` (a deliberate spike shortcut — P2
   * swaps in AudioDecoder behind the same clock interface), schedules them
   * gapless on the audio-master clock, and drives video presentation purely
   * from `clock.nowMediaUs()` — never rAF-only timekeeping. */
  async runAvSyncTest(spec: {
    seconds: number;
    cuts: number;
    sourceUrls: Record<string, string>;
  }): Promise<AvSyncReport> {
    if (!this.audioClock) throw new Error('startAudio() must be called first.');
    const sourceIds = [...this.sources.keys()];
    if (sourceIds.length < 1) throw new Error('No sources loaded.');
    const segmentSeconds = spec.seconds / spec.cuts;

    type Segment = {
      sourceId: string;
      startFrame: number;
      frameCount: number;
      mediaStartUs: number;
      mediaEndUs: number;
    };
    const segments: Segment[] = [];
    let mediaCursorUs = 0;
    for (let i = 0; i < spec.cuts; i++) {
      const sourceId = sourceIds[i % sourceIds.length];
      if (!sourceId) continue;
      const info = this.sources.get(sourceId);
      if (!info) continue;
      const frameCount = Math.round((segmentSeconds * 1_000_000) / info.frameDurationUs);
      // Alternate by ROUND (every sourceIds.length segments), not raw index —
      // see the identical fix + rationale in runCutTest.
      const round = Math.floor(i / sourceIds.length);
      const startFrame = round % 2 === 0 ? 0 : Math.max(0, info.frameCount - frameCount);
      const durationUs = frameCount * info.frameDurationUs;
      segments.push({
        sourceId,
        startFrame,
        frameCount,
        mediaStartUs: mediaCursorUs,
        mediaEndUs: mediaCursorUs + durationUs,
      });
      mediaCursorUs += durationUs;
    }
    // Decode each source's whole audio track up front (data prep only — does
    // NOT start playback). Scheduling on the audio-master clock happens
    // AFTER decode-ahead priming below, not here: scheduleSegments() commits
    // audio to start at `ctx.currentTime + a small fixed lead`, so calling it
    // before the (real-wall-clock-costly) priming pump() gives audio a head
    // start video can never claw back — the actual root cause of a drift bug
    // this session's own verification caught (growing negative drift that
    // was really "video is perpetually behind because audio already started
    // while video was still filling its decode-ahead buffer").
    const audioBuffers = new Map<string, AudioBuffer>();
    const ctx = new AudioContext();
    for (const [sourceId, url] of Object.entries(spec.sourceUrls)) {
      const arrayBuffer = await (await fetch(url)).arrayBuffer();
      audioBuffers.set(sourceId, await ctx.decodeAudioData(arrayBuffer));
    }
    const scheduledAudioSegments = segments.map((seg) => {
      const buffer = audioBuffers.get(seg.sourceId);
      if (!buffer) throw new Error(`No audio buffer for ${seg.sourceId}`);
      const info = this.sources.get(seg.sourceId);
      if (!info) throw new Error(`No source info for ${seg.sourceId}`);
      return {
        mediaStartUs: seg.mediaStartUs,
        buffer,
        offsetSec: (seg.startFrame * info.frameDurationUs) / 1_000_000,
        durationSec: (seg.frameCount * info.frameDurationUs) / 1_000_000,
      };
    });

    // A REAL jitter buffer, not a whole-segment burst: pushing an entire
    // multi-second segment's frames into the ring in one shot guarantees
    // most of them get evicted by the ring's own capacity cap (FrameRing.push
    // closes the oldest frame once over capacity) long before playback
    // reaches them — a real bug this design caught during P0 verification
    // (drift grew to ~1.1 frame durations by segment end because only the
    // ring's LAST `capacity` frames of a burst-decoded segment survived).
    // Decode-ahead here is windowed and paced to the ring's fill level,
    // matching the plan's target architecture ("decode N frames ahead"),
    // not "decode the whole segment ahead." Capacity matches the plan's P0
    // gate #5 budget (<=24 in-flight VideoFrames for a multi-clip timeline).
    const RING_CAPACITY = 24;
    const WINDOW_FRAMES = 8;
    const REFILL_BELOW = 12;
    const ring = new FrameRing<TaggedFrame>(RING_CAPACITY);
    const samples: AvSyncSample[] = [];
    const watermarkViolations: string[] = [];
    let visibilityInvalidated = false;

    let segmentCursor = 0;
    let chunkCursorWithinSegment = 0;
    let pumping = false;

    const pump = async () => {
      if (pumping) return;
      pumping = true;
      try {
        while (ring.size < REFILL_BELOW && segmentCursor < segments.length) {
          const segment = segments[segmentCursor];
          if (!segment) break;
          const remainingInSegment = segment.frameCount - chunkCursorWithinSegment;
          if (remainingInSegment <= 0) {
            segmentCursor++;
            chunkCursorWithinSegment = 0;
            continue;
          }
          const windowSize = Math.min(WINDOW_FRAMES, remainingInSegment);
          const from = segment.startFrame + chunkCursorWithinSegment;
          const to = from + windowSize - 1;
          const { frames } = await this.client.decodeRange(segment.sourceId, from, to);
          for (const frameMsg of frames) {
            const mediaTimeUs =
              segment.mediaStartUs +
              ((frameMsg.chunkIndex - segment.startFrame) *
                (segment.mediaEndUs - segment.mediaStartUs)) /
                segment.frameCount;
            ring.push({
              timestamp: Math.round(mediaTimeUs),
              videoFrame: frameMsg.frame,
              sourceId: segment.sourceId,
              chunkIndex: frameMsg.chunkIndex,
              close: () => this.client.closeFrame(frameMsg.frame),
            });
          }
          chunkCursorWithinSegment += windowSize;
        }
      } finally {
        pumping = false;
      }
    };

    // Prime the ring BEFORE starting the clock, so presentation never starts
    // on an empty buffer AND audio never gets a head start while video is
    // still filling its decode-ahead buffer (see the comment above).
    await pump();
    this.audioClock.scheduleSegments(scheduledAudioSegments);

    const totalDurationUs = mediaCursorUs;
    const frameDurationUs =
      this.sources.get(segments[0]?.sourceId ?? sourceIds[0] ?? '')?.frameDurationUs ?? 33_333;

    await new Promise<void>((resolve) => {
      const tick = () => {
        if (document.visibilityState !== 'visible') {
          visibilityInvalidated = true;
        }
        const nowMediaUs = this.audioClock?.nowMediaUs() ?? 0;
        // Check end-of-content BEFORE measuring a sample for this tick: once
        // nowMediaUs reaches the end, there is no "next" frame to have
        // presented (chunk 299 is the true last frame of the whole EDL) —
        // the "current" frame necessarily holds past its own end until this
        // check fires, which is an unavoidable, honest artifact of finite
        // content ending, not a buffering/decode-ahead failure. Measuring
        // drift only over samples strictly within real content keeps the
        // gate about steady-state playback, which is what it's meant for.
        if (nowMediaUs >= totalDurationUs) {
          ring.clear();
          resolve();
          return;
        }
        ring.evictBefore(nowMediaUs);
        void pump();
        const current = ring.frameAt(nowMediaUs);
        if (current) {
          const watermark = this.drawAndReadWatermark(current.videoFrame);
          if (watermark !== current.chunkIndex) {
            watermarkViolations.push(
              `${current.sourceId} chunk ${current.chunkIndex}: watermark read ${watermark}`,
            );
          }
          samples.push({
            ctxNowSec: nowMediaUs / 1_000_000,
            driftUs: current.timestamp - nowMediaUs,
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const maxAbsDriftUs = samples.reduce((max, s) => Math.max(max, Math.abs(s.driftUs)), 0);
    return { samples, maxAbsDriftUs, frameDurationUs, watermarkViolations, visibilityInvalidated };
  }

  /** Gate #5: resource hygiene snapshot. `inFlightPeak` is the real
   * high-water mark of `framesCreatedTotal - framesClosedTotal` observed
   * across every gate run so far (frames genuinely overlap in-flight while a
   * decodeRange's whole batch is collected before being drawn+closed one by
   * one, and while the gate #4 ring holds decode-ahead frames). */
  async resourceStats(): Promise<ResourceReport> {
    const reconfigureCounts: Record<string, number> = {};
    for (const sourceId of this.sources.keys()) {
      reconfigureCounts[sourceId] = await this.client.reconfigureCountFor(sourceId);
    }
    return { ...this.client.frameAccounting(), reconfigureCounts };
  }
}
