/**
 * Text and caption rasters from the engine itself (PX2.3, desktop).
 *
 * Pillow rasterises the export's glyphs with FreeType hinting; a canvas cannot match its edge
 * coverage. On the desktop the monitor asks the sidecar for the raster through the compiler's
 * own calls (`POST /preview/text-raster` via the bridge) and only places, transforms and blends
 * it on the GPU. Rasters are cached by what changes their pixels (style params, text, frame
 * size), never by transform, so animated text is not re-rasterised per frame.
 *
 * Without an engine (plain browser) or when a request fails, the caller falls back to the canvas
 * rasteriser and the monitor says "Preview text approximate". It is never silent.
 */
import type { PreviewTextRasterRequest, PreviewTextRasterResult } from '@framepilot/shared-types';
import { createLogger } from '@framepilot/shared-types';
import { getBridge } from '../../editor/bridge-base.js';

const log = createLogger('preview:text-rasters');

/** Rasters kept: a timeline's titles and captions at one or two render scales. */
const MAX_ENTRIES = 256;
/**
 * Bytes kept. An animated caption is one raster per frame (a 1080p chip is about 1.6 MB), and a
 * frame the playhead has passed is not asked for again, so without a byte bound the per-frame
 * entries would hold hundreds of megabytes. Oldest go first, as for the entry bound.
 */
const MAX_BYTES = 96 * 1024 * 1024;
/** A refused request is asked again after this long (the sidecar may have been restarting). */
const RETRY_AFTER_MS = 10_000;

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
  | { readonly state: 'ready'; readonly raster: EngineTextRaster }
  | { readonly state: 'pending' }
  /** No engine, or the engine refused: draw the approximate canvas raster. */
  | { readonly state: 'fallback' };

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
  ]);
}

export class EngineTextRasters {
  private readonly ready = new Map<string, EngineTextRaster>();
  private readyBytes = 0;
  /** Refused keys and when they were refused. */
  private readonly failed = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Styled captions whose raster moves with the frame time, by static key. */
  private readonly animated = new Set<string>();
  /**
   * The first request of a styled caption whose motion is not known yet, by static key. The other
   * frames of the window wait on it: if the cue turns out to be still, they need no request at all.
   */
  private readonly probing = new Map<string, Promise<void>>();
  private approximate = false;

  constructor(
    private readonly source: TextRasterSource | null,
    private readonly onApproximateChange: (approximate: boolean) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True while a refusal is recent enough to keep drawing the fallback (see RETRY_AFTER_MS). */
  private refused(key: string): boolean {
    const at = this.failed.get(key);
    if (at === undefined) return false;
    if (this.now() - at < RETRY_AFTER_MS) return true;
    this.failed.delete(key);
    return false;
  }

  lookup(req: PreviewTextRasterRequest): TextRasterLookup {
    if (this.source === null) {
      this.setApproximate(true);
      return { state: 'fallback' };
    }
    const key = textRasterKey(req);
    const raster = this.ready.get(staticTextRasterKey(req)) ?? this.ready.get(key);
    if (raster) return { state: 'ready', raster };
    if (this.refused(key)) {
      this.setApproximate(true);
      return { state: 'fallback' };
    }
    if (this.awaitingProbe(req) === null) void this.fetch(key, req);
    return { state: 'pending' };
  }

  /** The in-flight probe `req` should wait for instead of asking itself, or `null`. */
  private awaitingProbe(req: PreviewTextRasterRequest): Promise<void> | null {
    if (req.frameTime === undefined) return null;
    const staticKey = staticTextRasterKey(req);
    if (this.animated.has(staticKey)) return null;
    return this.probing.get(staticKey) ?? null;
  }

  /** Resolve once every request is ready or has failed. */
  async ensure(reqs: readonly PreviewTextRasterRequest[]): Promise<void> {
    if (this.source === null) return;
    await Promise.all(
      reqs.map((req) => {
        const key = textRasterKey(req);
        if (this.ready.has(staticTextRasterKey(req)) || this.ready.has(key) || this.refused(key)) {
          return Promise.resolve();
        }
        const probe = this.awaitingProbe(req);
        if (probe !== null) {
          // The probe answers for a still cue; a moving one then needs its own frame.
          return probe.then(() =>
            this.ready.has(staticTextRasterKey(req)) || this.refused(key)
              ? undefined
              : this.fetch(key, req),
          );
        }
        return this.fetch(key, req);
      }),
    );
  }

  private fetch(key: string, req: PreviewTextRasterRequest): Promise<void> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const source = this.source!;
    const staticKey = staticTextRasterKey(req);
    const probe = req.frameTime !== undefined && !this.animated.has(staticKey);
    // Declared first: the body's `finally` compares against it to retire only its own probe.
    let run: Promise<void> | undefined = undefined;
    run = (async () => {
      try {
        const result = await source(req);
        if (!result.ok) throw new Error(result.error);
        if (result.animated === true) this.animated.add(staticKey);
        const bytes = new Uint8ClampedArray(result.width * result.height * 4);
        bytes.set(result.rgba);
        this.makeRoom(bytes.byteLength + (result.backdrop?.byteLength ?? 0));
        // A cue whose raster does not move is one entry for its whole span, not one per frame.
        const stored = req.frameTime !== undefined && result.animated !== true
          ? staticTextRasterKey(req)
          : key;
        const replaced = this.ready.get(stored);
        if (replaced !== undefined) {
          this.ready.delete(stored);
          this.readyBytes -=
            replaced.image.data.byteLength + (replaced.backdrop?.coverage.byteLength ?? 0);
        }
        this.readyBytes += bytes.byteLength + (result.backdrop?.byteLength ?? 0);
        this.ready.set(stored, {
          image: new ImageData(bytes, result.width, result.height),
          width: result.width,
          height: result.height,
          x: result.x,
          y: result.y,
          backdrop:
            result.backdrop === undefined
              ? null
              : { coverage: result.backdrop, sigmaPx: result.backdropSigmaPx ?? 0 },
        });
        this.setApproximate(this.failed.size > 0);
      } catch (error) {
        // Remembered, not retried per frame: a down sidecar would otherwise be asked 60x a second.
        this.failed.set(key, this.now());
        log.warn('engine text raster unavailable; drawing approximate text', {
          kind: req.kind,
          message: error instanceof Error ? error.message : String(error),
        });
        this.setApproximate(true);
      } finally {
        this.inFlight.delete(key);
        if (probe && this.probing.get(staticKey) === run) this.probing.delete(staticKey);
      }
    })();
    this.inFlight.set(key, run);
    if (probe && !this.probing.has(staticKey)) this.probing.set(staticKey, run);
    return run;
  }

  /** Evict the oldest rasters until one more of `incoming` bytes fits both bounds. */
  private makeRoom(incoming: number): void {
    while (
      this.ready.size > 0 &&
      (this.ready.size >= MAX_ENTRIES || this.readyBytes + incoming > MAX_BYTES)
    ) {
      const [oldestKey, oldest] = this.ready.entries().next().value!;
      this.ready.delete(oldestKey);
      this.readyBytes -= oldest.image.data.byteLength + (oldest.backdrop?.coverage.byteLength ?? 0);
    }
  }

  private setApproximate(value: boolean): void {
    if (value === this.approximate) return;
    this.approximate = value;
    this.onApproximateChange(value);
  }
}
