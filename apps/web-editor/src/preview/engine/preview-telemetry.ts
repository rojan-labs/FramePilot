/**
 * The layer engine's own playback telemetry (PX5.1, budgets in
 * `plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md` and measured numbers in
 * `plan/background-removal-ai/PX5-BUDGETS.md`).
 *
 * WHY the engine measures itself: the PX5 budgets (≤ 1% dropped frames, seek-to-present
 * ≤ 100 ms, memory bounded by the decoder pool and the picture cache) are claims about what the
 * engine did, and a test harness timing the page from outside measures the harness as well. The
 * budget spec and an editor's session read the same recorder.
 *
 * **Channels** (milliseconds, a ring of the latest samples each):
 *
 * - `frameInterval` — one animation-frame tick to the next during playback. A GPU that cannot
 *   keep up shows here (the browser throttles `requestAnimationFrame`), which `composite` alone
 *   cannot see because GL calls return before the GPU has run them.
 * - `composite` — `present()` on a tick that DREW: plan → raster work → GL submission → the 2D
 *   canvas copy. Main-thread time, not GPU time (unless GPU sync is on, below). A tick whose
 *   frame is unchanged (a 60 Hz display showing a 30 fps frame twice) draws nothing and is not
 *   a sample, or half the samples would be zeros.
 * - `seekToPresent` — `seek()` entered to the frame being on the monitor's canvas. A paused
 *   frame is read back with `readPixels`, so this one includes the GPU's time.
 * - `exactComposite` — the composite inside a seek (full resolution, read back). Seek-to-present
 *   minus this is the wait for decoded pictures and mattes.
 * - `maskRaster` — one CPU mask-stack raster inside a composite (a cache miss; hits cost nothing
 *   and are counted, not timed).
 * - `keyStack` — a key mask's GPU stack (qualifier + finesse chain) inside a composite. GL
 *   submission time only; the chain's GPU cost is the difference between `composite` (GPU sync
 *   on) or `exactComposite` with and without it.
 * - `decode` — one decode-ahead window, request to pictures in the cache.
 *
 * **Dropped frames** are counted, not timed: the project frame index due on every tick is
 * compared with the last index presented. An index that was due and never shown is one dropped
 * frame. It is a property of the tick sequence, so the accounting is unit-tested exactly.
 *
 * **GPU sync** (`gpuSync`) is a measurement mode, off unless a measurement turns it on: the
 * compositor reads one pixel back at the end of a playback composite, which waits for the GPU,
 * so `composite` includes the GPU's work. It stalls the pipeline, so it is never on in a
 * session. `keyStack` stays submission time either way.
 */

/** Samples kept per channel; old ones are dropped. */
const RING_SIZE = 4096;
/** Slack when turning a clock time into a frame index (a tick a hair before a frame boundary). */
const FRAME_INDEX_EPSILON = 1e-6;

export type PreviewTelemetryChannel =
  | 'frameInterval'
  | 'composite'
  | 'seekToPresent'
  | 'exactComposite'
  | 'maskRaster'
  | 'keyStack'
  | 'decode';

const CHANNELS: readonly PreviewTelemetryChannel[] = [
  'frameInterval',
  'composite',
  'seekToPresent',
  'exactComposite',
  'maskRaster',
  'keyStack',
  'decode',
];

/** Byte and occupancy gauges: the current value and the highest seen since the last reset. */
export type PreviewTelemetryGauge =
  'pictureCacheBytes' | 'glPoolBytes' | 'glPoolTargets' | 'liveDecoders';

const GAUGES: readonly PreviewTelemetryGauge[] = [
  'pictureCacheBytes',
  'glPoolBytes',
  'glPoolTargets',
  'liveDecoders',
];

export interface ChannelSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface PlaybackSummary {
  /** Project frames that came due between play and the last tick. */
  readonly expectedFrames: number;
  /** Of those, the ones some tick presented. */
  readonly presentedFrames: number;
  readonly droppedFrames: number;
  /** `droppedFrames / expectedFrames` (0 without playback). */
  readonly droppedShare: number;
  /** Ticks whose frame was not decoded yet (the previous picture stayed up). */
  readonly missingTicks: number;
  /** Render-scale steps taken (PX2.8 load shedding), either direction. */
  readonly renderScaleChanges: number;
  /** The lowest render scale playback reached (1 = never reduced). */
  readonly lowestRenderScale: number;
}

export interface PreviewTelemetrySnapshot {
  readonly channels: Record<PreviewTelemetryChannel, ChannelSummary>;
  readonly playback: PlaybackSummary;
  readonly gauges: Record<
    PreviewTelemetryGauge,
    { readonly current: number; readonly peak: number }
  >;
  readonly maskRasterCacheHits: number;
  readonly gpuSync: boolean;
}

/** A percentile of recorded samples (nearest rank; 0 without samples). */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function summarise(samples: readonly number[]): ChannelSummary {
  return {
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: samples.reduce((max, value) => Math.max(max, value), 0),
  };
}

export class PreviewTelemetry {
  /** See the module note: a one-pixel read-back per playback composite. Measurement only. */
  gpuSync = false;

