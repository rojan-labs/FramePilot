/**
 * Canvas-based audio waveform for timeline clips.
 *
 * Responsiveness: a ResizeObserver watches the canvas element so any change
 * to the clip's CSS size (zoom in/out, trim, window resize) triggers an
 * immediate repaint at the correct physical resolution — no prop needed.
 *
 * Performance: the first paint goes through OffscreenCanvas → createImageBitmap
 * so the main thread isn't blocked. Subsequent identical sizes are served from
 * the ImageBitmap cache as a single drawImage() call.
 *
 * Playhead independence: this canvas only redraws when peak data or clip size
 * changes — never for playhead movement, which lives on a separate CSS layer.
 */
import { useEffect, useRef } from 'react';
import type { AssetMedia } from '@framepilot/timeline-schema';
import { useWaveformPeaks } from '../editor/useWaveformPeaks.js';
import { renderWaveform } from '../editor/waveformRenderer.js';
import { LruCache } from '../editor/lruCache.js';

// ── ImageBitmap cache ──────────────────────────────────────────────────────
// Key: "{assetId}:{bucketW}:{physH}". One bitmap per asset × bucketed width.
//
// A continuous zoom gesture resizes every clip every animation frame, so keying
// on the EXACT physical width minted a brand-new ImageBitmap per frame — an
// unbounded cache of GPU-backed bitmaps that made repeated zooming lag the whole
// app. Two fixes: (1) quantize the width to WIDTH_BUCKET_PX buckets so nearby zoom
// levels reuse one bitmap (blitted scaled to the exact size — imperceptible for a
// waveform), and (2) bound the cache with an LRU that closes each evicted bitmap
// so its backing memory is freed immediately.
const MAX_WAVEFORM_BITMAPS = 120;
const bitmapCache = new LruCache<string, ImageBitmap>(MAX_WAVEFORM_BITMAPS, (bmp) => bmp.close());

/** Drop every cached waveform bitmap (closing each) — called when the project changes (P6.2). */
export function clearWaveformBitmapCache(): void {
  bitmapCache.clear();
}

/** How many waveform bitmaps are cached right now (tests, resource probes). */
export function waveformBitmapCacheSize(): number {
  return bitmapCache.size;
}

/**
 * Cap on a waveform canvas's backing-store width (device px). A clip zoomed in
 * on a long timeline can be hundreds of thousands of CSS px wide; sizing the
 * canvas to match exceeds browser per-dimension canvas limits (~32k px) and
 * allocates hundreds of MB per clip that the GPU never reclaims — the "zoom in
 * and the whole app lags until restart" failure. The backing store is clamped
 * and CSS stretches it across the clip; for a waveform the stretch is
 * imperceptible (only the on-screen slice of a huge clip is visible anyway).
 */
export const MAX_WAVEFORM_BACKING_PX = 8192;

/** Device-px width bucket — nearby zoom levels share one cached bitmap. */
const WIDTH_BUCKET_PX = 48;
const bucketWidth = (physW: number): number =>
  Math.max(WIDTH_BUCKET_PX, Math.round(physW / WIDTH_BUCKET_PX) * WIDTH_BUCKET_PX);

// Stable empty-markers default so an omitted `markers` prop keeps a constant
// identity — otherwise a fresh `[]` each render re-fires the repaint effect
// (dep `[peaks, markers, assetId]`) on every parent re-render (perf slice 4).
const EMPTY_MARKERS: readonly number[] = [];

function cacheKey(assetId: string, bucketW: number, physH: number): string {
  return `${assetId}:${bucketW}:${physH}`;
}

// ── Render pipeline ────────────────────────────────────────────────────────

