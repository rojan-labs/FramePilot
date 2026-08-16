/**
 * What one animatable property's keyframes look like *right now* (revamp Phase 5, F5).
 *
 * ## Why this is a module and not a few `if`s in the row
 *
 * The keyframe diamond has five distinguishable states, and every one of them is an
 * answer to a question about time: is there a keyframe *here*, is there one
 * *anywhere*, does the value the user is looking at match the curve, where is the
 * *next* one. Getting any of them subtly wrong shows up as a diamond that lies about
 * what clicking it will do. That is arithmetic, so it lives in a pure module with
 * tests rather than inside a component that can only be checked by rendering it.
 *
 * ## The rule the whole phase hangs on
 *
 * **A property that is not animated has a base value; a property that is animated has
 * a curve.** Editing the value of a non-animated property moves its base (a keyframe
 * at time 0) and creates no animation. Editing the value of an *animated* property at
 * a playhead between keyframes has to create a keyframe there — anything else would
 * either discard the animation or silently move a keyframe the user was not pointing
 * at. This is the same contract After Effects states with its stopwatch, and
 * {@link KeyframeState.willCreateKeyframe} is how the row says so **before** the
 * commit rather than surprising the user after it.
 *
 * ## Time is clip-relative
 *
 * Keyframes are stored clip-relative (`Keyframe.time` is seconds from the clip's
 * start, which is why `split_clip` re-bases them). Every function here takes and
 * returns clip-relative seconds; converting from the timeline playhead is the
 * caller's job, done once.
 */
import { KEYFRAME_REPLACE_EPSILON, evaluateKeyframes } from '@framepilot/editor-core';
import type { Keyframe } from '@framepilot/timeline-schema';

/**
 * The clip properties that get a keyframe diamond.
 *
 * Exactly the set the render composites — `evaluate_clip_transform`'s
 * `TRANSFORM_PROPERTIES` (`scale`/`x`/`y`/`rotation`/`opacity`), all five of which the
 * preview also composites since Phase 3-1. **Nothing is listed here that the export
 * would ignore**: a diamond on a property the render drops would animate the preview
 * and not the finished video, which is the render-honesty rule inverted.
 *
 * Notably absent: clip **volume**. Audio gain is an effect param (`adjust_audio` →
 * `audio_gain`), not a keyframed clip property, so there is no curve for a diamond to
 * write. Animating it is a real feature, but it is an engine slice, not a UI one.
 */
export const ANIMATABLE_PROPERTIES = ['scale', 'x', 'y', 'rotation', 'opacity'] as const;

export type AnimatableProperty = (typeof ANIMATABLE_PROPERTIES)[number];

/** The identity value each animatable property falls back to with no keyframes. */
export const ANIMATABLE_DEFAULTS: Readonly<Record<AnimatableProperty, number>> = {
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
};

/**
 * The diamond's state. Distinguished in the UI by **shape and emphasis, not hue
 * alone** (design direction §3), so each name describes a fact, not a colour.
 */
export type KeyframeStatus =
  /** No keyframes for this property at all. The value is a plain static base. */
  | 'none'
  /** A keyframe sits at the playhead. Clicking the diamond removes it. */
  | 'at-playhead'
  /** Animated, but not at the playhead. Clicking the diamond adds one here. */
  | 'animated';

/** Everything the inspector needs to know about one property's animation. */
export interface KeyframeState {
  readonly property: string;
  readonly status: KeyframeStatus;
  /** This property's keyframes, ascending by time. Empty when not animated. */
  readonly points: readonly Keyframe[];
  /** The keyframe at the playhead (within the engine's epsilon), if any. */
  readonly atPlayhead: Keyframe | undefined;
  /**
   * What the curve evaluates to at the playhead, or `undefined` when the property is
   * not animated. This is the value the render will use — the row shows it so the
   * number on screen is the number that gets exported.
   */
  readonly curveValue: number | undefined;
  /** Time of the nearest keyframe strictly before the playhead, if any. */
  readonly prevTime: number | undefined;
  /** Time of the nearest keyframe strictly after the playhead, if any. */
  readonly nextTime: number | undefined;
  /**
   * Whether editing the value right now would CREATE a keyframe rather than move the
   * base. True exactly when the property is animated and the playhead is not on one
   * of its keyframes — see the module note.
   */
  readonly willCreateKeyframe: boolean;
}

/** Whether two clip-relative times are the same keyframe slot, per the engine. */
export function sameKeyframeTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= KEYFRAME_REPLACE_EPSILON;
}

/**
 * Resolve one property's keyframe state at a clip-relative time.
 *
 * @param keyframes - The clip's whole keyframe list; filtered here.
 * @param property - The property to inspect.
 * @param clipTime - Clip-relative seconds (the playhead, already converted).
 */
export function keyframeStateAt(
  keyframes: readonly Keyframe[],
  property: string,
  clipTime: number,
): KeyframeState {
  const points = keyframes
    .filter((keyframe) => keyframe.property === property)
    .slice()
    .sort((a, b) => a.time - b.time);

  const atPlayhead = points.find((keyframe) => sameKeyframeTime(keyframe.time, clipTime));

  // Strictly before/after by the SAME epsilon that defines "at the playhead", so the
  // three buckets partition the keyframes exactly: a keyframe can never be both "at
  // the playhead" and "the next one", which would make the chevron a no-op that still
  // looks enabled.
  const prevTime = points
    .filter((keyframe) => keyframe.time < clipTime && !sameKeyframeTime(keyframe.time, clipTime))
    .at(-1)?.time;
  const nextTime = points.find(
    (keyframe) => keyframe.time > clipTime && !sameKeyframeTime(keyframe.time, clipTime),
  )?.time;

  const animated = points.length > 0;
  return {
    property,
    status: !animated ? 'none' : atPlayhead !== undefined ? 'at-playhead' : 'animated',
    points,
    atPlayhead,
    curveValue: animated ? evaluateKeyframes(points, property, clipTime) : undefined,
    prevTime,
    nextTime,
    willCreateKeyframe: animated && atPlayhead === undefined,
  };
}

/**
 * The value to show in an animatable property's field.
 *
 * The curve's value at the playhead when animated, the base otherwise. Showing the
 * base while an animation is running would mean the number in the panel disagreed
 * with the picture in the monitor.
 */
export function displayValue(state: KeyframeState, base: number): number {
  return state.curveValue ?? base;
}

/**
 * Which of a clip's animatable properties carry keyframes, in declaration order.
 *
 * Drives the clip-level "animated" badge and, in Phase 6, which lanes exist. Ordered
 * by {@link ANIMATABLE_PROPERTIES} rather than by first-keyframe time so the list is
 * stable while the user edits.
 */
export function animatedProperties(keyframes: readonly Keyframe[]): readonly AnimatableProperty[] {
  const present = new Set(keyframes.map((keyframe) => keyframe.property));
  return ANIMATABLE_PROPERTIES.filter((property) => present.has(property));
}
