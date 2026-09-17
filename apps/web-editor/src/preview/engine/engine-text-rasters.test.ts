import { describe, expect, it, vi } from 'vitest';
import type { PreviewTextRasterRequest } from '@framepilot/shared-types';
import { EngineTextRasters } from './engine-text-rasters.js';

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
vi.stubGlobal('ImageData', FakeImageData);

const request = (text: string): PreviewTextRasterRequest => ({
  kind: 'caption',
  text,
  frameWidth: 1280,
  frameHeight: 720,
});

describe('EngineTextRasters', () => {
  it('fetches once per semantic signature and serves the engine bytes', async () => {
    const source = vi.fn(async () => ({
      ok: true as const,
      width: 1,
      height: 1,
      rgba: new Uint8Array([9, 8, 7, 6]),
      x: 5,
      y: 6,
    }));
    const store = new EngineTextRasters(source);
    expect(store.lookup(request('a')).state).toBe('pending');
    await store.ensure([request('a'), request('a')]);
    const found = store.lookup(request('a'));
    expect(found.state).toBe('ready');
    if (found.state === 'ready') {
      expect([...found.raster.image.data]).toEqual([9, 8, 7, 6]);
      expect([found.raster.x, found.raster.y]).toEqual([5, 6]);
    }
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('falls back and says so when there is no engine or it refuses, then retries later', async () => {
    const approximate = vi.fn();
    expect(new EngineTextRasters(null, approximate).lookup(request('a')).state).toBe('fallback');
    expect(approximate).toHaveBeenLastCalledWith(true);

    let clock = 0;
    const source = vi.fn(async () => ({ ok: false as const, error: 'down' }));
    const store = new EngineTextRasters(source, approximate, () => clock);
    await store.ensure([request('b')]);
    expect(store.lookup(request('b')).state).toBe('fallback');
    expect(source).toHaveBeenCalledTimes(1);
    clock = 20_000;
    expect(store.lookup(request('b')).state).toBe('pending');
    expect(source).toHaveBeenCalledTimes(2);
  });
});
