/**
 * `framePlanAt`'s per-timeline index: the time-independent work (track order, transition
 * under-layers, matte sources, caption spans, keyframe curves) is done once per timeline object
 * and reused. These tests pin that reusing it changes nothing, that an edit is never served the
 * previous timeline's index, and that a plan's cost follows what is on screen, not the clip
 * count. The desktop monitor plans up to 14 times per display refresh.
 */
import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  type Asset,
  type Clip,
  type Keyframe,
  type Timeline,
  type Track,
  type TranscriptWord,
} from '@framepilot/timeline-schema';
import { framePlanAt, type FramePlan, type FramePlanOptions } from './frame-plan.js';

const FRAME = { width: 1280, height: 720 } as const;

const ASSETS: readonly Asset[] = [
  {
    id: 'land',
    path: 'land.mp4',
    kind: 'video',
    durationSeconds: 5000,
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

const transitionIn = (id: string, kind: string, fromClipId?: string) => ({
  id: `${id}__transition`,
  type: 'transition',
  params: { kind, durationSeconds: 0.6, ...(fromClipId === undefined ? {} : { fromClipId }) },
  keyframes: [],
});

const transitionOut = (id: string, kind: string, toClipId?: string) => ({
  id: `${id}__transition_out`,
  type: 'transition_out',
  params: {
    kind,
    durationSeconds: 0.4,
    alignment: 'end',
    ...(toClipId === undefined ? {} : { toClipId }),
  },
  keyframes: [],
});

const keyframe = (id: string, property: string, time: number, value: number): Keyframe => ({
  id,
  property,
  time,
  value,
  easing: 'ease-in-out',
});

/** A cut sequence of `count` two-second shots, each dissolving in from the one before it. */
function cutSequence(trackId: string, count: number): Clip[] {
  return Array.from({ length: count }, (_, i) =>
    clip(`${trackId}${i}`, trackId, i * 2, (i + 1) * 2, {
      sourceStart: i * 3,
      effects: i === 0 ? [] : [transitionIn(`${trackId}${i}`, 'glitch', `${trackId}${i - 1}`)],
    }),
  );
}

/** Many clips per track, every drawn kind, both transition paths, captions, mattes, keyframes. */
function variedTimeline(): { timeline: Timeline; transcript: TranscriptWord[] } {
  const TRANSITION_KINDS = ['cross-dissolve', 'glitch', 'fade', 'push', 'zoom', 'slide-left'];
  const main = Array.from({ length: 90 }, (_, i) => {
    const start = i * 1.5;
    const kind = TRANSITION_KINDS[i % TRANSITION_KINDS.length]!;
    return clip(`m${i}`, 'main', start, start + 1.5, {
      sourceStart: 2 + (i % 7),
      ...(i % 5 === 0 ? { speed: i % 10 === 0 ? 2 : -1 } : {}),
      ...(i % 9 === 0 ? { crop: { x: 0.1, y: 0, width: 0.8, height: 0.9 } } : {}),
      effects: [
        ...(i > 0 && i % 2 === 0 ? [transitionIn(`m${i}`, kind, `m${i - 1}`)] : []),
        ...(i % 3 === 1 ? [transitionIn(`m${i}`, kind)] : []),
        ...(i % 4 === 3 ? [transitionOut(`m${i}`, kind, `m${i + 1}`)] : []),
      ],
      keyframes:
        i % 3 === 0
          ? [
              keyframe(`m${i}k0`, 'scale', 1, 1.4),
              keyframe(`m${i}k1`, 'x', 0.2, -40),
              keyframe(`m${i}k2`, 'scale', 0, 1),
              keyframe(`m${i}k3`, 'opacity', 0.5, 0.5),
              keyframe(`m${i}k4`, 'x', 1.2, 60),
              keyframe(`m${i}k5`, 'rotation', 0.3, 12),
            ]
          : [],
      ...(i === 12
        ? {
            masks: [
              MaskLayerSchema.parse({
                id: 'tm',
                kind: 'layer',
                source: { kind: 'clip', clipId: 'title3' },
                channel: 'luma',
              }),
            ],
          }
        : {}),
    });
  });
  // Stills and titles on an overlay lane, out of list order and partly overlapping.
  const overlay = Array.from({ length: 40 }, (_, i) => {
    const start = ((i * 13) % 40) * 3.2;
    return i % 2 === 0
      ? clip(`still${i}`, 'over', start, start + 4, {
          assetId: 'png',
          sourceStart: 0,
          effects: [transitionOut(`still${i}`, 'slide-left')],
          keyframes: [keyframe(`s${i}k`, 'opacity', 1, 0.3)],
        })
      : clip(`title${i}`, 'over', start, start + 2.5, {
          assetId: '__text__',
          sourceStart: 0,
          effects: [
            {
              id: `title${i}__text`,
              type: 'text',
              params: { text: `Title ${i}`, inAnimation: 'pop', outAnimation: 'fade' },
              keyframes: [],
            },
          ],
        });
  });
  const captions = Array.from({ length: 120 }, (_, i) =>
    clip(`cap${i}`, 'captions', i * 1.1, i * 1.1 + 1.3, {
      assetId: '__caption__',
      sourceStart: 0,
      ...(i % 3 === 0 ? {} : { captionCue: { text: i % 7 === 0 ? '' : `cue ${i}`, words: [] } }),
    }),
  );
  const transcript = Array.from({ length: 400 }, (_, i) => ({
    word: `w${i}`,
    start: i * 0.35,
    end: i * 0.35 + 0.3,
  }));
  return {
    timeline: {
      tracks: [
        track('captions', 'caption', captions),
        track('over', 'overlay', overlay),
        track('main', 'video', main),
        track('bed', 'video', cutSequence('bed', 30)),
        track('hidden', 'video', cutSequence('hidden', 10), { hidden: true }),
      ],
    },
    transcript,
  };
}

function sampleTimes(end: number, step: number): number[] {
  const times: number[] = [];
  for (let t = -0.25; t <= end + 0.25; t += step) times.push(t);
  return times;
}

describe('framePlanAt per-timeline index', () => {
  it('serves the reused index the same plans a fresh one derives', () => {
    const { timeline, transcript } = variedTimeline();
    const options: FramePlanOptions = { burnCaptions: true, sourceFps: { land: 30 }, transcript };
    for (const t of sampleTimes(136, 0.37)) {
      const reused = framePlanAt(timeline, ASSETS, t, FRAME, options);
      // A structural clone is a new object, so it misses every cache.
      const fresh = framePlanAt(structuredClone(timeline), ASSETS, t, FRAME, options);
      expect(reused, `t=${t}`).toStrictEqual(fresh);
    }
  });

  it('draws overlapping clips in start order, whatever their list order', () => {
    const shots = [
      clip('long', 'v', 0, 100),
      ...Array.from({ length: 30 }, (_, i) => {
        const start = (i * 7) % 50;
        return clip(`s${i}`, 'v', start, start + 3 + (i % 4));
      }),
      clip('empty', 'v', 5, 5),
      clip('twin-a', 'v', 20, 22),
      clip('twin-b', 'v', 20, 21),
    ];
    const listed = [...shots.slice(0, 17).reverse(), ...shots.slice(17)];
    const timeline: Timeline = { tracks: [track('v', 'video', listed)] };
    const inStartOrder = [...listed].sort((a, b) => a.start - b.start);
    for (const t of [...sampleTimes(101, 0.25), 5, 20, 21, 22, 100]) {
      const expected = inStartOrder
        .filter((shot) => shot.start <= t && t < shot.start + (shot.end - shot.start))
        .map((shot) => shot.id);
      const drawn = framePlanAt(timeline, ASSETS, t, FRAME).layers.map((layer) => layer.clipId);
      expect(drawn, `t=${t}`).toEqual(expected);
    }
  });

  it('burns overlapping captions in list order', () => {
    const cue = (id: string, start: number, end: number): Clip =>
      clip(id, 'c', start, end, {
        assetId: '__caption__',
        sourceStart: 0,
        captionCue: { text: id, words: [] },
      });
    const cues = [cue('late', 3, 6), cue('wide', 0, 10), cue('early', 1, 4)];
    const timeline: Timeline = { tracks: [track('c', 'caption', cues)] };
    const burned = (t: number) =>
      framePlanAt(timeline, ASSETS, t, FRAME, { burnCaptions: true }).layers.map(
        (layer) => layer.text,
      );
    expect(burned(3.5)).toEqual(['late', 'wide', 'early']);
    expect(burned(0.5)).toEqual(['wide']);
    expect(burned(4)).toEqual(['late', 'wide']);
  });

  it('never serves an edited timeline the index of the one it replaced', () => {
    const { timeline } = variedTimeline();
    const before = framePlanAt(timeline, ASSETS, 3.2, FRAME);
    expect(before.layers.some((layer) => layer.clipId === 'm2')).toBe(true);
    // An edit is a new timeline: move m2 away, as the operations do (copy on write).
    const edited: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((lane) =>
        lane.id !== 'main'
          ? lane
          : {
              ...lane,
              clips: lane.clips.map((shot) =>
                shot.id === 'm2' ? { ...shot, start: 500, end: 501.5 } : shot,
              ),
            },
      ),
    };
    const after = framePlanAt(edited, ASSETS, 3.2, FRAME);
    expect(after.layers.some((layer) => layer.clipId === 'm2')).toBe(false);
    expect(after).toStrictEqual(framePlanAt(structuredClone(edited), ASSETS, 3.2, FRAME));
    expect(framePlanAt(edited, ASSETS, 500.5, FRAME).layers.map((layer) => layer.clipId)).toEqual([
      'm2',
    ]);
    // The original is still planned from its own index.
    expect(framePlanAt(timeline, ASSETS, 3.2, FRAME)).toStrictEqual(before);
  });

  it('rebuilds when the same timeline meets assets of a different kind', () => {
    const timeline: Timeline = { tracks: [track('v', 'video', [clip('c', 'v', 0, 4)])] };
    expect(framePlanAt(timeline, ASSETS, 1, FRAME).layers[0]?.source?.assetKind).toBe('video');
    const asStill: readonly Asset[] = [
      { id: 'land', path: 'land.png', kind: 'image', media: { width: 1920, height: 1080 } },
    ];
    expect(framePlanAt(timeline, asStill, 1, FRAME).layers[0]?.source?.assetKind).toBe('image');
    const asAudio: readonly Asset[] = [{ id: 'land', path: 'land.wav', kind: 'audio' }];
    expect(framePlanAt(timeline, asAudio, 1, FRAME).layers.map((layer) => layer.kind)).toEqual([
      'solid',
    ]);
    expect(framePlanAt(timeline, [...ASSETS], 1, FRAME).layers[0]?.source?.assetKind).toBe('video');
  });
});

/**
 * Wraps each clip in a proxy that counts property reads. Reads are what a plan's cost is made
 * of, and unlike time they do not vary between runs.
 */
function counted(clips: readonly Clip[]): { clips: Clip[]; reads: () => number } {
  let reads = 0;
  const handler: ProxyHandler<Clip> = {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  };
  return { clips: clips.map((shot) => new Proxy(shot, handler)), reads: () => reads };
}

function readsForOnePlan(
  timeline: Timeline,
  reads: () => number,
  t: number,
  options: FramePlanOptions,
): { plan: FramePlan; reads: number } {
  framePlanAt(timeline, ASSETS, 0.5, FRAME, options); // builds the index
  const from = reads();
  const plan = framePlanAt(timeline, [...ASSETS], t, FRAME, options);
  return { plan, reads: reads() - from };
}

describe('framePlanAt cost', () => {
  it('reads the same clips per plan on a 20-shot track as on a 2000-shot one', () => {
    const plannedAt = (count: number) => {
      const { clips, reads } = counted(cutSequence('v', count));
      // Clip 10's dissolve window: an under-layer and the clip itself.
      return readsForOnePlan({ tracks: [track('v', 'video', clips)] }, reads, 20.2, {
        sourceFps: { land: 30 },
      });
    };
    const short = plannedAt(20);
    const long = plannedAt(2000);
    expect(short.plan.layers.map((layer) => [layer.role, layer.clipId])).toEqual([
      ['underlay', 'v9'],
      ['clip', 'v10'],
    ]);
    expect(long.plan).toStrictEqual(short.plan);
    expect(long.reads).toBe(short.reads);
  });

  it('reads the same cues per plan whatever the caption count', () => {
    const plannedAt = (count: number) => {
      const cues = Array.from({ length: count }, (_, i) =>
        clip(`k${i}`, 'c', i, i + 1, {
          assetId: '__caption__',
          sourceStart: 0,
          captionCue: { text: `cue ${i}`, words: [] },
        }),
      );
      const { clips, reads } = counted(cues);
      return readsForOnePlan({ tracks: [track('c', 'caption', clips)] }, reads, 10.5, {
        burnCaptions: true,
      });
    };
    const short = plannedAt(20);
    const long = plannedAt(3000);
    expect(short.plan.layers.map((layer) => layer.text)).toEqual(['cue 10']);
    expect(long.reads).toBe(short.reads);
  });

  it('groups and sorts a clip’s keyframes once, not per evaluation', () => {
    let propertyReads = 0;
    const keyframes = Array.from({ length: 60 }, (_, i) =>
      keyframe(`k${i}`, ['scale', 'x', 'y', 'opacity'][i % 4]!, (i * 7) % 60, i / 10),
    ).map(
      (point) =>
        new Proxy(point, {
          get(target, property, receiver) {
            if (property === 'property') propertyReads += 1;
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    );
    const timeline: Timeline = {
      tracks: [track('v', 'video', [clip('c', 'v', 0, 60, { keyframes })])],
    };
    framePlanAt(timeline, ASSETS, 1, FRAME);
    const afterFirst = propertyReads;
    // Filtering per evaluation read all 60 five times per transform, three transforms a layer.
    for (const t of [2, 7.5, 30, 59]) framePlanAt(timeline, ASSETS, t, FRAME);
    expect(afterFirst).toBeGreaterThan(0);
    expect(propertyReads).toBe(afterFirst);
  });
});
