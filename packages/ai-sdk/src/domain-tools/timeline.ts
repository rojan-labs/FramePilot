/**
 * Timeline tools — the sequence itself.
 *
 * The largest family, and the one whose reads and writes most need to agree: the
 * queries that report where a cut is (`get_timeline_map`, `map_time`,
 * `list_edit_boundaries`) and the operations that move one (`trim_clip`,
 * `ripple_delete`, `move_clip`) share a single definition of what a clip's
 * boundaries mean. Split across a read array and a mutate array, a change to that
 * definition could land on one side only — and a query that disagrees with the
 * edit it informs is the most expensive kind of drift here, because the model
 * reads the wrong number and then acts on it confidently.
 *
 * Semantic timeline intent — roll, slip, slide, J/L cuts, multicam — lives in
 * `professional-edit.ts`, which compiles it down to these same primitives.
 */
import { z } from 'zod/v4';
import { AudioRoleSchema, BlendModeSchema, CropRectSchema } from '@framepilot/timeline-schema';
import type { CropRect, Project, Timeline, Track } from '@framepilot/timeline-schema';
import {
  buildTimelineMap,
  coverCropFor,
  listEditBoundaries,
  mapSequenceTime,
  mapSourceTime,
  mapTranscript,
  speechAssetIdsFor,
} from '@framepilot/editor-core';
import type { Operation } from '@framepilot/editor-core';
import { createLaneAllocator } from '@framepilot/editor-core';

/** The per-call lane bookkeeping `addClipOperation` needs; see `createLaneAllocator`. */
type LaneAllocator = ReturnType<typeof createLaneAllocator>;
/** The per-call picture-layer bookkeeping; see `createPicturePlacer`. */
type PicturePlacer = ReturnType<typeof createPicturePlacer>;
import { frameToSeconds, secondsToFrame } from '../frame-time.js';
import { readEditSignals } from '../proposers/edit-signals.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { clipCandidates } from './clip-candidates.js';
import { createPicturePlacer, tracksCoveredByPictureInFront } from './picture-layers.js';
import { mutateTool, noArgs, readTool } from './tool-factories.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { boolean, filterString, numeric, seconds } from './tool-args.js';

/**
 * The range that removes a whole clip — **snapped outward to the frame grid**.
 *
 * WHY outward, and not the clip's own numbers. `assembleEdit` quantizes every operation
 * to the frame grid before it validates and applies (`normalizeOperationTimes`), and its
 * rounding is *nearest*. A clip whose `end` sits off the grid — every clip a
 * non-frame-aligned import or an off-grid authoring path produced — therefore had its
 * delete range rounded back INSIDE itself, and the "delete" left a sub-frame husk of the
 * clip on the track while the tool card reported success.
 *
 * The husk is then undeletable: its own start and end round to the same frame, so the
 * next `delete_clip` on it assembles a zero-length range and the validator refuses it
 * with `delete_range.end must be greater than start.` The model, told the clip is still
 * there and that deleting it failed for a reason it cannot act on, asks again. That is
 * the `delete_clip` 48 % / `delete_clips` 33 % identical-repeat row in
 * `docs/reports/system-mission/01-call-classification.md`: in the mission runs, **29 of
 * 48** failed delete calls carry exactly that validator message, and the montage run's
 * own `get_timeline` shows the husk it kept re-deleting — `clip_005`, 8 ms wide, at
 * 134.6667–134.6747 s.
 *
 * Flooring the start and ceiling the end makes the range cover the clip's every frame, so
 * normalization is a no-op on it and the clip is actually gone. A clip already on the grid
 * is unaffected — floor and ceil of a grid value are that value — so this only ever
 * changes the off-grid case that was broken.
 */
const clipDeleteOp = (
  project: ToolContext['project'],
  clipId: string,
  ripple: boolean,
): { type: 'delete_range' | 'ripple_delete'; trackId: string; start: number; end: number } => {
  const timeline = project.timeline;
  const fps = project.fps;
  const found = findClipById(timeline, clipId);
  if (!found) {
    throw new Error(`Unknown clip "${clipId}". ${clipCandidates(project, clipId)}`);
  }
  return {
    type: ripple ? 'ripple_delete' : 'delete_range',
    trackId: found.track.id,
    start: frameToSeconds(secondsToFrame(found.clip.start, fps, 'floor'), fps),
    end: frameToSeconds(secondsToFrame(found.clip.end, fps, 'ceil'), fps),
  };
};

/**
 * Compact clip row for windowed listings (`get_clips`). Deliberately omits the
 * heavy nested payloads (effects, keyframes, caption style) and replaces them
 * with counts/flags, so a long-form timeline can be scanned cheaply; `get_clip`
 * returns the full clip when the detail is actually needed.
 *
 * `cropped` and `graded` are flags rather than payloads for the same reason — but they had to
 * be ADDED, and their absence was expensive. Crop was the one clip property with no cheap
 * observability: effects and keyframes had counts, speed rode along, and crop appeared in
 * nothing but the per-clip deep read. So "which of my 47 clips still need reframing" cost 47
 * tool calls, which means it was never asked, which is why two captured runs reframed a
 * handful of shots, lost track, and reported the job done. A flag is one call.
 */
const clipRow = (clip: Track['clips'][number]): Record<string, unknown> => ({
  id: clip.id,
  trackId: clip.trackId,
  assetId: clip.assetId,
  start: clip.start,
  end: clip.end,
  sourceStart: clip.sourceStart,
  sourceEnd: clip.sourceEnd,
  ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
  cropped: clip.crop !== undefined,
  graded: clip.effects.some((effect) => effect.type === 'color_grade'),
  effectCount: clip.effects.length,
  keyframeCount: clip.keyframes.length,
});

const deleteSchema = z.object({ trackId: z.string(), start: seconds, end: seconds }).strict();

/** Locate a clip and its track, or `undefined` when the id is unknown. */
const findClipById = (
  timeline: Timeline,
  clipId: string,
): { track: Track; clip: Track['clips'][number] } | undefined => {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
};

// `get_clips` windowed listing: every filter is optional; `limit` bounds the page
// so a long-form timeline can never dump thousands of clips into one result.
const GET_CLIPS_DEFAULT_LIMIT = 50;
const GET_CLIPS_MAX_LIMIT = 200;
const getClipsSchema = z
  .object({
    trackId: filterString(),
    start: seconds.optional(),
    end: seconds.optional(),
    offset: numeric(z.number().int().nonnegative()).optional(),
    limit: numeric(z.number().int().min(1).max(GET_CLIPS_MAX_LIMIT)).optional(),
  })
  .strict();

