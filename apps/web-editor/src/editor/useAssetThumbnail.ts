/**
 * useAssetThumbnail — produce a real preview image for a bin asset (master-prompt
 * §3.2 "real content over placeholders").
 *
 * Resolution order:
 *  1. An engine-generated thumbnail (`asset.media.thumbnailPaths[0]`) when present
 *     — the durable path that survives reload.
 *  2. For an **image** asset, its own source (object URL in-session).
 *  3. For a **video** asset imported this session, a frame captured client-side
 *     from the object URL via `<video>` → `<canvas>` (no engine round-trip).
 *  4. Otherwise `none` → the caller shows the type-glyph fallback.
 *
 * Video capture is shared, bounded, and visibility-scoped. Multiple consumers of
 * the same source reuse one decoder, no more than four decoders run at once, and
 * virtualized cards cancel queued/running work when they leave the viewport.
 * This prevents fast asset scrolling or project-open remounts from leaving stale
 * decoder work behind to compete with the preview and timeline.
 */
import { useEffect, useState } from 'react';
import type { Asset } from '@framepilot/timeline-schema';
import { mediaSrc } from './media.js';
import { LruCache } from './lruCache.js';
import { ThumbnailCapturePool } from './thumbnailCapturePool.js';

/**
 * Cap on concurrent video-frame captures. Each capture spins up a `<video>`
 * decode + canvas draw; firing one per asset at once saturates the main thread
 * and media decoders. Surplus captures stay queued until a slot is available.
 */
const MAX_CONCURRENT_CAPTURES = 4;

/**
 * Cache captured video-frame data URLs by source, so the same asset shown many
 * times (a bin tile + every clip cut of it on the timeline) captures once and the
 * rest reuse the result.
 *
 * Bounded by an LRU so a large project cannot grow the cache without limit. Each
 * entry is a base64 JPEG data URL, so an unbounded map would compound GC pressure.
 */
const MAX_CAPTURED_THUMBNAILS = 256;
const captureCache = new LruCache<string, string>(MAX_CAPTURED_THUMBNAILS);

/**
 * One shared scheduler for the renderer session. It deduplicates by resolved
 * media source and aborts work whose final visible consumer unmounts.
 */
const capturePool = new ThumbnailCapturePool<string>(
  MAX_CONCURRENT_CAPTURES,
  async (src, signal) => {
    const url = await captureVideoFrame(src, signal);
    captureCache.set(src, url);
    return url;
  },
);

export type ThumbnailState =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string };

/** The synchronously-knowable state before any async capture runs. */
function initialState(asset: Asset | undefined, enginePath: string | undefined): ThumbnailState {
  if (!asset) return { status: 'none' };
  // Resolve through `mediaSrc` so on-disk paths load via the `fp-media://` scheme
  // rather than being resolved against the page origin (which the renderer CSP
  // blocks as `http://localhost:…/media/…`).
  //
  // An image is its own thumbnail — render the source directly and BEFORE any
  // engine path. A correct import already sets `thumbnailPaths[0]` to the image's
  // own path, but an older import that mislabelled a photo as video left derived
  // `thumbs/thumb_000.png` frames that were never generated; preferring the
  // source sidesteps that stale pointer (the fp-media ENOENT flood).
  if (asset.kind === 'image' && asset.path) return { status: 'ready', url: mediaSrc(asset.path) };
  if (enginePath) return { status: 'ready', url: mediaSrc(enginePath) };
  if (asset.kind === 'video' && asset.path) {
    const cached = captureCache.get(mediaSrc(asset.path));
    return cached ? { status: 'ready', url: cached } : { status: 'loading' };
  }
  return { status: 'none' };
}

export function useAssetThumbnail(asset: Asset | undefined): ThumbnailState {
  const enginePath = asset?.media?.thumbnailPaths?.[0];
  const [state, setState] = useState<ThumbnailState>(() => initialState(asset, enginePath));

  useEffect(() => {
    // Only the video frame capture is async; everything else resolves up front.
    if (!asset || enginePath || asset.kind !== 'video' || !asset.path) {
      setState(initialState(asset, enginePath));
      return;
    }
    const src = mediaSrc(asset.path);
    const cached = captureCache.get(src);
    if (cached) {
      setState({ status: 'ready', url: cached });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });
    const request = capturePool.request(src);
    request.promise
      .then((url) => {
        if (!cancelled) setState({ status: 'ready', url });
      })
      .catch(() => {
        // Cancellation is expected when a virtualized card leaves the viewport.
        // A genuine decode failure uses the same honest glyph fallback.
        if (!cancelled) setState({ status: 'none' });
      });

    return () => {
      cancelled = true;
      request.release();
    };
  }, [asset, asset?.kind, asset?.path, enginePath]);

  return state;
}

/** Longest edge (px) of a captured thumbnail. The asset card is intentionally small. */
const THUMB_MAX_EDGE = 160;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Thumbnail capture cancelled.');
  error.name = 'AbortError';
  return error;
}

/* v8 ignore start -- DOM canvas capture; jsdom has no media/canvas pipeline. */
function captureVideoFrame(src: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const onAbort = (): void => fail(abortError(signal));

    signal.addEventListener('abort', onAbort, { once: true });
    video.onloadeddata = () => {
      if (signal.aborted) {
        onAbort();
        return;
      }
      // Nudge past any black leader frame, clamped within the clip.
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
      } catch {
        /* some sources disallow seeking — fall through to onseeked/onerror */
      }
    };
    video.onseeked = () => {
      if (signal.aborted) {
        onAbort();
        return;
      }
      const w = video.videoWidth || THUMB_MAX_EDGE;
      const h = video.videoHeight || Math.round((THUMB_MAX_EDGE * 9) / 16);
      const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        fail(new Error('no 2d context'));
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      succeed(canvas.toDataURL('image/jpeg', 0.7));
    };
    video.onerror = () => fail(new Error('thumbnail capture failed'));
    video.src = src;
  });
}
/* v8 ignore stop */
