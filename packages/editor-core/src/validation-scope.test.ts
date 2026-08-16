import { describe, expect, it } from 'vitest';
import type { Operation } from './operations.js';
import { postValidationScope } from './validation-scope.js';

const clips = new Map([
  ['clip_a', 'track_a'],
  ['clip_b', 'track_b'],
]);

const check = (op: Operation) => postValidationScope(op, clips);

describe('postValidationScope', () => {
  it('limits a move to its source and destination tracks', () => {
    expect(
      check({ type: 'move_clip', clipId: 'clip_a', toTrackId: 'track_b', toStart: 5 }),
    ).toEqual({
      trackIds: ['track_a', 'track_b'],
      overlap: true,
      transitions: true,
      speed: true,
    });
  });

  it('limits clip timing changes to the owning track', () => {
    expect(check({ type: 'trim_clip', clipId: 'clip_a', start: 1, end: 2 })).toMatchObject({
      trackIds: ['track_a'],
      overlap: true,
      transitions: true,
      speed: true,
    });
    expect(
      check({
        type: 'set_clip_source_range',
        clipId: 'clip_a',
        sourceStart: 2,
        sourceEnd: 3,
      }),
    ).toMatchObject({ trackIds: ['track_a'], speed: true });
    expect(check({ type: 'set_clip_speed', clipId: 'clip_b', speed: 2 })).toMatchObject({
      trackIds: ['track_b'],
      speed: true,
    });
  });

  it('checks only transition invariants for transition-param edits', () => {
    expect(
      check({
        type: 'set_effect_params',
        clipId: 'clip_a',
        effectId: 'fx',
        params: { durationSeconds: 1 },
      }),
    ).toEqual({
      trackIds: ['track_a'],
      overlap: false,
      transitions: true,
      speed: false,
    });
    expect(
      check({
        type: 'add_transition',
        trackId: 'track_b',
        fromClipId: 'a',
        toClipId: 'b',
        kind: 'crossfade',
        durationSeconds: 0.5,
      }),
    ).toMatchObject({ trackIds: ['track_b'], transitions: true, overlap: false, speed: false });
  });

  it('does no timeline geometry scan for visual/audio/keyframe-only operations', () => {
    expect(
      check({
        type: 'apply_color_grade',
        clipId: 'clip_a',
        effect: { id: 'fx', type: 'exposure', params: { value: 0.1 }, keyframes: [] },
      }),
    ).toEqual({ trackIds: [], overlap: false, transitions: false, speed: false });
    expect(check({ type: 'set_clip_blend_mode', clipId: 'clip_a', blendMode: 'screen' })).toEqual({
      trackIds: [],
      overlap: false,
      transitions: false,
      speed: false,
    });
    // Keyframes animate a clip's look over its existing span — they can never
    // move a cut, so a dense keyframe edit must not trigger a geometry scan.
    expect(
      check({
        type: 'add_keyframes',
        clipId: 'clip_a',
        keyframes: [{ id: 'kf', property: 'scale', time: 0, value: 1, easing: 'linear' }],
      }),
    ).toEqual({ trackIds: [], overlap: false, transitions: false, speed: false });
    expect(check({ type: 'remove_keyframes', clipId: 'clip_a', keyframeIds: ['kf'] })).toEqual({
      trackIds: [],
      overlap: false,
      transitions: false,
      speed: false,
    });
  });

  it('tracks whole-track restoration by its explicit track id', () => {
    expect(check({ type: 'restore_clips', trackId: 'track_a', clips: [] })).toMatchObject({
      trackIds: ['track_a'],
      overlap: true,
      transitions: true,
      speed: true,
    });
  });
});
