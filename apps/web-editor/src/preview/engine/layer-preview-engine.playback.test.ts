/**
 * Playback and transport behaviour of the layer compositor's engine: the parts a user feels as
 * "stuck" — pausing and resuming where you stopped, edits and seeks while playing, scrubbing, and
 * text that has not arrived yet. The decode worker, the GPU compositor and Web Audio are fakes;
 * the planning, caching and scheduling are the engine's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import type { PreviewTextRasterRequest, PreviewTextRasterResult } from '@framepilot/shared-types';
import type { LayerEngineProject } from './layer-preview-engine.js';

// --- fakes -------------------------------------------------------------------------------------

interface DecodeCall {
  readonly assetId: string;
  readonly from: number;
  readonly to: number;
  resolve: () => void;
  fail: (error: Error) => void;
  settled: boolean;
  readonly startedAt: number;
}

const decoder = vi.hoisted(() => ({
  calls: [] as DecodeCall[],
  /** Answer decodes at once (true) or hold them until the test resolves them. */
  immediate: true,
  /** The size the fake decoder hands frames back at (a proxy of a portrait clip is upright). */
  size: { width: 64, height: 36 },
  /** Each source load and the quarter turns it asked the worker for. */
  loads: [] as { url: string; rotation: number }[],
  restarts: 0,
}));

vi.mock('../decode/worker-client.js', () => {
  class DecodeWorkerRestartedError extends Error {}
  class DecodeWorkerClient {
    restart(reason: string) {
      decoder.restarts++;
      const waiting = decoder.calls.filter((call) => !call.settled);
      for (const call of waiting) call.fail(new DecodeWorkerRestartedError(reason));
    }
    async loadSource(_sourceId: string, url: string, options: { rotation?: number } = {}) {
      decoder.loads.push({ url, rotation: options.rotation ?? 0 });
      return {
        frameCount: 300,
        frameRate: 30,
        frameDurationUs: 33_333,
        frameTimesSec: null,
        presentationTimestampsUs: Array.from({ length: 300 }, (_, i) => Math.round(i * 33_333)),
        fileBytes: new ArrayBuffer(0),
      };
    }
    decodePictures(
      assetId: string,
      from: number,
      to: number,
      onPicture?: (message: unknown) => void,
    ) {
      const { width, height } = decoder.size;
      const answer = {
        pictures: Array.from({ length: to - from + 1 }, (_, i) => ({
          chunkIndex: from + i,
          timestampUs: Math.round((from + i) * 33_333),
          picture: {
            kind: 'i420' as const,
            width,
            height,
            y: new Uint8Array(width * height),
            u: new Uint8Array((width * height) / 4),
            v: new Uint8Array((width * height) / 4),
            matrix: null,
            fullRange: null,
            byteLength: (width * height * 3) / 2,
          },
        })),
      };
      return new Promise((resolve, reject) => {
        const call: DecodeCall = {
          assetId,
          from,
          to,
          startedAt: performance.now(),
          settled: false,
          resolve: () => {
            call.settled = true;
            if (!onPicture) return resolve(answer);
            for (const picture of answer.pictures) onPicture(picture);
            resolve({ pictures: [] });
          },
          fail: (error) => {
            call.settled = true;
            reject(error);
          },
        };
        decoder.calls.push(call);
        if (decoder.immediate) call.resolve();
      });
    }
    releasePicture() {}
    closeFrame() {}
    async unloadSource() {}
    dispose() {}
    debugTraffic() {
      return { silentForMs: null, sent: [], received: [], pending: [] };
    }
    async debugStages() {
      // The worker's own account: each unanswered decode sits in a decode step.
      return decoder.calls
        .filter((call) => !call.settled)
        .map((call) => ({
          sourceId: call.assetId,
          stage: 'await-output',
          ageMs: performance.now() - call.startedAt,
        }));
    }
    async decoderPoolStats() {
      return { liveDecoders: 0, peakLiveDecoders: 0 };
    }
  }
  return { DecodeWorkerClient, DecodeWorkerRestartedError };
});

vi.mock('../decode/matte-decode-pool.js', () => ({
  MatteDecodePool: class {
    dispose() {}
  },
}));

const compositor = vi.hoisted(() => ({
  renders: [] as { layers: readonly unknown[] }[],
}));

vi.mock('./layer-compositor.js', () => ({
  LayerCompositor: class {
    setTelemetry() {}
    setLuts() {}
    dispose() {}
    render(size: { width: number; height: number }, layers: readonly unknown[]) {
      compositor.renders.push({ layers });
      return new ImageData(
        new Uint8ClampedArray(size.width * size.height * 4),
        size.width,
        size.height,
      );
    }
  },
}));

vi.mock('./raster/sws-host.js', () => ({ configureSwsUnscaledConverterFromHost: async () => {} }));

