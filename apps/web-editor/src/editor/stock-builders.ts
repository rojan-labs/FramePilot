/**
 * Patches for the Photos and Videos panel's manual placements (plan/elements EL9, ADR 0193):
 * **Add as overlay** and a tile dropped on the timeline — and the media bin's **Add as overlay** on
 * the user's own images (EL11), the same placement. The shape of each placement is decided
 * in `@framepilot/editor-core` (`buildAddStockOverlayOps`, `buildDropStockOps`), beside the
 * cutaway's `buildAddStockOps`, so a later agent path cannot drift from the panel; these give it
 * the patch identity only — id, author and the line History shows.
 */
import {
  buildAddStockOverlayOps,
  buildDropStockOps,
  type Patch,
  type StockLanePlacement,
} from '@framepilot/editor-core';
import type { Asset, Timeline } from '@framepilot/timeline-schema';

const patchId = (raw: string): Patch['patchId'] => raw as Patch['patchId'];
const ms = (seconds: number): number => Math.round(seconds * 1000);

/** The editor state a stock placement reads. */
export interface StockTarget {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
}

/** A placed stock clip, for the caller that selects and announces it afterwards. */
export interface AddedStock {
  readonly patch: Patch;
  readonly clipId: string;
  /** Where it starts on the timeline, in seconds. */
  readonly start: number;
}

/** A dropped stock clip, which also says whether it landed on the lane under the cursor. */
export interface DroppedStock extends AddedStock {
  readonly onDroppedLane: boolean;
}

/** One patch around a placement; its inverse removes the clip, the lane and the asset. */
function patchFor(
  placement: StockLanePlacement,
  asset: Asset,
  idPrefix: string,
  reason: string,
): Patch {
  return {
    patchId: patchId(`${idPrefix}_${asset.id}_${placement.trackId}_${ms(placement.start)}`),
    createdBy: 'user',
    reason,
    operations: [...placement.operations],
  };
}

/**
 * **Add as overlay**: `asset` as a centred picture-in-picture at 40% of its contain-fit size,
 * starting at `atStart`, over whatever is there. Never refused for covering picture — that is
 * what an overlay is for; **Add** keeps the cutaway rule (ADR 0140).
 *
 * @param target - The live editor state (the download took a while; the timeline moved on).
 * @param asset - The downloaded stock asset.
 * @param atStart - Where it starts: the playhead when the download landed.
 */
export function addStockOverlayPatch(
  target: StockTarget,
  asset: Asset,
  atStart: number,
): AddedStock {
  const placement = buildAddStockOverlayOps(target.timeline, target.assets, asset, atStart);
  return {
    clipId: placement.clipId,
    start: placement.start,
    patch: patchFor(
      placement,
      asset,
      'stockoverlay',
      `Add stock ${placement.kind} "${asset.id}" as an overlay at ${placement.start.toFixed(2)}s`,
    ),
  };
}

/**
 * The media bin's **Add as overlay** on one of the user's own images (a logo, a screenshot, a
 * cut-out): the Pexels tile's placement exactly (ADR 0193, amendment "bin images"), so a second
 * entry point cannot drift from the first. The image is already in the bin, which the builder sees
 * and so adds no asset operation: one undo takes back the clip and any lane it opened, and the
 * image stays in the bin.
 *
 * @param target - The live editor state.
 * @param asset - The bin image.
 * @param name - What the bin calls it (its file name), for History.
 * @param atStart - Where it starts: the playhead.
 */
export function addImageOverlayPatch(
  target: StockTarget,
  asset: Asset,
  name: string,
  atStart: number,
): AddedStock {
  const placement = buildAddStockOverlayOps(target.timeline, target.assets, asset, atStart);
  return {
    clipId: placement.clipId,
    start: placement.start,
    patch: patchFor(placement, asset, 'imageoverlay', `Add “${name}” as an overlay`),
  };
}

/**
 * A photo or video tile dropped on the timeline: full frame at the drop time, on the picture lane
 * it was dropped on when that lane has room, else on a new lane in front of the footage.
 *
 * @param target - The live editor state once the download has landed.
 * @param asset - The downloaded stock asset.
 * @param atStart - The drop time.
 * @param trackId - The lane under the cursor, when it was a picture lane.
 */
export function dropStockClipPatch(
  target: StockTarget,
  asset: Asset,
  atStart: number,
  trackId?: string,
): DroppedStock {
  const placement = buildDropStockOps(target.timeline, target.assets, asset, atStart, trackId);
  const where = placement.createdLayer ? ' on a new layer' : '';
  return {
    clipId: placement.clipId,
    start: placement.start,
    onDroppedLane: placement.onDroppedLane,
    patch: patchFor(
      placement,
      asset,
      'stockdrop',
      `Add stock ${placement.kind} "${asset.id}"${where} at ${placement.start.toFixed(2)}s`,
    ),
  };
}

/** `75` → `1:15`: a timeline position as a person reads it aloud. */
function positionLabel(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * What the editor's polite live region says once a Pexels clip lands (plan/elements 02 §3,
 * "Added … at 0:12"), so a screen-reader user hears that the download finished and where it went.
 *
 * @param asset - The placed asset (its kind names it: photo or video).
 * @param placement - An overlay (Add as overlay) or a drop on the timeline.
 * @param atSeconds - Where it starts.
 */
export function stockAddedAnnouncement(
  asset: Asset,
  placement: 'overlay' | 'drop',
  atSeconds: number,
): string {
  const noun = asset.kind === 'image' ? 'photo' : 'video';
  const where = positionLabel(atSeconds);
  return placement === 'overlay'
    ? `Added the ${noun} as an overlay at ${where}`
    : `Added the ${noun} at ${where}`;
}

/**
 * What the polite live region says once a bin image lands as an overlay: the file's own name,
 * since "the photo" would misname a logo or a screenshot.
 *
 * @param name - What the bin calls the image.
 * @param atSeconds - Where it starts.
 */
export function imageOverlayAnnouncement(name: string, atSeconds: number): string {
  return `Added ${name} as an overlay at ${positionLabel(atSeconds)}`;
}
