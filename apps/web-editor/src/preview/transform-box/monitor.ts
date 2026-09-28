/**
 * The program monitor's side of the bounding box: where a selected picture's box is, what it
 * stores, and the timeline a live drag previews.
 *
 * The box is read from the FRAME PLAN (`framePlanAt`), the computation the compositor and the
 * export's frame plan share, so it frames exactly the pixels the monitor draws: a 16:9 clip fitted
 * into a 9:16 frame gets a box around the picture, not around the frame, and a sticker gets a box
 * around the sticker.
 */
import type { Clip, Keyframe, Timeline } from '@framepilot/timeline-schema';
import { evaluateKeyframes, type FramePlan } from '@framepilot/editor-core';
import { boxOfPlacement, type PictureBaseTransform } from './adapters.js';
import type { Box } from './geometry.js';

/** The selected picture's box at this frame, or `null` when the plan does not draw it. */
export function pictureBoxAt(plan: Pick<FramePlan, 'layers'>, clipId: string): Box | null {
  for (const layer of plan.layers) {
    if (layer.kind !== 'picture' || layer.role !== 'clip' || layer.clipId !== clipId) continue;
    const geometry = layer.geometry;
    if (geometry === null || geometry.width === null || geometry.height === null) continue;
    return boxOfPlacement({
      anchorX: geometry.anchorX,
      anchorY: geometry.anchorY,
      width: geometry.width,
      height: geometry.height,
      rotation: geometry.rotation,
    });
  }
  return null;
}

/** A picture's stored base transform: every property the box writes, evaluated at time 0. */
export function pictureBaseOf(keyframes: readonly Keyframe[]): PictureBaseTransform {
  const at0 = (property: string, identity: number): number =>
    evaluateKeyframes(keyframes, property, 0) ?? identity;
  return {
    scale: at0('scale', 1),
    scaleX: at0('scaleX', 1),
    scaleY: at0('scaleY', 1),
    x: at0('x', 0),
    y: at0('y', 0),
    rotation: at0('rotation', 0),
  };
}

/**
 * The values to write for a picture's new base transform: the uniform four always, and the
 * stretch only when the picture is stretched or already carries it, so an unstretched clip never
 * gains identity keyframes it did not need.
 */
export function pictureTransformWrite(
  clip: Pick<Clip, 'keyframes'>,
  next: PictureBaseTransform,
): Record<string, number> {
  const carries = (property: string): boolean =>
    clip.keyframes.some((keyframe) => keyframe.property === property);
  return {
    scale: next.scale,
    x: next.x,
    y: next.y,
    rotation: next.rotation,
    ...(next.scaleX !== 1 || carries('scaleX') ? { scaleX: next.scaleX } : {}),
    ...(next.scaleY !== 1 || carries('scaleY') ? { scaleY: next.scaleY } : {}),
  };
}

/** `timeline` with one clip's keyframes replaced (a live drag's preview; nothing is committed). */
export function timelineWithClipKeyframes(
  timeline: Timeline,
  clipId: string,
  keyframes: readonly Keyframe[],
): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.clips.some((clip) => clip.id === clipId)
        ? {
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === clipId ? { ...clip, keyframes: [...keyframes] } : clip,
            ),
          }
        : track,
    ),
  };
}

/**
 * `keyframes` with the base (time-0) values of `write` in place: what the committed patch will
 * store, so the picture a drag previews is the picture the release keeps.
 */
export function keyframesWithBase(
  keyframes: readonly Keyframe[],
  write: Readonly<Record<string, number>>,
): readonly Keyframe[] {
  const written = new Set(Object.keys(write));
  const kept = keyframes.filter(
    (keyframe) => keyframe.time !== 0 || !written.has(keyframe.property),
  );
  const base: Keyframe[] = Object.entries(write).map(([property, value]) => ({
    id: `live_base_${property}`,
    time: 0,
    property,
    value,
    easing: 'linear',
  }));
  return [...base, ...kept];
}
