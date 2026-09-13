import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { applyPatch, invertPatch } from './patch.js';
import type { TrackSample } from './track-samples.js';
import { compileTrackingCommand, type ApplyTrackedMaskCommand } from './tracking-commands.js';

const assets: Asset[] = [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 4 }];
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
            effects: [
              {
                id: 'shot__mask',
                type: 'mask',
                params: {
                  shape: 'rectangle',
                  bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                  feather: 0.05,
                },
                keyframes: [],
              },
            ],
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
      { frame: 60, box: { x: 0.5, y: 0.2, width: 0.3, height: 0.4 }, confidence: 0.9, occluded: false },
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

  it('steers the mask effect itself, which is what export animates', () => {
    const result = compile();
    if (result.status !== 'compiled') throw new Error('expected compilation');

    const applied = applyPatch(timeline(), result.patch);
    const mask = applied.tracks[0]!.clips[0]!.effects.find((effect) => effect.id === 'shot__mask')!;
    expect(mask.params).toMatchObject({
      shape: 'rectangle',
      bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      feather: 0.05,
    });
    const xs = mask.keyframes
      .filter((keyframe) => keyframe.property === 'x')
      .sort((left, right) => left.time - right.time);
    expect(xs.length).toBe(8);
    expect(xs[xs.length - 1]!.value).toBeGreaterThan(xs[0]!.value);
    expect(xs[xs.length - 1]!.time).toBeGreaterThan(xs[0]!.time);
  });

  it('point follow moves only the centre, keeping the drawn mask size', () => {
    const tiny = Array.from({ length: 8 }, (_unused, frame) => ({
      frame,
      box: { x: 0.24 + frame * 0.01, y: 0.39, width: 0.02, height: 0.02 },
      confidence: 0.9,
      occluded: false,
    }));
    const result = compile({ target: 'object', samples: tiny });
    if (result.status !== 'compiled') throw new Error(`expected compilation: ${JSON.stringify(result)}`);

    const mask = applyPatch(timeline(), result.patch).tracks[0]!.clips[0]!.effects.find(
      (effect) => effect.id === 'shot__mask',
    )!;
    const values = (property: string) =>
      mask.keyframes.filter((keyframe) => keyframe.property === property).map((keyframe) => keyframe.value);
    expect(new Set(values('width'))).toEqual(new Set([0.3]));
    expect(new Set(values('height'))).toEqual(new Set([0.4]));
    // Centre 0.25 → mask x 0.25 - 0.15 = 0.10 at frame 0.
    expect(values('x')[0]).toBeCloseTo(0.1 + 0.01, 1);
    expect(values('y')[0]).toBeCloseTo(0.2, 5);
  });

  it('times keyframes from the requested first frame when the opening frames were occluded', () => {
    const late = samples(8).map((sample) =>
      sample.frame < 3 ? { ...sample, occluded: true, confidence: 0 } : sample,
    );
    const anchored = compile({ samples: late, firstFrame: 0 });
    if (anchored.status !== 'compiled') throw new Error('expected compilation');
    const mask = applyPatch(timeline(), anchored.patch).tracks[0]!.clips[0]!.effects.find(
      (effect) => effect.id === 'shot__mask',
    )!;
    const firstTime = Math.min(...mask.keyframes.map((keyframe) => keyframe.time));
    expect(firstTime).toBeCloseTo(3 / 30, 6);
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
    if (result.status !== 'compiled') throw new Error(`expected compilation: ${JSON.stringify(result)}`);
    const times = result.patch.operations
      .flatMap((operation) => ('keyframes' in operation ? (operation.keyframes ?? []) : []))
      .map((keyframe) => keyframe.time);
    expect(Math.max(...times)).toBeLessThanOrEqual(2);
    expect(Math.max(...times)).toBeGreaterThan(1.9);
  });

  it('refuses a reversed clip with a clear reason instead of mistiming the track', () => {
    const reversed = timeline();
    (reversed.tracks[0]!.clips[0]! as { speed?: number }).speed = -1;
    expect(
      compileTrackingCommand({ timeline: reversed, assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'unusable_track', detail: expect.stringMatching(/forward/) });
  });

  it('refuses keyframes that would fall outside the clip', () => {
    const result = compile({ startSeconds: 3.99, samples: samples(30) });

    expect(result).toMatchObject({ status: 'rejected', code: 'unusable_track' });
  });
});
