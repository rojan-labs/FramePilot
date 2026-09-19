import { describe, expect, it } from 'vitest';
import type { Asset, MaskLayer, Timeline } from '@framepilot/timeline-schema';
import { applyPatch, invertPatch } from './patch.js';
import type { TrackSample } from './track-samples.js';
import { compileTrackingCommand, type ApplyTrackedMaskCommand } from './tracking-commands.js';

const W = 1920;
const H = 1080;
const assets: Asset[] = [
  {
    id: 'asset',
    path: 'shot.mp4',
    kind: 'video',
    durationSeconds: 4,
    media: { width: W, height: H },
  },
];

/** The drawn box {x 0.1, y 0.2, w 0.3, h 0.4} as a v22 rectangle in source pixels. */
const drawnMask = {
  kind: 'rectangle',
  id: 'shot__mask',
  name: '',
  color: '#3b82f6',
  enabled: true,
  locked: false,
  target: { kind: 'alpha' },
  mode: 'add',
  opacity: 1,
  invert: false,
  expansionPx: 0,
  featherInnerPx: 0,
  featherOuterPx: 54,
  falloff: 'smooth',
  featherModel: 'distance',
  space: 'source',
  keyframes: [],
  cx: 0.25 * W,
  cy: 0.4 * H,
  width: 0.3 * W,
  height: 0.4 * H,
  rotation: 0,
  roundness: 0,
} satisfies MaskLayer;

const maskOf = (value: Timeline): MaskLayer =>
  value.tracks[0]!.clips[0]!.masks!.find((mask) => mask.id === 'shot__mask')!;
const ENGINE = 'framepilot.tracking-lite@1.0.0';

