import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { applyPatch } from './patch.js';
import {
  compileMotionCommand,
  type MotionCommand,
  type MotionCommandCompileResult,
} from './motion-commands.js';

const RATE_30 = { numerator: 30, denominator: 1 } as const;
const RATE_2997 = { numerator: 30_000, denominator: 1001 } as const;

const baseTimeline = (locked = false): Timeline => ({
  revision: 3,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      ...(locked ? { locked: true } : {}),
      clips: [
        {
          id: 'hero',
          assetId: 'hero_asset',
          trackId: 'v1',
          start: 10,
          end: 20,
          sourceStart: 0,
          sourceEnd: 10,
          effects: [],
          keyframes: [{ id: 'old', time: 1, property: 'scale', value: 1.05, easing: 'linear' }],
        },
      ],
    },
  ],
});

const assets: Asset[] = [
  {
    id: 'hero_asset',
    path: 'hero.mp4',
    kind: 'video',
    durationSeconds: 10,
  },
];

function command(overrides: Partial<MotionCommand> = {}): MotionCommand {
  return {
    type: 'animate_clip_property',
    timelineRevision: 3,
    clipId: 'hero',
    property: 'scale',
    rate: RATE_30,
    points: [
      { domain: 'clip', frame: 30, value: 1, easing: 'ease-in-out' },
      { domain: 'clip', frame: 45, value: 1.1, easing: 'ease-out' },
    ],
    ...overrides,
  } as MotionCommand;
}

function compiled(
  motion: MotionCommand,
  timeline = baseTimeline(),
): Extract<MotionCommandCompileResult, { status: 'compiled' }> {
  const result = compileMotionCommand({ timeline, assets, command: motion });
  expect(result.status, result.status === 'rejected' ? result.detail : undefined).toBe('compiled');
  return result as Extract<MotionCommandCompileResult, { status: 'compiled' }>;
}

describe('motion command compiler', () => {
  it('compiles clip-frame motion with replace semantics and exact undo', () => {
    const base = baseTimeline();
    const result = compiled(command(), base);
    expect(result.patch.operations).toEqual([
      {
        type: 'add_keyframes',
        clipId: 'hero',
        replace: true,
        keyframes: [
          {
            id: 'motion__hero__scale__30',
            time: 1,
            property: 'scale',
            value: 1,
            easing: 'ease-in-out',
          },
          {
            id: 'motion__hero__scale__45',
            time: 1.5,
            property: 'scale',
            value: 1.1,
            easing: 'ease-out',
          },
        ],
      },
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips[0]!.keyframes.map((keyframe) => keyframe.id)).toEqual([
      'motion__hero__scale__30',
      'motion__hero__scale__45',
    ]);
    const restored = applyPatch(edited, result.inversePatch);
    expect({ ...restored, revision: base.revision }).toEqual(base);
  });

  it('converts rational clip frames without decimal-fps drift', () => {
    const result = compiled(
      command({
        rate: RATE_2997,
        points: [
          { domain: 'clip', frame: 0, value: 0, easing: 'linear' },
          { domain: 'clip', frame: 10, value: 1, easing: 'ease-in-out' },
        ],
        property: 'opacity',
      }),
    );
    const operation = result.patch.operations[0];
    expect(operation.type).toBe('add_keyframes');
    if (operation.type === 'add_keyframes') {
      expect(operation.keyframes[1]!.time).toBe((10 * 1001) / 30_000);
    }
  });

  it.each([
    [command({ timelineRevision: 2 }), 'stale_timeline'],
    [command({ rate: { numerator: 0, denominator: 1 } }), 'invalid_frame_rate'],
    [
      command({ points: [{ domain: 'clip', frame: 0, value: 1, easing: 'linear' }] }),
      'insufficient_points',
    ],
    [
      command({
        points: [
          { domain: 'clip', frame: 2, value: 1, easing: 'linear' },
          { domain: 'clip', frame: 2, value: 1.1, easing: 'linear' },
        ],
      }),
      'duplicate_frame',
    ],
    [command({ clipId: 'missing' }), 'missing_clip'],
    [
      command({
        points: [
          { domain: 'clip', frame: 0, value: 1, easing: 'linear' },
          { domain: 'clip', frame: 301, value: 1.1, easing: 'linear' },
        ],
      }),
      'point_outside_clip',
    ],
    [
      command({
        property: 'opacity',
        points: [
          { domain: 'clip', frame: 0, value: 1, easing: 'linear' },
          { domain: 'clip', frame: 1, value: 1.1, easing: 'linear' },
        ],
      }),
      'invalid_keyframe',
    ],
  ] as const)('rejects invalid motion as %s', (motion, code) => {
    expect(
      compileMotionCommand({ timeline: baseTimeline(), assets, command: motion }),
    ).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('rejects a locked destination track', () => {
    expect(
      compileMotionCommand({ timeline: baseTimeline(true), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'locked_track' });
  });
});
