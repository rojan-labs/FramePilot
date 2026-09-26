/**
 * Where an element lands, as operations (plan/elements EL4a): the one builder the Shapes tab
 * and the agent's `add_shape` tool share, so a click and a prompt that ask for the same thing
 * put it in the same place.
 *
 * A shape goes on an overlay lane, like a title: the front-most unlocked, visible overlay lane
 * with room over its span, else a lane that already has room, else a new overlay lane at the
 * front. It never goes on a picture lane, where it would be read as a cutaway. A sticker is an
 * ordinary `image` asset on an overlay lane the same way (plan/elements 04 §1): never the footage
 * cutaway placer, which would cover-crop it to the full frame.
 */
import {
  shapeDescriptor,
  type Asset,
  type Folder,
  type Timeline,
} from '@framepilot/timeline-schema';
import { createLaneAllocator, nextLayerId } from './lane-placement.js';
import { addClipId, shapeClipId, shapeEffectId, type Operation } from './operations.js';
import type { ProjectOperation } from './project-operations.js';
import { syntheticClipKind } from './synthetic-assets.js';

/** What {@link buildAddShapeOps} decided. */
export interface ShapePlacement {
  readonly operations: readonly Operation[];
  /** The lane the shape lands on (possibly one the operations create). */
  readonly trackId: string;
  /** The id the new shape clip will have. */
  readonly clipId: string;
}

/**
 * The operations that add a shape spanning `[start, end]`.
 *
 * @param timeline - The timeline the operations will apply to.
 * @param params - Complete shape params (`presetShapeParams` builds them from a preset).
 * @param start - Timeline seconds the shape appears.
 * @param end - Timeline seconds it disappears; must be after `start`.
 * @param preferredTrackId - An overlay lane to use when it has room (the agent may name one).
 */
export function buildAddShapeOps(
  timeline: Timeline,
  params: Readonly<Record<string, unknown>>,
  start: number,
  end: number,
  preferredTrackId?: string,
): ShapePlacement {
  // A named overlay lane is honoured when it can take the shape; anything else (a picture lane,
  // an id the timeline lacks) falls back to the ordinary choice rather than stranding the shape.
  const named = timeline.tracks.find(
    (track) => track.id === preferredTrackId && track.type === 'overlay' && track.locked !== true,
  );
  const usable = (track: Timeline['tracks'][number]): boolean =>
    track.type === 'overlay' && track.locked !== true && track.hidden !== true;
  // Shapes join the lane that already holds shapes, so titles and callouts keep their own lanes
  // and a person reading the timeline finds every callout in one place.
  const overlay =
    named ??
    timeline.tracks.find(
      (track) =>
        usable(track) && track.clips.some((clip) => syntheticClipKind(clip.assetId) === 'shape'),
    ) ??
    timeline.tracks.find(usable);
  let trackId: string;
  let setupOps: readonly Operation[];
  if (overlay !== undefined) {
    const placed = createLaneAllocator(timeline).allocate(overlay.id, start, end);
    trackId = placed.trackId;
    setupOps = placed.setupOps;
  } else {
    trackId = nextLayerId(timeline, 'overlay');
    setupOps = [{ type: 'add_layer', layerId: trackId, layerType: 'overlay', atIndex: 0 }];
  }
  const clipId = shapeClipId(trackId, start);
  return {
    operations: [...setupOps, { type: 'add_shape', trackId, start, end, params, clipId }],
    trackId,
    clipId,
  };
}

/**
 * The operation that changes some of a shape's params. The engine re-validates the merged
 * params, so a change that would leave the shape undrawable is refused before it lands.
 *
 * @param clipId - The shape clip.
 * @param changes - Only the keys that change; `undefined` removes a key.
 */
export function setShapeParamsOp(
  clipId: string,
  changes: Readonly<Record<string, unknown>>,
): Operation {
  return { type: 'set_effect_params', clipId, effectId: shapeEffectId(clipId), params: changes };
}

/**
 * A shape's params with its geometry swapped for `shapeId`'s (plan/elements 04 §2.3): the style
 * (colours, stroke, caps, label) and the placement (box or ends) stay, the old shape's knobs are
 * dropped, and the new shape's knobs start at their defaults.
 *
 * @returns `undefined` when `shapeId` is unknown or placed differently (a box shape cannot become
 *   a line: there is no box-to-ends mapping the editor would expect).
 */
export function swapShapeParams(
  params: Readonly<Record<string, unknown>>,
  shapeId: string,
): Record<string, unknown> | undefined {
  const next = shapeDescriptor(shapeId);
  const current = typeof params.shape === 'string' ? shapeDescriptor(params.shape) : undefined;
  if (next === undefined || current === undefined || next.frame !== current.frame) return undefined;
  const oldKnobs = new Set(current.knobs.map((knob) => knob.name));
  const swapped: Record<string, unknown> = { shape: shapeId };
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'shape' && !oldKnobs.has(key)) swapped[key] = value;
  }
  for (const knob of next.knobs) swapped[knob.name] = knob.default;
  return swapped;
}

// --- stickers (plan/elements EL6a) ----------------------------------------------------------

/** The sticker libraries, by the `source.provider` their assets carry. */
export const ELEMENT_PROVIDERS: readonly string[] = ['fluent-emoji'];

/**
 * Whether `asset` is an element (a sticker) rather than footage: derived from its provenance,
 * never stored. The Inspector, the agent's asset views, footage indexing and Credits all ask this
 * one question.
 */
export function isElementAsset(asset: Pick<Asset, 'source'> | undefined): boolean {
  const provider = asset?.source?.provider;
  return provider !== undefined && ELEMENT_PROVIDERS.includes(provider);
}

