/**
 * Where an element lands, as operations (plan/elements EL4a): the one builder the Shapes tab
 * and the agent's `add_shape` tool share, so a click and a prompt that ask for the same thing
 * put it in the same place.
 *
 * A shape goes on an overlay lane, like a title: the front-most unlocked, visible overlay lane
 * with room over its span, else a lane that already has room, else a new overlay lane at the
 * front. It never goes on a picture lane, where it would be read as a cutaway.
 */
import type { Timeline } from '@framepilot/timeline-schema';
import { createLaneAllocator, nextLayerId } from './lane-placement.js';
import { shapeClipId, shapeEffectId, type Operation } from './operations.js';

/** What {@link buildAddShapeOps} decided. */
export interface ShapePlacement {
  readonly operations: readonly Operation[];
  /** The lane the shape lands on (possibly one the operations create). */
  readonly trackId: string;
  /** The id the new shape clip will have. */
  readonly clipId: string;
}

/**
 * The operations that add a shape spanning `[start, end]`.
 *
 * @param timeline - The timeline the operations will apply to.
 * @param params - Complete shape params (`presetShapeParams` builds them from a preset).
 * @param start - Timeline seconds the shape appears.
 * @param end - Timeline seconds it disappears; must be after `start`.
 */
export function buildAddShapeOps(
  timeline: Timeline,
  params: Readonly<Record<string, unknown>>,
  start: number,
  end: number,
): ShapePlacement {
  const overlay = timeline.tracks.find(
    (track) => track.type === 'overlay' && track.locked !== true && track.hidden !== true,
  );
  let trackId: string;
  let setupOps: readonly Operation[];
  if (overlay !== undefined) {
    const placed = createLaneAllocator(timeline).allocate(overlay.id, start, end);
    trackId = placed.trackId;
    setupOps = placed.setupOps;
  } else {
    trackId = nextLayerId(timeline, 'overlay');
    setupOps = [{ type: 'add_layer', layerId: trackId, layerType: 'overlay', atIndex: 0 }];
  }
  const clipId = shapeClipId(trackId, start);
  return {
    operations: [...setupOps, { type: 'add_shape', trackId, start, end, params, clipId }],
    trackId,
    clipId,
  };
}

/**
 * The operation that changes some of a shape's params. The engine re-validates the merged
 * params, so a change that would leave the shape undrawable is refused before it lands.
 *
 * @param clipId - The shape clip.
 * @param changes - Only the keys that change; `undefined` removes a key.
 */
export function setShapeParamsOp(
  clipId: string,
  changes: Readonly<Record<string, unknown>>,
): Operation {
  return { type: 'set_effect_params', clipId, effectId: shapeEffectId(clipId), params: changes };
}
