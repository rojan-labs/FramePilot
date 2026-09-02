/**
 * Where an agent placement of picture media actually goes.
 *
 * ## Why this exists
 *
 * The preview paints ONE picture layer at a time. The DOM monitor shows the
 * front-most picture clip at the playhead; the canvas compositor consumes
 * `apps/web-editor/src/editor/selectors-base.ts#pictureSegments`, which resolves
 * a stack the same way. The export does not: `render/compiler.py` composites
 * every track's picture, bottom-up, with alpha and blend modes.
 *
 * Those two agree exactly when the layer in front **covers the whole frame
 * opaquely** — then "show the front clip" and "composite the layers" produce the
 * same pixels. They disagree the moment the front layer is scaled, positioned,
 * cropped, masked, faded or blended, because the export folds in what is
 * underneath and the preview cannot.
 *
 * ## What this module does about it
 *
 * ADR 0140 refused every stacked picture placement, which was the safe answer
 * before anything knew which layer was in front. ADR 0169 narrows it to the case
 * that genuinely diverges:
 *
 * - a **full-frame opaque** placement over existing picture is legal, and lands
 *   on a layer in FRONT of everything it covers — an existing one when there is
 *   a usable one, otherwise a new layer opened at the visual front in the same
 *   patch, so it applies atomically and one undo removes both;
 * - anything else — scaled, positioned, cropped, masked, faded, blended — is
 *   still refused, with the reason and the two legal moves.
 *
 * {@link coverageVerdict} is the predicate, and it lives in `editor-core`
 * because the canvas preview's eligibility test asks the identical question.
 * Two copies would drift, and the way they would drift is that this one starts
 * allowing an overlay the preview cannot show.
 *
 * ADR 0170 made it a RELATION rather than a property of the front clip: the
 * renderer fits rather than covers, so whether a letterboxed layer diverges
 * depends on the shape of what is UNDERNEATH it. A crop is part of that
 * geometry, which is why a cover-cropped placement is now legal.
 *
 * Manual UI editing is deliberately out of scope: a person dragging a clip onto
 * a second layer can see both, chose it, and owns the result.
 *
 * ## Why it is not `editor-core`'s `picturePlacementConflict`
 *
 * That predicate measures occupancy over the whole timeline, including the
 * target track, because the Stock panel and `add_stock` pick the track
 * themselves and cannot be handed a new one. Here the track is named by the
 * caller and CAN be replaced, and same-track overlap is already the validator's
 * job — it rejects it with a better message than this could.
 */
import type { Asset, Clip, Project, Track } from '@framepilot/timeline-schema';
import type { Operation } from '@framepilot/editor-core';
import {
  coverageVerdict,
  trackHasRoomFor,
  type CoverageVerdict,
  type FullFrameOpaqueFields,
  type ShapedClip,
  type SourceShape,
} from '@framepilot/editor-core';
import { clipKindOf } from '../project-index.js';
import { ToolRefusalError } from '../tool-refusal.js';

/** Clip kinds that flow through the preview's single picture chain. */
const PICTURE_KINDS: ReadonlySet<string> = new Set(['video', 'image']);

/** A placement to test: where it would land, and for how long. */
export interface PictureCandidate {
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
  readonly assetId: string;
  /**
   * A clip already on the timeline that this candidate IS (a `move_clip`), so it
   * cannot conflict with itself sitting at its old position.
   */
  readonly ignoreClipId?: string;
  /**
   * The compositing the placed clip will carry, when it is not a plain placement.
   *
   * `add_clip`/`add_clips` write a bare clip, but they compute their auto-reframe
   * crop BEFORE asking, and pass it: under ADR 0170 a crop is geometry, and the
   * cover crop is precisely what makes a landscape source legal over picture in a
   * portrait project. Asking first and cropping afterwards refused the placement
   * the reframe exists to make work. `move_clip` moves a clip that already exists
   * and may carry any compositing, so it passes the real one.
   */
  readonly compositing?: FullFrameOpaqueFields;
}

/** One existing picture clip the candidate would sit on top of. */
export interface PictureConflict {
  readonly clipId: string;
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
  /** The conflicting track's z-order slot — 0 is the visual front. */
  readonly depth: number;
  /**
   * The covered clip and its measured source shape, ready for
   * {@link coverageVerdict}. Coverage is a relation (ADR 0170): deciding it needs
   * the shape of what is under the candidate, not only the candidate's own
   * compositing, so the conflict list carries it rather than making the caller
   * re-derive it from the project.
   */
  readonly shaped: ShapedClip;
}