async function paintCanvas(
  canvas: HTMLCanvasElement,
  peaks: readonly number[],
  markers: readonly number[],
  assetId: string,
): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;
  if (cssW <= 0 || cssH <= 0 || peaks.length === 0) return;

  const physW = Math.min(Math.round(cssW * dpr), MAX_WAVEFORM_BACKING_PX);
  const physH = Math.round(cssH * dpr);
  // Render/cache at a bucketed width so continuous zoom reuses one bitmap; the
  // exact-size canvas backing store then scales it on blit (drawImage stretch).
  const bucketW = bucketWidth(physW);
  const key = cacheKey(assetId, bucketW, physH);

  // ── Cache hit: instant blit (scaled from the bucket size to the exact size) ─
  const cached = bitmapCache.get(key);
  if (cached) {
    canvas.width = physW;
    canvas.height = physH;
    canvas.getContext('2d')?.drawImage(cached, 0, 0, physW, physH);
    return;
  }

  // ── Cache miss: render off-thread at the bucket width, then blit scaled ─────
  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreen = new OffscreenCanvas(bucketW, physH);
    const ctx = offscreen.getContext('2d');
    if (!ctx) return;
    renderWaveform(ctx, peaks, bucketW, physH, markers);
    const bmp = await createImageBitmap(offscreen);
    bitmapCache.set(key, bmp);
    // Guard: canvas may have been resized again while we were awaiting.
    if (canvas.offsetWidth === cssW && canvas.offsetHeight === cssH) {
      canvas.width = physW;
      canvas.height = physH;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0, physW, physH);
    }
  } else {
    // Synchronous fallback (no OffscreenCanvas support)
    canvas.width = physW;
    canvas.height = physH;
    const ctx = canvas.getContext('2d');
    if (ctx) renderWaveform(ctx, peaks, physW, physH, markers);
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export interface ClipWaveformProps {
  assetId: string;
  media: AssetMedia | undefined;
  assetPath: string | undefined;
  sourceStart: number;
  sourceEnd: number;
  /** Relative event positions (0..1) — rendered as orange ticks at clip bottom. */
  markers?: readonly number[];
  /**
   * Layout mode. `full` (default) fills the whole clip — used by audio-only clips.
   * `band` confines the canvas to a thin strip at the clip bottom (positioned by
   * CSS) — used by video clips that sit above a filmstrip picture layer. The render
   * math is identical; only the canvas's CSS box differs.
   */
  variant?: 'full' | 'band';
}

export function ClipWaveform({
  assetId,
  media,
  assetPath,
  sourceStart,
  sourceEnd,
  markers = EMPTY_MARKERS,
  variant = 'full',
}: ClipWaveformProps): JSX.Element | null {
  const { peaks } = useWaveformPeaks(assetId, media, assetPath, sourceStart, sourceEnd);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Stable ref so ResizeObserver callback always sees latest peaks/markers.
  const peaksRef = useRef<readonly number[]>(peaks);
  const markersRef = useRef<readonly number[]>(markers);
  peaksRef.current = peaks;
  markersRef.current = markers;

  // ── Wire up ResizeObserver ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    const el = canvas; // capture before async — TypeScript loses narrowing across closures

    function scheduleRepaint() {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        paintCanvas(el, peaksRef.current, markersRef.current, assetId).catch(() => {
          const dpr = window.devicePixelRatio || 1;
          const physW = Math.min(Math.round(el.offsetWidth * dpr), MAX_WAVEFORM_BACKING_PX);
          const physH = Math.round(el.offsetHeight * dpr);
          el.width = physW;
          el.height = physH;
          const ctx = el.getContext('2d');
          if (ctx) renderWaveform(ctx, peaksRef.current, physW, physH, markersRef.current);
        });
      });
    }

    const ro = new ResizeObserver(scheduleRepaint);
    ro.observe(canvas);
    // Initial paint (peaks may already be loaded from cache).
    scheduleRepaint();

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [assetId]);

  // ── Repaint when peaks arrive / change ────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    let rafId = 0;
    rafId = requestAnimationFrame(() => {
      paintCanvas(canvas, peaks, markers, assetId).catch(() => {
        const dpr = window.devicePixelRatio || 1;
        const physW = Math.min(Math.round(canvas.offsetWidth * dpr), MAX_WAVEFORM_BACKING_PX);
        const physH = Math.round(canvas.offsetHeight * dpr);
        canvas.width = physW;
        canvas.height = physH;
        const ctx = canvas.getContext('2d');
        if (ctx) renderWaveform(ctx, peaks, physW, physH, markers);
      });
    });
    return () => cancelAnimationFrame(rafId);
  }, [peaks, markers, assetId]);

  // No peaks yet and no skeleton — return null so the clip background shows.
  if (peaks.length === 0) return null;

  const canvasClass =
    variant === 'band' ? 'clip-waveform-canvas clip-waveform--band' : 'clip-waveform-canvas';

  return (
    <>
      <canvas ref={canvasRef} className={canvasClass} aria-hidden="true" />
      <div className="clip-waveform-sel-overlay" aria-hidden="true" />
    </>
  );
}