vi.mock('../masks/mask-stack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../masks/mask-stack.js')>()),
  configureLegacyMaskArithmeticFromHost: async () => {},
}));

vi.mock('./text-raster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./text-raster.js')>()),
  loadExportTextFont: async () => false,
}));

vi.mock('../audio/program-audio.js', () => ({
  ProgramAudio: class {
    async retain() {}
    segmentsFrom() {
      return [];
    }
    dispose() {}
  },
}));

const clock = vi.hoisted(() => ({
  nowUs: 0,
  scheduled: [] as number[],
  handovers: 0,
}));

vi.mock('../clock/audio-clock.js', () => ({
  AudioMasterClock: class {
    contextState = 'running';
    setGain() {}
    async start() {}
    clear() {}
    scheduleSegments(_segments: unknown, mediaStartUs: number) {
      clock.scheduled.push(mediaStartUs);
      clock.nowUs = mediaStartUs;
    }
    rescheduleContinuous() {
      clock.handovers++;
    }
    nowMediaUs() {
      return clock.nowUs;
    }
  },
}));

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

class FakeAudioContext {
  state = 'running';
  onstatechange: (() => void) | null = null;
  async decodeAudioData(): Promise<AudioBuffer> {
    throw new Error('no audio');
  }
  async close() {}
}

let frameCallbacks: FrameRequestCallback[] = [];
/** Run one display refresh at `timeSec` on the audio clock. */
function refresh(timeSec: number): void {
  clock.nowUs = Math.round(timeSec * 1_000_000);
  const pending = frameCallbacks;
  frameCallbacks = [];
  for (const callback of pending) callback(0);
}

vi.stubGlobal('ImageData', FakeImageData);
vi.stubGlobal('AudioContext', FakeAudioContext);
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  frameCallbacks.push(callback);
  return frameCallbacks.length;
});
vi.stubGlobal('cancelAnimationFrame', () => {
  frameCallbacks = [];
});

const { LayerPreviewEngine } = await import('./layer-preview-engine.js');
const { mediaSrc } = await import('../../editor/media.js');

// --- fixtures ----------------------------------------------------------------------------------

