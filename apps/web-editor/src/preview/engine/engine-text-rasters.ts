/**
 * Text and caption rasters from the engine itself (PX2.3, desktop).
 *
 * Pillow rasterises the export's glyphs with FreeType hinting; a canvas cannot match its edge
 * coverage. On the desktop the monitor asks the sidecar for the raster through the compiler's
 * own calls (`POST /preview/text-raster` via the bridge) and only places, transforms and blends
 * it on the GPU. Rasters are cached by what changes their pixels (style params, text, frame
 * size), never by transform, so animated text is not re-rasterised per frame.
 *
 * A styled caption changes with the frame time (every template does: word states, entrances,
 * loops), so it is a raster per project frame. Those are fetched in WINDOWS ahead of the playhead
 * (`POST /preview/caption-frames`: one build of the cue, each distinct raster once) and kept per
 * cue by project frame index. Playback never waits on one: a frame whose raster has not arrived is
 * drawn with the nearest one of the same cue (`lookup(..., 'playback')`), and a paused frame waits
 * for its exact raster (`ensure`).
 *
 * Without an engine (plain browser), when the engine refuses a request, or when it stays
 * unreachable, the caller falls back to the canvas rasteriser and the monitor says "Preview text
 * approximate". It is never silent.
 */
import type {
  PreviewTextRasterImage,
  PreviewTextRasterRequest,
  PreviewTextRasterResult,
} from '@framepilot/shared-types';
import { createLogger, PREVIEW_CAPTION_MAX_FRAMES } from '@framepilot/shared-types';
import { getBridge } from '../../editor/bridge-base.js';

const log = createLogger('preview:text-rasters');

/** Titles, shapes and exact-time captions kept: a timeline's worth at one or two render scales. */
const MAX_SINGLE_ENTRIES = 256;
/**
 * Bytes kept across every raster. A moving 720p caption chip is about 0.7 MB per distinct frame,
 * so this holds a few seconds of the busiest template around the playhead plus every title.
 * Least recently used goes first, and frames the playhead has passed are dropped as it goes.
 */
const MAX_BYTES = 128 * 1024 * 1024;
/** A refused request (the engine says it cannot draw it) is asked again after this long. */
const RETRY_AFTER_REFUSAL_MS = 10_000;
/** A transient failure (sidecar unreachable, slow, failing) is asked again after this long. */
const RETRY_AFTER_TRANSIENT_MS = 1_000;
/**
 * Transient failures in a row before the approximate canvas raster stands in. One timeout while
 * the sidecar is busy used to swap a styled caption for the plain one for ten seconds.
 */
const TRANSIENT_FAILURES_TO_FALL_BACK = 3;
/** Caption windows in flight at once: the sidecar also serves exports, analysis and the agent. */
const MAX_WINDOWS_IN_FLIGHT = 2;
/**
 * Frames per caption window. The engine samples a frame in 5-25 ms, so a window answers in about a
 * tenth of a second and the nearest frames come back first; a whole two-second horizon in one
 * call took half a second and, for a karaoke cue, tens of megabytes per answer.
 */
const CUE_WINDOW_FRAMES = Math.min(15, PREVIEW_CAPTION_MAX_FRAMES);
/** Per-frame requests in flight at once, for a host that cannot answer a window. */
const MAX_SINGLES_IN_FLIGHT = 4;
/** How far back from its frame a playback lookup looks for a stand-in raster of the same cue. */
const MAX_STALE_FRAMES = 240;
/**
 * Seconds of a cue's frames kept around the playhead: one behind (a short rewind) and three ahead
 * (the two-second prefetch horizon and a margin). Stepping backward through a long cue while
 * paused would otherwise keep every frame ahead of it.
 */
const KEEP_BEHIND_SEC = 1;
const KEEP_AHEAD_SEC = 3;
/** Frame-index slack when deciding whether a time is on the project frame grid. */
const GRID_EPSILON_FRAMES = 1e-3;

export type TextRasterSource = (req: PreviewTextRasterRequest) => Promise<PreviewTextRasterResult>;

