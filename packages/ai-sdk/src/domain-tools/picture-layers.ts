/**
 * Would this agent placement put picture on top of picture?
 *
 * ## Why this exists
 *
 * The preview flattens picture clips from **every** track into one time-ordered
 * chain (`apps/web-editor/src/editor/selectors.ts`, `PictureSegment[]` — the
 * later clip simply overwrites the time), while the export composites the layers
 * properly (`render/compiler.py#_blend_layer_over`). Two picture clips
 * overlapping in time on two tracks therefore preview one way and render
 * another. That divergence is blocker #1 in
 * `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2, and `SUC-P1` exists to
 * close it. It has not started.
 *
 * ADR 0140 decided the answer for stock media: refuse the placement, say why,
 * and name the alternative. This is that same rule for every AGENT picture
 * placement — `add_clip`, `add_clips`, `move_clip` — because the agent is the
 * other path that places picture *for* the user rather than *by* the user, and
 * an edit the user approves in the preview must be the edit that exports.
 *
 * Manual UI editing is deliberately out of scope: a person dragging a clip onto
 * a second layer can see both, chose it, and owns the result.
 *
 * ## Why it is not `editor-core`'s `picturePlacementConflict`
 *
 * That predicate measures occupancy over the whole timeline, including the
 * target track, because the Stock panel picks the track itself. Here the track
 * is named by the caller, and same-track overlap is already the validator's job
 * — it rejects it with a better message than this could. What is left, and what
 * only this can catch, is the overlap ACROSS tracks that the validator allows
 * and the preview cannot show.
 */
import type { Asset, Clip, Project, Track } from '@framepilot/timeline-schema';
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
}

