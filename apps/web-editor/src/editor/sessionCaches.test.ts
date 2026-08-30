/**
 * Project-close emptiness for every renderer session cache (plan P6.2 "done when").
 *
 * The bound of each cache is tested at its owner; what this asserts is the other half
 * of the done-when — that opening a different project actually releases what the old
 * one filled, through ONE call site rather than four that drift apart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bitmapCacheSize, getFrameBitmap } from './bitmapCache.js';
import { loadBrowserWaveformPeaks, waveformPeakCacheSize } from './useWaveformPeaks.js';
import { paintCanvas, waveformBitmapCacheSize } from '../components/ClipWaveform.js';
import { aiSidebarScrollCacheSize } from '../components/ai/AiSidebar.js';
import { clearProjectSessionCaches } from './sessionCaches.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearProjectSessionCaches();
});

/** Fill each cache with one project's worth of entries. */
async function fillCaches(): Promise<void> {
  const loaded: Array<{ fireLoad: () => void }> = [];
  class FakeImage {
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public width = 160;
    public height = 90;
    public set src(_value: string) {
      loaded.push({ fireLoad: () => this.onload?.() });
    }
  }
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('createImageBitmap', () => Promise.resolve({ close: () => undefined }));
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      public constructor(
        public width: number,
        public height: number,
      ) {}
      public getContext(): unknown {
        const stub: unknown = new Proxy({}, { get: () => () => stub });
        return stub;
      }
    },
  );

  const frame = getFrameBitmap('old-project/frame.jpg');
  loaded[0]!.fireLoad();
  await frame;

  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'offsetWidth', { value: 96, configurable: true });
  Object.defineProperty(canvas, 'offsetHeight', { value: 32, configurable: true });
  canvas.getContext = (() => new Proxy({}, { get: () => () => undefined })) as never;
  await paintCanvas(canvas, [0.2, 0.8], [], 'old-asset');

  await loadBrowserWaveformPeaks('old-asset', 'old-project/audio.wav', () =>
    Promise.resolve([0.1, 0.2, 0.3]),
  );
}

describe('clearProjectSessionCaches', () => {
  it('empties every renderer session cache', async () => {
    await fillCaches();
    expect(bitmapCacheSize()).toBe(1);
    expect(waveformBitmapCacheSize()).toBe(1);
    expect(waveformPeakCacheSize()).toBe(1);

    clearProjectSessionCaches();

    expect(bitmapCacheSize()).toBe(0);
    expect(waveformBitmapCacheSize()).toBe(0);
    expect(waveformPeakCacheSize()).toBe(0);
    expect(aiSidebarScrollCacheSize()).toBe(0);
  });

  it('the peak cache is bounded, not just clearable', async () => {
    // 32 assets is the bound; the 33rd evicts the least-recently-used one.
    for (let i = 0; i <= 32; i += 1) {
      await loadBrowserWaveformPeaks(`asset-${i}`, `src-${i}`, () => Promise.resolve([0.5]));
    }
    expect(waveformPeakCacheSize()).toBe(32);
  });
});
