/**
 * bitmapCache — decode each filmstrip/thumbnail source ONCE (plan AGENT-NATIVE-UX P1).
 *
 * WHY: the filmstrip used one `background-image` div per slot, so the browser
 * re-rasterized the same JPEG/data-URL at a new size on every zoom tick, for
 * every slot, for every clip — the dominant main-thread cost behind "thumbnails
 * on + zoom = the whole app lags". This cache decodes a source URL to a GPU-side
 * `ImageBitmap` exactly once; every canvas blit after that is a cheap copy.
 *
 * Bounded by an LRU (≈ one bitmap per distinct source — thumbnails are ≤160px,
 * so the ceiling is a few MB) whose eviction hook `close()`s the bitmap so its
 * backing memory is released immediately, not at GC time. Failures are NOT
 * cached: a transient load error retries on the next request.
 */
import { LruCache } from './lruCache.js';

/** Anything a 2D canvas can draw — `ImageBitmap` where supported, else the image element. */
export type FrameBitmap = ImageBitmap | HTMLImageElement;

/** Ceiling on distinct decoded sources kept alive (LRU-evicted beyond this). */
const MAX_DECODED_BITMAPS = 256;

const cache = new LruCache<string, Promise<FrameBitmap>>(MAX_DECODED_BITMAPS, (promise) => {
  // Release the decoded pixels as soon as the entry falls out of the LRU. A
  // still-rejecting entry has nothing to close (and must not surface as an
  // unhandled rejection here).
  promise
    .then((bitmap) => {
      if ('close' in bitmap) bitmap.close();
    })
    .catch(() => undefined);
});

/* v8 ignore start -- jsdom has no image decode pipeline; exercised in e2e/manual. */
function decodeFrame(url: string): Promise<FrameBitmap> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load frame: ${url.slice(0, 80)}`));
    image.src = url;
  }).then(async (image) => {
    // Prefer a real ImageBitmap (decoded off the element, drawable with no
    // per-blit rasterization); fall back to the element where unsupported.
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(image);
      } catch {
        return image;
      }
    }
    return image;
  });
}
/* v8 ignore stop */

/**
 * Resolve a frame source URL to its decoded bitmap, decoding at most once per
 * URL across the whole app (bin tiles + every filmstrip slot of every clip).
 */
export function getFrameBitmap(url: string): Promise<FrameBitmap> {
  const hit = cache.get(url);
  if (hit) return hit;
  const promise = decodeFrame(url);
  cache.set(url, promise);
  // Do not memoize failures — drop the entry so the next request retries.
  promise.catch(() => cache.delete(url));
  return promise;
}

/** Test hook: current number of cached decode entries. */
export function bitmapCacheSize(): number {
  return cache.size;
}

/** Test hook: drop every cached bitmap (closes them via the eviction hook). */
export function clearBitmapCache(): void {
  cache.clear();
}
