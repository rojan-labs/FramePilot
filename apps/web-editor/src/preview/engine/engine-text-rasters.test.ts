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

describe('styled caption windows (playback)', () => {
  const FPS = 30;
  const cue = (frameTime: number): PreviewTextRasterRequest => ({
    kind: 'caption',
    text: 'top 1% of motion',
    frameWidth: 288,
    frameHeight: 512,
    trackStyle: { templateId: 'karaoke' },
    words: [{ word: 'top', start: 1, end: 1.3 }],
    clipStart: 1,
    clipEnd: 2.5,
    frameTime,
  });
  const image = (value: number) => ({
    width: 1,
    height: 1,
    rgba: new Uint8Array([value, 0, 0, 255]),
    x: 0,
    y: 0,
  });
  /** A host with windows: frame `k` draws `k`, two frames at a time share a raster. */
  const windowed = () =>
    vi.fn(async (req: PreviewTextRasterRequest) => {
      const times = req.frameTimes ?? [req.frameTime!];
      const frames = times.map((t) => Math.round(t * FPS));
      const distinct = [...new Set(frames.map((k) => k - (k % 2)))];
      return {
        ok: true as const,
        ...image(distinct[0]!),
        animated: true,
        sequence: {
          index: frames.map((k) => distinct.indexOf(k - (k % 2))),
          rasters: distinct.map(image),
        },
      };
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const drawn = (store: EngineTextRasters, frame: number) => {
    const found = store.lookup(cue(frame / FPS), 'playback');
    return found.state === 'ready' ? found.raster.image.data[0] : found.state;
  };

  it('fetches a window in one call and serves each frame its own raster', async () => {
    const source = windowed();
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    store.prefetch(cue(0), [30, 31, 32, 33, 34, 35], 30);
    await settle();
    expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0]![0].frameTimes).toEqual([
      1,
      31 / 30,
      32 / 30,
      33 / 30,
      34 / 30,
      35 / 30,
    ]);
    expect([30, 31, 32, 33, 34, 35].map((k) => drawn(store, k))).toEqual([30, 30, 32, 32, 34, 34]);
    // Frames already held are not asked again.
    store.prefetch(cue(0), [30, 31, 32], 30);
    await settle();
    expect(source).toHaveBeenCalledTimes(1);
    // Two distinct 1x1 rasters... three: each distinct raster is counted once.
    expect(store.stats().bytes).toBe(3 * 4);
  });

  it('asks for a long horizon in small windows, two at a time, nearest first', async () => {
    const answers: (() => void)[] = [];
    const inner = windowed();
    const source = vi.fn(
      (req: PreviewTextRasterRequest) =>
        new Promise<Awaited<ReturnType<typeof inner>>>((resolve) =>
          answers.push(() => void inner(req).then(resolve)),
        ),
    );
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    const horizon = Array.from({ length: 60 }, (_, i) => 30 + i);
    store.prefetch(cue(0), horizon, 30);
    store.prefetch(cue(0), horizon, 30);
    store.prefetch(cue(0), horizon, 30);
    expect(source.mock.calls.map(([req]) => req.frameTimes?.length)).toEqual([15, 15]);
    expect(source.mock.calls[0]![0].frameTimes![0]).toBe(1);
    answers.shift()!();
    await settle();
    store.prefetch(cue(0), horizon, 30);
    expect(source.mock.calls).toHaveLength(3);
    expect(source.mock.calls[2]![0].frameTimes![0]).toBeCloseTo(60 / FPS, 9);
  });

  it('never waits in playback: a missing frame shows the nearest one of the cue', async () => {
    const source = windowed();
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    // Nothing held yet: pending (the monitor skips the caption this frame, not the picture),
    // and the lookup itself asks for the frame.
    expect(store.lookup(cue(40 / FPS), 'playback').state).toBe('pending');
    await settle();
    expect(source).toHaveBeenCalledTimes(1);
    const later = store.lookup(cue(45 / FPS), 'playback');
    expect(later.state).toBe('ready');
    if (later.state === 'ready') {
      expect(later.stale).toBe(true);
      expect(later.raster.image.data[0]).toBe(40);
    }
  });

  it('asks a host without windows one frame at a time, a few in flight', async () => {
    const source = vi.fn(async (req: PreviewTextRasterRequest) => ({
      ok: true as const,
      ...image(Math.round(req.frameTime! * FPS)),
      animated: true,
    }));
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    store.prefetch(cue(0), [30, 31, 32, 33, 34, 35, 36, 37], 30);
    await settle();
    // The first answer had no `sequence`: the host cannot answer windows.
    expect(store.stats().windowsSupported).toBe(false);
    store.prefetch(cue(0), [30, 31, 32, 33, 34, 35, 36, 37], 30);
    await settle();
    // After the first answer, every ask is one frame, and at most four were out at once.
    const [first, ...rest] = source.mock.calls.map(([req]) => req.frameTimes);
    expect(first).toHaveLength(8);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((times) => times === undefined)).toBe(true);
    expect(rest.length).toBeLessThanOrEqual(4);
    expect(drawn(store, 30)).toBe(30);
    expect(drawn(store, 31)).toBe(31);
  });

  it('keeps the styled look through a busy sidecar, and falls back only when it stays down', async () => {
    let clock = 0;
    const approximate = vi.fn();
    let down = false;
    const healthy = windowed();
    const source = vi.fn(async (req: PreviewTextRasterRequest) =>
      down ? { ok: false as const, error: 'timeout', transient: true } : healthy(req),
    );
    // Retries wait on the test's own clock, a second each.
    const wait = async (ms: number): Promise<void> => {
      clock += ms;
    };
    const store = new EngineTextRasters(source, approximate, () => clock, wait);
    store.setFrameRate(FPS);
    store.prefetch(cue(0), [30, 31], 30);
    await settle();
    down = true;
    store.prefetch(cue(0), [32, 33], 32);
    await settle();
    // One timeout: the cue keeps drawing its own (stale) raster, not the plain caption.
    store.beginFrame();
    expect(store.lookup(cue(33 / FPS), 'playback').state).toBe('ready');
    store.endFrame(true);
    expect(approximate).not.toHaveBeenCalledWith(true);
    // A paused frame of a cue with nothing held: ensure asks again until three timeouts in a
    // row, then the frame is drawn approximate (and may recover), never left undrawn.
    const other = (t: number) => ({ ...cue(t), text: 'another cue' });
    const asked = source.mock.calls.length;
    await store.ensure([other(2)]);
    expect(source.mock.calls.length - asked).toBe(3);
    store.beginFrame();
    expect(store.lookup(other(2)).state).toBe('fallback');
    store.endFrame(true);
    expect(approximate).toHaveBeenLastCalledWith(true);
    expect(store.shownFrameCouldRecover()).toBe(true);
    // Back up: the next ask succeeds, and the next frame drawn says it is exact again.
    down = false;
    clock += 1_500;
    await store.ensure([other(2)]);
    store.beginFrame();
    expect(store.lookup(other(2)).state).toBe('ready');
    store.endFrame(true);
    expect(approximate).toHaveBeenLastCalledWith(false);
    expect(store.shownFrameCouldRecover()).toBe(false);
  });

  it('falls back at once when the engine refuses the cue', async () => {
    const source = vi.fn(async () => ({ ok: false as const, error: 'Engine refused (422).' }));
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    await store.ensure([cue(1)]);
    expect(store.lookup(cue(1)).state).toBe('fallback');
    expect(store.lookup(cue(1.5), 'playback').state).toBe('fallback');
  });

  it('releases frames the playhead passed more than a second ago', async () => {
    const source = windowed();
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    store.prefetch(cue(0), [30, 32, 34], 30);
    await settle();
    expect(store.stats().bytes).toBe(3 * 4);
    store.prefetch(cue(0), [], 30 + FPS + 3);
    // 30 and 32 are more than a second behind; 34 (and the latest raster) stay.
    expect(drawn(store, 30)).toBe(34);
    expect(store.stats().bytes).toBe(4);
  });

  it('answers a paused frame from one window when several are asked at once', async () => {
    const source = windowed();
    const store = new EngineTextRasters(source);
    store.setFrameRate(FPS);
    await store.ensure([cue(1), cue(31 / 30), cue(32 / 30)]);
    expect(source).toHaveBeenCalledTimes(1);
    const found = store.lookup(cue(32 / 30));
    expect(found.state === 'ready' && found.raster.image.data[0]).toBe(32);
  });
});
