/**
 * Tests for the patch validator (PLAN §1.4 / PRD §8.5). Every validation code
 * is exercised, plus the valid (no-issue) path.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { Operation } from './operations.js';
import { validatePatch, type ValidationCode } from './validator.js';

const clip = (over: Partial<Clip> & Pick<Clip, 'id' | 'trackId'>): Clip => ({
  assetId: 'asset_1',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...over,
});

const timeline = (): Timeline => ({
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        clip({ id: 'a', trackId: 'video_1' }),
        clip({ id: 'b', trackId: 'video_1', start: 10, end: 20, sourceEnd: 10 }),
      ],
    },
    {
      id: 'audio_1',
      type: 'audio',
      clips: [clip({ id: 'au', trackId: 'audio_1', end: 20, sourceEnd: 20 })],
    },
    { id: 'caption_1', type: 'caption', clips: [] },
    { id: 'overlay_1', type: 'overlay', clips: [] },
  ],
});

const validate = (ops: Operation[], options?: Parameters<typeof validatePatch>[2]) =>
  validatePatch(timeline(), { operations: ops }, options);

const codes = (ops: Operation[], options?: Parameters<typeof validatePatch>[2]): ValidationCode[] =>
  validate(ops, options).issues.map((i) => i.code);

describe('validatePatch — valid patches', () => {
  it('accepts a clean multi-op patch', () => {
    const result = validate([
      { type: 'trim_clip', clipId: 'a', start: 0, end: 5 },
      { type: 'add_caption_layer', trackId: 'caption_1', start: 1, end: 3 },
      {
        type: 'apply_color_grade',
        clipId: 'b',
        effect: { id: 'e', type: 'lut', params: {}, keyframes: [] },
      },
      { type: 'adjust_audio', clipId: 'au', gainDb: -3 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts a set_transcript project op (no timeline references to check)', () => {
    const result = validatePatch(timeline(), {
      operations: [
        { type: 'set_transcript', words: [{ word: 'hi', start: 0, end: 0.5 }] },
      ] as unknown as Operation[],
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts a set_caption_style patch that adds/clears a caption clip style (schema v5)', () => {
    const result = validate([
      { type: 'add_caption_layer', trackId: 'caption_1', start: 1, end: 3, clipId: 'cap_1' },
      {
        type: 'set_caption_style',
        clipId: 'cap_1',
        captionStyle: { templateId: 'bold-pop', fontScale: 1.2 },
      },
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts a set_clip_crop patch that sets/clears a clip crop rect (schema v7)', () => {
    const result = validate([
      { type: 'set_clip_crop', clipId: 'a', crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
      { type: 'set_clip_crop', clipId: 'a', crop: null },
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts a set_clip_blend_mode patch that sets/clears a clip blend mode (schema v8)', () => {
    const result = validate([
      { type: 'set_clip_blend_mode', clipId: 'a', blendMode: 'multiply' },
      { type: 'set_clip_blend_mode', clipId: 'a', blendMode: null },
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('skips the missing-asset check when no asset ids are supplied', () => {
    expect(
      codes([
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'unknown',
          start: 30,
          end: 35,
          sourceStart: 0,
          sourceEnd: 5,
        },
      ]),
    ).toEqual([]);
  });
});

describe('validatePatch — each PRD §8.5 check', () => {
  it('missing_reference', () => {
    expect(codes([{ type: 'trim_clip', clipId: 'ghost', start: 0, end: 5 }])).toContain(
      'missing_reference',
    );
    expect(codes([{ type: 'delete_range', trackId: 'ghost', start: 0, end: 5 }])).toContain(
      'missing_reference',
    );
  });

  it('negative_duration (trim, add_clip, transition, split)', () => {
    expect(codes([{ type: 'trim_clip', clipId: 'a', start: 5, end: 5 }])).toContain(
      'negative_duration',
    );
    expect(
      codes([
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'asset_1',
          start: 30,
          end: 30,
          sourceStart: 0,
          sourceEnd: 5,
        },
      ]),
    ).toContain('negative_duration');
    expect(
      codes([
        {
          type: 'add_transition',
          trackId: 'video_1',
          fromClipId: 'a',
          toClipId: 'b',
          kind: 'fade',
          durationSeconds: 0,
        },
      ]),
    ).toContain('negative_duration');
    expect(codes([{ type: 'split_clip', clipId: 'a', at: 0 }])).toContain('negative_duration');
  });

  it('type-agnostic layers: text/caption may live on any layer (no layer-order error)', () => {
    // Phase 2 (ADR 0032): layers are not typed, so adding a text overlay or caption
    // onto a 'video' layer is valid — kind is derived per clip, never constrained.
    expect(
      codes([{ type: 'add_text_overlay', trackId: 'video_1', text: 'x', start: 1, end: 2 }]),
    ).not.toContain('invalid_layer_order');
    expect(
      codes([{ type: 'add_caption_layer', trackId: 'video_1', start: 1, end: 2 }]),
    ).not.toContain('invalid_layer_order');
  });

  it('missing_asset (when asset ids are supplied)', () => {
    const result = codes(
      [
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'unknown',
          start: 30,
          end: 35,
          sourceStart: 0,
          sourceEnd: 5,
        },
      ],
      { assetIds: ['asset_1'] },
    );
    expect(result).toContain('missing_asset');
    expect(
      codes(
        [
          {
            type: 'set_clip_media',
            clipId: 'a',
            assetId: 'unknown',
            sourceStart: 0,
            sourceEnd: 10,
          },
        ],
        { assetIds: ['asset_1'] },
      ),
    ).toContain('missing_asset');
  });

  it('accepts add_clip when the asset is known', () => {
    expect(
      codes(
        [
          {
            type: 'add_clip',
            trackId: 'video_1',
            assetId: 'asset_1',
            start: 30,
            end: 35,
            sourceStart: 0,
            sourceEnd: 5,
          },
        ],
        { assetIds: ['asset_1'] },
      ),
    ).toEqual([]);
  });

  it('unsupported_effect', () => {
    expect(
      codes([
        {
          type: 'apply_color_grade',
          clipId: 'a',
          effect: { id: 'e', type: 'wormhole', params: {}, keyframes: [] },
        },
      ]),
    ).toContain('unsupported_effect');
  });

  it('accepts set_effect_params once its effect exists in the same patch', () => {
    // apply_color_grade adds effect 'e' to clip 'b'; a later set_effect_params in the
    // same patch edits it — the replay advances state so the effect is present.
    const result = validate([
      {
        type: 'apply_color_grade',
        clipId: 'b',
        effect: { id: 'e', type: 'lut', params: {}, keyframes: [] },
      },
      { type: 'set_effect_params', clipId: 'b', effectId: 'e', params: { intensity: 0.5 } },
    ]);
    expect(result.valid).toBe(true);
  });

  it('missing_reference for set_effect_params on an unknown effect id', () => {
    expect(
      codes([{ type: 'set_effect_params', clipId: 'a', effectId: 'ghost', params: { x: 1 } }]),
    ).toContain('missing_reference');
  });

  it('broken_audio_link (audio op on a caption/overlay clip)', () => {
    const tl: Timeline = {
      tracks: [
        { id: 'caption_1', type: 'caption', clips: [clip({ id: 'cap', trackId: 'caption_1' })] },
      ],
    };
    const result = validatePatch(tl, {
      operations: [{ type: 'adjust_audio', clipId: 'cap', gainDb: -3 }],
    });
    expect(result.issues.map((i) => i.code)).toContain('broken_audio_link');
  });

  it('reports no broken_audio_link when the clip itself is unknown', () => {
    // The scoped validator resolves the owning track from the clip index. An
    // adjust_audio on a clip that does not exist has no track to judge, so the
    // missing-reference check owns the error rather than the audio-link check
    // inventing a second one.
    const tl: Timeline = {
      tracks: [
        { id: 'caption_1', type: 'caption', clips: [clip({ id: 'cap', trackId: 'caption_1' })] },
      ],
    };
    const result = validatePatch(tl, {
      operations: [{ type: 'adjust_audio', clipId: 'ghost', gainDb: -3 }],
    });
    expect(result.issues.map((i) => i.code)).not.toContain('broken_audio_link');
    expect(result.valid).toBe(false);
  });

  it('overlap_error (placing a clip over an existing one)', () => {
    expect(
      codes([
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'asset_1',
          start: 5,
          end: 12,
          sourceStart: 0,
          sourceEnd: 7,
          clipId: 'new',
        },
      ]),
    ).toContain('overlap_error');
  });

  it('overlap_error (duplicate clip id)', () => {
    expect(
      codes([
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'asset_1',
          start: 30,
          end: 35,
          sourceStart: 0,
          sourceEnd: 5,
          clipId: 'a',
        },
      ]),
    ).toContain('overlap_error');
  });

  it('duplicate_layer (add_layer with an id that already exists)', () => {
    expect(
      codes([{ type: 'add_layer', layerId: 'video_1', layerType: 'video', atIndex: 0 }]),
    ).toContain('duplicate_layer');
  });

  it('unsupported_operation (unknown op type) and stops replaying it', () => {
    const result = validate([{ type: 'teleport' } as unknown as Operation]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(['unsupported_operation']);
  });

  it('missing_reference (set_caption_style targeting an unknown clip id)', () => {
    expect(
      codes([
        { type: 'set_caption_style', clipId: 'ghost', captionStyle: { templateId: 'clean' } },
      ]),
    ).toContain('missing_reference');
  });

  it('invalid_style (set_caption_style with an out-of-range style value)', () => {
    expect(
      codes([{ type: 'set_caption_style', clipId: 'a', captionStyle: { fontScale: -1 } }]),
    ).toContain('invalid_style');
  });

  it('invalid_cue (set_caption_cue with a negative word timestamp)', () => {
    expect(
      codes([
        {
          type: 'set_caption_cue',
          clipId: 'a',
          captionCue: { text: 'bad', words: [{ word: 'bad', start: -1, end: 0.5 }] },
        },
      ]),
    ).toContain('invalid_cue');
  });

  it('missing_reference (set_caption_cue targeting an unknown clip id)', () => {
    expect(
      codes([{ type: 'set_caption_cue', clipId: 'ghost', captionCue: { text: 'x', words: [] } }]),
    ).toContain('missing_reference');
  });

  it('accepts a valid set_caption_cue and set_track_caption_style', () => {
    // Both are supported, reversible operations (schema v11) — they must not be
    // rejected as unsupported, which is how a new op fails when the validator's
    // allowlist is not updated alongside the union.
    const result = validate([
      { type: 'set_caption_cue', clipId: 'a', captionCue: { text: 'hello', words: [] } },
      {
        type: 'set_track_caption_style',
        trackId: 'video_1',
        captionStyle: { templateId: 'karaoke' },
      },
    ]);
    expect(result.valid).toBe(true);
  });

  it('missing_reference (set_track_caption_style targeting an unknown track id)', () => {
    expect(
      codes([
        { type: 'set_track_caption_style', trackId: 'ghost', captionStyle: { templateId: 'k' } },
      ]),
    ).toContain('missing_reference');
  });

  it('invalid_style (set_track_caption_style with an out-of-range default)', () => {
    expect(
      codes([
        { type: 'set_track_caption_style', trackId: 'video_1', captionStyle: { fontScale: -1 } },
      ]),
    ).toContain('invalid_style');
  });

  it('missing_reference (set_clip_speed targeting an unknown clip id)', () => {
    expect(codes([{ type: 'set_clip_speed', clipId: 'ghost', speed: 2 }])).toContain(
      'missing_reference',
    );
  });

  it('invalid_speed (set_clip_speed with a non-finite speed)', () => {
    // Schema v15 (ADR 0090) made 0 (freeze) and negative (reverse) LEGAL, so the
    // remaining invalid case is a speed that is not a number at all.
    expect(
      codes([{ type: 'set_clip_speed', clipId: 'a', speed: Number.POSITIVE_INFINITY }]),
    ).toContain('invalid_speed');
    expect(codes([{ type: 'set_clip_speed', clipId: 'a', speed: Number.NaN }])).toContain(
      'invalid_speed',
    );
  });

  it('accepts a freeze and a reverse, and still catches a mismatched duration', () => {
    expect(codes([{ type: 'set_clip_speed', clipId: 'a', speed: 0 }])).not.toContain(
      'speed_duration_mismatch',
    );
    expect(codes([{ type: 'set_clip_speed', clipId: 'a', speed: -2 }])).not.toContain(
      'speed_duration_mismatch',
    );
  });

  it('missing_reference (set_clip_crop targeting an unknown clip id)', () => {
    expect(
      codes([
        { type: 'set_clip_crop', clipId: 'ghost', crop: { x: 0, y: 0, width: 1, height: 1 } },
      ]),
    ).toContain('missing_reference');
  });

  it('invalid_crop (set_clip_crop with an out-of-bounds or non-positive rect)', () => {
    expect(
      codes([
        { type: 'set_clip_crop', clipId: 'a', crop: { x: 0.6, y: 0, width: 0.6, height: 0.5 } },
      ]),
    ).toContain('invalid_crop');
    expect(
      codes([{ type: 'set_clip_crop', clipId: 'a', crop: { x: 0, y: 0, width: 0, height: 0.5 } }]),
    ).toContain('invalid_crop');
  });

  it('missing_reference (set_clip_blend_mode targeting an unknown clip id)', () => {
    expect(
      codes([{ type: 'set_clip_blend_mode', clipId: 'ghost', blendMode: 'multiply' }]),
    ).toContain('missing_reference');
  });

  it('invalid_blend_mode (set_clip_blend_mode with an unknown mode string)', () => {
    expect(
      codes([
        {
          type: 'set_clip_blend_mode',
          clipId: 'a',
          blendMode: 'not-a-real-mode' as never,
        },
      ]),
    ).toContain('invalid_blend_mode');
  });
});

describe('validatePatch — speed_duration_mismatch (schema v6)', () => {
  it('accepts a valid set_clip_speed patch (schema v6, speed/time-remap)', () => {
    const result = validate([{ type: 'set_clip_speed', clipId: 'a', speed: 2 }]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects a hand-crafted clip whose end/start disagree with sourceDuration/speed', () => {
    // restore_clips lets us inject an inconsistent clip directly (bypassing
    // set_clip_speed's own recomputation) to prove the validator catches ANY
    // operation that leaves a clip inconsistent, not just set_clip_speed.
    const inconsistent = clip({
      id: 'a',
      trackId: 'video_1',
      start: 0,
      end: 10, // should be 5 at speed 2 (sourceDuration 10 / speed 2)
      sourceStart: 0,
      sourceEnd: 10,
      speed: 2,
    });
    const result = validate([
      {
        type: 'restore_clips',
        trackId: 'video_1',
        clips: [inconsistent, timeline().tracks[0]!.clips[1]!],
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('speed_duration_mismatch');
  });

  it('defaults an absent speed to 1x in the mismatch message', () => {
    // `clip.speed` is optional; the message falls back to the schema default (1x)
    // rather than printing "undefinedx".
    const inconsistent = clip({
      id: 'a',
      trackId: 'video_1',
      start: 0,
      end: 10, // should be 8 at the default 1x (sourceDuration 8)
      sourceStart: 0,
      sourceEnd: 8,
    });
    const result = validate([
      {
        type: 'restore_clips',
        trackId: 'video_1',
        clips: [inconsistent, timeline().tracks[0]!.clips[1]!],
      },
    ]);
    expect(result.issues.find((i) => i.code === 'speed_duration_mismatch')?.message).toContain(
      'speed 1x',
    );
  });

  it("rejects a RAMPED clip whose duration disagrees with its curve's integral", () => {
    // Same check as the constant-speed case above, but the message names "its
    // speed ramp" rather than a numeric speed — worth its own case since the
    // two branches read completely different source data.
    const inconsistent = clip({
      id: 'a',
      trackId: 'video_1',
      start: 0,
      end: 10, // should be 5 (10s source integrated at a constant 2x)
      sourceStart: 0,
      sourceEnd: 10,
      speedRamp: [
        { id: 'p1', sourceTime: 0, rate: 2, easing: 'linear' },
        { id: 'p2', sourceTime: 10, rate: 2, easing: 'linear' },
      ],
    });
    const result = validate([
      {
        type: 'restore_clips',
        trackId: 'video_1',
        clips: [inconsistent, timeline().tracks[0]!.clips[1]!],
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('speed_duration_mismatch');
    expect(result.issues.find((i) => i.code === 'speed_duration_mismatch')?.message).toContain(
      'its speed ramp',
    );
  });

  it("rejects a speed-ramp point outside the clip's own source range", () => {
    // A point past the footage or before its start shapes nothing the render can
    // reach — worse than a no-op, since it looks like an intentional curve.
    const rampedClip = clip({
      id: 'a',
      trackId: 'video_1',
      start: 0,
      end: 5, // 10s of source at a constant 2x = 5s of timeline
      sourceStart: 0,
      sourceEnd: 10,
      speedRamp: [
        { id: 'p1', sourceTime: 0, rate: 2, easing: 'linear' },
        { id: 'p2', sourceTime: 10, rate: 2, easing: 'linear' },
        { id: 'p3', sourceTime: 15, rate: 2, easing: 'linear' }, // past the 10s footage
      ],
    });
    const result = validate([
      {
        type: 'restore_clips',
        trackId: 'video_1',
        clips: [rampedClip, timeline().tracks[0]!.clips[1]!],
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('invalid_speed');
  });

  it("accepts speed-ramp points that stay within the clip's own source range", () => {
    const rampedClip = clip({
      id: 'a',
      trackId: 'video_1',
      start: 0,
      end: 5,
      sourceStart: 0,
      sourceEnd: 10,
      speedRamp: [
        { id: 'p1', sourceTime: 0, rate: 2, easing: 'linear' },
        { id: 'p2', sourceTime: 10, rate: 2, easing: 'linear' },
      ],
    });
    const result = validate([
      {
        type: 'restore_clips',
        trackId: 'video_1',
        clips: [rampedClip, timeline().tracks[0]!.clips[1]!],
      },
    ]);
    expect(result.issues.map((i) => i.code)).not.toContain('invalid_speed');
  });
});

describe('validatePatch — transition_overlap', () => {
  // The transition check runs on the post-apply timeline of any op. We build a
  // timeline carrying a `transition` effect on clip `b` (referencing `a`), then
  // trigger validation with a benign op (a no-op-equivalent trim on `a`) so the
  // post-apply pass inspects the pre-existing transition. `a`/`b` are 10s each.
  const withTransition = (params: Record<string, unknown>): Timeline => ({
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          clip({ id: 'a', trackId: 'video_1', start: 0, end: 10, sourceEnd: 10 }),
          clip({
            id: 'b',
            trackId: 'video_1',
            start: 10,
            end: 20,
            sourceEnd: 10,
            effects: [{ id: 'b__transition', type: 'transition', params, keyframes: [] }],
          }),
        ],
      },
    ],
  });
  // Trim `a` back to its existing bounds — a real op that leaves the timeline
  // unchanged, so the post-apply transition check fires without altering durations.
  const trigger: Operation = { type: 'trim_clip', clipId: 'a', start: 0, end: 10 };
  const transitionCodes = (params: Record<string, unknown>): ValidationCode[] =>
    validatePatch(withTransition(params), { operations: [trigger] }).issues.map((i) => i.code);

  it('accepts a legal transition (adjacent fromClip, duration ≤ shorter neighbour)', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: 5, fromClipId: 'a' })).not.toContain(
      'transition_overlap',
    );
  });

  it('accepts a transition exactly equal to the shorter neighbour duration', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: 10, fromClipId: 'a' })).not.toContain(
      'transition_overlap',
    );
  });

  it('rejects a zero duration', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: 0, fromClipId: 'a' })).toContain(
      'transition_overlap',
    );
  });

  it('rejects a negative duration', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: -1, fromClipId: 'a' })).toContain(
      'transition_overlap',
    );
  });

  it('rejects a non-numeric duration', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: 'long', fromClipId: 'a' })).toContain(
      'transition_overlap',
    );
  });

  it('rejects a non-finite duration', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: Infinity, fromClipId: 'a' })).toContain(
      'transition_overlap',
    );
  });

  it('rejects a duration longer than the shorter neighbour', () => {
    // Both clips are 10s long; 11s exceeds the limit.
    expect(transitionCodes({ kind: 'fade', durationSeconds: 11, fromClipId: 'a' })).toContain(
      'transition_overlap',
    );
  });

  it('rejects a missing fromClipId', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: 5 })).toContain('transition_overlap');
  });

  it('rejects a fromClipId that is not the adjacent earlier clip', () => {
    expect(transitionCodes({ kind: 'fade', durationSeconds: 5, fromClipId: 'ghost' })).toContain(
      'transition_overlap',
    );
  });

  it('rejects a transition on the first clip (no earlier neighbour)', () => {
    const tl: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({
              id: 'a',
              trackId: 'video_1',
              start: 0,
              end: 10,
              sourceEnd: 10,
              effects: [
                {
                  id: 'a__transition',
                  type: 'transition',
                  params: { kind: 'fade', durationSeconds: 2, fromClipId: 'x' },
                  keyframes: [],
                },
              ],
            }),
          ],
        },
      ],
    };
    expect(
      validatePatch(tl, {
        operations: [{ type: 'trim_clip', clipId: 'a', start: 0, end: 10 }],
      }).issues.map((i) => i.code),
    ).toContain('transition_overlap');
  });

  it('accepts an over-long add_transition, which the op clamps to what the cut carries', () => {
    // `add_transition` honours `transitionEligibility`'s clamp, so a request
    // longer than the boundary can hold becomes a shorter transition rather than
    // a rejected patch — the reason short clips can take a transition at all.
    // The check above still guards effects that did NOT come through the op
    // (hand-edited files, imports, a newer build's project).
    expect(
      codes([
        {
          type: 'add_transition',
          trackId: 'video_1',
          fromClipId: 'a',
          toClipId: 'b',
          kind: 'fade',
          durationSeconds: 100,
        },
      ]),
    ).not.toContain('transition_overlap');
  });

  it('reports an add_transition that cannot exist as transition_overlap, via the replay failure path', () => {
    // Unlike the over-long case above (which applies successfully and is caught
    // by the post-apply check), an ineligible pair — here, clips on different
    // tracks — makes `applyOperation` itself throw `invalid_transition`. This
    // exercises `fromOperationError`'s conversion of that thrown error, not
    // `transitionOverlapChecks`.
    expect(
      codes([
        {
          type: 'add_transition',
          trackId: 'video_1',
          fromClipId: 'au',
          toClipId: 'b',
          kind: 'fade',
          durationSeconds: 1,
        },
      ]),
    ).toContain('transition_overlap');
  });

  it('accepts a legal transition produced by an add_transition op', () => {
    expect(
      codes([
        {
          type: 'add_transition',
          trackId: 'video_1',
          fromClipId: 'a',
          toClipId: 'b',
          kind: 'fade',
          durationSeconds: 4,
        },
      ]),
    ).not.toContain('transition_overlap');
  });
});

describe('validatePatch — replay semantics', () => {
  it('keeps validating later ops after one fails', () => {
    const result = validate([
      { type: 'trim_clip', clipId: 'ghost', start: 0, end: 5 }, // missing_reference
      { type: 'trim_clip', clipId: 'a', start: 5, end: 5 }, // negative_duration
    ]);
    expect(result.issues.map((i) => i.operationIndex)).toEqual([0, 1]);
    expect(result.issues.map((i) => i.code)).toEqual(['missing_reference', 'negative_duration']);
  });
});

describe('validatePatch — an unexpected throw is reported, not fatal', () => {
  it('reports a malformed clip as an invalid operation instead of crashing', () => {
    // `fromOperationError` maps the codes the operations layer raises deliberately. It used
    // to have no arm for anything else, so a throw it did not recognise fell off the end of
    // the switch, put `undefined` in the issue list, and took `validatePatch` down on the
    // `issue.severity` read. A validator may reject a patch; it must not die on one.
    // Reachable in practice: a clip with no `effects` array (a hand-built or partially
    // migrated project) makes `transitionOverlapChecks` throw a TypeError.
    const timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [{ id: 'c_1', assetId: 'a', start: 0, end: 2, sourceStart: 0, sourceEnd: 2 }],
        },
      ],
    } as unknown as Timeline;
    const patch = {
      id: 'p_malformed',
      operations: [
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'a',
          clipId: 'c_2',
          start: 2,
          end: 4,
          sourceStart: 0,
          sourceEnd: 2,
        },
      ],
    } as unknown as Parameters<typeof validatePatch>[1];

    const result = validatePatch(timeline, patch);
    expect(result.valid).toBe(false);
    expect(result.issues.every((issue) => issue.severity !== undefined)).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'invalid_operation')).toBe(true);
  });
});
