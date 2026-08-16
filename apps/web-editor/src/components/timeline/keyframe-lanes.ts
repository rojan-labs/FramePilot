/**
 * Keyframes as objects on the timeline (revamp Phase 6, F4).
 *
 * ## What was there before
 *
 * `clipKeyframeMarkers` collapsed a clip's keyframes *and* every effect's keyframes
 * into **one dot per rounded millisecond**, rendered them `aria-hidden`, and attached
 * no handlers. So two properties animating at the same instant showed as a single
 * dot; the dot did not say which property it belonged to; and it could not be
 * selected, dragged, deleted or inspected. It was decoration.
 *
 * A keyframe becomes an object when it has an **identity** (which property, at which
 * time, on which clip), a **place** (its own lane, so co-located keyframes do not
 * merge), and **arithmetic you can trust** (where a drag lands, what it snaps to,
 * whether the group still fits). That is what this module owns; the components own
 * only the pointer plumbing and the pixels.
 *
 * ## Everything here is clip-relative seconds
 *
 * `Keyframe.time` is measured from the clip's start (which is why `split_clip`
 * re-bases them). Converting to timeline seconds happens once, at the edge, in the
 * component. Mixing the two is the bug this note exists to prevent.
 */
import type { Clip, Keyframe, Marker, Track } from '@framepilot/timeline-schema';
import { ANIMATABLE_PROPERTIES } from '../inspector/keyframe-state.js';

/**
 * Height of one property lane, in px.
 *
 * Small on purpose: a clip animating four properties adds 48px, which a 56px track
 * can grow by without the timeline turning into a wall of lanes. The marker is 9px,
 * so the lane is the marker plus a hairline of breathing room either side.
 */
export const KEYFRAME_LANE_HEIGHT = 12;

/** One property's lane on one clip. */
export interface KeyframeLane {
  readonly property: string;
  /** This property's keyframes, ascending by time. Never empty — see `clipKeyframeLanes`. */
  readonly keyframes: readonly Keyframe[];
}

/**
 * A clip's property lanes, in a stable order.
 *
 * Ordered by {@link ANIMATABLE_PROPERTIES} rather than by first-keyframe time, so
 * lanes do not reorder underneath a user who is dragging in one of them. Properties
 * outside that set still get a lane (appended, alphabetically) rather than being
 * hidden: a keyframe the UI refuses to show is a keyframe the user cannot delete, and
 * effect params are animatable through routes this list does not enumerate.
 */
export function clipKeyframeLanes(clip: Clip): readonly KeyframeLane[] {
  const byProperty = new Map<string, Keyframe[]>();
  for (const keyframe of clip.keyframes) {
    const bucket = byProperty.get(keyframe.property);
    if (bucket) bucket.push(keyframe);
    else byProperty.set(keyframe.property, [keyframe]);
  }
  const known = ANIMATABLE_PROPERTIES.filter((property) => byProperty.has(property));
  const extra = [...byProperty.keys()]
    .filter((property) => !(ANIMATABLE_PROPERTIES as readonly string[]).includes(property))
    .sort();
  return [...known, ...extra].map((property) => ({
    property,
    keyframes: byProperty
      .get(property)!
      .slice()
      .sort((a, b) => a.time - b.time),
  }));
}

/**
 * Extra lane height a track needs while `expanded` clips show their keyframes.
 *
 * The **max** across the track's expanded clips, not the sum: the lanes are stacked
 * at the bottom of the track and two clips' lane stacks sit side by side in x, so the
 * track only has to be as tall as the deepest one.
 */
export function trackKeyframeLanesHeight(track: Track, expanded: ReadonlySet<string>): number {
  let deepest = 0;
  for (const clip of track.clips) {
    if (!expanded.has(clip.id)) continue;
    deepest = Math.max(deepest, clipKeyframeLanes(clip).length);
  }
  return deepest * KEYFRAME_LANE_HEIGHT;
}

/** Whether a clip has anything to expand. */
export function isAnimated(clip: Clip): boolean {
  return clip.keyframes.length > 0;
}

// --- Selection identity ------------------------------------------------------

/**
 * A stable handle for one keyframe across a render.
 *
 * Built from **clip + property + time-in-ms**, not from `Keyframe.id`, for the same
 * reason `remove_keyframes` matches that way: ids come from whichever producer built
 * the keyframe and two producers can collide or reuse them. Time in whole
 * milliseconds also matches the engine's `KEYFRAME_REPLACE_EPSILON`, so a key
 * identifies exactly the keyframe a patch targeting that time would hit.
 */
export function keyframeKey(clipId: string, property: string, time: number): string {
  return `${clipId}|${property}|${Math.round(time * 1000)}`;
}

