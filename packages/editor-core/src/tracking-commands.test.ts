import { describe, expect, it } from 'vitest';
import { MaskLayerSchema, type Asset, type Timeline } from '@framepilot/timeline-schema';
import { applyPatch } from './patch.js';
import {
  compileTrackingCommand,
  type TrackingCommand,
  type TrackingCommandCompileResult,
} from './tracking-commands.js';

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
            effects: [],
            masks: [
              options.shape === 'polygon'
                ? MaskLayerSchema.parse({
                    kind: 'path',
                    id: 'shot__mask',
                    pathKeyframes: [
                      {
                        id: 'p0',
                        sourceTime: 0,
                        points: [0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0],
                        vertexTypes: [0, 0, 0],
                      },
                    ],
                  })
                : MaskLayerSchema.parse({
                    kind: 'rectangle',
                    id: 'shot__mask',
                    cx: 0.25 * W,
                    cy: 0.4 * H,
                    width: 0.3 * W,
                    height: 0.4 * H,
                    featherOuterPx: 54,
                    keyframes: [
                      { id: 'x0', sourceTime: 0, property: 'cx', value: 0.25 * W },
                      {
                        id: 'x1',
                        sourceTime: 4,
                        property: 'cx',
                        value: 0.55 * W,
                        easing: 'ease-in-out',
                      },
                    ],
                  }),
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
    expect(result.patch.operations).toHaveLength(1);
    const operation = result.patch.operations[0]!;
    if (operation.type !== 'track_object') throw new Error('expected track_object');
    expect(operation).toMatchObject({ clipId: 'shot', target: 'object', engine: 'manual' });
    expect(operation.region!.x).toBeCloseTo(0.1, 12);
    expect(operation.region!.width).toBeCloseTo(0.3, 12);
    const at = (property: string, time: number) =>
      operation.keyframes!.find(
        (keyframe) => keyframe.property === property && keyframe.time === time,
      )!.value;
    expect(at('x', 4)).toBeCloseTo(0.4, 12);
    expect(at('width', 0)).toBeCloseTo(0.3, 12);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips[0]!.effects.map((effect) => effect.id)).toEqual(['shot__track']);
    expect(edited.tracks[0]!.clips[0]!.masks).toEqual(base.tracks[0]!.clips[0]!.masks);
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
      compileTrackingCommand({
        timeline: timeline({ shape: 'polygon' }),
        assets,
        command: command(),
      }),
    ).toMatchObject({ status: 'rejected', code: 'unsupported_mask_shape' });
    const unsafe = timeline();
    const unsafeMask = unsafe.tracks[0]!.clips[0]!.masks![0]!;
    (unsafeMask.keyframes[1] as { value: number }).value = 0.95 * W;
    expect(compileTrackingCommand({ timeline: unsafe, assets, command: command() })).toMatchObject({
      status: 'rejected',
      code: 'invalid_mask_motion',
    });
  });
});
