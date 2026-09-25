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

  describe('styled captions, asked for at each frame', () => {
    const styled = (frameTime: number): PreviewTextRasterRequest => ({
      kind: 'caption',
      text: 'top 1% of motion',
      frameWidth: 288,
      frameHeight: 512,
      trackStyle: { fontFamily: 'Anton' },
      words: [{ word: 'top', start: 1, end: 1.3 }],
      clipStart: 1,
      clipEnd: 2.5,
      frameTime,
    });
    const window = [1, 1.033, 1.067, 1.1, 1.133, 1.167, 1.2, 1.233, 1.267, 1.3, 1.333, 1.367];

    it('asks once for a still cue and serves every frame from that raster', async () => {
      const source = vi.fn(async () => ({
        ok: true as const,
        width: 1,
        height: 1,
        rgba: new Uint8Array([1, 2, 3, 4]),
        x: 0,
        y: 0,
        animated: false,
      }));
      const store = new EngineTextRasters(source);
      // The playhead's look-ahead asks for the whole window at once.
      await store.ensure(window.map(styled));
      expect(source).toHaveBeenCalledTimes(1);
      expect(store.lookup(styled(2.4)).state).toBe('ready');
      expect(source).toHaveBeenCalledTimes(1);
    });

    it('asks per frame for a moving cue once the first answer says it moves', async () => {
      let calls = 0;
      const source = vi.fn(async (req: PreviewTextRasterRequest) => {
        calls += 1;
        return {
          ok: true as const,
          width: 1,
          height: 1,
          rgba: new Uint8Array([Math.round((req.frameTime ?? 0) * 100) % 256, 0, 0, 255]),
          x: 0,
          y: 0,
          animated: true,
        };
      });
      const store = new EngineTextRasters(source);
      await store.ensure(window.map(styled));
      expect(calls).toBe(window.length);
      const early = store.lookup(styled(1));
      const late = store.lookup(styled(1.3));
      expect(early.state === 'ready' && late.state === 'ready').toBe(true);
      if (early.state === 'ready' && late.state === 'ready') {
        expect(early.raster.image.data[0]).not.toBe(late.raster.image.data[0]);
      }
    });

    it('carries a frosted chip’s coverage and blur', async () => {
      const source = vi.fn(async () => ({
        ok: true as const,
        width: 2,
        height: 1,
        rgba: new Uint8Array(8),
        x: 0,
        y: 0,
        animated: false,
        backdrop: new Uint8Array([0, 255]),
        backdropSigmaPx: 9,
      }));
      const store = new EngineTextRasters(source);
      await store.ensure([styled(1)]);
      const found = store.lookup(styled(1));
      expect(found.state === 'ready' && found.raster.backdrop).toEqual({
        coverage: new Uint8Array([0, 255]),
        sigmaPx: 9,
      });
    });
  });
});