/**
 * A non-colliding, deterministic id for a new track of the given advisory role.
 * Mirrors the web editor's `nextLayerId` (`apps/web-editor/.../patch-builders.ts`)
 * so AI- and user-created tracks share one naming scheme (`layer_<role>_<n>`).
 * Pure over the current track list.
 */
const nextTrackId = (timeline: Timeline, role: Track['type']): string => {
  let n = timeline.tracks.length + 1;
  let candidate = `layer_${role}_${n}`;
  while (timeline.tracks.some((t) => t.id === candidate)) {
    n += 1;
    candidate = `layer_${role}_${n}`;
  }
  return candidate;
};

// `read_edit_signals` takes the signals the model already gathered — map_footage
// chapters/highlights, analyze_silence ranges, detect_scenes cuts — and describes what is
// measurably there, in time order. It does NOT say which move to make: that used to be seven
// hardcoded rules with hand-tuned scores, and `proposers/edit-signals.ts` records why the
// authority moved to the agent. All inputs are optional so the model can describe whatever it
// has; transcript emphasis is measured from the project.
const proposeEditsSchema = z
  .object({
    chapters: z
      .array(
        z.object({
          t0: z.number(),
          t1: z.number(),
          title: z.string(),
          summary: z.string().optional(),
        }),
      )
      .optional(),
    highlights: z
      .array(
        z.object({
          t0: z.number(),
          t1: z.number(),
          label: z.string(),
          score: z.number().optional(),
        }),
      )
      .optional(),
    silences: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
    sceneCuts: z.array(z.number()).optional(),
    /**
     * Accepted and ignored. It used to switch on a `reframe` candidate for every highlight —
     * a decision that is now the agent's (see `proposers/edit-signals.ts`). Kept on the
     * schema so a caller that still sends it is not refused, and because the TS↔Python
     * contract mirror pins this shape.
     */
    verticalTarget: boolean().optional(),
  })
  .strict();

// `get_transcript` window (all optional): only words overlapping [start, end) are
// returned, so an hour-long transcript can be read a section at a time instead of
// wholesale. No args keeps today's full-transcript behavior.
const transcriptWindowSchema = z
  .object({ start: seconds.optional(), end: seconds.optional() })
  .strict();

// `get_timeline` window (all optional): only clips overlapping [start, end) are returned.
// No args keeps the full-timeline behavior.
const timelineWindowSchema = z
  .object({ start: seconds.optional(), end: seconds.optional() })
  .strict();

const trimSchema = z.object({ clipId: z.string(), start: seconds, end: seconds }).strict();
/**
 * The most placements one `add_clips` call may carry.
 *
 * A batch is still N operations to the turn's blast-radius bound, and the two default
 * bounds disagree — `orchestrator.ts` caps a turn at 100 operations, `kernel/conductor.ts`
 * at 200. Capping here at the SMALLER of the two means a batch that parses is a batch that
 * can be applied on either path. Beyond that the rejection has to come from the schema,
 * where it can say what the limit is: `Turn rejected: 120 operations exceeds the per-turn
 * cap` names no fix, so a model that hits it re-sends the same batch.
 *
 * Halved from 100 when a placement stopped costing exactly one operation: a measured
 * landscape source landing in a portrait project now carries its fill crop with it (see
 * {@link addClipOperation}), so the worst case is two operations per entry. At 100 entries
 * that montage assembled 200 operations and was refused by the 100-op path with precisely
 * the unactionable message this constant exists to avoid — and refused for a crop the model
 * never asked for. The bound is on OPERATIONS, so it has to be stated in the currency the
 * caps are: half of the smaller cap.
 */
export const MAX_CLIPS_PER_BATCH = 50;

/**
 * The centred crop that makes a source FILL a frame of a different aspect, or `undefined`
 * when the source is not wider than the frame and so needs no horizontal crop.
 *
 * The maths is the `vertical-reframe` skill's own, and it is dictated by the renderer:
 * `_apply_crop` cuts the rect out first and `_place_video_clip` then scales what is left
 * with `min(target_w/w, target_h/h)` — *contain*. Cut the source down to exactly the
 * target aspect and contain becomes cover, so the picture fills the frame with no bars.
 *
 * Full height (`height: 1`) and centred horizontally: keeping the whole vertical extent
 * throws away the least picture, and the middle is the only defensible guess without
 * subject evidence. It is a guess — see {@link autoReframeCrop} for why one is made at
 * all, and why it is announced rather than silent.
 *
 * @param source - Measured source pixel dimensions. Never guessed by the caller.
 * @param target - The project's output pixel dimensions.
 */
export function coverCropForFrame(
  source: { readonly width: number; readonly height: number },
  target: { readonly width: number; readonly height: number },
): CropRect | undefined {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    return undefined;
  }
  // The horizontal-only gate is this function's POLICY, not the maths (ADR 0170 moved the
  // maths to `editor-core#coverCropFor`, which crops either axis because the placement
  // refusal has to be able to suggest a rect for a taller source too). Padding a 4:5 still
  // in a 9:16 sequence is a real editorial choice; cropping its height silently is not one
  // `add_clip` should make on the run's behalf. See {@link autoReframeCrop}.
  if (source.width / source.height <= target.width / target.height) return undefined;
  return coverCropFor(source, target);
}

/**
 * The crop `add_clip`/`add_clips` apply on their own, or `undefined` for "leave it alone".
 *
 * ## Why the engine makes this editorial call
 *
 * It is the one geometry a short-form run gets wrong in the same way every time. The
 * renderer FITS, so a landscape source placed in a portrait sequence with no crop exports
 * with black bars — never what "make me a vertical short" means — and the crop that fixes
 * it is fully determined by two numbers the host already holds. In the captured
 * talking-head run the model was never told the source was landscape (nothing had been
 * probed), placed it bare, and the letterboxed export was reported as a success. Geometry
 * the model has to remember, across a run, for every shot, is geometry that gets
 * forgotten: `checkReframeCoverage` was written because two earlier runs reframed the
 * opening shots and then stopped.
 *
 * ## Why that is safe to do
 *
 * - **Measured only.** No dimensions, no crop. A guessed shape would crop the wrong axis,
 *   and this returns `undefined` rather than assume anything (same rule as `model-view.ts`).
 * - **Reversible and visible.** It arrives as its own `set_clip_crop` operation in the same
 *   patch, so it shows up in the diff, in the tool-result note ("Reframed clip …"), and in
 *   one undo. `set_clip_crop` with `crop: null` puts the whole frame back.
 * - **Narrow.** Portrait project, `video` track, landscape source. A landscape sequence is
 *   left alone (a landscape source in it is the ordinary case), and an `overlay` track is
 *   left alone because a picture-in-picture is deliberately not full-bleed.
 *
 * ## What it does NOT do
 *
 * It cannot see the speaker. A centred crop beheads an off-centre subject, and no amount
 * of arithmetic fixes that — subject-aware reframing needs tracker samples
 * (`editor-core/track-reframe.ts`, not wired). So the crop is announced, not hidden: the
 * run is expected to look and re-crop. Bars are the worse default of the two, because a
 * bar is wrong in every frame and a centred crop is wrong only sometimes.
 */
