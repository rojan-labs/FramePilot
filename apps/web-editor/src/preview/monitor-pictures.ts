/**
 * Which picture clips the program monitor is drawing at the playhead, and which of them the
 * editor is working on.
 *
 * The layered monitor composites every picture layer the frame plan lists, so a clip under
 * another one is still ON the monitor: it is just behind. Selecting it must give it the mask
 * tools and the transform box, as it does in any editor that stacks layers. Only offering them
 * for the front-most picture meant a clip under a cut-out, a title or a track matte source could
 * not have a mask drawn at all: the Mask tab's Draw buttons focused a canvas that was never
 * mounted (found by the masking end-to-end suite, E2E.8).
 */
import type { FramePlan } from '@framepilot/editor-core';
import type { Clip, Timeline } from '@framepilot/timeline-schema';

/**
 * The clips of the plan's picture layers, back to front (under-layers of transitions excluded).
 *
 * @param plan - The frame plan at the playhead.
 * @param timeline - The timeline the plan was made from, to resolve clip ids to clips.
 * @returns Each drawn picture clip once, in compositing order.
 */
export function drawnPictureClips(plan: Pick<FramePlan, 'layers'>, timeline: Timeline): Clip[] {
  const byId = new Map<string, Clip>();
  for (const track of timeline.tracks) for (const clip of track.clips) byId.set(clip.id, clip);
  const drawn: Clip[] = [];
  for (const layer of plan.layers) {
    if (layer.kind !== 'picture' || layer.role !== 'clip' || layer.clipId === null) continue;
    const clip = byId.get(layer.clipId);
    if (clip !== undefined && !drawn.includes(clip)) drawn.push(clip);
  }
  return drawn;
}

/**
 * The selected clip among the drawn pictures, front-most first when several are selected.
 *
 * @returns `null` when no drawn picture is selected (then the monitor offers no handles).
 */
export function selectedDrawnPicture(
  drawn: readonly Clip[],
  selectedIds: readonly string[],
): Clip | null {
  for (let index = drawn.length - 1; index >= 0; index -= 1) {
    if (selectedIds.includes(drawn[index]!.id)) return drawn[index]!;
  }
  return null;
}