/**
 * The asset id a sticker gets: `element_<library>_<itemId>`, deterministic so adding the same
 * sticker twice reuses one asset. The desktop's `sourcedAssetId('element', …)` is pinned to this
 * formula by its own test.
 */
export function elementAssetId(library: string, itemId: string): string {
  return `element_${library}_${itemId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** The bin folder element assets live in, created with the first one. */
export const ELEMENTS_FOLDER_ID = 'folder_elements';
export const ELEMENTS_FOLDER_NAME = 'Elements';

/** A new sticker's art height, as a share of the frame height (02 §3). */
export const STICKER_DEFAULT_HEIGHT = 0.3;

/**
 * The time-0 `scale` that makes a sticker's art `height` of the frame height after the renderer's
 * contain-fit, the same `scale` the on-canvas handles write.
 *
 * @param frame - The project resolution.
 * @param media - The sticker file's pixel size (the art plus its transparent margin).
 * @param artFraction - The art's share of the file's height (`sharpSize / height`); 1 without one.
 */
export function stickerBaseScale(
  frame: { readonly width: number; readonly height: number },
  media: { readonly width: number; readonly height: number },
  artFraction = 1,
  height = STICKER_DEFAULT_HEIGHT,
): number {
  const fit = Math.min(frame.width / media.width, frame.height / media.height);
  const fittedArt = (media.height * fit * artFraction) / frame.height;
  return Math.round((height / fittedArt) * 10000) / 10000;
}

/** What {@link buildAddStickerOps} decided. */
export interface StickerPlacement {
  readonly operations: readonly (Operation | ProjectOperation)[];
  readonly trackId: string;
  readonly clipId: string;
}

export interface StickerPlacementOptions {
  /** An overlay lane to use when it has room (a drop on a lane, or the agent, names one). */
  readonly trackId?: string;
  /** The art's share of the file's height; see {@link stickerBaseScale}. */
  readonly artFraction?: number;
  /** Where its centre lands, in canvas pixels from the frame centre (the handles' units). */
  readonly offset?: { readonly x: number; readonly y: number };
}

/**
 * The operations that add the sticker `asset` spanning `[start, end]`: the Elements folder and
 * the asset when the project lacks them, an overlay lane when none has room, the clip, and its
 * base transform at time 0 — the exact keyframes the on-canvas handles commit, so a placed sticker
 * and a hand-positioned one are the same data. One patch, one undo.
 */
export function buildAddStickerOps(
  project: {
    readonly timeline: Timeline;
    readonly assets: readonly Asset[];
    readonly folders?: readonly Folder[];
    readonly resolution: { readonly width: number; readonly height: number };
  },
  asset: Asset,
  start: number,
  end: number,
  options: StickerPlacementOptions = {},
): StickerPlacement {
  const { timeline } = project;
  const projectOps: ProjectOperation[] = [];
  const known = project.assets.find((candidate) => candidate.id === asset.id);
  if (known === undefined) {
    if (!(project.folders ?? []).some((folder) => folder.id === ELEMENTS_FOLDER_ID)) {
      projectOps.push({
        type: 'create_folder',
        folderId: ELEMENTS_FOLDER_ID,
        name: ELEMENTS_FOLDER_NAME,
        parentId: null,
      });
    }
    projectOps.push({ type: 'add_asset', asset: { ...asset, folderId: ELEMENTS_FOLDER_ID } });
  }
  const stickerAssets = new Set(
    [...project.assets, asset].filter((a) => isElementAsset(a)).map((a) => a.id),
  );
  const usable = (track: Timeline['tracks'][number]): boolean =>
    track.type === 'overlay' && track.locked !== true && track.hidden !== true;
  const named = timeline.tracks.find(
    (track) => track.id === options.trackId && track.type === 'overlay' && track.locked !== true,
  );
  // Stickers join the lane that already holds stickers, as shapes join theirs.
  const overlay =
    named ??
    timeline.tracks.find(
      (track) => usable(track) && track.clips.some((clip) => stickerAssets.has(clip.assetId)),
    ) ??
    timeline.tracks.find(usable);
  let trackId: string;
  let setupOps: readonly Operation[];
  if (overlay !== undefined) {
    const placed = createLaneAllocator(timeline).allocate(overlay.id, start, end);
    trackId = placed.trackId;
    setupOps = placed.setupOps;
  } else {
    trackId = nextLayerId(timeline, 'overlay');
    setupOps = [{ type: 'add_layer', layerId: trackId, layerType: 'overlay', atIndex: 0 }];
  }
  const clipId = addClipId(trackId, asset.id, start);
  const media = (known ?? asset).media;
  const scale =
    typeof media?.width === 'number' && typeof media.height === 'number'
      ? stickerBaseScale(
          project.resolution,
          { width: media.width, height: media.height },
          options.artFraction,
        )
      : STICKER_DEFAULT_HEIGHT;
  const base = { scale, x: options.offset?.x ?? 0, y: options.offset?.y ?? 0 };
  return {
    operations: [
      ...projectOps,
      ...setupOps,
      {
        type: 'add_clip',
        trackId,
        assetId: asset.id,
        start,
        end,
        sourceStart: 0,
        sourceEnd: end - start,
        clipId,
      },
      {
        type: 'add_keyframes',
        clipId,
        keyframes: (['scale', 'x', 'y'] as const).map((property) => ({
          id: `kf_${clipId}_${property}_base`,
          time: 0,
          property,
          value: base[property],
          easing: 'linear' as const,
        })),
        replace: true,
      },
    ],
    trackId,
    clipId,
  };
}