function autoReframeCrop(
  ctx: ToolContext,
  placement: { readonly trackId: string; readonly assetId: string },
): CropRect | undefined {
  const { resolution } = ctx.project;
  if (resolution.height <= resolution.width) return undefined;
  // The lane the CALLER NAMED, which is the lane the policy is about. Reading the RESOLVED
  // lane instead was a latent bug: a lane the picture placer had just opened
  // (`video_cutaway_N`) is not in the pre-turn timeline, so the lookup found nothing,
  // `track?.type !== 'video'` was true, and a lifted placement never reframed — the one
  // case where the source is most likely to be the wrong shape for the frame.
  const track = ctx.project.timeline.tracks.find((candidate) => candidate.id === placement.trackId);
  if (track?.type !== 'video') return undefined;
  const asset = ctx.project.assets.find((candidate) => candidate.id === placement.assetId);
  if (!asset || asset.kind === 'audio') return undefined;
  const width = asset.media?.width;
  const height = asset.media?.height;
  // Unmeasured is unknown, never square. `list_assets` says so out loud (`shape:
  // "unmeasured"`) so a run can see why nothing was reframed for it.
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  return coverCropForFrame({ width, height }, resolution);
}

/**
 * The id `add_clip` gives a clip when the caller does not name one.
 *
 * Mirrors `editor-core`'s own `deriveClipId('clip', …)`, which is not exported. It is
 * restated rather than approximated so an auto-reframed placement gets an id of the same
 * SHAPE as every other placement — an id that suddenly looked different depending on
 * whether a crop happened to be applied would read as two different code paths. Nothing
 * depends on the two matching value-for-value: the id travels on the operation, so it is
 * authoritative wherever it is used.
 */
const placementClipId = (placement: {
  readonly trackId: string;
  readonly assetId: string;
  readonly start: number;
}): string =>
  `clip__${placement.trackId}_${placement.assetId}_${String(Math.round(placement.start * 1000))}`;

/**
 * One placement, built the same way whether it arrived alone or in a batch.
 *
 * `sourceEnd` is derived rather than accepted: `add_clip` has no speed argument, so the
 * timeline span is the one authoritative duration and a caller-supplied source range could
 * only ever disagree with it. Shared by `add_clip` and `add_clips` so the two can never
 * drift — a batch that placed clips by slightly different rules than the singular tool
 * would be worse than no batch at all.
 *
 * Returns one or TWO operations: a measured landscape source landing on a video track of a
 * portrait project is followed by the `set_clip_crop` that makes it fill the frame (see
 * {@link autoReframeCrop}). The clip is named explicitly in that case so the crop can
 * address it — `add_clip` derives an id from `start`, and `start` is quantized to the frame
 * grid after this runs, so an id derived here from the raw value would not be the one the
 * clip ends up with.
 */
const roundSeconds = (n: number): string => (Math.round(n * 100) / 100).toString();

/** A clip's file name for a refusal sentence, or its id when the bin does not know it. */
function assetLabel(ctx: ToolContext, assetId: string): string {
  const asset = ctx.project.assets?.find((a) => a.id === assetId);
  const path = asset?.path;
  const name = typeof path === 'string' ? path.split('/').pop() : undefined;
  return `"${name && name !== '' ? name : assetId}"`;
}

/**
 * The same asset already reading the same source range over the same sequence span.
 *
 * Exact on all three, and deliberately so: two different moments of one file stacked at
 * one instant is a strange edit but a real one, and only the byte-identical placement is
 * provably invisible. Compared on the frame grid's own slack so a placement recomputed a
 * float apart still counts as the same one. See {@link addClipOperation}.
 */
function existingPlacement(
  project: Project,
  clip: {
    readonly assetId: string;
    readonly start: number;
    readonly end: number;
    readonly sourceStart: number;
  },
): { readonly trackId: string; readonly clipId: string } | undefined {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  for (const track of project.timeline.tracks) {
    for (const existing of track.clips) {
      if (existing.assetId !== clip.assetId) continue;
      if (!near(existing.start, clip.start) || !near(existing.end, clip.end)) continue;
      if (!near(existing.sourceStart, clip.sourceStart)) continue;
      return { trackId: track.id, clipId: existing.id };
    }
  }
  return undefined;
}

