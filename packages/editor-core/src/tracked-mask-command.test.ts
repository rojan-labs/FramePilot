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

  it('refuses keyframes that would fall outside the clip', () => {
    const result = compile({ startSeconds: 3.99, samples: samples(30) });

    expect(result).toMatchObject({ status: 'rejected', code: 'unusable_track' });
  });
});