/** One existing picture clip the candidate would sit on top of. */
export interface PictureConflict {
  readonly clipId: string;
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
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
  for (const track of project.timeline.tracks) {
    if (track.id === candidate.trackId) continue;
    if (!carriesPicture(track)) continue;
    for (const clip of track.clips) {
      if (clip.id === candidate.ignoreClipId) continue;
      if (!PICTURE_KINDS.has(clipKindOf(clip, assetById))) continue;
      if (clip.end <= candidate.start || clip.start >= candidate.end) continue;
      conflicts.push({
        clipId: clip.id,
        trackId: track.id,
        start: clip.start,
        end: clip.end,
      });
    }
  }
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
 * It names the offending clip and track (so the model can act rather than
 * re-guess), states the preview/export divergence as the reason, and gives the
 * two legal moves: the cutaway, or a free span. Deliberately NOT "try a
 * different track" — every track has the same answer, and a run told otherwise
 * walks the placement across layers one at a time.
 *
 * @param project - The project, for the asset's name.
 * @param candidate - The refused placement.
 * @param conflicts - What it would have covered, from {@link pictureOverlapAcross}.
 */
export function pictureOverlapRefusal(
  project: Project,
  candidate: PictureCandidate,
  conflicts: readonly PictureConflict[],
): string {
  const first = conflicts[0];
  /* v8 ignore next -- callers only build a refusal from a non-empty conflict list */
  if (!first) return '';
  const others = conflicts.length > 1 ? ` (and ${String(conflicts.length - 1)} more)` : '';
  return (
    `Refused: "${assetLabel(project, candidate.assetId)}" at ` +
    `${timeText(candidate.start)}–${timeText(candidate.end)}s would sit on top of ` +
    `${first.clipId} on ${first.trackId}${others}. The preview shows only one picture ` +
    'layer, so what you would see is not what exports (ADR 0140 / SUC-P1). Place it as a ' +
    `cutaway instead — split at ${timeText(candidate.start)}s and ${timeText(candidate.end)}s ` +
    'and add it on the same track — or choose a free span.'
  );
}

/**
 * Throw the refusal when `candidate` would stack picture over picture.
 *
 * A throw, not a return, because that is the tool boundary's own idiom: the
 * orchestrator catches it out of `buildOps`, settles the call as `failed` with
 * the sentence as its `data`, and marks it `deterministicFailure`. No patch is
 * assembled and nothing else in the turn is lost.
 *
 * The refusal carries `picture_over_picture` as its `RefusalCause` (`tool-refusal.ts`), and that,
 * not the sentence, is what run memory keys on (`deterministicFailureKey`). This
 * comment used to claim the guard already stopped the model retrying; run `369e8c82`
 * proved otherwise. The sentence names the asset, both times and the conflicting clip,
 * so a model that nudged 4.48–6s to 4.2–6s — believing it was trying something new —
 * produced a second key and was refused from scratch, four times over fifteen minutes.
 * The cause is the same for all four, so the second one is answered "you already tried
 * this" instead. A CORRECTED placement is untouched: the key is computed after the call
 * settles, so a placement into a free span never refuses and so never has a key to
 * match.
 *
 * A {@link ToolRefusalError} specifically, so the note reads `Refused "add_clip":
 * <sentence>` and not `Invalid arguments for "add_clip"` — the arguments were
 * read and understood, and telling the model otherwise sends it to nudge a
 * `start` that was already right instead of placing the cutaway.
 */
export function assertNoPictureStacking(project: Project, candidate: PictureCandidate): void {
  const conflicts = pictureOverlapAcross(project, candidate);
  if (conflicts.length === 0) return;
  throw new ToolRefusalError(pictureOverlapRefusal(project, candidate, conflicts), {
    refusalCause: 'picture_over_picture',
  });
}

/**
 * Float slack for comparing frame-quantized times. Cut points land on the grid, so any
 * real gap is at least one frame wide and nothing this small is ever an editorial gap.
 */
const COVERAGE_EPSILON = 1e-6;

/**
 * The video tracks with nowhere left to put a picture clip — because picture on the
 * OTHER video tracks already covers every instant of the sequence.
 *
 * ## Why the state summary needs this
 *
 * `arrangementLine` renders `b_roll [video] empty; v_main [video] 1 clips 0–49.77s` every
 * turn. In run `369e8c82` that was a standing invitation: an empty video track reads as a
 * free layer, and the run took it four times, each time meeting
 * {@link assertNoPictureStacking}. The refusal is a good sentence, but it arrives after
 * the call; the summary is what the model plans from, and it was saying the opposite.
 *
 * Exactly the rule {@link pictureOverlapAcross} enforces, asked track-wide instead of
 * placement-wide, so the two can never disagree about what is legal.
 *
 * Bounded like the line it feeds: one asset map, one pass over the clips to collect the
 * picture spans, then one sweep per video track. A project has few tracks.
 *
 * @param project - The project as the run currently holds it.
 * @returns The ids of the video tracks where every placement would be refused. Empty
 *   when the sequence is empty, since an empty timeline blocks nothing.
 */
export function tracksWithNoFreePictureSpan(project: Project): ReadonlySet<string> {
  const assetById = new Map<string, Asset>(
    (project.assets ?? []).map((asset) => [asset.id, asset]),
  );
  const spansByTrack = new Map<string, { start: number; end: number }[]>();
  let sequenceEnd = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) sequenceEnd = Math.max(sequenceEnd, clip.end);
    if (!carriesPicture(track)) continue;
    spansByTrack.set(
      track.id,
      track.clips
        .filter((clip) => PICTURE_KINDS.has(clipKindOf(clip, assetById)))
        .map((clip) => ({ start: clip.start, end: clip.end })),
    );
  }
  if (sequenceEnd <= 0) return new Set();
  const blocked = new Set<string>();
  for (const trackId of spansByTrack.keys()) {
    // The other video tracks' picture, swept in time order: `covered` walks forward only
    // while the spans keep touching, so the first real gap ends the sweep and the track
    // still has somewhere to go.
    const others = [...spansByTrack.entries()]
      .filter(([id]) => id !== trackId)
      .flatMap(([, spans]) => spans)
      .sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const span of others) {
      if (span.start > covered + COVERAGE_EPSILON) break;
      covered = Math.max(covered, span.end);
    }
    if (covered + COVERAGE_EPSILON >= sequenceEnd) blocked.add(trackId);
  }
  return blocked;
}
