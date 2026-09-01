/**
 * What the toolbar's keyframe button does to the focused clip, as a pure decision.
 *
 * The affordance CapCut puts on its clip toolbar: with a clip focused, one control
 * that records the clip's current pose at the playhead, or takes that pose away
 * again. The Inspector already has a per-property diamond, and that is the right
 * tool when you know which property you are animating. This is the other half —
 * you are watching the preview, the clip looks right *here*, and you want that
 * recorded without first deciding which of five properties you meant.
 *
 * The rule has two arms, and the difference between them is what the clip is
 * already doing:
 *
 *  - **The clip is already animated.** The button acts on exactly the properties
 *    that carry keyframes, and nothing else. Adding `opacity` to a clip that is
 *    only being scaled would silently pin a value the user never asked to animate.
 *  - **The clip is not animated yet.** There is nothing to infer from, so it seeds
 *    the whole transform set at the values the clip currently has. That is
 *    "start animating here", and because every value is the one already in effect,
 *    the picture does not move — the keyframe records, it does not change.
 *
 * In both arms, a playhead that already sits on a keyframe REMOVES rather than
 * adds, so the control is a toggle and pressing it twice is a no-op.
 *
 * Pure: it takes the clip and a clip-relative time and returns an intent. The
 * caller turns that into the one patch it commits, so this is unit-testable
 * without a store, a pointer or a DOM.
 */
import type { Clip } from '@framepilot/timeline-schema';
import { evaluateKeyframes } from '@framepilot/editor-core';
import {
  ANIMATABLE_DEFAULTS,
  type AnimatableProperty,
  animatedProperties,
} from '../inspector/keyframe-state.js';

/** How close (seconds) a keyframe must be to the playhead to count as "at" it. */
export const KEYFRAME_AT_PLAYHEAD_EPSILON = 1e-3;

/** One property to write, with the value the clip already shows at that time. */
export interface KeyframeWrite {
  readonly property: AnimatableProperty;
  readonly value: number;
}

/** One keyframe to remove, addressed the way `removeKeyframesPatch` wants it. */
export interface KeyframeRemoval {
  readonly clipId: string;
  readonly property: string;
  readonly time: number;
}

/** What the button should do when pressed. `kind: 'none'` disables it. */
export type ClipKeyframeIntent =
  | { readonly kind: 'add'; readonly writes: readonly KeyframeWrite[] }
  | { readonly kind: 'remove'; readonly removals: readonly KeyframeRemoval[] }
  | { readonly kind: 'none' };

/**
 * Decide what pressing the keyframe button should do.
 *
 * @param clip - The focused clip.
 * @param clipTime - The playhead, in clip-relative seconds.
 * @returns The intent; `none` when the playhead is outside the clip.
 */
export function clipKeyframeIntent(clip: Clip, clipTime: number): ClipKeyframeIntent {
  const duration = clip.end - clip.start;
  if (!Number.isFinite(clipTime) || clipTime < 0 || clipTime > duration) {
    return { kind: 'none' };
  }

  const atPlayhead = clip.keyframes.filter(
    (keyframe) => Math.abs(keyframe.time - clipTime) <= KEYFRAME_AT_PLAYHEAD_EPSILON,
  );
  if (atPlayhead.length > 0) {
    return {
      kind: 'remove',
      removals: atPlayhead.map((keyframe) => ({
        clipId: clip.id,
        property: keyframe.property,
        time: keyframe.time,
      })),
    };
  }

  const animated = animatedProperties(clip.keyframes);
  const targets: readonly AnimatableProperty[] =
    animated.length > 0 ? animated : (Object.keys(ANIMATABLE_DEFAULTS) as AnimatableProperty[]);

  return {
    kind: 'add',
    writes: targets.map((property) => ({
      property,
      // The value the curve already has here, so recording a pose never moves the
      // picture. With no keyframes on the property the evaluator has nothing to
      // interpolate, so the property's identity value is the honest answer.
      value: evaluateKeyframes(clip.keyframes, property, clipTime) ?? ANIMATABLE_DEFAULTS[property],
    })),
  };
}
