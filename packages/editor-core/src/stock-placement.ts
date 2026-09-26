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
import type { Asset, Clip, Timeline, Track } from '@framepilot/timeline-schema';
import type { AnyOperation } from './patch.js';
import { clipRenderKind, type ClipRenderKind } from './synthetic-assets.js';
import {
  firstFreePictureStart,
  lastPictureEnd,
  picturePlacementConflict,
} from './picture-occupancy.js';
import { nextLayerId as nextLaneId, trackHasRoomFor } from './lane-placement.js';
import { addClipId } from './operations.js';

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
type ClipKind = ClipRenderKind;

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
  return clipRenderKind(assetId, kindByAssetId.get(assetId));
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
      // In front of the footage, under every graphics lane (ADR 0191): at index 0 a photo placed
      // into empty time covered the stickers, shapes and titles above it.
      { type: 'add_layer', layerId, layerType: 'video', atIndex: frontPictureLaneIndex(timeline) },
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
 * The sentence NAMES A FREE MOMENT rather than stopping at "pick an empty
 * stretch". A person can scrub the timeline and find one; the agent cannot see
 * it, and a captured run re-proposed the same occupied moment four times because
 * the refusal said what was wrong and never what to do instead. The suggestion
 * comes from the same spans the refusal was computed over, so it can never name
 * a moment this function would then reject.
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
  const free = firstFreePictureStart(timeline, assets, durationSeconds, start);
  const occupied = `There is already picture on the timeline between ${start.toFixed(1)}s and ${end.toFixed(1)}s. Stock cannot sit on top of existing footage yet`;
  // A GAP, or the empty time after the programme? `firstFreePictureStart` always answers,
  // because the timeline has no end — so on one continuous take, the commonest project
  // there is, the only answer it can give is "after the last frame". Leading with that
  // number told run 19e20922 to append cutaways at 49.8s, 57.3s and 103.3s to a 49.77s
  // programme, which it then spent 6 move_clip, 4 trim_clip and a delete_clip undoing.
  // The editor had asked for cutaways DURING the talk, and the route that makes one —
  // bin, then add_clip on a layer in front (ADR 0169) — was the back half of the sentence.
  if (free >= lastPictureEnd(timeline, assets)) {
    return (
      `${occupied}, and this edit is covered end to end — the next free stretch starts at ` +
      `${free.toFixed(1)}s, which is past the last frame, so placing there would lengthen ` +
      'the programme rather than cut away inside it. Omit atSeconds to put this clip in ' +
      'the media bin, then place it with add_clip at the moment you want it: add_clip can ' +
      'lift a cutaway onto a layer in front of the footage it covers. Only pass ' +
      `atSeconds ${free.toFixed(1)} if you did mean to add to the end.`
    );
  }
  // An interior gap: "call again with atSeconds N" is a real cutaway slot, so it leads.
  //
  // The free second is given so the caller can act on it, and the sentence says WHICH
  // call to put it in. Every caller today is an agent path — the orchestrator's
  // post-download refusal and the desktop host's pre-download one — and the property both
  // are gated on (`ai-sdk/src/reliability/next-action.ts`) counts a move the reader has to
  // infer as a dead end. Naming only the number was that inference.
  return (
    `${occupied} — the first stretch long enough for this clip starts at ` +
    `${free.toFixed(1)}s. ` +
    `Call add_stock again with atSeconds ${free.toFixed(1)}, or omit atSeconds to put it ` +
    'in the media bin and place it later with add_clip.'
  );
}

// ---------------------------------------------------------------------------
// Manual placements from the Photos and Videos panel (plan/elements EL9, ADR 0193)
// ---------------------------------------------------------------------------

/**
 * **Add as overlay** places a picture at this share of its contain-fit size (MD-E5).
 *
 * Small enough that the footage it sits over stays the subject, big enough to read at a glance
 * on a phone. It is a starting size, not a rule: the on-canvas handles resize it like any clip.
 */
export const STOCK_OVERLAY_SCALE = 0.4;

/** Keyframes at the clip's first frame count as its base transform (the handles write time 0). */
const BASE_KEYFRAME_TIME = 1e-3;