function canvas(): HTMLCanvasElement {
  const ctx = {
    canvas: { width: 64, height: 36 },
    save() {},
    restore() {},
    putImageData() {},
    drawImage() {},
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    filter: 'none',
  };
  return { getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const videoAsset = (media: Record<string, unknown> = {}): Asset =>
  ({
    id: 'a',
    path: 'camera.mov',
    kind: 'video',
    durationSeconds: 10,
    media: { width: 64, height: 36, fps: 30, ...media },
  }) as unknown as Asset;

const clip = (id: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  assetId: 'a',
  trackId: 'v1',
  start,
  end,
  sourceStart: start,
  sourceEnd: end,
  effects: [],
  keyframes: [],
  ...extra,
});

function timeline(extraTracks: unknown[] = []): Timeline {
  return {
    tracks: [{ id: 'v1', type: 'video', clips: [clip('c1', 0, 10)] }, ...extraTracks],
  } as unknown as Timeline;
}

function project(
  overrides: { asset?: Asset; timeline?: Timeline; url?: string } = {},
): LayerEngineProject {
  const asset = overrides.asset ?? videoAsset();
  return {
    timeline: overrides.timeline ?? timeline(),
    assets: [asset],
    mediaUrls: new Map([['a', overrides.url ?? mediaSrc(asset.path)]]),
    projectResolution: { width: 64, height: 36 },
    canvasSize: { width: 64, height: 36 },
    projectFps: 30,
    burnCaptions: true,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  decoder.calls = [];
  decoder.loads = [];
  decoder.restarts = 0;
  decoder.immediate = true;
  decoder.size = { width: 64, height: 36 };
  compositor.renders = [];
  clock.nowUs = 0;
  clock.scheduled = [];
  clock.handovers = 0;
  frameCallbacks = [];
});

afterEach(() => {
  delete (window as unknown as { __fpTextRasterSource?: unknown }).__fpTextRasterSource;
});

// --- tests -------------------------------------------------------------------------------------

describe('LayerPreviewEngine transport', () => {
  it('pauses where playback stopped and resumes from there', async () => {
    const engine = new LayerPreviewEngine(canvas());
    await engine.setProject(project());
    await engine.play();
    refresh(3.2);
    engine.pause();
    expect(engine.currentTimeSec).toBeCloseTo(3.2, 6);
    await settle();
    await engine.play();
    // Resumed at the pause, not at 0 where the first play began.
    expect(clock.scheduled.at(-1)).toBe(3_200_000);
    engine.dispose();
  });

  it('keeps playing through a project change and hands the sound over', async () => {
    const playing = vi.fn();
    const engine = new LayerPreviewEngine(canvas(), { onPlayingChange: playing });
    await engine.setProject(project());
    await engine.play();
    refresh(1);
    await engine.setProject(project({ timeline: timeline() }));
    await engine.setProject(project({ timeline: timeline() }));
    expect(engine.isPlaying).toBe(true);
    expect(playing).not.toHaveBeenCalledWith(false);
    // Handed over once for both changes, after the coalescing delay.
    expect(clock.handovers).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(clock.handovers).toBe(1);
    engine.dispose();
  });

  it('continues playback from a seek made while playing', async () => {
    const playing = vi.fn();
    const times = vi.fn();
    const engine = new LayerPreviewEngine(canvas(), {
      onPlayingChange: playing,
      onTimeUpdate: times,
    });
    await engine.setProject(project());
    await engine.play();
    refresh(1);
    await engine.seek(6);
    expect(engine.isPlaying).toBe(true);
    expect(playing).not.toHaveBeenCalledWith(false);
    expect(clock.scheduled.at(-1)).toBe(6_000_000);
    expect(times).toHaveBeenLastCalledWith(6);
    engine.dispose();
  });

  it('serves a burst of paused seeks one at a time, latest wins', async () => {
    const engine = new LayerPreviewEngine(canvas());
    await engine.setProject(project());
    decoder.calls = [];
    decoder.immediate = false;
    const done = [1, 2, 3, 4].map((t) => engine.seek(t));
    await settle();
    // Only the first seek is decoding; the ones behind it collapsed into the latest.
    expect(decoder.calls.map((call) => call.from)).toEqual([30]);
    decoder.calls[0]!.resolve();
    await settle();
    expect(decoder.calls.map((call) => call.from)).toEqual([30, 120]);
    decoder.calls[1]!.resolve();
    await Promise.all(done);
    expect(engine.currentTimeSec).toBe(4);
    engine.dispose();
  });

  it('does not let one stalled paused seek hold the ones behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const engine = new LayerPreviewEngine(canvas());
      await engine.setProject(project());
      decoder.calls = [];
      decoder.immediate = false;
      void engine.seek(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(decoder.calls.map((call) => call.from)).toEqual([60]);
      // The decode for 2 s never answers; the user moves on.
      const later = engine.seek(5);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(decoder.calls.map((call) => call.from)).toEqual([60, 150]);
      decoder.calls[1]!.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await later;
      expect(engine.currentTimeSec).toBe(5);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a decode worker that stopped answering and serves the seek it held', async () => {
    // The hang report measures age with performance.now(), so it is faked too.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const errors = vi.fn();
      const engine = new LayerPreviewEngine(canvas(), { onError: errors });
      await engine.setProject(project());
      decoder.calls = [];
      decoder.immediate = false;
      const seek = engine.seek(2);
      // The decode never answers: PX5.7 names it after 10 s, and the worker is replaced.
      await vi.advanceTimersByTimeAsync(10_500);
      expect(decoder.restarts).toBe(1);
      expect(decoder.calls.map((call) => call.from)).toEqual([60, 60]);
      decoder.calls[1]!.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await seek;
      expect(engine.currentTimeSec).toBe(2);
      expect(errors).not.toHaveBeenCalled();
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does no planning or compositing on a refresh inside a frame already shown', async () => {
    const engine = new LayerPreviewEngine(canvas());
    await engine.setProject(project());
    await engine.play();
    refresh(1);
    await settle();
    refresh(1.001);
    const renders = compositor.renders.length;
    const decodes = decoder.calls.length;
    refresh(1.002);
    refresh(1.003);
    expect(compositor.renders.length).toBe(renders);
    expect(decoder.calls.length).toBe(decodes);
    expect(engine.debugStats().ticks).toBeGreaterThanOrEqual(4);
    engine.dispose();
  });
});

describe('LayerPreviewEngine text during playback', () => {
  const captionTrack = {
    id: 'cap',
    type: 'caption',
    captionStyle: { templateId: 'karaoke' },
    clips: [
      {
        id: 'cue',
        assetId: '__caption__',
        trackId: 'cap',
        start: 0,
        end: 5,
        sourceStart: 0,
        sourceEnd: 5,
        effects: [],
        keyframes: [],
        captionCue: {
          text: 'hello there',
          words: [
            { word: 'hello', start: 0, end: 1 },
            { word: 'there', start: 1, end: 2 },
          ],
        },
      },
    ],
  };

  it('never holds the playback picture for a caption that has not arrived', async () => {
    const asked: PreviewTextRasterRequest[] = [];
    (window as unknown as { __fpTextRasterSource: unknown }).__fpTextRasterSource = (
      req: PreviewTextRasterRequest,
    ) => {
      asked.push(req);
      return new Promise<PreviewTextRasterResult>(() => {});
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const engine = new LayerPreviewEngine(canvas());
      void engine.setProject(project({ timeline: timeline([captionTrack]) }));
      await vi.advanceTimersByTimeAsync(100);
      // The paused frame waits for its caption (exact), so nothing is presented yet...
      expect(compositor.renders).toHaveLength(0);
      // ...but not forever: a sidecar that never answers leaves the frame shown without it.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(compositor.renders).toHaveLength(1);
      // Playback is not held by the seek still waiting for that text.
      await engine.play();
      expect(engine.isPlaying).toBe(true);
      for (const t of [0, 0.034, 0.067, 0.1]) {
        refresh(t);
        await vi.advanceTimersByTimeAsync(1);
      }
      // Playback moves on: frames are composited without the caption, and counted.
      expect(compositor.renders.length).toBeGreaterThan(1);
      expect(engine.debugStats().textSkipped).toBeGreaterThan(0);
      // The cue's frames were asked for ahead of the playhead, as a window.
      expect(asked.some((req) => (req.frameTimes?.length ?? 0) > 1)).toBe(true);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a paused seek only once its late caption is drawn (a parity read waits for it)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      (window as unknown as { __fpTextRasterSource: unknown }).__fpTextRasterSource = (
        req: PreviewTextRasterRequest,
      ) =>
        new Promise<PreviewTextRasterResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                width: 1,
                height: 1,
                rgba: new Uint8Array([Math.round((req.frameTime ?? 0) * 30), 0, 0, 255]),
                x: 0,
                y: 0,
                animated: true,
              }),
            2_000,
          ),
        );
      const engine = new LayerPreviewEngine(canvas());
      let opened = false;
      void engine.setProject(project({ timeline: timeline([captionTrack]) })).then(() => {
        opened = true;
      });
      // Shown without the caption at 1.5 s, but the seek is not done yet.
      await vi.advanceTimersByTimeAsync(1_600);
      expect(compositor.renders).toHaveLength(1);
      expect(opened).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(opened).toBe(true);
      const last = compositor.renders.at(-1)!.layers as { kind: string }[];
      expect(last.some((layer) => layer.kind === 'raster')).toBe(true);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws a caption frame that has not arrived with the nearest one of its cue', async () => {
    const FPS = 30;
    (window as unknown as { __fpTextRasterSource: unknown }).__fpTextRasterSource = async (
      req: PreviewTextRasterRequest,
    ): Promise<PreviewTextRasterResult> => {
      const times = req.frameTimes ?? [req.frameTime ?? 0];
      // Only frames up to 0.5 s ever arrive (a slow window past that).
      const drawn = times.filter((t) => t <= 0.5);
      const raster = (t: number) => ({
        width: 1,
        height: 1,
        rgba: new Uint8Array([Math.round(t * FPS), 0, 0, 255]),
        x: 0,
        y: 0,
      });
      if (drawn.length === 0) return new Promise<PreviewTextRasterResult>(() => {});
      return {
        ok: true,
        ...raster(drawn[0]!),
        animated: true,
        ...(req.frameTimes
          ? { sequence: { index: drawn.map((_, i) => i), rasters: drawn.map(raster) } }
          : {}),
      };
    };
    const engine = new LayerPreviewEngine(canvas());
    await engine.setProject(project({ timeline: timeline([captionTrack]) }));
    await engine.play();
    for (let frame = 0; frame <= 24; frame++) {
      refresh(frame / FPS);
      await settle();
    }
    const last = compositor.renders.at(-1)!.layers as {
      kind: string;
      image?: { data: Uint8ClampedArray };
    }[];
    const caption = last.find((layer) => layer.kind === 'raster');
    // Frame 24 never arrived: the cue's frame 15 (0.5 s) stands in, and the picture kept moving.
    expect(caption?.image?.data[0]).toBe(15);
    expect(engine.debugStats().textStale).toBeGreaterThan(0);
    engine.dispose();
  });
});

describe('LayerPreviewEngine rotated footage', () => {
  it('gives the worker the asset’s rotation for its original and its proxy alike', async () => {
    const asset = videoAsset({ rotation: 90, proxyPath: 'proxies/a.mp4', width: 36, height: 64 });
    const viaProxy = new LayerPreviewEngine(canvas());
    await viaProxy.setProject(project({ asset, url: mediaSrc('proxies/a.mp4') }));
    viaProxy.dispose();
    const viaOriginal = new LayerPreviewEngine(canvas());
    await viaOriginal.setProject(project({ asset }));
    viaOriginal.dispose();
    // The worker applies it only to a file whose own display matrix is turned (an original);
    // a proxy ffmpeg autorotated carries none (see mp4-demuxer's displayRotationCw).
    expect(decoder.loads).toEqual([
      { url: mediaSrc('proxies/a.mp4'), rotation: 90 },
      { url: mediaSrc('camera.mov'), rotation: 90 },
    ]);
  });
});
