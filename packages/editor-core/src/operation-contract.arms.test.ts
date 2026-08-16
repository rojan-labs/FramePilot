/**
 * Every arm of the canonical operation contract.
 *
 * `assertOperationContract` is the last gate before an operation reaches persisted state,
 * shared by the AI path, MCP, and any future direct caller. It is exercised here directly
 * rather than through `applyPatch` so each arm's own rule is what fails the test, instead
 * of an unrelated apply-time error (a missing layer, an overlap) masking a contract hole.
 *
 * The two standing invariants: a locked track refuses content edits, and an invalid value
 * stays invalid — nothing here may be repaired into something legal.
 */
import { describe, expect, it } from 'vitest';
import type { EffectLayer, Timeline } from '@framepilot/timeline-schema';
import type { Operation } from './operations.js';
import { assertOperationContract } from './operation-contract.js';

const layer = (over: Partial<EffectLayer> = {}): EffectLayer =>
  ({
    id: 'fx-1',
    kind: 'blur-gaussian',
    start: 0,
    end: 4,
    params: {},
    ...over,
  }) as EffectLayer;

const timeline = (over: { locked?: boolean; effectLocked?: boolean } = {}): Timeline =>
  ({
    revision: 1,
    tracks: [
      {
        id: 'video-1',
        type: 'video',
        ...(over.locked === true ? { locked: true } : {}),
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
      { id: 'voice', type: 'audio', clips: [] },
      {
        id: 'fx-track',
        type: 'effect',
        ...(over.effectLocked === true ? { locked: true } : {}),
        clips: [],
        effectLayers: [layer()],
      },
    ],
  }) as unknown as Timeline;

const ok = (op: Operation, tl: Timeline = timeline()): void => {
  expect(() => assertOperationContract(tl, op)).not.toThrow();
};

const rejects = (op: Operation, pattern: RegExp, tl: Timeline = timeline()): void => {
  expect(() => assertOperationContract(tl, op)).toThrow(pattern);
};

describe('range and time arms', () => {
  it('requires an ordered, non-negative range on every windowed operation', () => {
    for (const type of ['trim_clip'] as const) {
      rejects({ type, clipId: 'clip-1', start: 5, end: 5 }, /greater than start/i);
      rejects({ type, clipId: 'clip-1', start: -1, end: 5 }, /non-negative/i);
      rejects({ type, clipId: 'clip-1', start: Number.NaN, end: 5 }, /finite/i);
    }
    ok({ type: 'set_clip_source_range', clipId: 'clip-1', sourceStart: 2, sourceEnd: 12 });
    rejects(
      { type: 'set_clip_source_range', clipId: 'clip-1', sourceStart: -1, sourceEnd: 9 },
      /non-negative/i,
    );
    for (const type of ['delete_range', 'ripple_delete'] as const) {
      ok({ type, trackId: 'video-1', start: 1, end: 3 });
      rejects({ type, trackId: 'video-1', start: 3, end: 1 }, /greater than start/i);
    }
    for (const type of ['add_text_overlay', 'add_caption_layer'] as const) {
      ok({ type, trackId: 'video-1', start: 0, end: 2 } as unknown as Operation);
      rejects({ type, trackId: 'video-1', start: 2, end: 2 } as unknown as Operation, /greater/i);
    }
  });

  it('accepts the legacy split spelling but never a missing split point', () => {
    ok({ type: 'split_clip', clipId: 'clip-1', at: 2 } as Operation);
    ok({ type: 'split_clip', clipId: 'clip-1', time: 2 } as unknown as Operation);
    rejects({ type: 'split_clip', clipId: 'clip-1' } as unknown as Operation, /finite/i);
    rejects({ type: 'split_clip', clipId: 'clip-1', at: -1 } as Operation, /non-negative/i);
  });

  it('keeps move and add-clip timing non-negative and ordered', () => {
    ok({ type: 'move_clip', clipId: 'clip-1', toTrackId: 'voice', toStart: 2 });
    rejects(
      { type: 'move_clip', clipId: 'clip-1', toTrackId: 'voice', toStart: -1 },
      /non-negative/i,
    );
    rejects(
      { type: 'move_clip', clipId: 'clip-1', toTrackId: 'voice', toStart: Number.NaN },
      /finite/i,
    );

    const addClip = {
      type: 'add_clip' as const,
      trackId: 'video-1',
      clip: undefined,
      assetId: 'asset-1',
      start: 0,
      end: 2,
      sourceStart: 0,
      sourceEnd: 2,
    } as unknown as Operation;
    ok(addClip);
    rejects(
      { ...(addClip as object), sourceStart: 2, sourceEnd: 2 } as Operation,
      /source range must be positive/i,
    );
    rejects({ ...(addClip as object), sourceEnd: Number.NaN } as Operation, /finite/i);
  });
});

describe('locked tracks', () => {
  it('refuses content edits across every clip-scoped arm', () => {
    const locked = timeline({ locked: true });
    const ops: Operation[] = [
      { type: 'trim_clip', clipId: 'clip-1', start: 1, end: 9 },
      { type: 'set_clip_source_range', clipId: 'clip-1', sourceStart: 1, sourceEnd: 11 },
      { type: 'split_clip', clipId: 'clip-1', at: 2 } as Operation,
      { type: 'move_clip', clipId: 'clip-1', toTrackId: 'video-1', toStart: 1 },
      { type: 'set_clip_blend_mode', clipId: 'clip-1', blendMode: 'screen' } as Operation,
      { type: 'delete_range', trackId: 'video-1', start: 0, end: 1 },
      // The clip-scoped arms that carry no numeric contract of their own still have to
      // honour the lock — otherwise "locked" would only stop the operations that happen
      // to validate something else.
      { type: 'set_effect_params', clipId: 'clip-1', effectId: 'e', params: {} } as Operation,
      { type: 'add_mask', clipId: 'clip-1', mask: { kind: 'rect' } } as unknown as Operation,
      { type: 'set_caption_style', clipId: 'clip-1', captionStyle: null } as Operation,
      { type: 'set_caption_cue', clipId: 'clip-1', cue: null } as unknown as Operation,
      { type: 'set_clip_speed', clipId: 'clip-1', speed: 2 } as Operation,
      { type: 'set_clip_speed_ramp', clipId: 'clip-1', ramp: null } as unknown as Operation,
      { type: 'set_clip_crop', clipId: 'clip-1', crop: null } as Operation,
    ];
    for (const op of ops) rejects(op, /locked track/i, locked);
  });

  it('still permits the flag operation that unlocks, and untouched tracks', () => {
    ok({ type: 'set_track_flags', trackId: 'video-1', locked: false }, timeline({ locked: true }));
    ok({ type: 'delete_range', trackId: 'voice', start: 0, end: 1 }, timeline({ locked: true }));
  });

  it('refuses effect-layer edits on a locked effect track', () => {
    const locked = timeline({ effectLocked: true });
    rejects({ type: 'remove_effect_layer', layerId: 'fx-1' } as Operation, /locked/i, locked);
    rejects(
      { type: 'set_effect_layer_enabled', layerId: 'fx-1', enabled: false } as Operation,
      /locked/i,
      locked,
    );
    rejects(
      { type: 'trim_effect_layer', layerId: 'fx-1', start: 0, end: 2 } as Operation,
      /locked/i,
      locked,
    );
    rejects(
      { type: 'move_effect_layer', layerId: 'fx-1', toStart: 1 } as Operation,
      /locked/i,
      locked,
    );
    rejects(
      { type: 'set_effect_layer_params', layerId: 'fx-1', params: {} } as Operation,
      /locked/i,
      locked,
    );
  });
});

describe('keyframe arms', () => {
  it('closes remove_keyframes to the renderer vocabulary and valid times', () => {
    ok({
      type: 'remove_keyframes',
      clipId: 'clip-1',
      targets: [{ property: 'scale' }],
    } as Operation);
    ok({
      type: 'remove_keyframes',
      clipId: 'clip-1',
      targets: [{ property: 'opacity', time: 2 }],
    } as Operation);
    rejects(
      { type: 'remove_keyframes', clipId: 'clip-1', targets: [{ property: 'blur' }] } as Operation,
      /unsupported/i,
    );
    rejects(
      {
        type: 'remove_keyframes',
        clipId: 'clip-1',
        targets: [{ property: 'scale', time: -1 }],
      } as Operation,
      /non-negative/i,
    );
    rejects(
      {
        type: 'remove_keyframes',
        clipId: 'clip-1',
        targets: [{ property: 'scale', time: Number.NaN }],
      } as Operation,
      /finite/i,
    );
  });

  it('surfaces every color-grade problem in one rejection', () => {
    ok({
      type: 'apply_color_grade',
      clipId: 'clip-1',
      effect: { id: 'g', type: 'color_grade', params: { exposure: 1 }, keyframes: [] },
    } as Operation);
    rejects(
      {
        type: 'apply_color_grade',
        clipId: 'clip-1',
        effect: {
          id: 'g',
          type: 'color_grade',
          params: { exposure: 99, vibrance: 1 },
          keyframes: [],
        },
      } as Operation,
      /exposure must be within.*Unknown color-grade parameter|Unknown color-grade parameter/i,
    );
  });

  it('accepts a well-formed add_keyframes payload', () => {
    ok({
      type: 'add_keyframes',
      clipId: 'clip-1',
      keyframes: [{ id: 'k', time: 1, property: 'scale', value: 1.2, easing: 'linear' }],
    } as Operation);
  });
});

describe('effect-layer arms', () => {
  it('bounds intensity on add and update', () => {
    ok({
      type: 'add_effect_layer',
      trackId: 'fx-track',
      layer: layer({ intensity: 1 }),
    } as Operation);
    rejects(
      {
        type: 'add_effect_layer',
        trackId: 'fx-track',
        layer: layer({ intensity: 1.1 }),
      } as Operation,
      /intensity must be within/i,
    );
    rejects(
      {
        type: 'add_effect_layer',
        trackId: 'fx-track',
        layer: layer({ intensity: Number.NaN }),
      } as Operation,
      /finite/i,
    );
    ok({ type: 'set_effect_layer_params', layerId: 'fx-1', intensity: 0 } as Operation);
    rejects(
      { type: 'set_effect_layer_params', layerId: 'fx-1', intensity: -0.1 } as Operation,
      /intensity must be within/i,
    );
    // An explicit null clears intensity rather than setting one, so it skips the range.
    ok({ type: 'set_effect_layer_params', layerId: 'fx-1', intensity: null } as Operation);
  });

  it('bounds a param to its descriptor range', () => {
    ok({
      type: 'add_effect_layer',
      trackId: 'fx-track',
      layer: layer({ params: { radius: 12 } }),
    } as Operation);
    rejects(
      {
        type: 'add_effect_layer',
        trackId: 'fx-track',
        layer: layer({ params: { radius: 999 } }),
      } as Operation,
      /must be within/i,
    );
  });

  it('defers an unknown layer id to the replay instead of inventing a target', () => {
    // No layer to resolve means no kind to check params against; the apply step reports
    // the missing layer, which is a clearer error than a fabricated param complaint.
    ok({ type: 'set_effect_layer_params', layerId: 'ghost', params: { radius: 1 } } as Operation);
    ok({ type: 'remove_effect_layer', layerId: 'ghost' } as Operation);
  });

  it('checks params against the kind descriptor catalog, not a free-form record', () => {
    rejects(
      {
        type: 'add_effect_layer',
        trackId: 'fx-track',
        layer: layer({ params: { notAParam: 1 } }),
      } as Operation,
      /does not support parameter/i,
    );
    rejects(
      {
        type: 'add_effect_layer',
        trackId: 'fx-track',
        layer: layer({ params: { radius: Number.NaN } }),
      } as Operation,
      /finite/i,
    );
    rejects(
      { type: 'set_effect_layer_params', layerId: 'fx-1', params: { notAParam: 1 } } as Operation,
      /does not support parameter/i,
    );
  });

  it('requires an ordered span and non-negative move target', () => {
    rejects(
      {
        type: 'add_effect_layer',
        trackId: 'fx-track',
        layer: layer({ start: 4, end: 4 }),
      } as Operation,
      /greater than start/i,
    );
    rejects(
      { type: 'trim_effect_layer', layerId: 'fx-1', start: 3, end: 1 } as Operation,
      /greater than start/i,
    );
    ok({
      type: 'move_effect_layer',
      layerId: 'fx-1',
      toStart: 0,
      toTrackId: 'fx-track',
    } as Operation);
    rejects(
      { type: 'move_effect_layer', layerId: 'fx-1', toStart: -1 } as Operation,
      /non-negative/i,
    );
    rejects(
      { type: 'move_effect_layer', layerId: 'fx-1', toStart: Number.NaN } as Operation,
      /finite/i,
    );
  });
});

describe('layer, transition, audio, and tracker arms', () => {
  it('requires whole non-negative layer indices', () => {
    ok({ type: 'add_layer', atIndex: 0 } as Operation);
    rejects({ type: 'add_layer', atIndex: 1.5 } as Operation, /non-negative integer/i);
    rejects({ type: 'add_layer', atIndex: -1 } as Operation, /non-negative integer/i);
    ok({ type: 'move_layer', layerId: 'video-1', toIndex: 1 } as Operation);
    rejects({ type: 'move_layer', layerId: 'video-1', toIndex: -1 } as Operation, /integer/i);
    ok({ type: 'remove_layer', layerId: 'voice' } as Operation);
  });

  it('never lets an invalid transition duration through', () => {
    ok({
      type: 'add_transition',
      trackId: 'video-1',
      fromClipId: 'clip-1',
      toClipId: 'clip-2',
      kind: 'cross-dissolve',
      durationSeconds: 0.5,
    } as Operation);
    for (const durationSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects(
        {
          type: 'add_transition',
          trackId: 'video-1',
          fromClipId: 'clip-1',
          toClipId: 'clip-2',
          kind: 'cross-dissolve',
          durationSeconds,
        } as Operation,
        /durationSeconds must be (positive|finite)/i,
      );
    }
  });

  it('validates audio fades against the clip they apply to', () => {
    ok({ type: 'adjust_audio', clipId: 'clip-1', gainDb: -6, fadeInSeconds: 1 });
    rejects(
      { type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, fadeInSeconds: -1 },
      /non-negative/i,
    );
    rejects(
      { type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, fadeOutSeconds: Number.NaN },
      /finite/i,
    );
    // A fade longer than an unknown clip cannot be checked, so it passes here and the
    // validator's richer pass reports it instead of the contract guessing.
    ok({ type: 'adjust_audio', clipId: 'ghost', gainDb: 0, fadeInSeconds: 99 });
    rejects(
      { type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, duckUnderTrackId: 'ghost' },
      /references missing track/i,
    );
    rejects(
      { type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, duckAmountDb: -12 },
      /requires duckUnderTrackId/i,
    );
    rejects(
      { type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, duckUnderTrackId: 'video-1' },
      /own track/i,
    );
    rejects(
      { type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, duckUnderTrackId: 'fx-track' },
      /audio-capable/i,
    );
    ok({ type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, duckUnderTrackId: 'voice' });
  });

  it('validates the EQ, compressor, and automation lane of an audio chain', () => {
    const chain = (extra: Record<string, unknown>): Operation =>
      ({ type: 'adjust_audio', clipId: 'clip-1', gainDb: 0, ...extra }) as Operation;

    ok(
      chain({
        eq: {
          bands: [
            { kind: 'high-pass', frequencyHz: 80 },
            { kind: 'peaking', frequencyHz: 3000, gainDb: -3, q: 2 },
          ],
        },
        dynamics: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120 },
      }),
    );
    // An empty band list is the "clear the EQ" instruction, not a malformed curve —
    // the same shape as an empty automation lane below.
    ok(chain({ eq: { bands: [] } }));
    rejects(chain({ eq: { bands: [{ kind: 'peaking', frequencyHz: 1000 }] } }), /requires gainDb/i);
    rejects(
      chain({ eq: { bands: [{ kind: 'low-pass', frequencyHz: 8000, gainDb: 3 }] } }),
      /takes no gainDb/i,
    );
    rejects(chain({ eq: { bands: [{ kind: 'tilt', frequencyHz: 1000, gainDb: 3 }] } }), /kind/i);
    rejects(
      chain({ dynamics: { thresholdDb: -18, ratio: 40, attackMs: 10, releaseMs: 120 } }),
      /ratio must be within/i,
    );

    const lane = (points: readonly { timeSeconds: number; value: number }[]): Operation =>
      chain({ automation: { property: 'gainDb', points } });
    ok(
      lane([
        { timeSeconds: 0, value: -20 },
        { timeSeconds: 5, value: 0 },
      ]),
    );
    // An empty lane is the documented "clear it" instruction, not a malformed one.
    ok(lane([]));
    rejects(lane([{ timeSeconds: 0, value: 0 }]), /at least 2 points/i);
    rejects(
      lane([
        { timeSeconds: 2, value: 0 },
        { timeSeconds: 2, value: -6 },
      ]),
      /strictly increase/i,
    );
    rejects(
      lane([
        { timeSeconds: 0, value: 0 },
        { timeSeconds: 99, value: -6 },
      ]),
      /inside the clip/i,
    );
    rejects(
      chain({
        automation: {
          property: 'pan',
          points: [
            { timeSeconds: 0, value: 0 },
            { timeSeconds: 1, value: 1 },
          ],
        },
      }),
      /Unsupported automation property/i,
    );
  });

  it('requires tracker regions to be normalized fractions inside the frame', () => {
    ok({
      type: 'track_object',
      clipId: 'clip-1',
      target: 'face',
      region: { x: 0, y: 0, width: 1, height: 1 },
    } as Operation);
    ok({ type: 'track_object', clipId: 'clip-1', target: 'face' } as Operation);
    rejects(
      {
        type: 'track_object',
        clipId: 'clip-1',
        target: 'object',
        region: { x: 0, y: 0, width: 0, height: 0.5 },
      } as Operation,
      /width and height must be positive/i,
    );
    rejects(
      {
        type: 'track_object',
        clipId: 'clip-1',
        target: 'object',
        region: { x: 1.5, y: 0, width: 0.2, height: 0.2 },
      } as Operation,
      /within 0\.\.1/i,
    );
    rejects(
      {
        type: 'track_object',
        clipId: 'clip-1',
        target: 'object',
        region: { x: 0, y: 0, width: Number.NaN, height: 0.2 },
      } as Operation,
      /finite/i,
    );
  });

  it('leaves the lossless inverse primitives unguarded so undo always restores', () => {
    ok({ type: 'restore_clips', trackId: 'video-1', clips: [] } as unknown as Operation);
    ok({
      type: 'restore_effect_layer',
      trackId: 'fx-track',
      layer: layer(),
    } as unknown as Operation);
    ok({ type: 'set_track_caption_style', trackId: 'video-1', captionStyle: null } as Operation);
  });
});
