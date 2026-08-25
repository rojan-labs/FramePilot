/**
 * @framepilot/editor-core/stock-placement — the one shape of "a fetched stock
 * clip on the timeline".
 *
 * ## Why this lives here rather than in the panel
 *
 * Two callers place a downloaded stock photo or video: the Stock panel (a person
 * clicked **Add**) and the agent's `add_stock` (the model decided). They run in
 * different packages and cannot import each other, so as long as each built its
 * own operations the two would drift — and the way they would drift is that one
 * of them starts producing a clip the other's tests never see. `editor-core` is
 * the package both already depend on, so the decision is made once, here, and
 * the two callers only wrap it with their own patch identity.
 *
 * ## The host downloads; it does not edit
 *
 * `add_stock` reaches the network in the trusted Electron main process and hands
 * back an asset. Everything after that is a typed, validated, reversible patch —
 * the host never mutates a timeline (AGENTS.md invariant 5). This module is the
 * boundary where a side effect becomes an edit, exactly as
 * `music-placement.ts` is for `add_music`.
 */
import type { Asset, Timeline, Track } from '@framepilot/timeline-schema';
import type { AnyOperation } from './patch.js';
import { CAPTION_ASSET_ID, TEXT_OVERLAY_ASSET_ID } from './operations.js';
import { picturePlacementConflict } from './picture-occupancy.js';

/**
 * Length given to a still, matching the renderer's `DEFAULT_CLIP_SECONDS`: a
 * stock photo lands the same length as a photo the user dragged in. The user
 * trims it afterwards; there is no separate "still duration" setting.
 */
export const DEFAULT_STOCK_STILL_SECONDS = 5;

/**
 * Overlap tolerance, matching the renderer's `MIN_EDIT_SECONDS`. Butting a
 * cutaway against the clip before it is what an editor does, so touching edges
 * are not an overlap.
 */
const MIN_EDIT_SECONDS = 1e-3;

/** The picture kinds this module places. Stock media is always one of these. */
type StockKind = 'video' | 'image';

/**
 * The renderable kinds a clip can have. Mirrors the renderer's `ClipKind` so the
 * dominant-kind rule below counts over the same space and cannot resolve a tie
 * differently from the panel it replaced.
 */
type ClipKind = StockKind | 'audio' | 'text' | 'caption';

/** What {@link buildAddStockOps} decided, for a caller that must describe it. */
export interface StockPlacement {
  /** The operations, in the order they must apply. Always one patch. */
  readonly operations: readonly AnyOperation[];
  /** The layer the clip landed on — existing or freshly created. */
  readonly trackId: string;
  /** TRUE when the placement had to create that layer. */
  readonly createdLayer: boolean;
  /** The clamped start, in timeline seconds. */
  readonly start: number;
  /** The clip's length, in timeline seconds. */
  readonly durationSeconds: number;
  /** The asset's renderable kind, for describing what was placed. */
  readonly kind: StockKind;
}

/** The renderable kind of a stock asset: a still is an image, everything else picture. */
function stockKind(asset: Asset): StockKind {
  return asset.kind === 'image' ? 'image' : 'video';
}

/**
 * A clip's renderable kind, derived from its content — never from its layer's
 * advisory `type`, so a clip behaves the same on any layer. An asset id absent
 * from the bin reads as `video`, matching the renderer.
 */
function clipKindOf(assetId: string, kindByAssetId: ReadonlyMap<string, Asset['kind']>): ClipKind {
  if (assetId === TEXT_OVERLAY_ASSET_ID) return 'text';
  if (assetId === CAPTION_ASSET_ID) return 'caption';
  const kind = kindByAssetId.get(assetId);
  if (kind === 'audio') return 'audio';
  if (kind === 'image') return 'image';
  return 'video';
}

/**
 * The dominant kind of an existing layer, by clip count — the same rule the
 * renderer's auto-layering uses to decide "does this clip belong here?". An
 * empty layer has no kind and never matches, so a clip is never dropped onto a
 * layer whose purpose is unknown.
 */
