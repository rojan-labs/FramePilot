/**
 * Filmstrip "picture" layer for a video/image clip — the CapCut-style thumbnail
 * strip that fills the clip body behind the label/badges.
 *
 * Presentation only: it reads engine-derived `media.thumbnailPaths` via
 * {@link clipFilmstripFrames} and lays the frames out as an evenly-spaced flex row.
 * No media is decoded here (render-vs-preview rule); when an asset has no
 * thumbnails yet it falls back to a canvas-drawn procedural filmstrip placeholder
 * (gradient cells, matching the reference mock) so the clip reads as picture even
 * without real thumbnails.
 *
 * Playhead independence: this depends only on clip identity/media/size, never on
 * the playhead — so it never re-renders on a 60fps transport tick (it is memoized
 * and its parent's track-lane memo excludes playhead time).
 */
import { memo, useEffect, useRef } from 'react';
import type { Asset } from '@framepilot/timeline-schema';
import { clipFilmstripFrames } from '../editor/selectors.js';
import { mediaSrc } from '../editor/media.js';
import { useAssetThumbnail, type ThumbnailState } from '../editor/useAssetThumbnail.js';
import { getFrameBitmap, type FrameBitmap } from '../editor/bitmapCache.js';

/** Upper bound on thumbnail frames drawn per clip, to keep the DOM light. */
const MAX_FILMSTRIP_FRAMES = 16;
/** Target on-screen width of one filmstrip frame (px) — slots derive from this. */
const TARGET_FRAME_PX = 56;
/** Cap on a filmstrip canvas backing-store width (device px) — see ADR 0040. */
const MAX_PLACEHOLDER_BACKING_PX = 8192;
/**
 * P3 — zoom-gesture coalescing: during a continuous resize (zoom) the canvas
 * content is FROZEN (CSS stretches the last drawn store) and redrawn once this
 * long after the last resize event — the CapCut/Resolve settle behavior.
 */
const RESIZE_SETTLE_MS = 120;

/**
 * How many filmstrip frames fit a clip of `widthPx` (H6). Width-adaptive so a
 * zoomed-out sliver still shows ONE real frame (a fixed count divided into a
 * narrow clip produced sub-pixel, invisible frames — the "thumbnails
 * disappeared" bug) and a zoomed-in clip fills with more frames instead of
 * stretching a few. Quantized so zooming re-renders the strip only when the
 * slot count actually changes.
 */
export function filmstripSlots(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 1;
  return Math.max(1, Math.min(MAX_FILMSTRIP_FRAMES, Math.round(widthPx / TARGET_FRAME_PX)));
}

export interface ClipFilmstripProps {
  /** The clip's source asset, or `undefined` when unknown (→ placeholder). */
  asset: Asset | undefined;
  /** Source in-point of the clip, in seconds. */
  sourceStart: number;
  /** Source out-point of the clip, in seconds. */
  sourceEnd: number;
  /** Frame slots to draw (from {@link filmstripSlots}); legacy default 8. */
  slots?: number;
}