export interface EngineTextRaster {
  readonly image: ImageData;
  readonly width: number;
  readonly height: number;
  /** A caption's paste position; `null` for a text clip. */
  readonly x: number | null;
  readonly y: number | null;
  /**
   * A frosted-glass chip's coverage (`width` x `height` bytes) and its blur, or `null`: the
   * compositor blurs the picture already drawn under the chip before it draws the caption.
   */
  readonly backdrop: { readonly coverage: Uint8Array; readonly sigmaPx: number } | null;
}

/** What {@link EngineTextRasters.lookup} knows about a request right now. */
export type TextRasterLookup =
  /** `stale`: playback only — the nearest raster of the same cue stands in for this frame's. */
  | { readonly state: 'ready'; readonly raster: EngineTextRaster; readonly stale?: boolean }
  | { readonly state: 'pending' }
  /** No engine, or the engine refused: draw the approximate canvas raster. */
  | { readonly state: 'fallback' };

/** `exact`: a paused frame, which waits for its own raster. `playback`: never waits. */
export type TextRasterLookupMode = 'exact' | 'playback';

/** The cache's own numbers, for the monitor's telemetry and hang reports. */
export interface TextRasterStats {
  readonly bytes: number;
  readonly singles: number;
  readonly cues: number;
  readonly windowsInFlight: number;
  readonly windowsRequested: number;
  /** `false` once a host answered a window with one frame (the oracle's stand-in, for one). */
  readonly windowsSupported: boolean;
}

/**
 * The engine raster source for this host: the desktop bridge, else a test hook the parity
 * oracle installs to stand in for the bridge (it forwards to a real sidecar), else none.
 */
export function resolveTextRasterSource(): TextRasterSource | null {
  const bridge = getBridge();
  if (bridge?.previewTextRaster) return (req) => bridge.previewTextRaster!(req);
  const hook =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { __fpTextRasterSource?: TextRasterSource }).__fpTextRasterSource;
  return hook ?? null;
}

export function textRasterKey(req: PreviewTextRasterRequest): string {
  return JSON.stringify([staticTextRasterKey(req), req.frameTime ?? null]);
}

/**
 * The key of a raster that does not depend on the frame time: every field but `frameTime`.
 *
 * A styled caption is asked for at each frame it is drawn, because only the engine knows
 * whether its style moves (entrances, per-word states, loops). When the answer says it does not,
 * the raster is kept under this key and serves every frame of the cue from one request.
 */
export function staticTextRasterKey(req: PreviewTextRasterRequest): string {
  return JSON.stringify([
    req.kind,
    req.frameWidth,
    req.frameHeight,
    req.text ?? null,
    req.params ?? null,
    req.trackStyle ?? null,
    req.clipStyle ?? null,
    req.words ?? null,
    req.clipStart ?? null,
    req.clipEnd ?? null,
    // A shape on a rotating clip is drawn into a larger, rotation-safe square.
    req.rotates ?? false,
  ]);
}

/** A styled caption: the engine builds it at a frame time (everything else is one raster). */
function movesWithTime(req: PreviewTextRasterRequest): boolean {
  return (
    req.kind === 'caption' &&
    req.frameTime !== undefined &&
    (req.trackStyle !== undefined || req.clipStyle !== undefined)
  );
}

/** One styled cue's rasters, by project frame index. */
interface CueRasters {
  /** Set when the engine said the cue does not move: one raster for every frame. */
  still: EngineTextRaster | null;
  readonly frames: Map<number, EngineTextRaster>;
  /** The raster received last, for a playback stand-in when no nearer frame is held. */
  latest: EngineTextRaster | null;
  /** Frames a window in flight will answer. */
  readonly inFlight: Set<number>;
  bytes: number;
  lastUsed: number;
}

interface Failure {
  readonly at: number;
  readonly transient: boolean;
  readonly count: number;
}

const rasterBytes = (raster: EngineTextRaster): number =>
  raster.image.data.byteLength + (raster.backdrop?.coverage.byteLength ?? 0);

export class EngineTextRasters {
  /** Titles, shapes, unstyled captions and exact-time styled captions, by {@link textRasterKey}. */
  private readonly singles = new Map<string, { raster: EngineTextRaster; lastUsed: number }>();
  private singlesBytes = 0;
  /** Styled cues, by {@link staticTextRasterKey}. */
  private readonly cues = new Map<string, CueRasters>();
  private cuesBytes = 0;
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Failures by request key (singles) or static key (cues). */
  private readonly failures = new Map<string, Failure>();
  private approximate = false;
  /**
   * Between {@link beginFrame} and {@link endFrame}: whether this frame drew any approximate text,
   * and whether any of it was for a failure worth asking again (not a refusal, not "no engine").
   */
  private framing = false;
  private frameFallback = false;
  private frameRetryable = false;
  private lastFrameRetryable = false;
  private frameRate = 0;
  private useCounter = 0;
  private windowsInFlight = 0;
  private windowsRequested = 0;
  private singlesInFlight = 0;
  private windowsSupported = true;