function dominantClipKind(
  track: Track,
  kindByAssetId: ReadonlyMap<string, Asset['kind']>,
): ClipKind | null {
  if (track.clips.length === 0) return null;
  const counts = new Map<ClipKind, number>();
  for (const clip of track.clips) {
    const kind = clipKindOf(clip.assetId, kindByAssetId);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best: ClipKind | null = null;
  let bestCount = 0;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** TRUE when no clip on `track` overlaps the half-open span `[start, end)`. */
function hasRoomFor(track: Track, start: number, end: number): boolean {
  return !track.clips.some(
    (clip) => clip.start < end - MIN_EDIT_SECONDS && clip.end > start + MIN_EDIT_SECONDS,
  );
}

/** A non-colliding, deterministic id for a new layer, matching the renderer's scheme. */
function nextLayerId(timeline: Timeline, layerType: Track['type']): string {
  let n = timeline.tracks.length + 1;
  let id = `layer_${layerType}_${n}`;
  while (timeline.tracks.some((track) => track.id === id)) {
    n += 1;
    id = `layer_${layerType}_${n}`;
  }
  return id;
}

/**
 * The operations that put a downloaded stock asset in the bin AND on the
 * timeline — or `null` when placing it would make the preview disagree with the
 * export.
 *
 * ## Why this can refuse, and why that is the feature
 *
 * The preview is a single-picture-layer engine and the export is not, so a stock
 * clip laid over existing footage would show one thing on screen and render
 * another — blocker #1 in `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2,
 * which `SUC-P1` exists to close. Creating a front layer is right for a file the
 * user dragged in themselves — they chose to stack and can see what they did —
 * and wrong for a one-click **Add** or an agent placement, where nobody asked
 * for an unpreviewable result.
 *
 * Placing into *empty* time is never refused: a clip that overlaps nothing
 * composites identically either way.
 *
 * Returned as ONE list so the bin entry, the layer and the clip land in a single
 * patch and invert together — one undo leaves the project exactly as it was,
 * with no orphan asset or empty layer. The file stays on disk (non-destructive
 * invariant 1) and can be re-placed from the bin.
 *
 * Clip ids are deterministic so an agent-placed clip and a hand-placed one are
 * indistinguishable — including to a later operation that names the clip.
 *
 * @param timeline - Current timeline.
 * @param assets - The project's asset bin, for deriving existing clips' kinds.
 * @param asset - The downloaded stock asset.
 * @param atStart - Desired timeline start (seconds); clamped to >= 0.
 * @returns The placement, or `null` when the span already holds picture media.
 */
/**
 * The operations that put a downloaded stock asset in the BIN and nowhere else.
 *
 * `add_stock` used to be download-AND-place with no other mode, so a run could not gather
 * candidates before assembling a cut: the second download of a comparison always failed,
 * because {@link buildAddStockOps} refuses a span that already holds picture. A captured run
 * said twice that it was "locking the media into the bin first", found no tool that did
 * that, and invented an asset path instead.
 *
 * Deliberately here beside its placing sibling rather than inlined at the call site: both
 * are the shape of a stock arrival, both are shared with the Stock panel, and a bin entry
 * authored somewhere else is how the two paths drift (ADR 0140).
 *
 * @param asset - The downloaded stock asset, provenance included.
 * @returns The single reversible operation that registers it. One undo removes the bin
 *   entry; the file stays on disk (non-destructive invariant 1).
 */
export function buildStockBinOps(asset: Asset): readonly AnyOperation[] {
  return [{ type: 'add_asset', asset }];
}

export function buildAddStockOps(
  timeline: Timeline,
  assets: readonly Asset[],
  asset: Asset,
  atStart: number,
): StockPlacement | null {
  const start = atStart < 0 ? 0 : atStart;
  const durationSeconds = asset.durationSeconds ?? DEFAULT_STOCK_STILL_SECONDS;
  const end = start + durationSeconds;

  if (picturePlacementConflict(timeline, assets, start, end)) return null;

  const kind = stockKind(asset);
  const kindByAssetId = new Map(assets.map((candidate) => [candidate.id, candidate.kind]));
  const target = timeline.tracks.find(
    (track) => dominantClipKind(track, kindByAssetId) === kind && hasRoomFor(track, start, end),
  );

  const addAsset: AnyOperation = { type: 'add_asset', asset };
  if (target) {
    return {
      operations: [
        addAsset,
        {
          type: 'add_clip',
          trackId: target.id,
          assetId: asset.id,
          clipId: `${target.id}_${asset.id}_clip`,
          start,
          end,
          sourceStart: 0,
          sourceEnd: durationSeconds,
        },
      ],
      trackId: target.id,
      createdLayer: false,
      start,
      durationSeconds,
      kind,
    };
  }

  const layerId = nextLayerId(timeline, 'video');
  return {
    operations: [
      addAsset,
      { type: 'add_layer', layerId, layerType: 'video', atIndex: 0 },
      {
        type: 'add_clip',
        trackId: layerId,
        assetId: asset.id,
        clipId: `${layerId}_clip`,
        start,
        end,
        sourceStart: 0,
        sourceEnd: durationSeconds,
      },
    ],
    trackId: layerId,
    createdLayer: true,
    start,
    durationSeconds,
    kind,
  };
}

/**
 * Why {@link buildAddStockOps} would refuse, in a sentence a UI or a tool result
 * can show — or `null` when it would not refuse.
 *
 * Split out so a panel can disable **Add** with a reason *before* the click, and
 * so the agent's host can decline *before* spending a download. Shares the
 * predicate with the builder, so the three answers cannot disagree.
 *
 * @param timeline - Current timeline.
 * @param assets - The project's asset bin.
 * @param atStart - Desired timeline start (seconds); clamped to >= 0.
 * @param durationSeconds - The clip's length, so the probe covers the real span.
 */
export function stockPlacementConflictReason(
  timeline: Timeline,
  assets: readonly Asset[],
  atStart: number,
  durationSeconds: number,
): string | null {
  const start = atStart < 0 ? 0 : atStart;
  const end = start + durationSeconds;
  if (!picturePlacementConflict(timeline, assets, start, end)) return null;
  return (
    `There is already picture on the timeline between ${start.toFixed(1)}s and ` +
    `${end.toFixed(1)}s. Stock cannot sit on top of existing footage yet — ` +
    `pick an empty stretch.`
  );
}