/**
 * An asset's measured source shape, or `undefined` when nothing probed it.
 *
 * Both dimensions or neither: half a shape is not a shape, and `Asset.media.width/height`
 * are "honestly absent rather than guessed at" since schema v21.
 */
export function sourceShapeOf(project: Project, assetId: string): SourceShape | undefined {
  const media = (project.assets ?? []).find((asset) => asset.id === assetId)?.media;
  const width = media?.width;
  const height = media?.height;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/** Only `video` layers carry the picture chain; overlay/caption/audio composite separately. */
function carriesPicture(track: Track): boolean {
  return track.type === undefined || track.type === 'video';
}

/**
 * Every picture clip on a track OTHER than the candidate's that overlaps it in
 * time, in timeline order.
 *
 * Touching edges do not count: butting a cutaway against the clip before it is
 * exactly what an editor does.
 *
 * A non-picture candidate — a text overlay (`__text__`), a caption
 * (`__caption__`), an audio bed — conflicts with nothing here by construction,
 * because those composite outside the picture chain and stacking them is the
 * whole reason layers exist.
 *
 * @param project - The project as the tool currently holds it.
 * @param candidate - The placement under test.
 * @returns The overlapping picture clips, or an empty array when there are none.
 */
export function pictureOverlapAcross(
  project: Project,
  candidate: PictureCandidate,
): readonly PictureConflict[] {
  if (!(candidate.end > candidate.start)) return [];
  const assetById = new Map<string, Asset>(
    (project.assets ?? []).map((asset) => [asset.id, asset]),
  );
  // The candidate's own kind, derived exactly as a placed clip's would be — a
  // clip's kind comes from its content, never from the layer it lands on.
  const candidateKind = clipKindOf({ assetId: candidate.assetId } as Clip, assetById);
  if (!PICTURE_KINDS.has(candidateKind)) return [];

  const conflicts: PictureConflict[] = [];
  project.timeline.tracks.forEach((track, depth) => {
    if (track.id === candidate.trackId) return;
    if (!carriesPicture(track)) return;
    for (const clip of track.clips) {
      if (clip.id === candidate.ignoreClipId) continue;
      if (!PICTURE_KINDS.has(clipKindOf(clip, assetById))) continue;
      if (clip.end <= candidate.start || clip.start >= candidate.end) continue;
      conflicts.push({
        clipId: clip.id,
        trackId: track.id,
        start: clip.start,
        end: clip.end,
        depth,
        shaped: { clip, source: sourceShapeOf(project, clip.assetId) },
      });
    }
  });
  return conflicts.sort((a, b) => a.start - b.start);
}

/** A time in the refusal sentence: whole seconds stay whole, the rest keep 2dp. */
function timeText(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(2).replace(/0+$/, '');
}

/** The asset's file name, or its id when there is no asset to name. */
function assetLabel(project: Project, assetId: string): string {
  const asset = (project.assets ?? []).find((a) => a.id === assetId);
  if (!asset) return assetId;
  return asset.path.split('/').pop() ?? asset.path;
}

/**
 * The refusal, worded once.
 *
 * It names the offending clip and track, says which property of the placement makes it
 * un-showable, and gives the ways out. Deliberately NOT "try a different track" — every
 * track has the same answer, and a run told otherwise walks the placement across layers one
 * at a time.
 *
 * The reason comes from {@link CoverageVerdict} rather than being re-derived here. A second
 * copy of "which test failed first" would drift from the one that actually decides, and the
 * way it would drift is that the refusal starts naming a property the placement does not
 * have.
 *
 * @param project - The project, for the asset's name and measured shape.
 * @param candidate - The refused placement.
 * @param conflicts - What it would have covered, from {@link pictureOverlapAcross}.
 * @param verdict - Why the monitor and the export would disagree.
 */
export function pictureOverlapRefusal(
  project: Project,
  candidate: PictureCandidate,
  conflicts: readonly PictureConflict[],
  verdict: CoverageVerdict,
): string {
  const first = conflicts[0];
  /* v8 ignore next 2 -- callers only build a refusal from a non-empty conflict list and a
     failed verdict */
  if (!first || verdict.hides) return '';
  const others = conflicts.length > 1 ? ` (and ${String(conflicts.length - 1)} more)` : '';
  const file = assetLabel(project, candidate.assetId);
  const head =
    `Refused: "${file}" at ${timeText(candidate.start)}–${timeText(candidate.end)}s ` +
    `would sit on top of ${first.clipId} on ${first.trackId}${others}, and `;
  const divergence =
    'The preview shows one picture layer at a time, so only a layer that hides everything ' +
    'it covers previews the way it exports (ADR 0169 / 0170, SUC-P1). ';
  // The alternative that is legal WHATEVER the shapes are: a cutaway on the same track is
  // one picture layer, so there is nothing for the export to fold in.
  const hole =
    `cut a hole for it: split at ${timeText(candidate.start)}s and ` +
    `${timeText(candidate.end)}s and add it on the same track as a cutaway.`;

  if (verdict.reason === 'leaks') {
    const shape = sourceShapeOf(project, candidate.assetId);
    const size = shape ? `${String(shape.width)}x${String(shape.height)}` : 'letterboxed';
    // The crop first, because it is the move that keeps the layered edit the run asked for;
    // the hole is the fallback that changes the edit.
    // `null` rather than a rect when the SOURCE already matches the frame: the leak is then
    // the crop the clip is carrying, and the move is to put the whole frame back.
    const rect =
      verdict.coverCrop ?? (candidate.compositing?.crop !== undefined ? null : undefined);
    const cropWay =
      rect !== undefined
        ? (candidate.ignoreClipId !== undefined
            ? `set_clip_crop on ${candidate.ignoreClipId} with crop `
            : 'add it, then set_clip_crop with crop ') +
          `${JSON.stringify(rect)} so it fills the frame; then it goes on its own front ` +
          'layer. Or '
        : '';
    return (
      `${head}"${file}" is ${size} and ${verdict.detail ?? 'it does not cover them'}. ` +
      `${divergence}${cropWay}${cropWay === '' ? hole.charAt(0).toUpperCase() + hole.slice(1) : hole}`
    );
  }

  if (verdict.reason === 'unmeasured') {
    const covered = verdict.detail ?? first.clipId;
    // Never a crop: cropping to a shape nobody measured is a guess, and a wrong guess here
    // throws away picture in the wrong axis.
    const unknown =
      sourceShapeOf(project, candidate.assetId) === undefined
        ? `"${file}" has not been measured, so nothing can tell whether its bars line up ` +
          `with ${covered}'s`
        : `${covered} has not been measured, so nothing can tell whether its bars line up ` +
          `with "${file}"'s`;
    return (
      `${head}${unknown}. ${divergence}Either ${hole} It previews and exports identically ` +
      'whatever its shape. Or place it again once the engine has measured it — `list_assets` ' +
      'shows an asset\'s orientation and aspect instead of `shape: "unmeasured"` once it has.'
    );
  }

  const opacity =
    verdict.reason === 'blend'
      ? `it blends with what is under it (blendMode "${verdict.detail ?? ''}")`
      : verdict.reason === 'keyframes'
        ? 'it carries transform keyframes (a scaled, moved or faded layer)'
        : 'it carries a mask or a transition, so part of the frame shows through it';
  return (
    `${head}${opacity}. ${divergence}Either place it full-frame — a plain placement with no ` +
    'transform, blend mode or mask is put on its own front layer for you — or ' +
    `${hole}`
  );
}

/** A resolved picture placement: the lane it lands on, and what must exist first. */
export interface PicturePlacement {
  /** The lane the clip should be placed on. */
  readonly trackId: string;
  /**
   * Ops that must precede the placement. Empty when an existing lane was used; a
   * single `add_layer` when a front layer had to be opened. They ride the SAME
   * patch as the placement, so it applies atomically and one undo removes both.
   */
  readonly setupOps: readonly Operation[];
}

/**
 * A non-colliding, self-describing id for an auto-opened cutaway layer.
 *
 * Self-describing because the id is the only naming surface there is: `add_layer`
 * carries no `name`, and both the timeline UI and the agent's own `projectNames`
 * label a lane from its kind and position ("Video 1"). An editor scanning
 * `get_timeline` can at least see which lane the agent opened and why.
 *
 * Deterministic so the same placement produces the same patch twice — the
 * property the patch/undo contract and the golden tests both rely on.
 */
function nextCutawayLayerId(project: Project, opened: readonly string[]): string {
  const taken = new Set<string>([...project.timeline.tracks.map((t) => t.id), ...opened]);
  let n = 1;
  while (taken.has(`video_cutaway_${String(n)}`)) n += 1;
  return `video_cutaway_${String(n)}`;
}

/**
 * Resolves picture placements for one tool call, remembering what it has already
 * promised.
 *
 * Stateful by design and scoped to one call, exactly like `editor-core`'s
 * {@link createLaneAllocator}: `add_clips` builds every operation against the
 * timeline as it was before the call, so two entries that both need a front layer
 * would each open one and the patch would carry two `add_layer` ops with the same
 * id. The placer books each span as it hands it out, so a batch lays down exactly
 * like a sequence of single calls. Across CALLS the orchestrator threads the
 * turn's speculative working copy (`executeToolCalls`), so the second call sees
 * the layer the first opened.
 *
 * @param project - The project the placements are being planned against.
 */
export function createPicturePlacer(project: Project): {
  place: (candidate: PictureCandidate) => PicturePlacement;
} {
  /** Spans booked during this call, per lane id, on top of what the timeline holds. */
  const booked = new Map<string, { start: number; end: number }[]>();
  /** Front layers opened during this call, newest first (each went in at index 0). */
  const opened: string[] = [];

  const bookedHasRoom = (trackId: string, start: number, end: number): boolean =>
    !(booked.get(trackId) ?? []).some((span) => span.start < end && span.end > start);

  const book = (trackId: string, start: number, end: number): void => {
    const spans = booked.get(trackId);
    if (spans) spans.push({ start, end });
    else booked.set(trackId, [{ start, end }]);
  };

  /** Can a clip spanning `[start, end)` land on this existing lane and be seen? */
  const usableLane = (track: Track, start: number, end: number, frontOf: number): boolean => {
    const depth = project.timeline.tracks.indexOf(track);
    if (depth >= frontOf) return false; // behind the picture it must cover: invisible
    if (!carriesPicture(track)) return false;
    // A hidden lane renders nothing and a locked one refuses the edit; landing on
    // either would report success and produce no picture (the same bargain
    // `createLaneAllocator` refuses).
    if (track.hidden === true || track.locked === true) return false;
    return trackHasRoomFor(track, start, end) && bookedHasRoom(track.id, start, end);
  };

  return {
    place(candidate) {
      const conflicts = pictureOverlapAcross(project, candidate);
      if (conflicts.length === 0) {
        book(candidate.trackId, candidate.start, candidate.end);
        return { trackId: candidate.trackId, setupOps: [] };
      }
      // Coverage is a relation (ADR 0170): the front clip's compositing AND its fitted
      // rect against every rect it covers, in this project's frame.
      const compositing = candidate.compositing ?? {};
      const front: ShapedClip = {
        clip: { ...compositing, assetId: candidate.assetId },
        source: sourceShapeOf(project, candidate.assetId),
      };
      const verdict = coverageVerdict(
        front,
        conflicts.map((conflict) => conflict.shaped),
        project.resolution,
      );
      if (!verdict.hides) {
        throw new ToolRefusalError(pictureOverlapRefusal(project, candidate, conflicts, verdict), {
          refusalCause: 'picture_over_picture',
        });
      }
      // Everything it covers must end up BEHIND it, so the lane has to sit in
      // front of the front-most thing it covers.
      const frontOf = conflicts.reduce((min, c) => Math.min(min, c.depth), Infinity);

      // The lane the caller named wins whenever it can be seen — the agent chose
      // it, and relocating a placement it did not ask to relocate is its own kind
      // of wrong.
      const named = project.timeline.tracks.find((track) => track.id === candidate.trackId);
      if (named && usableLane(named, candidate.start, candidate.end, frontOf)) {
        book(named.id, candidate.start, candidate.end);
        return { trackId: named.id, setupOps: [] };
      }
      // Then any lane already in front with room — front-most first, since
      // `tracks` is ordered front to back. This is what stops a montage opening a
      // fresh layer per clip: the second entry reuses the first entry's lane.
      const reusableOpen = opened.find((id) => bookedHasRoom(id, candidate.start, candidate.end));
      if (reusableOpen !== undefined) {
        book(reusableOpen, candidate.start, candidate.end);
        return { trackId: reusableOpen, setupOps: [] };
      }
      const existing = project.timeline.tracks.find((track) =>
        usableLane(track, candidate.start, candidate.end, frontOf),
      );
      if (existing) {
        book(existing.id, candidate.start, candidate.end);
        return { trackId: existing.id, setupOps: [] };
      }
      // Nothing usable: open a video layer at the visual front (index 0). `video`
      // rather than `overlay` deliberately — a clip's kind comes from its asset,
      // so an `overlay` lane holding picture would still composite as picture at
      // export while this module's own occupancy scan stopped counting it, and the
      // next placement would be told the time was free.
      const layerId = nextCutawayLayerId(project, opened);
      opened.unshift(layerId);
      book(layerId, candidate.start, candidate.end);
      return {
        trackId: layerId,
        setupOps: [{ type: 'add_layer', layerId, layerType: 'video', atIndex: 0 }],
      };
    },
  };
}

/**
 * Float slack for comparing frame-quantized times. Cut points land on the grid, so any
 * real gap is at least one frame wide and nothing this small is ever an editorial gap.
 */
const COVERAGE_EPSILON = 1e-6;

/**
 * The video tracks that picture IN FRONT of them already covers end to end — so
 * anything placed there would be composited behind it and never seen.
 *
 * ## Why the state summary needs this
 *
 * `arrangementLine` renders `b_roll [video] empty; v_main [video] 1 clips 0–49.77s` every
 * turn. In run `369e8c82` that was a standing invitation: an empty video track reads as a
 * free layer, and the run took it four times. Under ADR 0140 each attempt met a refusal;
 * under ADR 0169 the placement succeeds but is *lifted* to a new front layer, which is a
 * better outcome and still not what the line described. Either way the summary is what the
 * model plans from, and a lane that cannot show picture must not read as one that can.
 *
 * Z-ORDER, not merely time, is what changed with ADR 0169. Picture BEHIND a track does not
 * hide it; only picture in front does. So the sweep looks at the tracks nearer the viewer
 * (a lower index — see `editor-core/operations.ts#AddLayerOp`), which is exactly the
 * question {@link createPicturePlacer} asks when it decides a lane is unusable.
 *
 * Bounded like the line it feeds: one asset map, one pass over the clips to collect the
 * picture spans, then one sweep per video track. A project has few tracks.
 *
 * @param project - The project as the run currently holds it.
 * @returns The ids of the video tracks nothing placed on could be seen on. Empty when the
 *   sequence is empty, since an empty timeline hides nothing.
 */
export function tracksCoveredByPictureInFront(project: Project): ReadonlySet<string> {
  const assetById = new Map<string, Asset>(
    (project.assets ?? []).map((asset) => [asset.id, asset]),
  );
  const spansByDepth: { depth: number; spans: { start: number; end: number }[] }[] = [];
  let sequenceEnd = 0;
  project.timeline.tracks.forEach((track, depth) => {
    for (const clip of track.clips) sequenceEnd = Math.max(sequenceEnd, clip.end);
    if (!carriesPicture(track)) return;
    spansByDepth.push({
      depth,
      spans: track.clips
        .filter((clip) => PICTURE_KINDS.has(clipKindOf(clip, assetById)))
        .map((clip) => ({ start: clip.start, end: clip.end })),
    });
  });
  if (sequenceEnd <= 0) return new Set();
  const blocked = new Set<string>();
  for (const { depth } of spansByDepth) {
    // The picture on the tracks IN FRONT, swept in time order: `covered` walks forward
    // only while the spans keep touching, so the first real gap ends the sweep and the
    // track still has somewhere its picture would show.
    const inFront = spansByDepth
      .filter((entry) => entry.depth < depth)
      .flatMap((entry) => entry.spans)
      .sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const span of inFront) {
      if (span.start > covered + COVERAGE_EPSILON) break;
      covered = Math.max(covered, span.end);
    }
    if (covered + COVERAGE_EPSILON >= sequenceEnd) {
      const track = project.timeline.tracks[depth];
      /* v8 ignore next -- depth came from the same array */
      if (track) blocked.add(track.id);
    }
  }
  return blocked;
}