/** The one track type that carries the picture chain; graphics, captions and sound do not. */
const PICTURE_LANE: Track['type'] = 'video';

/**
 * Where a new picture lane opens: just in front of the front-most picture lane, so it covers the
 * footage and stays under every graphics lane (stickers, shapes, titles — ADR 0191). With no
 * picture lane yet, it opens under the graphics and above the sound.
 *
 * @param timeline - The timeline the lane will be added to.
 * @returns The `add_layer` index (0 is the visual front).
 */
export function frontPictureLaneIndex(timeline: Timeline): number {
  const frontPicture = timeline.tracks.findIndex((track) => track.type === PICTURE_LANE);
  if (frontPicture >= 0) return frontPicture;
  const firstSound = timeline.tracks.findIndex((track) => track.type === 'audio');
  return firstSound >= 0 ? firstSound : timeline.tracks.length;
}

/** What a manual Photos/Videos placement decided, for the caller that selects and describes it. */
export interface StockLanePlacement {
  /** The operations, in the order they must apply: one patch, one undo. */
  readonly operations: readonly AnyOperation[];
  /** The lane the clip lands on — existing, or one the operations open. */
  readonly trackId: string;
  /** The id the new clip will have, so the caller can select it. */
  readonly clipId: string;
  /** TRUE when the placement opens that lane. */
  readonly createdLayer: boolean;
  /** The clamped start, in timeline seconds. */
  readonly start: number;
  /** The clip's length, in timeline seconds. */
  readonly durationSeconds: number;
  /** The asset's renderable kind, for describing what was placed. */
  readonly kind: StockKind;
}

/** A drop's placement, which also says whether it honoured the lane under the cursor. */
export interface StockDropPlacement extends StockLanePlacement {
  /** TRUE when the clip landed on the lane it was dropped on. */
  readonly onDroppedLane: boolean;
}

/** The span a stock asset occupies from `atStart`: clamped, with a still's default length. */
function stockSpan(
  asset: Asset,
  atStart: number,
): { readonly start: number; readonly end: number; readonly durationSeconds: number } {
  const start = atStart < 0 ? 0 : atStart;
  const durationSeconds = asset.durationSeconds ?? DEFAULT_STOCK_STILL_SECONDS;
  return { start, end: start + durationSeconds, durationSeconds };
}

/** A lane a manual placement may write to: a picture lane the user has not locked or hidden. */
function isOpenPictureLane(track: Track): boolean {
  return track.type === PICTURE_LANE && track.locked !== true && track.hidden !== true;
}

/** TRUE when the clip's base transform draws it smaller than its contain-fit size. */
function isScaledDown(clip: Clip): boolean {
  return (clip.keyframes ?? []).some(
    (keyframe) =>
      keyframe.property === 'scale' && keyframe.time <= BASE_KEYFRAME_TIME && keyframe.value < 1,
  );
}

/**
 * The front-most picture lane, when it holds only pictures-in-picture (or nothing) and has room
 * over the span — so a second overlay joins the first instead of opening a lane per clip, and an
 * overlay never lands on the footage it is meant to sit over.
 */
function pictureInPictureLane(timeline: Timeline, start: number, end: number): Track | undefined {
  const front = timeline.tracks.find((track) => track.type === PICTURE_LANE);
  if (front === undefined || !isOpenPictureLane(front)) return undefined;
  if (!front.clips.every(isScaledDown)) return undefined;
  return trackHasRoomFor(front, start, end) ? front : undefined;
}

/**
 * The asset (unless the bin has it), the lane (when one opens), the clip, then `extra` — one
 * patch, so a single undo takes back all of it and leaves no orphan asset or empty lane.
 */