// Seeded pseudo-random — deterministic per cell position so placeholder cells
// look stable across re-renders (no flicker on zoom / track-resize).
function cellSeed(i: number): number {
  const v = Math.sin(i * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Canvas that draws procedural filmstrip cells when no real thumbnails exist.
 * Matches the visual style of the `artifacts/timeline-mock` reference: evenly-
 * spaced cells with a sky/ground gradient and 1px divider lines, plus a subtle
 * tinted overlay so the placeholder reads as "video content".
 *
 * Repaints via ResizeObserver so it stays sharp at every zoom level. Returns
 * early when the canvas has zero layout size (jsdom / before first paint).
 */
function FilmstripPlaceholderCanvas(): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    function paint(): void {
      const dpr = window.devicePixelRatio || 1;
      // Clamp the backing store: a zoomed-in clip can be 100k+ CSS px wide, and a
      // canvas that size exceeds browser per-dimension limits (~32k device px) and
      // pins hundreds of MB per clip — the "zoom in and the app never recovers"
      // failure. CSS (width:100%) stretches the clamped store across the clip; the
      // procedural cells stretch with it, which is fine for a placeholder.
      const w = Math.min(canvas!.offsetWidth, Math.floor(MAX_PLACEHOLDER_BACKING_PX / dpr));
      const h = canvas!.offsetHeight;
      if (w <= 0 || h <= 0) return;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      const ctx = canvas!.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);

      // Dark base fill so no transparent gaps at the right edge.
      ctx.fillStyle = '#0d1a2a';
      ctx.fillRect(0, 0, w, h);

      // Draw evenly-spaced cells (same formula as the mock's filmstrip()).
      const cellW = Math.max(18, Math.round(h * 0.85));
      const n = Math.ceil(w / cellW);
      for (let i = 0; i < n; i++) {
        const t = cellSeed(i * 1.7);
        const t2 = cellSeed(i * 3.1 + 0.4);
        const r = Math.round(12 + t * 22);
        const g = Math.round(18 + t2 * 28);
        const b = Math.round(26 + t * 26);
        const grd = ctx.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, `rgb(${r + 9},${g + 14},${b + 11})`);
        grd.addColorStop(0.55, `rgb(${r},${g},${b})`);
        grd.addColorStop(
          1,
          `rgb(${Math.round(r * 0.58)},${Math.round(g * 0.6)},${Math.round(b * 0.62)})`,
        );
        ctx.fillStyle = grd;
        ctx.fillRect(i * cellW, 0, cellW - 1, h);
        // 1px divider between cells
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.fillRect(i * cellW + cellW - 1, 0, 1, h);
      }

      // Subtle tinted overlay matching the clip's accent family (video = blue tint).
      ctx.fillStyle = 'rgba(14,46,88,0.28)';
      ctx.fillRect(0, 0, w, h);
    }

    paint();
    // ResizeObserver is absent in jsdom test environments; paint() returns early
    // there anyway (offsetWidth/offsetHeight === 0), so null is correct.
    // Repaints are rAF-coalesced (H6): a zoom gesture resizes EVERY placeholder
    // clip continuously, and an unthrottled full-canvas repaint per RO callback
    // per clip is exactly the zoom jank being fixed.
    let raf = 0;
    const schedulePaint = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedulePaint) : null;
    ro?.observe(canvas);
    return () => {
      ro?.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} className="clip-filmstrip-placeholder" aria-hidden="true" />;
}

/**
 * Resolve the clip's frame slots to READY-to-use URLs (pure; exported for tests):
 * engine paths resolve through `mediaSrc` (→ the sandboxed `fp-media://` scheme the
 * renderer CSP allows); with no engine thumbnails yet, the single bin-captured
 * frame (already a usable URL) is tiled across every slot; with neither, empty.
 */
export function filmstripFrameUrls(
  engineFrames: readonly string[],
  thumb: ThumbnailState,
  slots: number,
): string[] {
  if (engineFrames.length > 0) return engineFrames.map((src) => mediaSrc(src));
  if (thumb.status === 'ready') {
    const { url } = thumb;
    return Array.from({ length: slots }, () => url);
  }
  return [];
}

/** Blit `bitmap` into the slot rect with `object-fit: cover` cropping. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  bitmap: FrameBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const bw = bitmap.width || 1;
  const bh = bitmap.height || 1;
  const scale = Math.max(w / bw, h / bh);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(bitmap, (bw - sw) / 2, (bh - sh) / 2, sw, sh, x, y, w, h);
}

/**
 * ONE canvas per clip drawn from cached decoded bitmaps (P2) — replaces the
 * per-slot `background-image` divs whose re-rasterization on every zoom tick ×
 * every clip was the thumbnail-zoom lag's root cause. Redraws happen only when
 * the frame list changes (slot-bucket crossing / source-window change) or when
 * a resize SETTLES (P3): mid-gesture, CSS stretches the frozen backing store.
 */