/** The three parts of a {@link keyframeKey}, or `null` if it is not one. */
export function parseKeyframeKey(
  key: string,
): { clipId: string; property: string; time: number } | null {
  // Split from the RIGHT: clip ids may contain `|` in principle, property names and
  // the millisecond stamp cannot.
  const lastBar = key.lastIndexOf('|');
  if (lastBar <= 0) return null;
  const midBar = key.lastIndexOf('|', lastBar - 1);
  if (midBar <= 0) return null;
  const ms = Number(key.slice(lastBar + 1));
  if (!Number.isFinite(ms)) return null;
  return {
    clipId: key.slice(0, midBar),
    property: key.slice(midBar + 1, lastBar),
    time: ms / 1000,
  };
}

// --- Drag arithmetic ---------------------------------------------------------

/** How near (in px) a drag has to come before it snaps. Matches the clip-drag feel. */
export const KEYFRAME_SNAP_PX = 6;

/**
 * "Same keyframe slot", re-declared here rather than imported from `editor-core`,
 * because this module is about the *lane* and must stay usable without the engine.
 * It is the same 1ms the engine uses, and the two are asserted equal in the tests —
 * if they ever diverge, a snap could land a keyframe where a patch would replace one.
 */
const KEYFRAME_TIME_EPSILON = 0.001;

/**
 * The clip-relative times a dragged keyframe should snap to.
 *
 * Deliberately **not** the other keyframes in the same lane: landing exactly on a
 * sibling would replace it, silently destroying a keyframe the user was not thinking
 * about. Siblings in *other* lanes are included, because lining position up with
 * scale is the whole point of having lanes side by side.
 *
 * **Any target that collides with one of the lane's own keyframes is dropped**, for
 * the same reason — and that case is not hypothetical: `x` and `scale` animating at
 * the same instant is exactly what lanes exist to show, so the x keyframe's time
 * would otherwise pull a dragged scale keyframe straight onto its own sibling. Being
 * *helped* into destroying a keyframe is worse than not being helped. A free drag
 * that lands there is still allowed: that is the user choosing to replace it.
 *
 * @param clip - The clip being edited.
 * @param laneProperty - The lane the drag is in; its own keyframes are excluded.
 * @param playheadClipTime - The playhead, clip-relative, or `null` when off-clip.
 * @param markers - Project markers, in TIMELINE seconds; converted here.
 */
export function keyframeSnapTargets(
  clip: Clip,
  laneProperty: string,
  playheadClipTime: number | null,
  markers: readonly Marker[] = [],
): readonly number[] {
  const duration = clip.end - clip.start;
  const targets: number[] = [0, duration];
  if (playheadClipTime !== null && playheadClipTime >= 0 && playheadClipTime <= duration) {
    targets.push(playheadClipTime);
  }
  for (const keyframe of clip.keyframes) {
    if (keyframe.property === laneProperty) continue;
    targets.push(keyframe.time);
  }
  for (const marker of markers) {
    const relative = marker.time - clip.start;
    if (relative >= 0 && relative <= duration) targets.push(relative);
  }
  // Drop anything that coincides with a keyframe already in THIS lane — see the note.
  const occupied = clip.keyframes
    .filter((keyframe) => keyframe.property === laneProperty)
    .map((keyframe) => keyframe.time);
  return targets.filter(
    (target) => !occupied.some((time) => Math.abs(time - target) <= KEYFRAME_TIME_EPSILON),
  );
}

/**
 * Snap `time` to the nearest target within `thresholdSeconds`, or return it unchanged.
 *
 * Returns the snapped time **and** whether it snapped, because the lane draws a guide
 * only while a snap is actually in effect — a guide that is always on says nothing.
 */
export function snapKeyframeTime(
  time: number,
  targets: readonly number[],
  thresholdSeconds: number,
): { readonly time: number; readonly snapped: boolean } {
  let best = time;
  let bestDistance = thresholdSeconds;
  for (const target of targets) {
    const distance = Math.abs(target - time);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return { time: best, snapped: best !== time };
}

/**
 * Clamp a group move so every selected keyframe stays inside the clip.
 *
 * A group drag moves by ONE delta, so the constraint is on the group's extremes: the
 * earliest keyframe cannot go below 0 and the latest cannot pass the clip's end.
 * Clamping each keyframe independently would silently squash the group's shape —
 * two keyframes 1s apart would arrive 0.2s apart — which is not a move at all.
 */
export function clampGroupDelta(
  times: readonly number[],
  delta: number,
  clipDuration: number,
): number {
  if (times.length === 0) return 0;
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  const lowerBound = -earliest;
  const upperBound = clipDuration - latest;
  return delta < lowerBound ? lowerBound : delta > upperBound ? upperBound : delta;
}

/** A keyframe's hover readout: property · time · value · easing. */
export function describeKeyframe(keyframe: Keyframe): string {
  // Value rounded for reading, not for storage — 1.2000000000000002 in a tooltip is
  // noise, but the stored number stays exact.
  const value = Math.round(keyframe.value * 1000) / 1000;
  return `${keyframe.property} ${value} @ ${keyframe.time.toFixed(2)}s · ${keyframe.easing}`;
}
