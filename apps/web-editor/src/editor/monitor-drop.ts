/**
 * A sticker or shape tile dropped on the program monitor (plan/elements EL11, 02 §3): added at the
 * playhead, centred where it was dropped, through the builders a click on the tile uses — only the
 * drop point is new, converted into each builder's own units (a shape's `at` in percent, a
 * sticker's `offset` in canvas pixels from the centre).
 *
 * Photos, videos and bin assets dropped on the monitor are deferred; the monitor does not take them.
 */
import type { Patch } from '@framepilot/editor-core';
import {
  shapeAtForFramePoint,
  stickerOffsetForFramePoint,
  type FramePoint,
} from '../preview/frame-point.js';
import { addShapePatch } from './shape-builders.js';
import type { StickerTarget } from './sticker-builders.js';
import { placeDroppedSticker, type StickerDropDeps } from './sticker-drop.js';

/** What the monitor takes: a shape preset in a colour, or a sticker by catalogue id. */
export type MonitorDropItem =
  | { readonly kind: 'shape'; readonly presetId: string; readonly colour: string | null }
  | { readonly kind: 'sticker'; readonly elementId: string };

export interface MonitorDrop {
  readonly item: MonitorDropItem;
  /** Where on the picture it was let go, as fractions of the frame (`clientPointToFrame`). */
  readonly point: FramePoint;
  readonly projectId: string;
  /** The playhead: a drop on the monitor adds at the moment the monitor shows. */
  readonly atSeconds: number;
  readonly durationSeconds: number;
  /** The editor state when the placement is built: a sticker's copy takes a moment. */
  readonly target: () => StickerTarget;
}

/** The placed element, for the caller that applies, selects and announces it — or why not. */
export type PlacedOnMonitor =
  | { readonly ok: true; readonly added: { readonly patch: Patch; readonly clipId: string } }
  | { readonly ok: false; readonly message: string };

/** Said when a shape cannot be built (a preset this build does not have): what the tile says. */
const SHAPE_NOT_ADDED = 'That shape could not be added. Try another.';

/**
 * Build the patch for a tile dropped on the monitor.
 *
 * @param deps - How a sticker is copied into the project (main, by id) and found in the catalogue.
 * @param drop - What was dropped, where on the picture, and when on the timeline.
 * @returns One patch placing the element, or the sentence saying why it could not be placed.
 */
export async function placeMonitorDrop(
  deps: StickerDropDeps,
  drop: MonitorDrop,
): Promise<PlacedOnMonitor> {
  const { item } = drop;
  if (item.kind === 'sticker') {
    return placeDroppedSticker(deps, {
      projectId: drop.projectId,
      elementId: item.elementId,
      atSeconds: drop.atSeconds,
      durationSeconds: drop.durationSeconds,
      offset: stickerOffsetForFramePoint(drop.point, drop.target().resolution),
      target: drop.target,
    });
  }
  const added = addShapePatch(
    drop.target().timeline,
    item.presetId,
    drop.atSeconds,
    drop.durationSeconds,
    { colour: item.colour, at: shapeAtForFramePoint(drop.point) },
  );
  return added === null ? { ok: false, message: SHAPE_NOT_ADDED } : { ok: true, added };
}
