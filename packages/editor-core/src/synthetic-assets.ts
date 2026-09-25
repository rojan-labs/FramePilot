/**
 * Synthetic asset ids and a clip's renderable kind: the one definition in TypeScript
 * (plan/elements EL3). The Python twin is `framepilot_engine/timeline/synthetic_assets.py`;
 * `tests/fixtures/clip-kind.json` holds both to the same answers.
 *
 * A text overlay or a caption cue has no media file. Its `assetId` is a sentinel naming what
 * draws it. Every module that asks "is this a title?", "does this clip read a source?" or "what
 * kind of clip is this?" asks here, so a new synthetic kind (a shape) is a change to this module,
 * not to seventeen. `synthetic-assets.guard.test.ts` fails if a sentinel is spelled, copied or
 * compared anywhere else.
 */
import type { Track } from '@framepilot/timeline-schema';

/** The asset id of a text overlay (`add_text_overlay`). Persisted: never change it. */
export const TEXT_OVERLAY_ASSET_ID = '__text__';
/** The asset id of a caption cue (`add_caption_layer`). Persisted: never change it. */
export const CAPTION_ASSET_ID = '__caption__';

/** What a synthetic asset id draws. */
export type SyntheticClipKind = 'text' | 'caption';

const SYNTHETIC_KIND_BY_ASSET_ID: ReadonlyMap<string, SyntheticClipKind> = new Map([
  [TEXT_OVERLAY_ASSET_ID, 'text'],
  [CAPTION_ASSET_ID, 'caption'],
]);

/** Every synthetic asset id: a clip carrying one has no asset in the bin, by design. */
export const SYNTHETIC_ASSET_IDS: ReadonlySet<string> = new Set(SYNTHETIC_KIND_BY_ASSET_ID.keys());

/** The renderable kind of a clip. Mirrors the engine's `clip_render_kind`. */
export type ClipRenderKind = 'video' | 'image' | 'audio' | SyntheticClipKind;

/** True when `assetId` is a sentinel rather than a bin asset. */
export function isSyntheticAssetId(assetId: string): boolean {
  return SYNTHETIC_KIND_BY_ASSET_ID.has(assetId);
}

/** What a synthetic id draws, or `null` for a media asset id. */
export function syntheticClipKind(assetId: string): SyntheticClipKind | null {
  return SYNTHETIC_KIND_BY_ASSET_ID.get(assetId) ?? null;
}

/**
 * Does this clip draw from a real, time-based source?
 *
 * Text overlays and caption cues have no such source. They are generated at render time from
 * their own parameters, so every instant of them is as available as every other, and
 * `sourceStart: 0` on one of them means "nothing to say" rather than "the file starts here".
 * Treating that 0 as a real in-point is what made a text overlay extendable forwards and
 * immovable backwards: its earliest possible start computed to exactly where it already was.
 */
export function hasTimeBasedSource(clip: { readonly assetId: string }): boolean {
  return !isSyntheticAssetId(clip.assetId);
}

/**
 * A clip's renderable kind, from its asset id and its asset's `kind` — never from its lane's
 * advisory `type`, so a clip behaves the same on any lane. An id absent from the bin (or an
 * unknown asset kind) reads as `video`, as the renderer draws it.
 *
 * @param assetId - The clip's `assetId`.
 * @param assetKind - The bin asset's `kind`, or `null`/`undefined` when the bin has none.
 */
export function clipRenderKind(
  assetId: string,
  assetKind: string | null | undefined,
): ClipRenderKind {
  const synthetic = syntheticClipKind(assetId);
  if (synthetic !== null) return synthetic;
  if (assetKind === 'audio') return 'audio';
  if (assetKind === 'image') return 'image';
  return 'video';
}

/** The advisory `track.type` of a lane that hosts clips of `kind`. Video and stills share one. */
export function laneTypeForKind(kind: ClipRenderKind): Track['type'] {
  switch (kind) {
    case 'audio':
      return 'audio';
    case 'caption':
      return 'caption';
    case 'text':
      return 'overlay';
    case 'video':
    case 'image':
      return 'video';
  }
}
