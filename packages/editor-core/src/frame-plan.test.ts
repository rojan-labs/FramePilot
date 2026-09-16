/**
 * `framePlanAt` behaviour (PX1.2). Cross-language agreement with the engine is pinned
 * separately by `frame-plan.parity.test.ts` against `tests/fixtures/frame-plan`.
 */
import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  type Asset,
  type Clip,
  type Timeline,
  type Track,
} from '@framepilot/timeline-schema';
import {
  FramePlanError,
  framePlanAt,
  maskSourceTime,
  sourceFrameIndex,
  videoSourceTime,
} from './frame-plan.js';

const FRAME = { width: 1280, height: 720 } as const;

const ASSETS: readonly Asset[] = [
  {
    id: 'land',
    path: 'land.mp4',
    kind: 'video',
    durationSeconds: 20,
    media: { width: 1920, height: 1080 },
  },
  { id: 'png', path: 'still.png', kind: 'image', media: { width: 800, height: 600 } },
];

function clip(
  id: string,
  trackId: string,
  start: number,
  end: number,
  extra: Partial<Clip> = {},
): Clip {
  const sourceStart = extra.sourceStart ?? start;
  return {
    id,
    assetId: 'land',
    trackId,
    start,
    end,
    sourceStart,
    sourceEnd: sourceStart + (end - start),
    effects: [],
    keyframes: [],
    ...extra,
  };
}

function track(id: string, type: Track['type'], clips: Clip[], extra: Partial<Track> = {}): Track {
  return { id, type, clips, ...extra };
}

const text = (id: string, trackId: string, words: string): Clip =>
  clip(id, trackId, 0, 4, {
    assetId: '__text__',
    sourceStart: 0,
    effects: [
      { id: `${id}__t`, type: 'text', params: { text: words, xPercent: 25 }, keyframes: [] },
    ],
  });

const summary = (timeline: Timeline, t: number, burnCaptions = false) =>
  framePlanAt(timeline, ASSETS, t, FRAME, { burnCaptions }).layers.map((layer) => [
    layer.kind,
    layer.role,
    layer.clipId,
  ]);