  constructor(
    private readonly source: TextRasterSource | null,
    private readonly onApproximateChange: (approximate: boolean) => void = () => {},
    private readonly now: () => number = () => Date.now(),
    /** Waits between retries of a transient failure (a timer seam for tests). */
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * The lookups of one composited frame follow; {@link endFrame} then sets "approximate" from what
   * that frame drew, so the monitor says it exactly while such a frame is on screen.
   */
  beginFrame(): void {
    this.framing = true;
    this.frameFallback = false;
    this.frameRetryable = false;
  }

  /** @param shown - The frame reached the monitor (a frame abandoned for a missing picture did not). */
  endFrame(shown: boolean): void {
    this.framing = false;
    if (!shown) return;
    this.lastFrameRetryable = this.frameRetryable;
    this.setApproximate(this.frameFallback);
  }

  /**
   * Whether the frame on screen drew approximate text for an engine that was unreachable or slow:
   * asking again later may give the exact text.
   */
  shownFrameCouldRecover(): boolean {
    return this.lastFrameRetryable;
  }

  /** The project frame rate: playback asks for `k / fps`, and cue frames are kept by `k`. */
  setFrameRate(fps: number): void {
    this.frameRate = Number.isFinite(fps) && fps > 0 ? fps : 0;
  }

  /** The project frame index `timeSec` is exactly on, or `null` off the grid (a paused seek). */
  frameIndexOf(timeSec: number): number | null {
    if (this.frameRate <= 0) return null;
    const exact = timeSec * this.frameRate;
    const index = Math.round(exact);
    return Math.abs(exact - index) < GRID_EPSILON_FRAMES ? index : null;
  }

  stats(): TextRasterStats {
    return {
      bytes: this.singlesBytes + this.cuesBytes,
      singles: this.singles.size,
      cues: this.cues.size,
      windowsInFlight: this.windowsInFlight,
      windowsRequested: this.windowsRequested,
      windowsSupported: this.windowsSupported,
    };
  }

  lookup(req: PreviewTextRasterRequest, mode: TextRasterLookupMode = 'exact'): TextRasterLookup {
    if (this.source === null) return this.fallback(null);
    if (!movesWithTime(req)) return this.lookupSingle(textRasterKey(req), req);
    const staticKey = staticTextRasterKey(req);
    const cue = this.cues.get(staticKey);
    if (cue) cue.lastUsed = ++this.useCounter;
    const frameTime = req.frameTime!;
    const frame = this.frameIndexOf(frameTime);
    const exact = this.heldFrame(cue, frame, req);
    if (exact !== null) return { state: 'ready', raster: exact };
    const failure = this.activeFailure(staticKey);
    if (mode === 'playback') {
      // Heal a gap the scheduler has not covered (a seek into the middle of a cue, a window
      // that stopped at the byte budget): ask from here on, without waiting for it.
      if (failure === null && frame !== null && !cue?.inFlight.has(frame)) {
        this.prefetchFrames(req, [frame]);
      }
      const nearest = cue ? this.nearestFrame(cue, frame) : null;
      if (nearest !== null) return { state: 'ready', raster: nearest, stale: true };
      if (failure !== null && this.showsFallback(failure)) return this.fallback(failure);
      return { state: 'pending' };
    }
    if (failure !== null) {
      return this.showsFallback(failure) ? this.fallback(failure) : { state: 'pending' };
    }
    void this.fetchSingleFrame(req);
    return { state: 'pending' };
  }

  /**
   * Resolve once every request is ready or has settled on a failure (a paused frame's exact
   * rasters). A transient failure is asked again, a second apart, until it succeeds or has failed
   * {@link TRANSIENT_FAILURES_TO_FALL_BACK} times, so a paused frame is drawn either exact or
   * visibly approximate: one timeout, or a sidecar still starting, no longer leaves it undrawn.
   */
  async ensure(reqs: readonly PreviewTextRasterRequest[]): Promise<void> {
    if (this.source === null) return;
    const byCue = new Map<string, PreviewTextRasterRequest[]>();
    const waits: Promise<void>[] = [];
    for (const req of reqs) {
      if (!movesWithTime(req)) {
        const key = textRasterKey(req);
        if (this.singles.has(key) || this.settledFailure(key)) continue;
        waits.push(this.retrying(key, () => this.fetchSingle(key, req)));
        continue;
      }
      const staticKey = staticTextRasterKey(req);
      const cue = this.cues.get(staticKey);
      if (this.heldFrame(cue, this.frameIndexOf(req.frameTime!), req) !== null) continue;
      if (this.settledFailure(staticKey)) continue;
      const group = byCue.get(staticKey) ?? [];
      group.push(req);
      byCue.set(staticKey, group);
    }
    for (const [staticKey, group] of byCue) {
      waits.push(this.retrying(staticKey, () => this.ensureCueFrames(group)));
    }
    await Promise.all(waits);
  }

  /**
   * `attempt`, and again after each transient failure of `key` (a second apart, counting from
   * the failure) until it succeeds, is refused, or the streak reaches the fallback.
   */
  private async retrying(key: string, attempt: () => Promise<void>): Promise<void> {
    for (;;) {
      const before = this.failures.get(key);
      if (before?.transient === true && before.count < TRANSIENT_FAILURES_TO_FALL_BACK) {
        const elapsed = this.now() - before.at;
        if (elapsed < RETRY_AFTER_TRANSIENT_MS) await this.wait(RETRY_AFTER_TRANSIENT_MS - elapsed);
      }
      await attempt();
      const failure = this.failures.get(key);
      if (failure === undefined || !failure.transient) return;
      if (failure.count >= TRANSIENT_FAILURES_TO_FALL_BACK) return;
    }
  }

  /** A failure still in force that a paused frame should show as approximate, not wait out. */
  private settledFailure(key: string): boolean {
    const failure = this.activeFailure(key);
    return failure !== null && this.showsFallback(failure);
  }

  /**
   * Fetch, without waiting, the frames of one styled cue that playback is about to show and this
   * cache neither holds nor has asked for. `req` is any request of the cue; its `frameTime` is
   * ignored. Frames the playhead passed long ago are dropped first.
   *
   * @param frames - Project frame indices, in the order they will be shown.
   * @param playheadFrame - The frame on screen now; frames well behind it are released.
   */
  prefetch(
    req: PreviewTextRasterRequest,
    frames: readonly number[],
    playheadFrame: number | null = null,
  ): void {
    if (this.source === null || !movesWithTime({ ...req, frameTime: 0 })) return;
    if (this.frameRate <= 0) return;
    const staticKey = staticTextRasterKey(req);
    if (playheadFrame !== null) this.releaseFramesAwayFrom(staticKey, playheadFrame);
    if (this.activeFailure(staticKey) !== null) return;
    this.prefetchFrames(req, frames);
  }

  // --- styled cues ---------------------------------------------------------------------------

  private cueOf(staticKey: string): CueRasters {
    let cue = this.cues.get(staticKey);
    if (cue === undefined) {
      cue = {
        still: null,
        frames: new Map(),
        latest: null,
        inFlight: new Set(),
        bytes: 0,
        lastUsed: ++this.useCounter,
      };
      this.cues.set(staticKey, cue);
    }
    return cue;
  }

  /** This frame's own raster, if held: the cue's still raster, its grid frame, or an exact time. */
  private heldFrame(
    cue: CueRasters | undefined,
    frame: number | null,
    req: PreviewTextRasterRequest,
  ): EngineTextRaster | null {
    if (cue?.still) return cue.still;
    if (frame !== null) {
      const held = cue?.frames.get(frame);
      if (held !== undefined) return held;
    }
    const single = this.singles.get(textRasterKey(req));
    if (single === undefined) return null;
    single.lastUsed = ++this.useCounter;
    return single.raster;
  }

  /** The held raster nearest before `frame` (then after it), else the latest one received. */
  private nearestFrame(cue: CueRasters, frame: number | null): EngineTextRaster | null {
    if (cue.still) return cue.still;
    if (frame !== null) {
      for (let back = 1; back <= MAX_STALE_FRAMES; back++) {
        const held = cue.frames.get(frame - back);
        if (held !== undefined) return held;
      }
      for (let ahead = 1; ahead <= MAX_STALE_FRAMES; ahead++) {
        const held = cue.frames.get(frame + ahead);
        if (held !== undefined) return held;
      }
    }
    return cue.latest;
  }

  private prefetchFrames(req: PreviewTextRasterRequest, frames: readonly number[]): void {
    const staticKey = staticTextRasterKey(req);
    const cue = this.cueOf(staticKey);
    if (cue.still) return;
    const wanted = frames.filter((frame) => !cue.frames.has(frame) && !cue.inFlight.has(frame));
    if (wanted.length === 0) return;
    if (!this.windowsSupported) {
      // A host without windows: a few frames at a time, nearest first.
      for (const frame of wanted) {
        if (this.singlesInFlight >= MAX_SINGLES_IN_FLIGHT) break;
        cue.inFlight.add(frame);
        this.singlesInFlight++;
        void this.fetchCueFrames(staticKey, req, [frame]).finally(() => {
          this.singlesInFlight--;
        });
      }
      return;
    }
    if (this.windowsInFlight >= MAX_WINDOWS_IN_FLIGHT) return;
    const window = wanted.slice(0, CUE_WINDOW_FRAMES);
    for (const frame of window) cue.inFlight.add(frame);
    this.windowsInFlight++;
    this.windowsRequested++;
    void this.fetchCueFrames(staticKey, req, window).finally(() => {
      this.windowsInFlight--;
    });
  }

  /** A paused frame's exact rasters for one cue: one window, or one probe then per frame. */
  private async ensureCueFrames(group: readonly PreviewTextRasterRequest[]): Promise<void> {
    const first = group[0]!;
    const staticKey = staticTextRasterKey(first);
    const times = [...new Set(group.map((req) => req.frameTime!))];
    await this.fetchCueTimes(staticKey, first, times);
    const cue = this.cues.get(staticKey);
    if (cue?.still || this.activeFailure(staticKey) !== null) return;
    // A host that answered only the first time (no windows): the rest, one frame each.
    const missing = times.filter(
      (time) =>
        this.heldFrame(cue, this.frameIndexOf(time), { ...first, frameTime: time }) === null,
    );
    await Promise.all(missing.map((time) => this.fetchSingleFrame({ ...first, frameTime: time })));
  }

  private fetchCueFrames(
    staticKey: string,
    req: PreviewTextRasterRequest,
    frames: readonly number[],
  ): Promise<void> {
    const times = frames.map((frame) => frame / this.frameRate);
    return this.fetchCueTimes(staticKey, req, times).finally(() => {
      const cue = this.cues.get(staticKey);
      for (const frame of frames) cue?.inFlight.delete(frame);
    });
  }

  /** One answer for `times` of a cue: a window when there are several and the host has them. */
  private fetchCueTimes(
    staticKey: string,
    req: PreviewTextRasterRequest,
    times: readonly number[],
  ): Promise<void> {
    const windowed = times.length > 1 && this.windowsSupported;
    const ask: PreviewTextRasterRequest = {
      ...req,
      // A host that cannot answer a window answers this frame alone.
      frameTime: times[0]!,
      ...(windowed ? { frameTimes: [...times] } : {}),
    };
    const flightKey = windowed ? `${staticKey}|${times.join(',')}` : textRasterKey(ask);
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;
    const run = (async () => {
      const result = await this.ask(ask);
      if (!result.ok) {
        this.recordFailure(staticKey, result, req.kind);
        return;
      }
      this.failures.delete(staticKey);
      const cue = this.cueOf(staticKey);
      if (result.animated !== true) {
        cue.still = toRaster(result);
        cue.frames.clear();
        this.remeasureCue(cue);
        this.makeRoom();
        return;
      }
      const sequence = windowed ? result.sequence : undefined;
      if (windowed && sequence === undefined) {
        this.windowsSupported = false;
        log.debug('text raster host answers one frame per call; asking per frame');
      }
      const answered = sequence ?? { index: [0], rasters: [result] };
      const rasters = answered.rasters.map(toRaster);
      answered.index.forEach((slot, i) => {
        const time = times[i];
        const raster = rasters[slot];
        if (time === undefined || raster === undefined) return;
        this.storeCueFrame(cue, { ...req, frameTime: time }, time, raster);
      });
      cue.latest = rasters[answered.index[answered.index.length - 1] ?? 0] ?? cue.latest;
      this.remeasureCue(cue);
      this.makeRoom();
    })().finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, run);
    return run;
  }

