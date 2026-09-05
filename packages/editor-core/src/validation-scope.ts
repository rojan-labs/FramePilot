import type { Operation } from './operations.js';

/** Which expensive post-apply invariants can possibly change for one operation. */
export interface PostValidationScope {
  readonly trackIds: readonly string[];
  readonly overlap: boolean;
  readonly transitions: boolean;
  readonly speed: boolean;
}

const NONE: PostValidationScope = {
  trackIds: [],
  overlap: false,
  transitions: false,
  speed: false,
};

const scope = (
  trackIds: readonly (string | undefined)[],
  checks: Pick<PostValidationScope, 'overlap' | 'transitions' | 'speed'>,
): PostValidationScope => ({
  trackIds: [...new Set(trackIds.filter((id): id is string => id !== undefined))],
  ...checks,
});

const TIMING_CHECKS = { overlap: true, transitions: true, speed: true } as const;
const TRANSITION_CHECK = { overlap: false, transitions: true, speed: false } as const;

/**
 * Compute the post-apply validation footprint from the typed operation itself.
 * Unrelated tracks cannot acquire an overlap, broken transition, or speed-duration
 * mismatch when their clip arrays were untouched, so scanning/sorting them per op is
 * wasted work. The clip index is updated by the validator after each replayed op.
 */
export function postValidationScope(
  op: Operation,
  clipTrackById: ReadonlyMap<string, string>,
): PostValidationScope {
  switch (op.type) {
    case 'move_clip':
      return scope([clipTrackById.get(op.clipId), op.toTrackId], TIMING_CHECKS);
    case 'trim_clip':
    case 'set_clip_source_range':
    case 'set_clip_media':
    case 'split_clip':
    case 'set_clip_speed':
    case 'set_clip_speed_ramp':
      return scope([clipTrackById.get(op.clipId)], TIMING_CHECKS);
    case 'reorder_clips':
    case 'delete_range':
    case 'ripple_delete':
    case 'add_clip':
    case 'add_text_overlay':
    case 'add_caption_layer':
    case 'restore_clips':
      return scope([op.trackId], TIMING_CHECKS);
    case 'add_transition':
      return scope([op.trackId], TRANSITION_CHECK);
    case 'set_effect_params':
      // This generic operation can edit the params of a transition effect. It cannot
      // change clip geometry, but the transition pair/duration must be revalidated.
      return scope([clipTrackById.get(op.clipId)], TRANSITION_CHECK);
    case 'add_keyframes':
    case 'remove_keyframes':
    case 'apply_color_grade':
    case 'adjust_audio':
    case 'add_mask':
    case 'track_object':
    case 'set_track_flags':
    case 'set_track_caption_style':
    case 'set_caption_style':
    case 'set_caption_cue':
    case 'set_clip_crop':
    case 'set_clip_blend_mode':
    case 'add_layer':
    case 'remove_layer':
    case 'move_layer':
    case 'add_effect_layer':
    case 'remove_effect_layer':
    case 'move_effect_layer':
    case 'trim_effect_layer':
    case 'set_effect_layer_params':
    case 'set_effect_layer_enabled':
    case 'restore_effect_layer':
      return NONE;
  }
}
