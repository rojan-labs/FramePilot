/**
 * Dragging an element from Elements onto the timeline (plan/elements EL5.2): the payload a tile
 * puts on the drag and the timeline reads back on drop, beside `TEXT_OVERLAY_DND_TYPE`.
 */

/** The drag type an Elements tile carries. */
export const ELEMENT_DND_TYPE = 'application/x-framepilot-element';

/** A shape tile's payload: the preset (or `icon/<name>`) and the Shapes tab's chosen colour. */
export interface ShapeDragPayload {
  readonly kind: 'shape';
  readonly presetId: string;
  readonly colour: string | null;
}

export function encodeElementDrag(payload: ShapeDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * The payload of a drop, or `null` when it is not one this build reads. The data comes from
 * another window as easily as from this one, so every field is checked.
 */
export function decodeElementDrag(raw: string): ShapeDragPayload | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
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
