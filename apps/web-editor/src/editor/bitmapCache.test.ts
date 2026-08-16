/**
 * Tests for the decoded-bitmap LRU cache (plan AGENT-NATIVE-UX P1): one decode
 * per source URL app-wide (the cache-hit guarantee the filmstrip perf fix rests
 * on), failure non-memoization, and bounded size. jsdom's `Image` never fires
 * load/error on its own, so the tests drive it explicitly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bitmapCacheSize, clearBitmapCache, getFrameBitmap } from './bitmapCache.js';

/** Install an Image stub whose load/error we control; returns created instances. */
function stubImage(): Array<{ src: string; fireLoad: () => void; fireError: () => void }> {
  const instances: Array<{ src: string; fireLoad: () => void; fireError: () => void }> = [];
  class FakeImage {
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public width = 160;
    public height = 90;
    private _src = '';
    public set src(value: string) {
      this._src = value;
      instances.push({
        src: value,
        fireLoad: () => this.onload?.(),
        fireError: () => this.onerror?.(),
      });
    }
    public get src(): string {
      return this._src;
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return instances;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearBitmapCache();
});

describe('getFrameBitmap', () => {
  it('decodes each URL once — repeat requests share the same in-flight promise', () => {
    const instances = stubImage();
    const first = getFrameBitmap('fp-media://local/a.jpg');
    const second = getFrameBitmap('fp-media://local/a.jpg');
    // The cache-hit guarantee: same promise, ONE underlying decode.
    expect(second).toBe(first);
    expect(instances).toHaveLength(1);
    expect(bitmapCacheSize()).toBe(1);
  });

  it('resolves to a drawable source once the image loads', async () => {
    const instances = stubImage();
    const promise = getFrameBitmap('data:image/jpeg;base64,x');
    instances[0]!.fireLoad();
    const bitmap = await promise;
    expect(bitmap.width).toBe(160);
  });

  it('does not memoize failures — the next request retries the decode', async () => {
    const instances = stubImage();
    const failing = getFrameBitmap('fp-media://local/missing.jpg');
    instances[0]!.fireError();
    await expect(failing).rejects.toThrow(/failed to load frame/);
    expect(bitmapCacheSize()).toBe(0);
    // A fresh request starts a NEW decode instead of replaying the failure.
    const retry = getFrameBitmap('fp-media://local/missing.jpg');
    expect(retry).not.toBe(failing);
    expect(instances).toHaveLength(2);
  });

  it('caches distinct URLs independently', () => {
    const instances = stubImage();
    getFrameBitmap('a');
    getFrameBitmap('b');
    expect(instances).toHaveLength(2);
    expect(bitmapCacheSize()).toBe(2);
  });
});
