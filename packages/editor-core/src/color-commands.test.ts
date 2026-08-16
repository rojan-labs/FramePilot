import { describe, expect, it } from 'vitest';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { applyPatch } from './patch.js';
import {
  compileColorCommand,
  type ColorCommand,
  type ColorCommandCompileResult,
} from './color-commands.js';

const assets: Asset[] = [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 8 }];

function timeline(options: { readonly locked?: boolean; readonly audio?: boolean } = {}): Timeline {
  return {
    revision: 4,
    tracks: [
      {
        id: 'v1',
        type: options.audio ? 'audio' : 'video',
        ...(options.locked ? { locked: true } : {}),
        clips: [
          {
            id: 'shot',
            assetId: 'asset',
            trackId: 'v1',
            start: 0,
            end: 8,
            sourceStart: 0,
            sourceEnd: 8,
            effects: [
              {
                id: 'creative_lut',
                type: 'lut',
                params: { path: 'looks/film.cube' },
                keyframes: [],
              },
              {
                id: 'color__shot__primary',
                type: 'color_grade',
                params: { exposure: 0.1, saturation: 0.9 },
                keyframes: [],
              },
            ],
            keyframes: [],
          },
        ],
      },
    ],
  };
}

function command(overrides: Partial<ColorCommand> = {}): ColorCommand {
  return {
    type: 'correct_shot',
    timelineRevision: 4,
    clipId: 'shot',
    adjustments: { exposure: 0.2, temperature: -0.05 },
    ...overrides,
  } as ColorCommand;
}

function compiled(
  color: ColorCommand,
  base = timeline(),
): Extract<ColorCommandCompileResult, { status: 'compiled' }> {
  const result = compileColorCommand({ timeline: base, assets, command: color });
  expect(result.status, result.status === 'rejected' ? result.detail : undefined).toBe('compiled');
  return result as Extract<ColorCommandCompileResult, { status: 'compiled' }>;
}

describe('color command compiler', () => {
  it('merges the canonical primary correction without disturbing a creative look', () => {
    const base = timeline();
    const result = compiled(command(), base);
    expect(result.patch.operations).toEqual([
      {
        type: 'apply_color_grade',
        clipId: 'shot',
        effect: {
          id: 'color__shot__primary',
          type: 'color_grade',
          params: { exposure: 0.2, saturation: 0.9, temperature: -0.05 },
          keyframes: [],
        },
      },
    ]);
    const edited = applyPatch(base, result.patch);
    expect(edited.tracks[0]!.clips[0]!.effects.map((effect) => effect.id)).toEqual([
      'creative_lut',
      'color__shot__primary',
    ]);
    const restored = applyPatch(edited, result.inversePatch);
    expect({ ...restored, revision: base.revision }).toEqual(base);
  });

  it('creates the canonical node when the clip has no primary correction', () => {
    const base = timeline();
    base.tracks[0]!.clips[0]!.effects = [];
    expect(compiled(command(), base).patch.operations[0]).toMatchObject({
      type: 'apply_color_grade',
      effect: { id: 'color__shot__primary', params: { exposure: 0.2, temperature: -0.05 } },
    });
  });

  it.each([
    [command({ timelineRevision: 3 }), 'stale_timeline'],
    [command({ clipId: 'missing' }), 'missing_clip'],
    [command({ adjustments: {} }), 'empty_adjustments'],
    [command({ adjustments: { exposure: 9 } }), 'invalid_grade'],
  ] as const)('rejects invalid color input as %s', (color, code) => {
    expect(compileColorCommand({ timeline: timeline(), assets, command: color })).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('rejects locked and non-visual tracks', () => {
    expect(
      compileColorCommand({ timeline: timeline({ locked: true }), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'locked_track' });
    expect(
      compileColorCommand({ timeline: timeline({ audio: true }), assets, command: command() }),
    ).toMatchObject({ status: 'rejected', code: 'wrong_track_kind' });
  });
});
