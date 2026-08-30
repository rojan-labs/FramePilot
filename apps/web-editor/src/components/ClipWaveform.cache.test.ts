/**
 * Bounds and release for the waveform ImageBitmap cache (plan P6.2).
 *
 * The cache is keyed by asset × bucketed width × height, so a session that zooms
 * across several projects mints entries indefinitely unless the LRU bound holds and
 * eviction actually `close()`s the bitmap — a GC-invisible GPU allocation otherwise.
 * These two properties are what the done-when asks for: eviction, and emptiness on
 * project close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_WAVEFORM_BITMAPS,
  clearWaveformBitmapCache,
  paintCanvas,
  waveformBitmapCacheSize,
} from './ClipWaveform.js';

/** Every bitmap handed to the cache, so the test can see which ones were released. */
let bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];

/**
 * A 2D context that swallows every drawing call — the pixels are not under test.
 * Every method returns another such stub, so factory calls (`createLinearGradient`)
 * hand back something with the methods the renderer goes on to use.
 */
function noopContext(): unknown {
  const stub: unknown = new Proxy(
    {},
    {
      get: () => () => stub,
    },
  );
  return stub;
}

beforeEach(() => {
  bitmaps = [];
  clearWaveformBitmapCache();
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      public constructor(
        public width: number,
        public height: number,
      ) {}
      public getContext(): unknown {
        return noopContext();
      }
    },
  );
  vi.stubGlobal('createImageBitmap', () => {
    const bitmap = { close: vi.fn() };
    bitmaps.push(bitmap);
    return Promise.resolve(bitmap);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearWaveformBitmapCache();
});

/** A canvas with a declared box — jsdom has no layout, so paintCanvas would bail at 0×0. */
function sizedCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'offsetWidth', { value: 96, configurable: true });
  Object.defineProperty(canvas, 'offsetHeight', { value: 32, configurable: true });
  // jsdom throws "not implemented" for a real 2D context; the blit is not under test.
  canvas.getContext = (() => noopContext()) as HTMLCanvasElement['getContext'];
  return canvas;
}

const PEAKS = [0.1, 0.5, 0.9, 0.3];

describe('waveform bitmap cache', () => {
  it('stops growing at the bound and closes the bitmap it evicts', async () => {
    const canvas = sizedCanvas();
    // One distinct asset per paint → one distinct cache key per paint.
    for (let i = 0; i <= MAX_WAVEFORM_BITMAPS; i += 1) {
      await paintCanvas(canvas, PEAKS, [], `asset-${i}`);
    }

    expect(bitmaps).toHaveLength(MAX_WAVEFORM_BITMAPS + 1);
    expect(waveformBitmapCacheSize()).toBe(MAX_WAVEFORM_BITMAPS);
    // The least-recently-used entry is the first one, and its GPU memory is released
    // at eviction rather than at some later GC that may never come.
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(bitmaps[1]!.close).not.toHaveBeenCalled();
  });

  it('serves a repeated key from the cache instead of decoding again', async () => {
    const canvas = sizedCanvas();
    await paintCanvas(canvas, PEAKS, [], 'asset-a');
    await paintCanvas(canvas, PEAKS, [], 'asset-a');
    expect(bitmaps).toHaveLength(1);
    expect(waveformBitmapCacheSize()).toBe(1);
  });

  it('is empty and fully released after a project close', async () => {
    const canvas = sizedCanvas();
    await paintCanvas(canvas, PEAKS, [], 'asset-a');
    await paintCanvas(canvas, PEAKS, [], 'asset-b');
    expect(waveformBitmapCacheSize()).toBe(2);

    clearWaveformBitmapCache();

    expect(waveformBitmapCacheSize()).toBe(0);
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