function stockLaneOperations(
  timeline: Timeline,
  assets: readonly Asset[],
  asset: Asset,
  span: { readonly start: number; readonly end: number; readonly durationSeconds: number },
  lane: Track | undefined,
  extra: (clipId: string) => readonly AnyOperation[],
): StockLanePlacement {
  const trackId = lane?.id ?? nextLaneId(timeline, PICTURE_LANE);
  const clipId = addClipId(trackId, asset.id, span.start);
  const inBin = assets.some((candidate) => candidate.id === asset.id);
  return {
    operations: [
      ...(inBin ? [] : [{ type: 'add_asset', asset } as const]),
      ...(lane === undefined
        ? [
            {
              type: 'add_layer',
              layerId: trackId,
              layerType: PICTURE_LANE,
              atIndex: frontPictureLaneIndex(timeline),
            } as const,
          ]
        : []),
      {
        type: 'add_clip',
        trackId,
        assetId: asset.id,
        clipId,
        start: span.start,
        end: span.end,
        sourceStart: 0,
        sourceEnd: span.durationSeconds,
      },
      ...extra(clipId),
    ],
    trackId,
    clipId,
    createdLayer: lane === undefined,
    start: span.start,
    durationSeconds: span.durationSeconds,
    kind: stockKind(asset),
  };
}

/**
 * The operations for **Add as overlay**: a downloaded photo or video as a picture-in-picture at
 * `atStart`, centred at {@link STOCK_OVERLAY_SCALE} of its contain-fit size, in front of the
 * front-most picture lane and under every graphics lane.
 *
 * ## Why this never refuses, when {@link buildAddStockOps} does
 *
 * **Add** is a cutaway, and ADR 0140 keeps it out of occupied picture. An overlay exists to sit
 * over footage — refusing it for covering picture would refuse the whole feature. The refusal was
 * about a monitor that could not composite layers; the monitor composites every layer now (ADR
 * 0180), and this is an ordinary picture clip with a base transform, so preview and export draw
 * it the same way (ADR 0193).
 *
 * The size is the base `scale` keyframe at time 0, the same keyframes the on-canvas handles
 * write, so a placed overlay and a hand-sized one are the same data. Manual only: the agent's
 * `add_stock` keeps its cutaway rule until picture-in-picture from the agent is measured.
 *
 * @param timeline - Current timeline.
 * @param assets - The project's asset bin (an asset already in it is not added twice).
 * @param asset - The downloaded stock asset.
 * @param atStart - Desired timeline start (seconds); clamped to >= 0.
 * @returns The placement — always one; nothing about the timeline can refuse it.
 */
export function buildAddStockOverlayOps(
  timeline: Timeline,
  assets: readonly Asset[],
  asset: Asset,
  atStart: number,
): StockLanePlacement {
  const span = stockSpan(asset, atStart);
  const base = { scale: STOCK_OVERLAY_SCALE, x: 0, y: 0 } as const;
  return stockLaneOperations(
    timeline,
    assets,
    asset,
    span,
    pictureInPictureLane(timeline, span.start, span.end),
    (clipId) => [
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
  );
}

/**
 * The operations for a photo or video tile dragged onto the timeline: full frame, at the drop
 * time, on the lane it was dropped on when that is an open picture lane with room — else on a new
 * lane in front of the front-most picture lane.
 *
 * A drag is an explicit stack: the user chose the moment and the lane and can see the result,
 * which is why ADR 0140 itself calls the front-lane placement right for a file dragged in by hand.
 * So this never refuses for covering picture either.
 *
 * @param timeline - Current timeline (the caller passes the live one once the download is in).
 * @param assets - The project's asset bin.
 * @param asset - The downloaded stock asset.
 * @param atStart - The drop time (seconds); clamped to >= 0.
 * @param droppedTrackId - The lane under the cursor, if the drop was on one.
 */
export function buildDropStockOps(
  timeline: Timeline,
  assets: readonly Asset[],
  asset: Asset,
  atStart: number,
  droppedTrackId?: string,
): StockDropPlacement {
  const span = stockSpan(asset, atStart);
  const dropped = timeline.tracks.find(
    (track) =>
      track.id === droppedTrackId &&
      track.type === PICTURE_LANE &&
      track.locked !== true &&
      trackHasRoomFor(track, span.start, span.end),
  );
  const placement = stockLaneOperations(timeline, assets, asset, span, dropped, () => []);
  return { ...placement, onDroppedLane: dropped !== undefined };
}
