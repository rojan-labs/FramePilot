/**
 * What the editor's polite live region says once an element lands (plan/elements 02 §3): "Added
 * the highlight box at 0:12", "Added Grinning face at 0:12", "Replaced Fire with Red heart". Every
 * add says what landed and where — a click, a key, a drop on a lane or on the monitor — because
 * the timeline it lands on is in another part of the window.
 */
import type { Patch } from '@framepilot/editor-core';
import { shapePreset } from '@framepilot/timeline-schema';
import { positionLabel } from './stock-builders.js';

/**
 * A shape by what it is: "Added the highlight box at 0:12".
 *
 * @param presetId - The preset (or `icon/<name>`) that was added.
 * @param atSeconds - Where it starts.
 */
export function shapeAddedAnnouncement(presetId: string, atSeconds: number): string {
  const name = shapePreset(presetId)?.preset.name.toLowerCase() ?? 'shape';
  return `Added the ${name} at ${positionLabel(atSeconds)}`;
}

/**
 * A sticker by its own name, as the Stickers tab names it: "Added Grinning face at 0:12".
 *
 * @param name - The sticker's catalogue name.
 * @param atSeconds - Where it starts.
 */
export function stickerAddedAnnouncement(name: string, atSeconds: number): string {
  return `Added ${name} at ${positionLabel(atSeconds)}`;
}

/** A swap from the Inspector's Replace…: "Replaced Fire with Red heart". */
export function stickerReplacedAnnouncement(from: string, to: string): string {
  return `Replaced ${from} with ${to}`;
}

/**
 * The clip a placement patch adds and where it starts, read from its `add_clip`, so the caller
 * can select it and say where it landed — or `null` when the patch adds no clip.
 */
export function placedClipOf(
  patch: Patch,
): { readonly clipId: string; readonly start: number } | null {
  for (const operation of patch.operations) {
    if (operation.type === 'add_clip' && typeof operation.clipId === 'string') {
      return { clipId: operation.clipId, start: operation.start };
    }
  }
  return null;
}