function FilmstripCanvas({ frames }: { frames: readonly string[] }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  // Effect keyed by content, not array identity — the parent recomputes the
  // array every render but the strip only redraws when the URLs really change.
  const framesKey = frames.join('\n');

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const urls = framesKey === '' ? [] : framesKey.split('\n');
    // Generation counter invalidates in-flight async draws on re-run/unmount.
    let generation = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    /* v8 ignore start -- canvas pipeline; jsdom offsetWidth/getContext are inert. */
    async function draw(): Promise<void> {
      const gen = ++generation;
      if (!canvas || urls.length === 0) return;
      const dpr = window.devicePixelRatio || 1;
      // Backing store clamped per ADR 0040: a zoomed-in clip can be 100k+ CSS px
      // wide; an unclamped store exceeds browser canvas limits and pins memory.
      const w = Math.min(canvas.offsetWidth, Math.floor(MAX_PLACEHOLDER_BACKING_PX / dpr));
      const h = canvas.offsetHeight;
      if (w <= 0 || h <= 0) return;
      // Each URL decodes ONCE app-wide (P1); repeat URLs share one bitmap.
      const bitmaps = await Promise.all(
        urls.map((url) => getFrameBitmap(url).catch((): null => null)),
      );
      if (gen !== generation) return; // superseded by a newer draw
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#0d1a2a';
      ctx.fillRect(0, 0, w, h);
      const slotW = w / urls.length;
      bitmaps.forEach((bitmap, i) => {
        if (bitmap) drawCover(ctx, bitmap, i * slotW, 0, slotW, h);
        // 1px divider between slots (matches the old per-frame border).
        if (i < urls.length - 1) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
          ctx.fillRect(Math.round((i + 1) * slotW) - 1, 0, 1, h);
        }
      });
    }
    /* v8 ignore stop */

    void draw();
    // P3: a zoom gesture resizes the clip continuously. The last drawn store is
    // frozen (CSS width:100% stretches it) and ONE redraw runs on settle.
    const scheduleSettledDraw = (): void => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        void draw();
      }, RESIZE_SETTLE_MS);
    };
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleSettledDraw) : null;
    ro?.observe(canvas);
    return () => {
      generation += 1;
      ro?.disconnect();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
    };
  }, [framesKey]);

  return <canvas ref={ref} className="clip-filmstrip-canvas" data-frames={frames.length} />;
}

function ClipFilmstripImpl({
  asset,
  sourceStart,
  sourceEnd,
  slots = 8,
}: ClipFilmstripProps): JSX.Element {
  const engineFrames = clipFilmstripFrames(asset, sourceStart, sourceEnd, slots);
  // Fallback preview: when the engine hasn't derived per-clip thumbnails yet
  // (browser mode / engine down), reuse the single representative frame captured
  // for the bin (cached, so it's produced once per asset) tiled across the clip —
  // so a clip shows its actual picture instead of the procedural placeholder.
  const thumb = useAssetThumbnail(asset);
  const frames = filmstripFrameUrls(engineFrames, thumb, slots);

  if (frames.length === 0) {
    // Keep the `clip-filmstrip--skeleton` class so tests and CSS can target the
    // placeholder state; the canvas draws on top of the CSS dark base.
    return (
      <div className="clip-filmstrip clip-filmstrip--skeleton" aria-hidden="true">
        <FilmstripPlaceholderCanvas />
      </div>
    );
  }

  return (
    <div className="clip-filmstrip" aria-hidden="true">
      <FilmstripCanvas frames={frames} />
    </div>
  );
}

/** Memoized so it only re-renders when the asset or source window changes. */
export const ClipFilmstrip = memo(ClipFilmstripImpl);
