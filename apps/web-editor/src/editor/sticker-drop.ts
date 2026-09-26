/**
 * A sticker tile dropped on the timeline (plan/elements EL6b, 02 §3): main copies the sticker into
 * the project by id, exactly as a click in the Stickers tab does, then one patch places it at the
 * drop time — on the lane it landed on when that is a graphics lane with room. Dropped on the
 * program monitor instead (EL11), it lands at the playhead, centred where it was dropped.
 */
import type { StickerCatalog } from '@framepilot/ai-sdk';
import type { ElementMaterializeRequest, ElementMaterializeResult } from '@framepilot/shared-types';
import {
  addStickerPatch,
  stickerErrorSentence,
  type AddedSticker,
  type StickerTarget,
} from './sticker-builders.js';

/** What a drop reaches outside the editor (tests pass their own). */
export interface StickerDropDeps {
  readonly materialize: (request: ElementMaterializeRequest) => Promise<ElementMaterializeResult>;
  readonly loadCatalog: () => Promise<StickerCatalog>;
}

export interface StickerDrop {
  readonly projectId: string;
  readonly elementId: string;
  readonly atSeconds: number;
  readonly durationSeconds: number;
  /** The graphics lane it was dropped on, if any. */
  readonly trackId?: string;
  /** Where its centre lands, in canvas pixels from the frame centre (a drop on the monitor). */
  readonly offset?: { readonly x: number; readonly y: number };
  /** The editor state once main has answered: the copy takes a moment, and edits go on. */
  readonly target: () => StickerTarget;
}

export type PlacedSticker =
  | { readonly ok: true; readonly added: AddedSticker }
  | { readonly ok: false; readonly message: string };

export async function placeDroppedSticker(
  deps: StickerDropDeps,
  drop: StickerDrop,
): Promise<PlacedSticker> {
  const item = (await deps.loadCatalog().catch(() => null))?.byId.get(drop.elementId);
  if (item === undefined) return { ok: false, message: stickerErrorSentence('unknown_element') };
  // Main may not answer at all (the licence lapsed, the window is closing): that is a copy that
  // failed, said as one, never an unhandled rejection.
  const copied = await deps
    .materialize({ projectId: drop.projectId, elementId: drop.elementId })
    .catch((): ElementMaterializeResult => ({ ok: false, error: 'io_failed' }));
  if (!copied.ok) return { ok: false, message: stickerErrorSentence(copied.error, copied.detail) };
  const added = addStickerPatch(
    drop.target(),
    copied.asset,
    item.name,
    drop.atSeconds,
    drop.durationSeconds,
    {
      ...(drop.trackId !== undefined ? { trackId: drop.trackId } : {}),
      ...(drop.offset !== undefined ? { offset: drop.offset } : {}),
    },
  );
  return added === null
    ? { ok: false, message: 'That sticker could not be added. Try another.' }
    : { ok: true, added };
}