describe('framePlanAt', () => {
  it('composites text in its track position, back to front', () => {
    const timeline: Timeline = {
      tracks: [
        track('front', 'video', [clip('f', 'front', 0, 4)]),
        track('words', 'overlay', [text('t', 'words', 'Hi')]),
        track('back', 'video', [clip('b', 'back', 0, 4)]),
      ],
    };
    expect(summary(timeline, 1)).toEqual([
      ['picture', 'clip', 'b'],
      ['text', 'clip', 't'],
      ['picture', 'clip', 'f'],
    ]);
    const textLayer = framePlanAt(timeline, ASSETS, 1, FRAME).layers[1];
    expect(textLayer?.geometry?.anchorX).toBe(320);
    expect(textLayer?.geometry?.width).toBeNull();
  });

  it('drops hidden tracks and is end-exclusive', () => {
    const timeline: Timeline = {
      tracks: [
        track('front', 'video', [clip('f', 'front', 0, 4)], { hidden: true }),
        track('back', 'video', [clip('b', 'back', 1, 2)]),
      ],
    };
    expect(summary(timeline, 1.5)).toEqual([['picture', 'clip', 'b']]);
    expect(summary(timeline, 2)).toEqual([]);
  });

  it('burns captions above every track, in caption-track list order', () => {
    const caption = (id: string, trackId: string): Clip =>
      clip(id, trackId, 0, 4, {
        assetId: '__caption__',
        sourceStart: 0,
        captionCue: { text: id, words: [] },
      });
    const timeline: Timeline = {
      tracks: [
        track('c1', 'caption', [caption('k1', 'c1')]),
        track('v', 'video', [clip('p', 'v', 0, 4)]),
        track('c2', 'caption', [caption('k2', 'c2')]),
      ],
    };
    expect(summary(timeline, 1, true)).toEqual([
      ['picture', 'clip', 'p'],
      ['caption', 'clip', 'k1'],
      ['caption', 'clip', 'k2'],
    ]);
    expect(summary(timeline, 1)).toEqual([['picture', 'clip', 'p']]);
  });

  it('letterboxes a landscape source into the frame and applies authored scale', () => {
    const timeline: Timeline = {
      tracks: [
        track('v', 'video', [
          clip('c', 'v', 0, 4, {
            keyframes: [{ id: 's', time: 0, property: 'scale', value: 0.5, easing: 'linear' }],
          }),
        ]),
      ],
    };
    const geometry = framePlanAt(timeline, ASSETS, 1, { width: 1080, height: 1920 }).layers[0]
      ?.geometry;
    expect(geometry?.baseScale).toBeCloseTo(1080 / 1920, 12);
    expect(geometry?.width).toBeCloseTo(540, 9);
    expect(geometry?.anchorX).toBeCloseTo(540, 9);
    expect(geometry?.anchorY).toBeCloseTo(960, 9);
  });

  it('places a still without its crop or opacity, as the export does', () => {
    const still = clip('s', 'v', 0, 4, {
      assetId: 'png',
      sourceStart: 0,
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      keyframes: [{ id: 'o', time: 0, property: 'opacity', value: 0.25, easing: 'linear' }],
    });
    const layer = framePlanAt({ tracks: [track('v', 'video', [still])] }, ASSETS, 1, FRAME)
      .layers[0];
    expect(layer?.crop).toBeNull();
    expect(layer?.opacity).toBe(1);
    expect(layer?.geometry?.baseScale).toBeCloseTo(720 / 600, 12);
  });

  it('puts a transition under-layer from the neighbour handle beneath the incoming clip', () => {
    const incoming = clip('b', 'v', 2, 4, {
      sourceStart: 8,
      effects: [
        {
          id: 'b__transition',
          type: 'transition',
          params: { kind: 'glitch', durationSeconds: 0.5, fromClipId: 'a' },
          keyframes: [],
        },
      ],
    });
    const timeline: Timeline = {
      tracks: [track('v', 'video', [clip('a', 'v', 0, 2, { sourceStart: 3 }), incoming])],
    };
    const [underlay, top] = framePlanAt(timeline, ASSETS, 2.25, FRAME, {
      sourceFps: { land: 30 },
    }).layers;
    expect(underlay?.role).toBe('underlay');
    expect(underlay?.forClipId).toBe('b');
    expect(underlay?.source?.time).toBe(0.25 + 5);
    expect(underlay?.source?.frame).toBe(157);
    expect(top?.transitions).toEqual([
      expect.objectContaining({ role: 'in', kind: 'glitch', path: 'catalog', progress: 0.5 }),
    ]);
  });

  it('maps constant speed, freeze and reverse as MoviePy does', () => {
    const base = { sourceStart: 4, sourceEnd: 8 };
    expect(videoSourceTime({ ...base }, 0.5, 30, 20)).toBe(0.5 + 4);
    expect(videoSourceTime({ ...base, speed: 2 }, 0.5, 30, 20)).toBe(2 * 0.5 + 4);
    expect(videoSourceTime({ ...base, speed: 0 }, 0.5, 30, 20)).toBe(4);
    expect(videoSourceTime({ ...base, speed: -2 }, 0.5, 30, 20)).toBe(4 - 2 * 0.5 - 1 / 30 + 4);
    // Reverse needs the probed fps: the time mirror is one source frame short.
    expect(videoSourceTime({ ...base, speed: -1 }, 0.5, null, 20)).toBeNull();
    expect(sourceFrameIndex(2.9999999999, 30)).toBe(90);
  });

  it('maps a speed ramp through the shared curve inversion', () => {
    const ramped = videoSourceTime(
      {
        sourceStart: 2,
        sourceEnd: 4,
        speedRamp: [
          { id: 'p0', sourceTime: 0, rate: 1, easing: 'linear' },
          { id: 'p1', sourceTime: 2, rate: 1, easing: 'linear' },
        ],
      },
      0.5,
      30,
      20,
    );
    expect(ramped).toBeCloseTo(2.5, 9);
  });

  it('refuses a non-finite time and never mutates its inputs', () => {
    const timeline: Timeline = Object.freeze({
      tracks: Object.freeze([
        Object.freeze(track('v', 'video', [Object.freeze(clip('c', 'v', 0, 4))])),
      ]),
    }) as Timeline;
    expect(() => framePlanAt(timeline, ASSETS, Number.NaN, FRAME)).toThrow(FramePlanError);
    expect(framePlanAt(timeline, ASSETS, 1, FRAME).layers).toHaveLength(1);
  });
});

describe('framePlanAt mask stack (schema v22)', () => {
  const rect = (id: string, extra: Record<string, unknown> = {}) =>
    MaskLayerSchema.parse({
      id,
      kind: 'rectangle',
      cx: 960,
      cy: 540,
      width: 400,
      height: 300,
      ...extra,
    });

  it('carries the enabled masks top first with their targets and the source time', () => {
    const masked = clip('c', 'v', 0, 4, {
      sourceStart: 2,
      sourceEnd: 6,
      masks: [
        rect('top'),
        rect('off', { enabled: false }),
        rect('grade', { mode: 'subtract', target: { kind: 'effect', effectId: 'g1' } }),
      ],
    });
    const layer = framePlanAt({ tracks: [track('v', 'video', [masked])] }, ASSETS, 1, FRAME)
      .layers[0]!;
    expect(layer.mask?.sourceTime).toBe(3);
    expect(layer.mask?.layers.map((entry) => entry.id)).toEqual(['top', 'grade']);
    expect(layer.mask?.layers[1]?.target).toEqual({ kind: 'effect', effectId: 'g1' });
  });

  it('plans a clip whose masks are all disabled as unmasked', () => {
    const masked = clip('c', 'v', 0, 4, { masks: [rect('off', { enabled: false })] });
    const layer = framePlanAt({ tracks: [track('v', 'video', [masked])] }, ASSETS, 1, FRAME)
      .layers[0]!;
    expect(layer.mask).toBeNull();
  });

  it('evaluates masks on the continuous source clock for reverse and freeze', () => {
    const base = { sourceStart: 2, sourceEnd: 6 };
    expect(maskSourceTime({ ...base, speed: -1 }, 1)).toBe(5);
    expect(maskSourceTime({ ...base, speed: 0 }, 1)).toBe(2);
    expect(maskSourceTime({ ...base, speed: 2 }, 1)).toBe(4);
  });
});
