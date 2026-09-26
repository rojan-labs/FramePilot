/**
 * Patches for stickers (plan/elements EL6a): add one at the playhead, or replace the sticker a clip
 * shows. The file is already in the project (main copied it, `elementsMaterialize`); these build
 * the one validated, reversible patch that places it, with editor-core's `buildAddStickerOps` — the
 * builder the agent's `add_sticker` uses too.
 */
import { buildAddStickerOps, elementArtFraction, type Patch } from '@framepilot/editor-core';
import type { ElementAssetWire, ElementErrorCodeWire } from '@framepilot/shared-types';
import type { Asset, Folder, Timeline } from '@framepilot/timeline-schema';

const patchId = (raw: string): Patch['patchId'] => raw as Patch['patchId'];
const ms = (seconds: number): number => Math.round(seconds * 1000);

/** The editor state a sticker patch reads. */
export interface StickerTarget {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly folders?: readonly Folder[];
  readonly resolution: { readonly width: number; readonly height: number };
}

/** The project asset a materialised sticker becomes. */
export function stickerAssetFromWire(wire: ElementAssetWire): Asset {
  return {
    id: wire.id,
    path: wire.path,
    kind: 'image',
    media:
      wire.media.width !== null && wire.media.height !== null
        ? { width: wire.media.width, height: wire.media.height }
        : {},
    source: wire.source,
  } as Asset;
}

/** The art's share of the file's height: the placement's `artFraction`. */
export function stickerArtFraction(wire: ElementAssetWire): number {
  return wire.sharpSize !== null && wire.media.height !== null && wire.media.height > 0
    ? wire.sharpSize / wire.media.height
    : 1;
}

/** What an added sticker is, for the caller that selects it afterwards. */
export interface AddedSticker {
  readonly patch: Patch;
  readonly clipId: string;
}

/**
 * Add the sticker `wire` at `start` for `durationSeconds`: the asset and the Elements folder when
 * the project lacks them, an overlay lane, the clip, and its base transform — one undo step.
 *
 * @param name - The sticker's name, for History ("Add sticker “Fire”").
 */
export function addStickerPatch(
  target: StickerTarget,
  wire: ElementAssetWire,
  name: string,
  start: number,
  durationSeconds: number,
  options: { readonly trackId?: string; readonly offset?: { x: number; y: number } } = {},
): AddedSticker | null {
  if (!(durationSeconds > 0)) return null;
  const placed = buildAddStickerOps(
    target,
    stickerAssetFromWire(wire),
    start,
    start + durationSeconds,
    { ...options, artFraction: stickerArtFraction(wire) },
  );
  // Where it sits is part of the edit: the same sticker dropped at two places on the monitor at
  // the same moment is two different patches, so it never shares an id with the other.
  const at = options.offset === undefined ? '' : `_${options.offset.x}_${options.offset.y}`;
  return {
    clipId: placed.clipId,
    patch: {
      patchId: patchId(`sticker_${wire.id}_${placed.trackId}_${ms(start)}${at}`),
      createdBy: 'user',
      reason: `Add sticker “${name}”`,
      operations: [...placed.operations],
    },
  };
}

/**
 * Place a sticker that is already in the bin (a double-click or a drag from the media bin): the
 * same builder and the same transform as the Stickers tab, never the footage path.
 *
 * @param trackId - The lane it was dropped on, used when it is a graphics lane with room.
 */
export function placeElementAssetPatch(
  target: StickerTarget,
  asset: Asset,
  start: number,
  durationSeconds: number,
  trackId?: string,
): AddedSticker | null {
  if (!(durationSeconds > 0)) return null;
  const placed = buildAddStickerOps(target, asset, start, start + durationSeconds, {
    artFraction: elementArtFraction(asset),
    ...(trackId !== undefined ? { trackId } : {}),
  });
  const id = asset.source?.remoteId ?? asset.id;
  const name = id.replace(/_/g, ' ');
  return {
    clipId: placed.clipId,
    patch: {
      patchId: patchId(`sticker_${asset.id}_${placed.trackId}_${ms(start)}`),
      createdBy: 'user',
      reason: `Add sticker “${name.charAt(0).toUpperCase()}${name.slice(1)}”`,
      operations: [...placed.operations],
    },
  };
}

/**
 * Show `wire` in the sticker clip `clipId` instead of what it shows now: its timing, transform,
 * animation and effects stay; only the asset changes (`set_clip_media`). Brings the asset first
 * when the project lacks it.
 *
 * @returns `null` when the clip is gone (it was deleted while the panel was open).
 */
export function replaceStickerPatch(
  target: StickerTarget,
  clipId: string,
  wire: ElementAssetWire,
  name: string,
): Patch | null {
  const clip = target.timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
  if (clip === undefined) return null;
  const asset = stickerAssetFromWire(wire);
  const known = target.assets.some((candidate) => candidate.id === asset.id);
  const placed = known
    ? []
    : buildAddStickerOps(target, asset, clip.start, clip.end).operations.filter(
        (op) => op.type === 'create_folder' || op.type === 'add_asset',
      );
  return {
    patchId: patchId(`sticker_replace_${clipId}_${wire.id}`),
    createdBy: 'user',
    reason: `Replace sticker with “${name}”`,
    operations: [
      ...placed,
      {
        type: 'set_clip_media',
        clipId,
        assetId: asset.id,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
      },
    ],
  };
}

/** The sentence a sticker that could not be added shows (plan/elements 02 §8). */
export function stickerErrorSentence(error: ElementErrorCodeWire, detail?: string): string {
  switch (error) {
    case 'disk_full':
      return "Couldn't add this sticker: there isn't enough disk space.";
    case 'library_missing':
      return detail !== undefined && detail.includes('desktop app')
        ? detail
        : "This sticker's file is missing from this install of FramePilot. Reinstalling fixes it.";
    case 'integrity_failed':
      return "This sticker's file in this install of FramePilot is damaged. Reinstalling fixes it.";
    case 'unknown_element':
      return 'That sticker is not in this version of FramePilot. Pick another.';
    case 'io_failed':
      return "Couldn't copy this sticker into the project. Check the project folder can be written to, then try again.";
  }
}
