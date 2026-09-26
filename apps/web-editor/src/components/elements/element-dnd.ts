/**
 * Dragging an element from Elements onto the timeline (plan/elements EL5.2, EL6b): the payload a
 * tile puts on the drag and the timeline reads back on drop, beside `TEXT_OVERLAY_DND_TYPE`.
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

export type ElementDragPayload = ShapeDragPayload | StickerDragPayload;

export function encodeElementDrag(payload: ElementDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * The payload of a drop, or `null` when it is not one this build reads. The data comes from
 * another window as easily as from this one, so every field is checked.
 */
export function decodeElementDrag(raw: string): ElementDragPayload | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
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
