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
import { BlendModeSchema, CropRectSchema } from '@framepilot/timeline-schema';
import type { Timeline, Track } from '@framepilot/timeline-schema';
import {
  buildTimelineMap,
  listEditBoundaries,
  mapSequenceTime,
  mapSourceTime,
  mapTranscript,
} from '@framepilot/editor-core';
import { proposeCandidates } from '../proposers/candidate-proposer.js';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool, noArgs, readTool } from './tool-factories.js';
import { boolean, filterString, numeric, seconds } from './tool-args.js';

const clipDeleteOp = (
  timeline: Timeline,
  clipId: string,
  ripple: boolean,
): { type: 'delete_range' | 'ripple_delete'; trackId: string; start: number; end: number } => {
  const found = findClipById(timeline, clipId);
  if (!found) {
    throw new Error(`Unknown clip "${clipId}". Use get_clips to list real clip ids.`);
  }
  return {
    type: ripple ? 'ripple_delete' : 'delete_range',
    trackId: found.track.id,
    start: found.clip.start,
    end: found.clip.end,
  };
};

/**
 * Compact clip row for windowed listings (`get_clips`). Deliberately omits the
 * heavy nested payloads (effects, keyframes, caption style) and replaces them
 * with counts/flags, so a long-form timeline can be scanned cheaply; `get_clip`
 * returns the full clip when the detail is actually needed.
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

// `propose_edits` (plan FI4.1) takes the signals the model already gathered — map_footage
// chapters/highlights, analyze_silence ranges, detect_scenes cuts, and a vertical-target
// flag — and returns grounded, cited edit candidates. All inputs are optional so the model
// can propose from whatever it has; transcript emphasis is read from the project.
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
    verticalTarget: boolean().optional(),
  })
  .strict();

// `get_transcript` window (all optional): only words overlapping [start, end) are
// returned, so an hour-long transcript can be read a section at a time instead of
// wholesale. No args keeps today's full-transcript behavior.
const transcriptWindowSchema = z
  .object({ start: seconds.optional(), end: seconds.optional() })
  .strict();

const trimSchema = z.object({ clipId: z.string(), start: seconds, end: seconds }).strict();
export const TIMELINE_TOOLS: readonly ToolSpec[] = [
  readTool(
    { name: 'get_timeline', description: 'Return the current timeline (tracks/clips).' },
    noArgs,
    (_args, ctx) => ctx.project.timeline,
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
      name: 'propose_edits',
      description:
        'Turn footage understanding into GROUNDED, citable edit candidates — the bridge ' +
        'from "what is in the footage" to "where the moves go". Pass the signals you have ' +
        'already gathered (map_footage chapters/highlights, analyze_silence ranges, ' +
        'detect_scenes cuts, and whether the target is vertical); returns a ranked list of ' +
        'candidates [{ kind: punch_in|reframe|speed|cut|broll, t0, t1, why, cite, score }] ' +
        'in timeline seconds, each citing the real span it came from. Deterministic — every ' +
        'candidate is real; YOU choose which to apply and emit the patch. Does not edit the ' +
        'timeline. Reads transcript emphasis from the project automatically.',
      capabilities: ['analysis', 'visual'],
    },
    proposeEditsSchema,
    (a, ctx) =>
      proposeCandidates({
        ...(a.chapters ? { chapters: a.chapters } : {}),
        ...(a.highlights ? { highlights: a.highlights } : {}),
        ...(a.silences ? { silences: a.silences } : {}),
        ...(a.sceneCuts ? { sceneCuts: a.sceneCuts } : {}),
        ...(a.verticalTarget !== undefined ? { verticalTarget: a.verticalTarget } : {}),
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
      const tracks = ctx.project.timeline.tracks.map((track) => ({
        id: track.id,
        type: track.type,
        clipCount: track.clips.length,
        firstClipStart: track.clips.length ? Math.min(...track.clips.map((c) => c.start)) : null,
        lastClipEnd: track.clips.length ? Math.max(...track.clips.map((c) => c.end)) : null,
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
        'you it did.',
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
      if (a.sequenceTime !== undefined) {
        return { at: mapSequenceTime(map, a.sequenceTime), revision: map.revision };
      }
      // No timestamp asked about ⇒ hand back the whole mapping rather than
      // erroring: every read tool must answer usefully with no arguments, and
      // the map is the right answer to "tell me about the timing".
      if (a.sourceTime === undefined) return map;
      const assetId = a.assetId ?? ctx.project.assets[0]?.id;
      if (assetId === undefined) {
        throw new Error('map_time needs an assetId — this project has no assets.');
      }
      return {
        hits: mapSourceTime(map, assetId, a.sourceTime),
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
        'carrying it — grouped into runs that never cross a cut. This is what captions, ' +
        'markers, and any "quote the video at time T" answer must be built from. Words ' +
        'in deleted footage are gone, so anything you read here is genuinely audible.',
    },
    transcriptWindowSchema,
    (a, ctx) => {
      const map = buildTimelineMap(ctx.project.timeline);
      const mapped = mapTranscript(map, ctx.project.transcript);
      if (a.start === undefined && a.end === undefined) return mapped;
      const start = a.start ?? Number.NEGATIVE_INFINITY;
      const end = a.end ?? Number.POSITIVE_INFINITY;
      return {
        ...mapped,
        words: mapped.words.filter((w) => w.end > start && w.start < end),
        runs: mapped.runs.filter((r) => r.end > start && r.start < end),
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
    (_args, ctx) => listEditBoundaries(ctx.project.timeline, ctx.project.assets),
  ),
  readTool(
    {
      name: 'get_clips',
      description:
        'List clips as compact rows (ids, times, source in/out, effect/keyframe ' +
        'counts), optionally filtered to one trackId and/or a start/end window ' +
        '(timeline seconds), paginated with offset/limit (default 50, max 200). ' +
        'Returns { clips, total, hasMore }. Use this instead of get_timeline on a ' +
        'long-form project; use get_clip for one clip in full detail.',
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
      if (!found) return { error: `Unknown clip "${a.clipId}". Use get_clips to list real ids.` };
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
        "the same amount. Use to tighten or extend one clip's edges.",
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
    (a, ctx) => [clipDeleteOp(ctx.project.timeline, a.clipId, a.ripple ?? false)],
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
        clipDeleteOp(ctx.project.timeline, clipId, ripple),
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
      name: 'move_clip',
      description: 'Move a clip to a track at a new timeline start time (duration unchanged).',
    },
    z.object({ clipId: z.string(), toTrackId: z.string(), toStart: seconds }).strict(),
    (a) => [{ type: 'move_clip', clipId: a.clipId, toTrackId: a.toTrackId, toStart: a.toStart }],
  ),
  mutateTool(
    {
      name: 'add_track',
      description:
        'Create a new empty track (a "layer") to get a free lane for clips that ' +
        'would otherwise overlap. Clips on one track can never overlap, so this is ' +
        'how you stack simultaneous elements — a title over b-roll, picture-in-' +
        'picture, an extra overlay, or a second audio bed — when no existing track ' +
        "has a free range. `type` is the track's advisory role " +
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
        'track whose range is free — clips on one track can never overlap.',
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
    (a) => [
      {
        type: 'add_clip',
        trackId: a.trackId,
        assetId: a.assetId,
        start: a.start,
        end: a.end,
        sourceStart: a.sourceStart,
        sourceEnd: a.sourceStart + (a.end - a.start),
      },
    ],
  ),
  mutateTool(
    {
      name: 'set_track_flags',
      description:
        'Mute/unmute, lock/unlock, or hide/show a track (schema v4). Muting silences ' +
        "a track's audio in the render; hiding drops a visual track's picture; locking " +
        'prevents edits. Only the provided flags change; omit a flag to leave it as-is.',
    },
    z
      .object({
        trackId: z.string(),
        muted: boolean().optional(),
        locked: boolean().optional(),
        hidden: boolean().optional(),
      })
      .strict()
      .refine((a) => a.muted !== undefined || a.locked !== undefined || a.hidden !== undefined, {
        message: 'Set at least one of muted/locked/hidden.',
      }),
    (a) => [
      {
        type: 'set_track_flags',
        trackId: a.trackId,
        ...(a.muted !== undefined ? { muted: a.muted } : {}),
        ...(a.locked !== undefined ? { locked: a.locked } : {}),
        ...(a.hidden !== undefined ? { hidden: a.hidden } : {}),
      },
    ],
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
