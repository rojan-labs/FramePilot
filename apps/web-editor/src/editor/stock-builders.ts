/**
 * Patches for the Photos and Videos panel's manual placements (plan/elements EL9, ADR 0193):
 * **Add as overlay** and a tile dropped on the timeline. The shape of each placement is decided
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

/** A placed stock clip, for the caller that selects it afterwards. */
export interface AddedStock {
  readonly patch: Patch;
  readonly clipId: string;
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
    patch: patchFor(
      placement,
      asset,
      'stockoverlay',
      `Add stock ${placement.kind} "${asset.id}" as an overlay at ${placement.start.toFixed(2)}s`,
    ),
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
    onDroppedLane: placement.onDroppedLane,
    patch: patchFor(
      placement,
      asset,
      'stockdrop',
      `Add stock ${placement.kind} "${asset.id}"${where} at ${placement.start.toFixed(2)}s`,
    ),
  };
}
