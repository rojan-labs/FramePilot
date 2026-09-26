/**
 * Dragging an element from Elements onto the timeline (plan/elements EL5.2, EL6b, EL9): the
 * payload a tile puts on the drag and the timeline reads back on drop, beside
 * `TEXT_OVERLAY_DND_TYPE`.
 */
import { STICKER_ID_PATTERN } from '@framepilot/ai-sdk';

/** The drag type an Elements tile carries. */
export const ELEMENT_DND_TYPE = 'application/x-framepilot-element';

/** A shape tile's payload: the preset (or `icon/<name>`) and the Shapes tab's chosen colour. */
export interface ShapeDragPayload {
  readonly kind: 'shape';
  readonly presetId: string;
  readonly colour: string | null;
}

/**
 * A sticker tile's payload: the catalogue id only. The drop asks main to copy that sticker into
 * the project, exactly as a click does; nothing path-shaped ever rides on a drag.
 */
export interface StickerDragPayload {
  readonly kind: 'sticker';
  readonly elementId: string;
}

/**
 * A Photos or Videos tile's payload (plan/elements EL9): the provider's id for the item and its
 * kind, and nothing else. The drop asks main to download that item, exactly as **Add** does; main
 * resolves the id against what it fetched itself this session, so no URL or path ever rides on a
 * drag.
 */
export interface StockDragPayload {
  readonly kind: 'stock';
  readonly mediaKind: 'photo' | 'video';
  readonly remoteId: string;
}

/**
 * What a provider id may look like on a drag: letters, digits, `_` and `-` (Pexels ids are
 * digits). Strict on purpose — nothing path- or URL-shaped gets through.
 */
export const STOCK_REMOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ElementDragPayload = ShapeDragPayload | StickerDragPayload | StockDragPayload;

export function encodeElementDrag(payload: ElementDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * The drag type naming a tile's kind, which carries nothing but that name. A drop target can read
 * the payload only on drop — during dragover it sees the types alone — so a target that takes some
 * kinds and not others (the program monitor takes stickers and shapes, not photos or videos) reads
 * the kind from here to show the right cursor before the drop, rather than taking a drop it then
 * ignores.
 */
export function elementKindDndType(kind: ElementDragPayload['kind']): string {
  return `${ELEMENT_DND_TYPE}-kind-${kind}`;
}

/**
 * Put `payload` on a tile's drag: the payload under {@link ELEMENT_DND_TYPE}, and its kind under
 * {@link elementKindDndType}.
 */
export function writeElementDrag(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  payload: ElementDragPayload,
): void {
  dataTransfer.setData(ELEMENT_DND_TYPE, encodeElementDrag(payload));
  dataTransfer.setData(elementKindDndType(payload.kind), payload.kind);
}

/**
 * Whether a drag's types say it carries an element of one of `kinds` — readable during dragover,
 * unlike the payload. The drop still decodes and checks the payload itself.
 */
export function dragCarriesElementKind(
  types: readonly string[],
  kinds: readonly ElementDragPayload['kind'][],
): boolean {
  return kinds.some((kind) => types.includes(elementKindDndType(kind)));
}

/**
 * The payload of a drop, or `null` when it is not one this build reads. The data comes from
 * another window as easily as from this one, so every field is checked.
 */
export function decodeElementDrag(raw: string): ElementDragPayload | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.kind === 'stock') {
      return (value.mediaKind === 'photo' || value.mediaKind === 'video') &&
        typeof value.remoteId === 'string' &&
        STOCK_REMOTE_ID_PATTERN.test(value.remoteId)
        ? { kind: 'stock', mediaKind: value.mediaKind, remoteId: value.remoteId }
        : null;
    }
    if (value.kind === 'sticker') {
      return typeof value.elementId === 'string' && STICKER_ID_PATTERN.test(value.elementId)
        ? { kind: 'sticker', elementId: value.elementId }
        : null;
    }
    if (value.kind !== 'shape' || typeof value.presetId !== 'string') return null;
    const colour =
      typeof value.colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.colour)
        ? value.colour
        : null;
    return { kind: 'shape', presetId: value.presetId, colour };
  } catch {
    return null;
  }
}