function timeline(options: { readonly locked?: boolean } = {}): Timeline {
  return {
    revision: 3,
    tracks: [
      {
        id: 'v1',
        type: 'video',
        ...(options.locked ? { locked: true } : {}),
        clips: [
          {
            id: 'shot',
            assetId: 'asset',
            trackId: 'v1',
            start: 0,
            end: 4,
            sourceStart: 0,
            sourceEnd: 4,
            effects: [],
            masks: [drawnMask],
            keyframes: [],
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

function samples(count = 8, overrides: Partial<TrackSample> = {}): TrackSample[] {
  return Array.from({ length: count }, (_unused, frame) => ({
    frame,
    box: { x: 0.1 + frame * 0.01, y: 0.2, width: 0.3, height: 0.4 },
    confidence: 0.9,
    occluded: false,
    ...overrides,
  }));
}

function command(overrides: Partial<ApplyTrackedMaskCommand> = {}): ApplyTrackedMaskCommand {
  return {
    type: 'apply_tracked_mask',
    timelineRevision: 3,
    clipId: 'shot',
    maskEffectId: 'shot__mask',
    target: 'bounding_box',
    engine: ENGINE,
    fps: 30,
    startSeconds: 0,
    samples: samples(),
    ...overrides,
  };
}

function compile(overrides: Partial<ApplyTrackedMaskCommand> = {}, options = {}) {
  return compileTrackingCommand({
    timeline: timeline(options),
    assets,
    command: command(overrides),
  });
}

describe('apply_tracked_mask', () => {
  it('compiles measured samples into a validated tracking patch', () => {
    const result = compile();

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    const operation = result.patch.operations[0]!;
    expect(operation.type).toBe('track_object');
    expect(operation).toMatchObject({ clipId: 'shot', engine: ENGINE });
    expect(result.facts).toContainEqual({ name: 'engine', value: ENGINE });
  });

  it('records the exact pack identity that measured the track', () => {
    const result = compile({ engine: 'framepilot.tracking-lite@1.2.3' });

    if (result.status !== 'compiled') throw new Error('expected compilation');
    expect(result.patch.operations[0]).toMatchObject({ engine: 'framepilot.tracking-lite@1.2.3' });
  });

  it('inverts exactly, restoring the original timeline', () => {
    const original = timeline();
    const result = compile();

    if (result.status !== 'compiled') throw new Error('expected compilation');
    const applied = applyPatch(original, result.patch);
    expect(applied).not.toEqual(original);
    const restored = applyPatch(applied, result.inversePatch);
    expect(restored.tracks).toEqual(original.tracks);
  });

  it('survives a save/reload round trip and still inverts', () => {
    const original = timeline();
    const result = compile();

    if (result.status !== 'compiled') throw new Error('expected compilation');
    const applied = applyPatch(original, result.patch);
    const reloaded = JSON.parse(JSON.stringify(applied)) as Timeline;
    expect(reloaded).toEqual(applied);
    const inverse = invertPatch(original, result.patch);
    expect(applyPatch(reloaded, inverse).tracks).toEqual(original.tracks);
  });

  it('is deterministic: identical samples compile to an identical patch', () => {
    expect(compile()).toEqual(compile());
  });

  it('refuses a track whose subject was lost for too long rather than smoothing over it', () => {
    const gapped: TrackSample[] = [
      ...samples(3),
      {
        frame: 60,
        box: { x: 0.5, y: 0.2, width: 0.3, height: 0.4 },
        confidence: 0.9,
        occluded: false,
      },
    ];

    const result = compile({ samples: gapped });

    expect(result).toMatchObject({ status: 'rejected', code: 'unusable_track' });
  });

  it('refuses a track with no confident measurement at all', () => {
    const result = compile({ samples: samples(6, { occluded: true, confidence: 0 }) });

    expect(result).toMatchObject({ status: 'rejected', code: 'unusable_track' });
  });

  it.each([
    ['a stale timeline revision', { timelineRevision: 2 }, 'stale_timeline', {}],
    ['a missing clip', { clipId: 'nope' }, 'missing_clip', {}],
    ['a missing mask', { maskEffectId: 'nope' }, 'missing_mask', {}],
    ['a locked track', {}, 'locked_track', { locked: true }],
  ])('rejects %s', (_label, overrides, code, options) => {
    expect(compile(overrides as Partial<ApplyTrackedMaskCommand>, options)).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('steers the mask itself, on the source clock and in source pixels', () => {
    const result = compile();
    if (result.status !== 'compiled') throw new Error('expected compilation');

    const mask = maskOf(applyPatch(timeline(), result.patch));
    expect(mask).toMatchObject({
      kind: 'rectangle',
      cx: 0.25 * W,
      width: 0.3 * W,
      featherOuterPx: 54,
    });
    const cxs = mask.keyframes.filter((keyframe) => keyframe.property === 'cx');
    expect(cxs.length).toBe(8);
    expect(cxs[cxs.length - 1]!.value).toBeGreaterThan(cxs[0]!.value);
    expect(cxs[cxs.length - 1]!.sourceTime).toBeGreaterThan(cxs[0]!.sourceTime);
    expect(result.patch.operations.map((operation) => operation.type)).toEqual([
      'track_object',
      'remove_mask',
      'add_mask',
    ]);
  });

  it('point follow moves only the centre, keeping the drawn mask size', () => {
    const tiny = Array.from({ length: 8 }, (_unused, frame) => ({
      frame,
      box: { x: 0.24 + frame * 0.01, y: 0.39, width: 0.02, height: 0.02 },
      confidence: 0.9,
      occluded: false,
    }));
    const result = compile({ target: 'object', samples: tiny });
    if (result.status !== 'compiled')
      throw new Error(`expected compilation: ${JSON.stringify(result)}`);

    const mask = maskOf(applyPatch(timeline(), result.patch));
    const values = (property: string) =>
      mask.keyframes
        .filter((keyframe) => keyframe.property === property)
        .map((keyframe) => keyframe.value);
    expect(values('width')).toEqual([]);
    expect(values('height')).toEqual([]);
    expect(mask).toMatchObject({ width: 0.3 * W, height: 0.4 * H });
    // Centre 0.25 of the frame at frame 0.
    expect(Math.abs(values('cx')[0]! - 0.25 * W)).toBeLessThan(0.05 * W);
    expect(values('cy')[0]).toBeCloseTo(0.4 * H, 3);
  });

  it('times keyframes from the requested first frame when the opening frames were occluded', () => {
    const late = samples(8).map((sample) =>
      sample.frame < 3 ? { ...sample, occluded: true, confidence: 0 } : sample,
    );
    const anchored = compile({ samples: late, firstFrame: 0 });
    if (anchored.status !== 'compiled') throw new Error('expected compilation');
    const mask = maskOf(applyPatch(timeline(), anchored.patch));
    const firstTime = Math.min(...mask.keyframes.map((keyframe) => keyframe.sourceTime));
    expect(firstTime).toBeCloseTo(3 / 30, 6);
  });

  it('refuses media whose size was never measured, rather than guessing one', () => {
    const result = compileTrackingCommand({
      timeline: timeline(),
      assets: [{ id: 'asset', path: 'shot.mp4', kind: 'video' }],
      command: command(),
    });
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'missing_region',
      detail: expect.stringMatching(/Measure this media first/),
    });
  });

  it('places keyframes in clip time for a clip playing at speed 2', () => {
    const fast = timeline();
    const clip = fast.tracks[0]!.clips[0]! as { end: number; sourceEnd: number; speed?: number };
    clip.end = 2;
    clip.sourceEnd = 4;
    clip.speed = 2;
    // 120 source frames at 30fps = 4 source seconds = 2 clip seconds.
    const result = compileTrackingCommand({
      timeline: fast,
      assets,
      command: command({ samples: samples(120).map((s) => ({ ...s, box: { ...s.box, x: 0.1 } })) }),
    });
    if (result.status !== 'compiled')
      throw new Error(`expected compilation: ${JSON.stringify(result)}`);
    const times = result.patch.operations
      .flatMap((operation) =>
        operation.type === 'track_object' ? (operation.keyframes ?? []) : [],
      )
      .map((keyframe) => keyframe.time);
    // The mask's own keyframes are on the SOURCE clock: 2 clip seconds at 2x reach source 4s.
    const sourceTimes = result.patch.operations.flatMap((operation) =>
      operation.type === 'add_mask'
        ? (operation.mask.keyframes ?? []).map((keyframe) => keyframe.sourceTime)
        : [],
    );
    expect(Math.max(...sourceTimes)).toBeGreaterThan(3.8);
    expect(Math.max(...times)).toBeLessThanOrEqual(2);
    expect(Math.max(...times)).toBeGreaterThan(1.9);
  });

  it('refuses a reversed clip with a clear reason instead of mistiming the track', () => {
    const reversed = timeline();
    (reversed.tracks[0]!.clips[0]! as { speed?: number }).speed = -1;
    expect(
      compileTrackingCommand({ timeline: reversed, assets, command: command() }),
    ).toMatchObject({
      status: 'rejected',
      code: 'unusable_track',
      detail: expect.stringMatching(/forward/),
    });
  });

  it('refuses keyframes that would fall outside the clip', () => {
    const result = compile({ startSeconds: 3.99, samples: samples(30) });

    expect(result).toMatchObject({ status: 'rejected', code: 'unusable_track' });
  });
});