function addClipOperation(
  clip: {
    readonly trackId: string;
    readonly assetId: string;
    readonly start: number;
    readonly end: number;
    readonly sourceStart: number;
  },
  ctx: ToolContext,
  lanes: LaneAllocator,
  picture: PicturePlacer,
  /**
   * Placements already handed out by THIS call, so a batch cannot duplicate inside
   * itself. `existingPlacement` reads the pre-call timeline and therefore cannot see an
   * entry the same `add_clips` batch booked a moment ago — `add_clips` plans every entry
   * against one snapshot, which is the whole reason the lane allocators are per-call too.
   */
  booked: Set<string>,
): Operation[] {
  // Resolve the lane rather than trusting the one that was named — by two
  // different rules, because picture and everything else fail differently.
  //
  // Clips on one track can never overlap, and a placement that collided used to
  // take the whole patch down with the validator's overlap error. For an overlay,
  // a caption or an audio bed that is a dead end for an intent lanes exist to
  // express, so those are relocated to a lane with room.
  //
  // Picture is answered by `picture-layers.ts` (ADR 0169) because "a lane with
  // room" is not enough for it: the preview paints ONE picture layer, so the
  // clip has to end up in FRONT of everything it covers or the user approves a
  // frame the export does not produce. That placer keeps the named lane when the
  // lane can be seen, moves to an existing front lane when there is one, and
  // otherwise opens a front lane in the same patch. A placement that could not
  // preview honestly at all — scaled, cropped, faded, blended — it refuses.
  //
  // Both are allocators rather than lookups because `add_clips` plans every entry
  // against the same pre-call timeline: without booking each span as it is handed
  // out, two overlapping entries in one batch would both be told the lane was
  // free, and two entries needing a front layer would each open one with the same id.
  //
  // The auto-reframe crop is computed FIRST and handed to the placer. Under ADR 0170 a crop
  // is geometry, so the cover crop is exactly what lets a landscape source sit over picture
  // in a portrait project; deciding the placement against the bare clip and cropping
  // afterwards refused the very placement the reframe exists to make legal.
  // THE SAME SHOT AT THE SAME MOMENT, TWICE, IS INVISIBLE WORK.
  //
  // The placer's job is to find a lane for a clip that collides with picture, and it does
  // it well — for a clip that is genuinely NEW. It cannot tell that from the same clip
  // sent again, and when the collision is with an identical copy of itself the honest
  // answer is not "open another layer". Run `137d8fd0` placed `Video_6381282` over 0–9s
  // three times and finished with nineteen video lanes for a sixty-second edit; two of
  // those copies can never be seen, and every one of them costs a lane, a render pass and
  // a row in the editor's timeline.
  //
  // Nothing else catches it: a second placement really does change the project, so the
  // run's no-change guard cannot see it, and the copies share no track so the validator
  // cannot either.
  const placementKey = `${clip.assetId}@${clip.start}-${clip.end}:${clip.sourceStart}`;
  const alreadyThere = existingPlacement(ctx.project, clip);
  if (alreadyThere || booked.has(placementKey)) {
    throw new ToolRefusalError(
      `${assetLabel(ctx, clip.assetId)} is already on the timeline from ` +
        `${roundSeconds(clip.start)}s to ${roundSeconds(clip.end)}s` +
        `${alreadyThere ? `, on ${alreadyThere.trackId}` : ' — this call placed it already'}. ` +
        'A second copy of the same shot over the same moment cannot be seen behind the ' +
        'first. Place it at a different time, use a different shot, or change the one ' +
        'that is there with trim_clip or move_clip.',
    );
  }
  const kind = ctx.project.assets?.find((a) => a.id === clip.assetId)?.kind;
  const isPicture = kind === 'video' || kind === 'image' || kind === undefined;
  const crop = autoReframeCrop(ctx, clip);
  const placed = isPicture
    ? picture.place({
        trackId: clip.trackId,
        assetId: clip.assetId,
        start: clip.start,
        end: clip.end,
        compositing: crop ? { crop } : {},
      })
    : lanes.allocate(clip.trackId, clip.start, clip.end);
  const clipId = crop ? placementClipId({ ...clip, trackId: placed.trackId }) : undefined;
  const add: Operation = {
    type: 'add_clip',
    trackId: placed.trackId,
    assetId: clip.assetId,
    start: clip.start,
    end: clip.end,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceStart + (clip.end - clip.start),
    ...(clipId ? { clipId } : {}),
  };
  booked.add(placementKey);
  const ops = [...placed.setupOps, add];
  if (!crop || !clipId) return ops;
  return [...ops, { type: 'set_clip_crop', clipId, crop }];
}

