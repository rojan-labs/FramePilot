import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { applyPatch } from './patch.js';
import {
  compileTrackingCommand,
  type TrackingCommand,
  type TrackingCommandCompileResult,
} from './tracking-commands.js';

const assets: Asset[] = [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 4 }];

function timeline(options: { readonly locked?: boolean; readonly shape?: string } = {}): Timeline {
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
                  shape: options.shape ?? 'rectangle',
                  bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                  feather: 0.05,
                },
                keyframes: [
                  { id: 'x0', time: 0, property: 'x', value: 0.1, easing: 'linear' },
                  { id: 'x1', time: 4, property: 'x', value: 0.4, easing: 'ease-in-out' },
                ],
              },
            ],
            keyframes: [],
          },
        ],
      },
    ],
  };
}

function command(overrides: Partial<TrackingCommand> = {}): TrackingCommand {
  return {
    type: 'track_existing_mask',
    timelineRevision: 3,
    clipId: 'shot',
    maskEffectId: 'shot__mask',
    target: 'object',
    engine: 'manual',
    ...overrides,
  } as TrackingCommand;
}

function compiled(
  value: TrackingCommand,
  base = timeline(),
): Extract<TrackingCommandCompileResult, { status: 'compiled' }> {
  const result = compileTrackingCommand({ timeline: base, assets, command: value });
  expect(result.status, result.status === 'rejected' ? result.detail : undefined).toBe('compiled');
  return result as Extract<TrackingCommandCompileResult, { status: 'compiled' }>;
}

describe('tracking command compiler', () => {
  it('turns existing mask corrections into a reversible manual object track', () => {
    const base = timeline();
    const result = compiled(command(), base);
    expect(result.patch.operations).toEqual([
      expect.objectContaining({
        type: 'track_object',
        clipId: 'shot',
        target: 'object',
        engine: 'manual',
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        keyframes: expect.arrayContaining([
          expect.objectContaining({ property: 'x', time: 4, value: 0.4 }),
          expect.objectContaining({ property: 'width', time: 0, value: 0.3 }),
        ]),
      }),
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips[0]!.effects.map((effect) => effect.id)).toEqual([
      'shot__mask',
      'shot__track',
    ]);
    const restored = applyPatch(edited, result.inversePatch);
    expect({ ...restored, revision: base.revision }).toEqual(base);
  });

  it.each([
    [command({ timelineRevision: 2 }), 'stale_timeline'],
    [command({ clipId: 'missing' }), 'missing_clip'],
    [command({ maskEffectId: 'missing' }), 'missing_mask'],
  ] as const)('rejects invalid command input', (value, code) => {
    expect(compileTrackingCommand({ timeline: timeline(), assets, command: value })).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('rejects locked tracks, polygons, and mask motion that leaves the frame', () => {
    expect(
      compileTrackingCommand({ timeline: timeline({ locked: true }), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'locked_track' });
    expect(
      compileTrackingCommand({ timeline: timeline({ shape: 'polygon' }), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'unsupported_mask_shape' });
    const unsafe = timeline();
    unsafe.tracks[0]!.clips[0]!.effects[0]!.keyframes[1]!.value = 0.8;
    expect(compileTrackingCommand({ timeline: unsafe, assets, command: command() })).toMatchObject({
      status: 'rejected',
      code: 'invalid_mask_motion',
    });
  });
});