  private readonly rings = new Map<PreviewTelemetryChannel, number[]>();
  private readonly current = new Map<PreviewTelemetryGauge, number>();
  private readonly peak = new Map<PreviewTelemetryGauge, number>();
  private maskRasterCacheHits = 0;

  private fps = 0;
  private firstDueIndex: number | null = null;
  private lastDueIndex: number | null = null;
  private lastPresentedIndex: number | null = null;
  private presentedFrames = 0;
  private droppedFrames = 0;
  private missingTicks = 0;
  private renderScaleChanges = 0;
  private lowestRenderScale = 1;

  constructor() {
    this.reset();
  }

  /** Record one duration in milliseconds. Non-finite or negative values are ignored. */
  record(channel: PreviewTelemetryChannel, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const ring = this.rings.get(channel)!;
    ring.push(milliseconds);
    if (ring.length > RING_SIZE) ring.shift();
  }

  samples(channel: PreviewTelemetryChannel): readonly number[] {
    return this.rings.get(channel)!;
  }

  /** Set a gauge; its peak follows. */
  gauge(name: PreviewTelemetryGauge, value: number): void {
    if (!Number.isFinite(value)) return;
    this.current.set(name, value);
    if (value > (this.peak.get(name) ?? 0)) this.peak.set(name, value);
  }

  countMaskRasterCacheHit(): void {
    this.maskRasterCacheHits++;
  }

  /** Playback started: frames are due from the one at `startSec`. */
  playbackStarted(fps: number): void {
    this.fps = Math.max(1, fps);
    this.firstDueIndex = null;
    this.lastDueIndex = null;
    this.lastPresentedIndex = null;
  }

  /**
   * One playback tick at project time `timeSec`.
   *
   * @param presented - The frame due now is on the monitor (drawn, or unchanged from the last).
   */
  tick(timeSec: number, presented: boolean): void {
    if (this.fps === 0) return;
    const index = Math.floor(timeSec * this.fps + FRAME_INDEX_EPSILON);
    if (this.firstDueIndex === null) {
      this.firstDueIndex = index;
      // Frames before the first tick were never due in this run.
      this.lastPresentedIndex = index - 1;
    }
    // The audio clock does not run backwards; a repeated index is the display outrunning the
    // project frame rate (two 60 Hz ticks per 30 fps frame), not a new frame due.
    if (this.lastDueIndex === null || index > this.lastDueIndex) this.lastDueIndex = index;
    if (!presented) {
      this.missingTicks++;
      return;
    }
    const last = this.lastPresentedIndex ?? index - 1;
    if (index <= last) return;
    this.droppedFrames += index - last - 1;
    this.presentedFrames++;
    this.lastPresentedIndex = index;
  }

  /** Playback stopped: frames that were due after the last presented one were dropped too. */
  playbackStopped(): void {
    if (this.lastDueIndex !== null && this.lastPresentedIndex !== null) {
      this.droppedFrames += Math.max(0, this.lastDueIndex - this.lastPresentedIndex);
      this.lastPresentedIndex = this.lastDueIndex;
    }
    this.fps = 0;
  }

  renderScaleChanged(scale: number): void {
    this.renderScaleChanges++;
    this.lowestRenderScale = Math.min(this.lowestRenderScale, scale);
  }

  snapshot(): PreviewTelemetrySnapshot {
    const channels = {} as Record<PreviewTelemetryChannel, ChannelSummary>;
    for (const channel of CHANNELS) channels[channel] = summarise(this.rings.get(channel)!);
    const gauges = {} as Record<PreviewTelemetryGauge, { current: number; peak: number }>;
    for (const name of GAUGES) {
      gauges[name] = { current: this.current.get(name) ?? 0, peak: this.peak.get(name) ?? 0 };
    }
    const pending =
      this.fps !== 0 && this.lastDueIndex !== null && this.lastPresentedIndex !== null
        ? Math.max(0, this.lastDueIndex - this.lastPresentedIndex)
        : 0;
    const dropped = this.droppedFrames + pending;
    const expected = this.presentedFrames + dropped;
    return {
      channels,
      playback: {
        expectedFrames: expected,
        presentedFrames: this.presentedFrames,
        droppedFrames: dropped,
        droppedShare: expected === 0 ? 0 : dropped / expected,
        missingTicks: this.missingTicks,
        renderScaleChanges: this.renderScaleChanges,
        lowestRenderScale: this.lowestRenderScale,
      },
      gauges,
      maskRasterCacheHits: this.maskRasterCacheHits,
      gpuSync: this.gpuSync,
    };
  }

  /** Forget every sample, counter and peak (gauges keep their current value). */
  reset(): void {
    for (const channel of CHANNELS) this.rings.set(channel, []);
    for (const name of GAUGES) this.peak.set(name, this.current.get(name) ?? 0);
    this.maskRasterCacheHits = 0;
    this.firstDueIndex = null;
    this.lastDueIndex = null;
    this.lastPresentedIndex = null;
    this.presentedFrames = 0;
    this.droppedFrames = 0;
    this.missingTicks = 0;
    this.renderScaleChanges = 0;
    this.lowestRenderScale = 1;
  }
}