export const TIMELINE_TOOLS: readonly ToolSpec[] = [
  readTool(
    {
      name: 'get_timeline',
      description:
        'Return the current timeline (tracks/clips). Pass start/end (timeline seconds) to ' +
        'read only the clips playing in that window — on a long sequence, read sections ' +
        'rather than dumping every clip.',
    },
    // The same window `get_transcript` takes, for the same reason and in the same words.
    // Run 4c9b5f82 asked for `{start: 0, end: 50}` and then `{start: 0, end: 37}`, was told
    // `Unrecognized keys: "start", "end"` both times, and spent two of its seventeen model
    // calls learning that a read it had every reason to expect does not exist. A window on
    // a long timeline is the obvious ask; refusing it taught nothing and cost two turns.
    timelineWindowSchema,
    (a, ctx) => {
      const timeline = ctx.project.timeline;
      if (a.start === undefined && a.end === undefined) return timeline;
      const start = a.start ?? Number.NEGATIVE_INFINITY;
      const end = a.end ?? Number.POSITIVE_INFINITY;
      return {
        ...timeline,
        tracks: timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => clip.end > start && clip.start < end),
        })),
      };
    },
  ),
  readTool(
    {
      name: 'get_transcript',
      description:
        'Return the word-level transcript in SOURCE time — where each word sits in the ' +
        'original recording, NOT where it plays on the edited timeline. The two are the ' +
        'same only before any cut. To place captions, add markers, or reference a moment ' +
        'on the timeline, use get_mapped_transcript instead; never convert these ' +
        'timestamps yourself. Pass start/end (source seconds) to read only that window — ' +
        'on a long recording, read sections, not the whole thing.',
    },
    transcriptWindowSchema,
    (a, ctx) => {
      const start = a.start ?? Number.NEGATIVE_INFINITY;
      const end = a.end ?? Number.POSITIVE_INFINITY;
      if (a.start === undefined && a.end === undefined) return ctx.project.transcript;
      return ctx.project.transcript.filter((w) => w.end > start && w.start < end);
    },
  ),
  readTool(
    {
      name: 'read_edit_signals',
      description:
        'Describe what is measurably THERE across a stretch of the edit — the facts a move ' +
        'should be chosen from, never the move itself. Pass the signals you have already ' +
        'gathered (map_footage chapters/highlights, analyze_silence ranges, detect_scenes ' +
        'cuts); returns them in TIME order as [{ kind: highlight|chapter|silence|emphasis|' +
        "scene_change, t0, t1, observation, from }] in timeline seconds, with each chapter's " +
        'shape (length, highlights inside, words spoken) and each silence long enough to ' +
        'notice. Transcript emphasis is measured from the project for you. `from` says ' +
        'whether a signal was supplied by you or measured here — a chapter you did not read ' +
        'from the footage is still only your own claim. WHICH move each observation deserves ' +
        '— a punch-in, a reframe, a ramp, a cut, nothing at all — is your judgement, and this ' +
        'tool deliberately does not rank or recommend. Does not edit the timeline.',
      capabilities: ['analysis', 'visual'],
    },
    proposeEditsSchema,
    (a, ctx) =>
      readEditSignals({
        ...(a.chapters ? { chapters: a.chapters } : {}),
        ...(a.highlights ? { highlights: a.highlights } : {}),
        ...(a.silences ? { silences: a.silences } : {}),
        ...(a.sceneCuts ? { sceneCuts: a.sceneCuts } : {}),
        transcript: ctx.project.transcript,
      }),
  ),
  readTool(
    {
      name: 'get_timeline_summary',
      description:
        'Return a compact overview of the timeline: total duration, and per track its ' +
        'id, type, flags, clip count, and first/last clip times — plus marker and ' +
        'transcript-word counts. Orient with this first on a large project; it is far ' +
        'cheaper than get_timeline, which dumps every clip.',
    },
    noArgs,
    (_args, ctx) => {
      // Which video tracks nothing could be SEEN on, because picture in front of them
      // already covers the whole sequence. `arrangementLine` reports the same fact from
      // the same helper — a run that reads this tool and a run that reads the arrangement
      // fact must hold the timeline in the same terms, and run `369e8c82` spent fifteen
      // minutes placing stock onto an "empty" track neither of them said was unusable.
      const blocked = tracksCoveredByPictureInFront(ctx.project);
      const tracks = ctx.project.timeline.tracks.map((track) => ({
        id: track.id,
        type: track.type,
        clipCount: track.clips.length,
        firstClipStart: track.clips.length ? Math.min(...track.clips.map((c) => c.start)) : null,
        lastClipEnd: track.clips.length ? Math.max(...track.clips.map((c) => c.end)) : null,
        ...(blocked.has(track.id) ? { hiddenBehindPicture: true } : {}),
        ...(track.muted !== undefined ? { muted: track.muted } : {}),
        ...(track.locked !== undefined ? { locked: track.locked } : {}),
        ...(track.hidden !== undefined ? { hidden: track.hidden } : {}),
      }));
      return {
        durationSeconds: tracks.reduce((max, t) => Math.max(max, t.lastClipEnd ?? 0), 0),
        trackCount: tracks.length,
        clipCount: tracks.reduce((sum, t) => sum + t.clipCount, 0),
        tracks,
        markerCount: ctx.project.markers.length,
        transcriptWordCount: ctx.project.transcript.length,
      };
    },
  ),
  readTool(
    {
      name: 'get_timeline_map',
      description:
        'THE authoritative source↔sequence timing for every clip: assetId, source ' +
        'in/out, sequence in/out, speed, track — plus the sequence duration and the ' +
        'timeline revision. Read this whenever you need to relate a moment in the ' +
        'original footage to a moment on the edit. Never compute that relationship ' +
        'yourself from clip durations, and never reuse a mapping you read earlier: ' +
        'any cut, trim, move or speed change makes it wrong, and the revision tells ' +
        'you it did. It returns EVERY clip and takes no arguments — on a long ' +
        'timeline read a window with get_clips (same source in/out, filtered by ' +
        'track/time and paginated) instead.',
    },
    noArgs,
    (_args, ctx) => buildTimelineMap(ctx.project.timeline),
  ),
  readTool(
    {
      name: 'map_time',
      description:
        'Convert one timestamp between the original footage and the edited sequence. ' +
        'Give { sourceTime, assetId } to ask where a moment of footage ended up — the ' +
        'answer is a LIST, because it may have been cut (empty) or used more than once. ' +
        'Give { sequenceTime } to ask what plays at a moment of the edit. Use this ' +
        'instead of doing the arithmetic; it accounts for trims, speed, and reuse. ' +
        'Called with no arguments it returns the whole timeline map.',
    },
    z
      .object({
        sourceTime: seconds.optional(),
        assetId: filterString(),
        sequenceTime: seconds.optional(),
      })
      .strict(),
    (a, ctx) => {
      const map = buildTimelineMap(ctx.project.timeline);
      const fps = ctx.project.fps;
      // P3.2: the answer carries the FRAME, not only the second. `map_time` exists so the
      // model does not do this arithmetic itself — "it accounts for trims, speed, and
      // reuse" — and a frame number is the natural completion of that promise now that a
      // frame is a real thing on this timeline (ADR 0146). Only SEQUENCE frames are
      // reported: a source asset may run at its own rate, which this tool is not given.
      if (a.sequenceTime !== undefined) {
        return {
          at: mapSequenceTime(map, a.sequenceTime),
          sequenceFrame: secondsToFrame(a.sequenceTime, fps),
          fps,
          revision: map.revision,
        };
      }
      // No timestamp asked about ⇒ hand back the whole mapping rather than
      // erroring: every read tool must answer usefully with no arguments, and
      // the map is the right answer to "tell me about the timing".
      if (a.sourceTime === undefined) return { ...map, fps };
      const assetId = a.assetId ?? ctx.project.assets[0]?.id;
      if (assetId === undefined) {
        throw new Error('map_time needs an assetId — this project has no assets.');
      }
      return {
        hits: mapSourceTime(map, assetId, a.sourceTime).map((hit) => ({
          ...hit,
          sequenceFrame: secondsToFrame(hit.sequenceTime, fps),
        })),
        fps,
        revision: map.revision,
      };
    },
  ),
  readTool(
    {
      name: 'get_mapped_transcript',
      description:
        'The transcript as it plays on the EDITED timeline: only words that survived ' +
        'the cuts, each with its sequence time, its original source time, and the clip ' +
        'carrying it. Also returns the RUNS — the stretches of continuous audio, with ' +
        'their sequence bounds and word counts. A run boundary is a break in the ' +
        'speech: a caption cue may span as many picture cuts as you like but must never ' +
        'cross a run boundary, because the words either side were never spoken in one ' +
        'breath. Partition the words by run bounds to segment cues. This is what ' +
        'captions, markers, and any "quote the video at time T" answer must be built ' +
        'from. Words in deleted footage are gone, so anything you read here is ' +
        'genuinely audible.',
    },
    transcriptWindowSchema,
    (a, ctx) => {
      const map = buildTimelineMap(ctx.project.timeline);
      // The timings the model cuts on. An unattributed word matching any asset reports
      // narration as audible inside a silent b-roll clip, and every cut placed from that
      // reading is wrong before the model does anything.
      const mapped = mapTranscript(
        map,
        ctx.project.transcript,
        speechAssetIdsFor(ctx.project.assets, ctx.project.transcript),
      );
      const start = a.start ?? Number.NEGATIVE_INFINITY;
      const end = a.end ?? Number.POSITIVE_INFINITY;
      const words = mapped.words.filter((w) => w.end > start && w.start < end);
      // WHY runs do not carry their words: `MappedTranscript.runs[].words` repeats every
      // word object already in `words`, so the payload was exactly twice the size of the
      // information in it — 81 words serialized to 27 KB. A run recall then cost six
      // turns of paging at the recall budget, which is how a caption run spent its whole
      // step allowance retrieving a transcript it had already been given.
      //
      // Nothing is lost. A run is a time span, and the words inside it are the words
      // whose midpoint falls in that span — the same ownership rule `verify_captions`
      // applies, so what this returns and what the verifier enforces cannot disagree.
      const runs = mapped.runs
        .filter((r) => r.end > start && r.start < end)
        .map((run) => ({
          clipId: run.clipId,
          assetId: run.assetId,
          start: run.start,
          end: run.end,
          wordCount: words.filter((w) => {
            const mid = (w.start + w.end) / 2;
            return mid >= run.start - 1e-6 && mid <= run.end + 1e-6;
          }).length,
        }));
      // P3.2: word-accurate captioning is frame-accurate captioning or it is neither. The
      // frame span is what a trim can actually be aimed at — "cut before she says but"
      // means a frame, and the model should not be deriving it from a float.
      const fps = ctx.project.fps;
      const timedWords = words.map((w) => ({
        ...w,
        startFrame: secondsToFrame(w.start, fps),
        endFrame: secondsToFrame(w.end, fps),
      }));
      return {
        words: timedWords,
        runs,
        droppedCount: mapped.droppedCount,
        fps,
        revision: mapped.revision,
      };
    },
  ),
  readTool(
    {
      name: 'list_edit_boundaries',
      description:
        'Every real cut in the sequence — where one clip ends and the next begins — ' +
        'with the two clip ids, the sequence time, and the longest transition each can ' +
        'carry. A transition can only go at one of these. A narrative pivot INSIDE a ' +
        'continuous clip is not a boundary: split the clip there first, or the ' +
        'transition has nothing to happen at.',
    },
    noArgs,
    (_args, ctx) => {
      // P3.2: a boundary HAS a frame. This module's whole reason for existing is that a
      // cut is a boundary rather than an effect on a clip; a boundary an editor can name
      // is one they can name in frames, and a transition's ceiling is a frame count
      // before it is a duration.
      const fps = ctx.project.fps;
      return listEditBoundaries(ctx.project.timeline, ctx.project.assets).map((boundary) => ({
        ...boundary,
        frame: secondsToFrame(boundary.at, fps),
        maxTransitionFrames: secondsToFrame(boundary.maxTransitionSeconds, fps),
        fps,
      }));
    },
  ),
  readTool(
    {
      name: 'get_clips',
      description:
        'List clips as compact rows — ids, times, source in/out, `cropped` and `graded` ' +
        'flags, effect/keyframe counts — optionally filtered to one trackId and/or a ' +
        'start/end window (timeline seconds), paginated with offset/limit (default 50, max ' +
        '200). Returns { clips, total, hasMore }. `cropped` is how you check reframing ' +
        'coverage across a whole cut in ONE call: an uncropped clip whose source aspect ' +
        'differs from the sequence renders with black bars. Use this instead of ' +
        'get_timeline on a long-form project; use get_clip for one clip in full detail.',
    },
    getClipsSchema,
    (a, ctx) => {
      const start = a.start ?? Number.NEGATIVE_INFINITY;
      const end = a.end ?? Number.POSITIVE_INFINITY;
      const matched = ctx.project.timeline.tracks
        .filter((track) => a.trackId === undefined || track.id === a.trackId)
        .flatMap((track) => track.clips)
        .filter((clip) => clip.end > start && clip.start < end)
        .sort((x, y) => x.start - y.start || x.trackId.localeCompare(y.trackId));
      const offset = a.offset ?? 0;
      const limit = a.limit ?? GET_CLIPS_DEFAULT_LIMIT;
      const page = matched.slice(offset, offset + limit);
      return {
        clips: page.map(clipRow),
        total: matched.length,
        hasMore: offset + page.length < matched.length,
      };
    },
  ),
  readTool(
    {
      name: 'get_clip',
      description:
        'Return one clip in full detail (effects, keyframes, styling) plus its ' +
        'trackId. The precise deep read to pair with the compact get_clips listing.',
    },
    z.object({ clipId: z.string() }).strict(),
    (a, ctx) => {
      const found = findClipById(ctx.project.timeline, a.clipId);
      if (!found) {
        return { error: `Unknown clip "${a.clipId}". ${clipCandidates(ctx.project, a.clipId)}` };
      }
      return { trackId: found.track.id, clip: found.clip };
    },
  ),
  readTool(
    {
      name: 'get_selected_range',
      description:
        "Return the user's selected timeline range (start/end seconds), or null when " +
        'nothing is selected.',
    },
    noArgs,
    (_args, ctx) => ctx.selection ?? null,
  ),
  mutateTool(
    {
      name: 'trim_clip',
      description:
        "Set a clip's new start/end in timeline seconds; the source in/out shifts by " +
        "the same amount. Use to tighten or extend one clip's edges. It cannot change " +
        'WHERE IN THE ASSET a clip reads from while keeping its timeline position and ' +
        'length — to do that, delete_clip it and add_clip the same span with a different ' +
        'sourceStart.',
    },
    trimSchema,
    (a) => [{ type: 'trim_clip', clipId: a.clipId, start: a.start, end: a.end }],
  ),
  mutateTool(
    {
      name: 'split_clip',
      description: 'Split a clip in two at a timeline time strictly inside the clip.',
    },
    z.object({ clipId: z.string(), at: seconds }).strict(),
    (a) => [{ type: 'split_clip', clipId: a.clipId, at: a.at }],
  ),
  mutateTool(
    {
      name: 'delete_range',
      description:
        'Delete a timeline range (seconds) on one track, leaving a gap. Use ' +
        'ripple_delete instead when the gap should close.',
    },
    deleteSchema,
    (a) => [{ type: 'delete_range', trackId: a.trackId, start: a.start, end: a.end }],
  ),
  mutateTool(
    {
      name: 'delete_clip',
      description:
        'Delete one clip by id. Set ripple: true to also close the gap it leaves ' +
        '(later clips on its track shift earlier). Safer than delete_range/' +
        'ripple_delete when you mean a specific clip — no hand-computed times.',
    },
    z.object({ clipId: z.string(), ripple: boolean().optional() }).strict(),
    (a, ctx) => [clipDeleteOp(ctx.project, a.clipId, a.ripple ?? false)],
  ),
  mutateTool(
    {
      name: 'delete_clips',
      description:
        'Delete several clips by id in one call (max 50). Set ripple: true to close ' +
        'each gap (later clips shift earlier). Use for multi-cut edits like removing ' +
        'every flagged clip — one call instead of many delete_clip calls.',
    },
    z
      .object({
        clipIds: z.array(z.string()).min(1).max(50),
        ripple: boolean().optional(),
      })
      .strict(),
    (a, ctx) => {
      const ripple = a.ripple ?? false;
      const ops = [...new Set(a.clipIds)].map((clipId) =>
        clipDeleteOp(ctx.project, clipId, ripple),
      );
      // Ripple shifts everything after each cut earlier, so delete back-to-front:
      // the ranges were computed against the CURRENT timeline and stay correct
      // only while nothing before them has moved.
      return ripple ? ops.sort((x, y) => y.start - x.start) : ops;
    },
  ),
  mutateTool(
    {
      name: 'ripple_delete',
      description:
        'Delete a timeline range (seconds) on one track and close the gap — later ' +
        'clips shift earlier. Prefer this for cutting dead air or tightening pacing.',
    },
    deleteSchema,
    (a) => [{ type: 'ripple_delete', trackId: a.trackId, start: a.start, end: a.end }],
  ),
  mutateTool(
    {
      name: 'reorder_clips',
      description:
        'Reorder one track\'s clips — "put the last shot first", "swap these two". ' +
        'Pass the track and ALL its clip ids in the new order; they are re-laid end to ' +
        'end keeping each length and media. Nothing is deleted or added, so this cannot ' +
        'lose footage; deleting and re-adding clips can. move_clip cannot reorder.',
    },
    z
      .object({
        trackId: z.string(),
        clipIds: z
          .array(z.string())
          .min(1)
          .max(500)
          .describe("All the track's clip ids, each once, in play order"),
      })
      .strict(),
    (a) => [{ type: 'reorder_clips', trackId: a.trackId, clipIds: a.clipIds }],
  ),
  mutateTool(
    {
      name: 'move_clip',
      description:
        'Move ONE clip to a track at a new timeline start time (duration unchanged). ' +
        'To reorder a track, use reorder_clips.',
    },
    z.object({ clipId: z.string(), toTrackId: z.string(), toStart: seconds }).strict(),
    (a, ctx) => {
      // Moving picture over picture is the same question `add_clip` answers, so it
      // goes through the same placer: a full-frame clip lands in front of what it
      // covers (on a layer opened here when there is none), and one that could not
      // preview honestly is refused in the same words. Unlike a fresh placement
      // this clip ALREADY carries compositing — a crop, a punch-in, a blend mode —
      // so the real fields are handed over rather than assumed empty. An unknown
      // clip is left to the validator, which names the ids that do exist.
      const found = findClipById(ctx.project.timeline, a.clipId);
      if (!found) {
        return [
          { type: 'move_clip', clipId: a.clipId, toTrackId: a.toTrackId, toStart: a.toStart },
        ];
      }
      const placed = createPicturePlacer(ctx.project).place({
        trackId: a.toTrackId,
        assetId: found.clip.assetId,
        start: a.toStart,
        end: a.toStart + (found.clip.end - found.clip.start),
        ignoreClipId: a.clipId,
        compositing: found.clip,
      });
      return [
        ...placed.setupOps,
        { type: 'move_clip', clipId: a.clipId, toTrackId: placed.trackId, toStart: a.toStart },
      ];
    },
  ),
  mutateTool(
    {
      name: 'add_track',
      description:
        'Create a new empty track (a "layer") to get a free lane for clips that ' +
        'would otherwise overlap. Clips on one track can never overlap, so this is ' +
        'how you stack simultaneous elements — titles, captions, overlays, an audio ' +
        'bed, or full-frame picture over existing footage — when no existing track ' +
        'has a free range. You rarely need it for picture: add_clip opens a front ' +
        "layer itself when the shot has to go over what is already there. `type` is the track's advisory role " +
        '(video/audio/caption/overlay): it sets the default label/icon only, not a ' +
        'content limit, so any clip can live on any track. `atIndex` is the z-order ' +
        'slot where index 0 is the visual front (nearer the viewer); omit it to add ' +
        'the track in front. Pass `id` to name the track so you can reference it as ' +
        'trackId in the same turn (in add_clip/add_text_layer); ' +
        'otherwise a deterministic id is generated and appears in the next get_timeline.',
      capabilities: ['edit', 'tracks'],
    },
    z
      .object({
        type: z.enum(['video', 'audio', 'caption', 'overlay']).default('overlay'),
        atIndex: numeric(z.number().int().nonnegative()).optional(),
        id: filterString(),
      })
      .strict(),
    (a, ctx) => [
      {
        type: 'add_layer',
        layerId: a.id ?? nextTrackId(ctx.project.timeline, a.type),
        layerType: a.type,
        atIndex: a.atIndex ?? 0,
      },
    ],
  ),
  mutateTool(
    {
      name: 'remove_track',
      description:
        'Remove a track (a "layer") by id, including any clips on it. Reversible ' +
        '(undo restores the track with its clips), but prefer targeted clip edits — ' +
        'removing a populated track that holds prior work is rejected unless the ' +
        'user themselves asked for it.',
      capabilities: ['edit', 'tracks'],
    },
    z.object({ trackId: z.string() }).strict(),
    (a) => [{ type: 'remove_layer', layerId: a.trackId }],
  ),
  mutateTool(
    {
      name: 'move_track',
      description:
        'Reorder a track to a new z-order slot. toIndex 0 is the visual front ' +
        '(nearer the viewer); clips are untouched. Use to put an overlay above the ' +
        'footage it should cover, or push b-roll behind a title.',
      capabilities: ['edit', 'tracks'],
    },
    z.object({ trackId: z.string(), toIndex: numeric(z.number().int().nonnegative()) }).strict(),
    (a) => [{ type: 'move_layer', layerId: a.trackId, toIndex: a.toIndex }],
  ),
  mutateTool(
    {
      name: 'add_clip',
      description:
        'Place an existing asset on a track: start/end are timeline seconds; ' +
        'assetId must be copied from the project asset list and trackId must be copied ' +
        'from the timeline track list — these are separate id namespaces. ' +
        'sourceStart picks where playback begins in the asset (default 0), so the same ' +
        'asset can be reused many times by giving each placement a different sourceStart. ' +
        'sourceEnd is NOT yours to set: the host always derives it from the timeline span ' +
        'at 1x (sourceStart + end - start) and ignores any sourceEnd you send, because ' +
        'add_clip has no speed argument and the two must agree. To play a specific source ' +
        'range, set sourceStart and make the timeline span the same length. Read the ' +
        'timeline and assets first so you use real track/asset ids, and pick a ' +
        'track whose range is free — clips on one track can never overlap. Placing ' +
        'video or an image over footage that is already there is fine: the shot is put ' +
        'on a layer in FRONT of what it covers, opening one if needed, and the result ' +
        'is in the patch you get back. It covers the frame completely, so use it for a ' +
        'cutaway or a montage, not for a picture-in-picture or a see-through overlay — ' +
        'a scaled, cropped, faded or blended clip over other picture is refused, ' +
        'because the preview can only show one picture layer at a time. ' +
        'In a PORTRAIT project, a source the engine has measured as landscape gets a ' +
        'centred fill crop on the way in (a set_clip_crop you will see in the result), ' +
        'because the renderer fits rather than fills and it would otherwise export with ' +
        'black bars — call set_clip_crop on that clip to re-centre it on the subject, or ' +
        'with crop: null to keep the whole frame. An UNMEASURED source gets nothing: ' +
        'check list_assets for `shape: "unmeasured"` and crop it yourself.',
    },
    z
      .object({
        trackId: z.string(),
        assetId: z.string(),
        start: seconds,
        end: seconds,
        sourceStart: seconds.default(0),
        // Backward-compatible input only. add_clip has no speed argument, so sourceEnd
        // is derived below from the one authoritative duration (end - start). Keeping
        // this optional field accepts older MCP/provider calls without letting a model
        // create an internally inconsistent clip.
        sourceEnd: seconds.optional(),
      })
      .strict(),
    (a, ctx) =>
      addClipOperation(
        a,
        ctx,
        createLaneAllocator(ctx.project.timeline),
        createPicturePlacer(ctx.project),
        // One placement, so nothing can precede it within the call.
        new Set<string>(),
      ),
  ),
  mutateTool(
    {
      name: 'add_clips',
      description:
        'Place MANY assets on one track in a single call — the same placement as ' +
        'add_clip, once per entry, in one reversible patch and one undo. Use this ' +
        'whenever you are laying out a sequence rather than fixing one shot: a montage, ' +
        'a b-roll pass, a set of photos on a beat grid. Entries are { assetId, start, ' +
        'end, sourceStart? } and follow add_clip’s rules exactly — timeline seconds, ' +
        'real asset ids, no overlaps on the track, and sourceEnd derived for you. The ' +
        'whole call is validated together, so if any one entry is rejected none of them ' +
        'land and the reason names the entry: fix that one and send the batch again. ' +
        'Landscape sources measured by the engine are fill-cropped for a portrait ' +
        'project exactly as add_clip does it. At ' +
        `most ${String(MAX_CLIPS_PER_BATCH)} entries per call — split a longer sequence ` +
        'across consecutive calls.',
    },
    z
      .object({
        trackId: z.string(),
        clips: z
          .array(
            z
              .object({
                assetId: z.string(),
                start: seconds,
                end: seconds,
                sourceStart: seconds.default(0),
                sourceEnd: seconds.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_CLIPS_PER_BATCH),
      })
      .strict(),
    (a, ctx) => {
      // ONE allocator and ONE picture placer for the whole batch, so entry N sees
      // the lanes — and the front layer — entries 1..N-1 already took.
      const lanes = createLaneAllocator(ctx.project.timeline);
      const picture = createPicturePlacer(ctx.project);
      const booked = new Set<string>();
      return a.clips.flatMap((clip) =>
        addClipOperation({ ...clip, trackId: a.trackId }, ctx, lanes, picture, booked),
      );
    },
  ),
  mutateTool(
    {
      name: 'set_track_flags',
      description:
        'Mute/unmute, lock/unlock, hide/show, or LABEL a track. Muting silences ' +
        "a track's audio in the render; hiding drops a visual track's picture; locking " +
        'prevents edits. role labels an audio track as dialogue, music or sfx — the ' +
        'mix roles professional_audio duck_roles works in ("duck the music under the ' +
        'dialogue"), which are never guessed from a track\'s name because a lane called ' +
        '"Music 2" routinely holds a voice-over. Label the track, then duck by role. ' +
        'Pass role: null to remove a label. Only the fields you provide change.',
    },
    z
      .object({
        trackId: z.string(),
        muted: boolean().optional(),
        locked: boolean().optional(),
        hidden: boolean().optional(),
        role: z.union([AudioRoleSchema, z.null()]).optional(),
      })
      .strict()
      .refine(
        (a) =>
          a.muted !== undefined ||
          a.locked !== undefined ||
          a.hidden !== undefined ||
          a.role !== undefined,
        { message: 'Set at least one of muted/locked/hidden/role.' },
      ),
    (a, ctx) => {
      // A role on a picture track is meaningless — the schema calls it "harmless
      // elsewhere", which is exactly how a mislabelled project gets built. Refused here,
      // at the boundary, where the sentence can name the track's actual type.
      if (a.role !== undefined) {
        const track = ctx.project.timeline.tracks.find((candidate) => candidate.id === a.trackId);
        if (track !== undefined && track.type !== 'audio') {
          throw new ToolRefusalError(
            `role labels an audio track, and "${a.trackId}" is a ${track.type} track. ` +
              'Mix roles describe sound; name the audio track carrying it.',
          );
        }
      }
      return [
        {
          type: 'set_track_flags',
          trackId: a.trackId,
          ...(a.muted !== undefined ? { muted: a.muted } : {}),
          ...(a.locked !== undefined ? { locked: a.locked } : {}),
          ...(a.hidden !== undefined ? { hidden: a.hidden } : {}),
          ...(a.role !== undefined ? { role: a.role } : {}),
        },
      ];
    },
  ),
  mutateTool(
    {
      name: 'set_clip_speed',
      description:
        "Set a clip's constant playback speed (schema v6 time-remap): 2 plays it 2× " +
        'faster, 0.5 at half speed. speed: null resets to 1×. The clip’s timeline length ' +
        'is recomputed from its (unchanged) source in/out points, so a speed-up shortens ' +
        'the clip and a slow-down lengthens it.',
      capabilities: ['edit', 'timing'],
    },
    z.object({ clipId: z.string(), speed: numeric(z.number().positive().nullable()) }).strict(),
    (a) => [{ type: 'set_clip_speed', clipId: a.clipId, speed: a.speed }],
  ),
  mutateTool(
    {
      name: 'set_clip_crop',
      description:
        'Crop/reframe a clip to a rectangle of its source frame (schema v7), given as ' +
        '0..1 fractions { x, y, width, height } from the top-left corner. crop: null ' +
        'clears the crop back to the full frame. Use it to reframe 16:9 footage into a ' +
        '9:16 subject-centered crop.',
      capabilities: ['edit', 'reframe'],
    },
    z.object({ clipId: z.string(), crop: CropRectSchema.nullable() }).strict(),
    (a) => [{ type: 'set_clip_crop', clipId: a.clipId, crop: a.crop }],
  ),
  mutateTool(
    {
      name: 'set_clip_blend_mode',
      description:
        'Set how a clip composites over the layers beneath it (schema v8): e.g. ' +
        "'screen', 'multiply', 'overlay', 'soft-light'. blendMode: null resets to " +
        "'normal'. Meaningful for overlay-track clips (light leaks, textures, glows).",
      capabilities: ['edit', 'compositing'],
    },
    z.object({ clipId: z.string(), blendMode: BlendModeSchema.nullable() }).strict(),
    (a) => [{ type: 'set_clip_blend_mode', clipId: a.clipId, blendMode: a.blendMode }],
  ),
];