  private fetchSingleFrame(req: PreviewTextRasterRequest): Promise<void> {
    return this.fetchCueTimes(staticTextRasterKey(req), req, [req.frameTime!]);
  }

  private storeCueFrame(
    cue: CueRasters,
    req: PreviewTextRasterRequest,
    time: number,
    raster: EngineTextRaster,
  ): void {
    const frame = this.frameIndexOf(time);
    if (frame !== null) {
      cue.frames.set(frame, raster);
      return;
    }
    // Off the grid (a paused seek at an arbitrary instant): kept as an exact-time single.
    this.storeSingle(textRasterKey(req), raster);
  }

  /**
   * Drop a cue's frames outside {@link KEEP_BEHIND_SEC} behind and {@link KEEP_AHEAD_SEC} ahead of
   * the playhead: frames it has passed are not shown again, and far-ahead ones are asked for again
   * when the prefetch reaches them.
   */
  private releaseFramesAwayFrom(staticKey: string, playheadFrame: number): void {
    const cue = this.cues.get(staticKey);
    if (!cue || cue.frames.size === 0) return;
    const keepFrom = playheadFrame - Math.max(1, Math.round(this.frameRate * KEEP_BEHIND_SEC));
    const keepTo = playheadFrame + Math.max(1, Math.round(this.frameRate * KEEP_AHEAD_SEC));
    let dropped = false;
    for (const frame of cue.frames.keys()) {
      if (frame >= keepFrom && frame <= keepTo) continue;
      cue.frames.delete(frame);
      dropped = true;
    }
    if (dropped) this.remeasureCue(cue);
  }

