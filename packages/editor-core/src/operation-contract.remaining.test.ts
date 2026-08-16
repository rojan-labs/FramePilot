import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import type { Patch } from './patch.js';
import { applyPatch } from './patch.js';

const timeline = (locked = false): Timeline =>
  ({
    revision: 1,
    tracks: [
      {
        id: 'video-1',
        type: 'video',
        locked,
        clips: [
          {
            id: 'clip-1',
            assetId: 'asset-1',
            trackId: 'video-1',
            start: 0,
            end: 10,
            sourceStart: 0,
            sourceEnd: 10,
            effects: [],
            keyframes: [],
          },
        ],
      },
      {
        id: 'voice',
        type: 'audio',
        clips: [],
      },
    ],
  }) as Timeline;

const patch = (operations: Patch['operations']): Patch => ({
  patchId: 'audit-contract' as Patch['patchId'],
  createdBy: 'agent',
  reason: 'contract regression',
  operations,
});

const rejects = (operations: Patch['operations'], pattern: RegExp): void => {
  expect(() => applyPatch(timeline(), patch(operations))).toThrow(pattern);
};

describe('canonical patch operation contract', () => {
  it('rejects content edits on a locked track from the patch authority itself', () => {
    expect(() =>
      applyPatch(
        timeline(true),
        patch([{ type: 'trim_clip', clipId: 'clip-1', start: 1, end: 9 }]),
      ),
    ).toThrow(/locked track/i);
  });

  it('still allows the operation that unlocks a locked track', () => {
    const next = applyPatch(
      timeline(true),
      patch([{ type: 'set_track_flags', trackId: 'video-1', locked: false }]),
    );
    // `set_track_flags` canonicalises "off" as *absent* rather than `false`
    // (see applySetTrackFlags), so unlocked is `undefined`, not `false`.
    expect(next.tracks[0]?.locked).toBeUndefined();
    // And the track is genuinely editable again, not merely flag-cleared.
    expect(() =>
      applyPatch(next, patch([{ type: 'trim_clip', clipId: 'clip-1', start: 1, end: 9 }])),
    ).not.toThrow();
  });

  it('rejects renderer-unsupported clip keyframe properties', () => {
    rejects(
      [
        {
          type: 'add_keyframes',
          clipId: 'clip-1',
          keyframes: [
            {
              id: 'kf-1',
              time: 1,
              property: 'blur',
              value: 2,
              easing: 'linear',
            },
          ],
        },
      ],
      /Unsupported clip keyframe property/i,
    );
  });

  it('rejects illegal scale and opacity keyframe values', () => {
    rejects(
      [
        {
          type: 'add_keyframes',
          clipId: 'clip-1',
          keyframes: [{ id: 'kf-scale', time: 1, property: 'scale', value: 0, easing: 'linear' }],
        },
      ],
      /Scale keyframes/i,
    );
    rejects(
      [
        {
          type: 'add_keyframes',
          clipId: 'clip-1',
          keyframes: [
            { id: 'kf-opacity', time: 1, property: 'opacity', value: 1.1, easing: 'linear' },
          ],
        },
      ],
      /Opacity keyframes/i,
    );
  });

  it('rejects color effects the render compiler does not implement', () => {
    rejects(
      [
        {
          type: 'apply_color_grade',
          clipId: 'clip-1',
          effect: { id: 'grade', type: 'transform', params: {}, keyframes: [] },
        },
      ],
      /Unsupported color effect type/i,
    );
  });

  it('rejects unknown and out-of-range color-grade parameters', () => {
    rejects(
      [
        {
          type: 'apply_color_grade',
          clipId: 'clip-1',
          effect: {
            id: 'grade',
            type: 'color_grade',
            params: { vibrance: 2 },
            keyframes: [],
          },
        },
      ],
      /Unknown color-grade parameter/i,
    );
    rejects(
      [
        {
          type: 'apply_color_grade',
          clipId: 'clip-1',
          effect: {
            id: 'grade',
            type: 'color_grade',
            params: { exposure: 6 },
            keyframes: [],
          },
        },
      ],
      /exposure must be within/i,
    );
  });

  it('rejects audio settings outside the renderer contract', () => {
    rejects([{ type: 'adjust_audio', clipId: 'clip-1', gainDb: 25 }], /gainDb must be within/i);
    rejects(
      [{ type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, duckAmountDb: 1 }],
      /duckAmountDb/i,
    );
    rejects(
      [{ type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, fadeCurve: 'logarithmic' }],
      /fadeCurve must be one of/i,
    );
    rejects(
      [{ type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, fadeInSeconds: 11 }],
      /cannot exceed the clip duration/i,
    );
  });

  it('rejects tracker rectangles that leave the normalized frame', () => {
    rejects(
      [
        {
          type: 'track_object',
          clipId: 'clip-1',
          target: 'object',
          region: { x: 0.8, y: 0.1, width: 0.3, height: 0.5 },
        },
      ],
      /inside the normalized frame/i,
    );
  });
});
