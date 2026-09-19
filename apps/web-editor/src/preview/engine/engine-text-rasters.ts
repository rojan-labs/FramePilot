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
  return JSON.stringify([
    req.kind,
    req.frameWidth,
    req.frameHeight,
    req.text ?? null,
    req.params ?? null,
  ]);
}

export class EngineTextRasters {
  private readonly ready = new Map<string, EngineTextRaster>();
  /** Refused keys and when they were refused. */
  private readonly failed = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
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
    const raster = this.ready.get(key);
    if (raster) return { state: 'ready', raster };
    if (this.refused(key)) {
      this.setApproximate(true);
      return { state: 'fallback' };
    }
    void this.fetch(key, req);
    return { state: 'pending' };
  }

  /** Resolve once every request is ready or has failed. */
  async ensure(reqs: readonly PreviewTextRasterRequest[]): Promise<void> {
    if (this.source === null) return;
    await Promise.all(
      reqs.map((req) => {
        const key = textRasterKey(req);
        if (this.ready.has(key) || this.refused(key)) return Promise.resolve();
        return this.fetch(key, req);
      }),
    );
  }

  private fetch(key: string, req: PreviewTextRasterRequest): Promise<void> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const source = this.source!;
    const run = (async () => {
      try {
        const result = await source(req);
        if (!result.ok) throw new Error(result.error);
        const bytes = new Uint8ClampedArray(result.width * result.height * 4);
        bytes.set(result.rgba);
        if (this.ready.size >= MAX_ENTRIES) this.ready.delete(this.ready.keys().next().value!);
        this.ready.set(key, {
          image: new ImageData(bytes, result.width, result.height),
          width: result.width,
          height: result.height,
          x: result.x,
          y: result.y,
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
      }
    })();
    this.inFlight.set(key, run);
    return run;
  }

  private setApproximate(value: boolean): void {
    if (value === this.approximate) return;
    this.approximate = value;
    this.onApproximateChange(value);
  }
}
