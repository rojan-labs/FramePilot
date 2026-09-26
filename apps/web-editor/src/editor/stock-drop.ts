/**
 * A Photos or Videos tile dropped on the timeline (plan/elements EL9, 02 §3): the drag carries a
 * provider id and nothing else; main downloads that item exactly as the panel's **Add** does —
 * the same registry, so the tile shows the progress, Cancel and failure — and then one patch
 * places it at the drop time: on the picture lane it was dropped on when that lane has room, else
 * on a new lane in front of the footage (`buildDropStockOps`).
 */
import { downloadAndPlaceStock, type StockFetch, type StockFetchDeps } from './stock-download.js';
import { dropStockClipPatch, type DroppedStock, type StockTarget } from './stock-builders.js';

/** Said when the timeline changed during the download so the lane under the drop had no room. */
export const STOCK_DROP_MOVED_NOTICE =
  'The lane you dropped this on had no room by the time it downloaded, so it went on a new lane in front.';

/** Unreachable while a drop always has a lane to land on; said rather than thrown if it ever is. */
const STOCK_DROP_UNPLACED = 'That clip downloaded but could not be placed. Drag it from Assets.';

export interface StockDrop extends StockFetch {
  /** The drop time, in timeline seconds. */
  readonly atSeconds: number;
  /** The picture lane it was dropped on, if any. */
  readonly trackId?: string;
  /** The editor as it was at the drop, to tell whether the download changed where it lands. */
  readonly atDrop: StockTarget;
  /** The editor once main has answered: a download takes a while, and edits go on. */
  readonly target: () => StockTarget;
}

export type PlacedStockDrop =
  | {
      readonly ok: true;
      readonly added: DroppedStock;
      /** A sentence to show when it landed somewhere other than the drop asked for. */
      readonly notice: string | null;
    }
  /** `message` is empty when there is nothing to say (the user cancelled it). */
  | { readonly ok: false; readonly message: string };

/**
 * Download the dropped item and build the patch that places it. The caller applies the patch and
 * selects the clip; the tile's state is already settled when this resolves.
 *
 * @param deps - The download bridge and the tile registry.
 * @param drop - Where it was dropped, and how to read the editor now.
 */
export async function placeDroppedStock(
  deps: StockFetchDeps,
  drop: StockDrop,
): Promise<PlacedStockDrop> {
  // Filled in by the placement callback, which runs once the bytes have landed.
  const landing: { placed?: { readonly added: DroppedStock; readonly notice: string | null } } = {};
  const outcome = await downloadAndPlaceStock(deps, drop, (asset) => {
    const added = dropStockClipPatch(drop.target(), asset, drop.atSeconds, drop.trackId);
    // Would it have landed on the lane at the moment it was dropped? If so and it no longer does,
    // the timeline moved under the download, and the user is owed a sentence — not a clip
    // quietly on a different lane from the one they aimed at.
    const aimed = dropStockClipPatch(drop.atDrop, asset, drop.atSeconds, drop.trackId);
    landing.placed = {
      added,
      notice: aimed.onDroppedLane && !added.onDroppedLane ? STOCK_DROP_MOVED_NOTICE : null,
    };
    return null;
  });
  if (!outcome.ok) return { ok: false, message: outcome.message };
  if (landing.placed === undefined) return { ok: false, message: STOCK_DROP_UNPLACED };
  return { ok: true, ...landing.placed };
}