  /** A cue's bytes: each distinct raster once (frames of a still word state share one). */
  private remeasureCue(cue: CueRasters): void {
    const distinct = new Set<EngineTextRaster>(cue.frames.values());
    if (cue.still) distinct.add(cue.still);
    if (cue.latest) distinct.add(cue.latest);
    let bytes = 0;
    for (const raster of distinct) bytes += rasterBytes(raster);
    this.cuesBytes += bytes - cue.bytes;
    cue.bytes = bytes;
  }

  // --- titles, shapes, unstyled captions -----------------------------------------------------

  private lookupSingle(key: string, req: PreviewTextRasterRequest): TextRasterLookup {
    const held = this.singles.get(key);
    if (held) {
      held.lastUsed = ++this.useCounter;
      return { state: 'ready', raster: held.raster };
    }
    const failure = this.activeFailure(key);
    if (failure !== null) {
      return this.showsFallback(failure) ? this.fallback(failure) : { state: 'pending' };
    }
    void this.fetchSingle(key, req);
    return { state: 'pending' };
  }

  private fetchSingle(key: string, req: PreviewTextRasterRequest): Promise<void> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = (async () => {
      const result = await this.ask(req);
      if (!result.ok) {
        this.recordFailure(key, result, req.kind);
        return;
      }
      this.failures.delete(key);
      this.storeSingle(key, toRaster(result));
      this.makeRoom();
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private storeSingle(key: string, raster: EngineTextRaster): void {
    const replaced = this.singles.get(key);
    if (replaced) this.singlesBytes -= rasterBytes(replaced.raster);
    this.singles.set(key, { raster, lastUsed: ++this.useCounter });
    this.singlesBytes += rasterBytes(raster);
  }

  // --- shared --------------------------------------------------------------------------------

  /** The source's answer, with a thrown error read as a transient failure. */
  private async ask(req: PreviewTextRasterRequest): Promise<PreviewTextRasterResult> {
    try {
      return await this.source!(req);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        transient: true,
      };
    }
  }

  private recordFailure(
    key: string,
    result: Extract<PreviewTextRasterResult, { ok: false }>,
    kind: PreviewTextRasterRequest['kind'],
  ): void {
    const previous = this.failures.get(key);
    const transient = result.transient === true;
    const count =
      previous !== undefined && previous.transient === transient ? previous.count + 1 : 1;
    // Remembered, not retried per frame: a down sidecar would otherwise be asked 60x a second.
    this.failures.set(key, { at: this.now(), transient, count });
    log.warn(
      transient
        ? 'engine text raster unavailable; asking again shortly'
        : 'engine refused a text raster; drawing approximate text',
      { kind, message: result.error, failures: count },
    );
  }

  /** The failure still holding `key` back, or `null` once it is due to be asked again. */
  private activeFailure(key: string): Failure | null {
    const failure = this.failures.get(key);
    if (failure === undefined) return null;
    const wait = failure.transient ? RETRY_AFTER_TRANSIENT_MS : RETRY_AFTER_REFUSAL_MS;
    if (this.now() - failure.at < wait) return failure;
    // Due again. A transient streak is kept (not deleted) so its count carries to the next try.
    if (!failure.transient) this.failures.delete(key);
    return null;
  }

  private showsFallback(failure: Failure): boolean {
    return !failure.transient || failure.count >= TRANSIENT_FAILURES_TO_FALL_BACK;
  }

  /**
   * The approximate canvas raster stands in. Inside a frame it is noted for {@link endFrame};
   * outside one (a caller not composing) the monitor is told at once.
   *
   * @param failure - Why, or `null` when there is no engine at all.
   */
  private fallback(failure: Failure | null): TextRasterLookup {
    if (this.framing) {
      this.frameFallback = true;
      if (failure?.transient === true) this.frameRetryable = true;
    } else {
      this.setApproximate(true);
    }
    return { state: 'fallback' };
  }

  /** Evict least recently used rasters until both bounds hold. */
  private makeRoom(): void {
    while (this.singles.size > MAX_SINGLE_ENTRIES) this.evictOldestSingle();
    while (this.singlesBytes + this.cuesBytes > MAX_BYTES) {
      const single = this.oldestSingle();
      // Never the only cue left: it is the one on screen, trimmed as the playhead passes.
      const cue = this.cues.size > 1 ? this.oldestCue() : null;
      if (single === null && cue === null) return;
      if (cue === null || (single !== null && single.lastUsed <= cue.lastUsed)) {
        this.evictOldestSingle();
        continue;
      }
      this.cues.delete(cue.key);
      this.cuesBytes -= cue.entry.bytes;
    }
  }

  private oldestSingle(): { key: string; lastUsed: number } | null {
    let oldest: { key: string; lastUsed: number } | null = null;
    for (const [key, entry] of this.singles) {
      if (oldest === null || entry.lastUsed < oldest.lastUsed) {
        oldest = { key, lastUsed: entry.lastUsed };
      }
    }
    return oldest;
  }

  private evictOldestSingle(): void {
    const oldest = this.oldestSingle();
    if (oldest === null) return;
    const entry = this.singles.get(oldest.key)!;
    this.singles.delete(oldest.key);
    this.singlesBytes -= rasterBytes(entry.raster);
  }

  private oldestCue(): { key: string; entry: CueRasters; lastUsed: number } | null {
    let oldest: { key: string; entry: CueRasters; lastUsed: number } | null = null;
    for (const [key, entry] of this.cues) {
      if (entry.inFlight.size > 0) continue;
      if (oldest === null || entry.lastUsed < oldest.lastUsed) {
        oldest = { key, entry, lastUsed: entry.lastUsed };
      }
    }
    return oldest;
  }

  private setApproximate(value: boolean): void {
    if (value === this.approximate) return;
    this.approximate = value;
    this.onApproximateChange(value);
  }
}

/** The engine's bytes as a raster the compositor can upload (its own copy, straight RGBA). */
function toRaster(result: PreviewTextRasterImage): EngineTextRaster {
  const bytes = new Uint8ClampedArray(result.width * result.height * 4);
  bytes.set(result.rgba);
  return {
    image: new ImageData(bytes, result.width, result.height),
    width: result.width,
    height: result.height,
    x: result.x,
    y: result.y,
    // Copied too: a window's coverages are views into one response buffer of tens of
    // megabytes, which a kept view would hold alive whole.
    backdrop:
      result.backdrop === undefined
        ? null
        : { coverage: new Uint8Array(result.backdrop), sigmaPx: result.backdropSigmaPx ?? 0 },
  };
}
