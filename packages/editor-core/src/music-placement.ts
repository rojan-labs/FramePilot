/**
 * @framepilot/editor-core/music-placement — the one shape of "a fetched music
 * bed on the timeline".
 *
 * The audio twin of `stock-placement.ts`, and it exists for the same reason:
 * two callers place a downloaded track — the Sounds panel (a person clicked
 * **Add**) and the agent's `add_music` — in two packages that cannot import each
 * other. While each built its own operations they drifted, and the drift was
 * invisible: the two produced different layer ids and different fallback
 * lengths, so "the agent places what you would have placed" was true only for
 * tracks whose duration the provider happened to report.
 *
 * The decision is therefore made once, here; the callers add only their own
 * patch identity. `@framepilot/ai-sdk` re-exports this for the agent path.
 */
import type { Asset, Project, Timeline } from '@framepilot/timeline-schema';
import type { AnyOperation } from './patch.js';

/**
 * Bed length when a provider reported no duration. Openverse routinely omits it,
 * and a 5-second bed under a two-minute video would be a worse lie than a
 * 30-second one the user can see and trim.
 */
export const DEFAULT_MUSIC_SECONDS = 30;

/**
 * Default duck depth, matching `audio-commands.ts`: a duck requested without an
 * explicit amount lands on −12 dB — deep enough to clear speech, shallow enough
 * to keep the bed audible.
 */
export const DEFAULT_DUCK_DB = -12;

/**
 * The least picture a bed can be trimmed to: one frame at 60fps.
 *
 * Below this there is nothing to score. Trimming to it would produce a clip the frame grid
 * rounds away to nothing, and the validator would refuse the whole placement.
 */
const MIN_SCORED_SECONDS = 1 / 60;

/**
 * The next free `music_N` layer id for this timeline.
 *
 * Ids are per-project and stable within a run, so two placements in one turn
 * land on separate layers rather than colliding.
 */
export function nextMusicLayerId(timeline: Timeline): string {
  const taken = new Set(timeline.tracks.map((track) => track.id));
  for (let n = 1; ; n += 1) {
    const candidate = `music_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Track ids this project could actually duck a bed under, in timeline order.
 *
 * "Audio-capable" is the renderer's own rule, not a narrower one. `_duck_intervals`
 * (`render/compiler.py`) reads the sidechain track's CLIP INTERVALS and never looks at its
 * type, so a video track whose clips carry sound ducks the bed exactly as a dedicated
 * dialogue track does. `operation-contract.ts` and `audio-commands.ts` agree: both refuse
 * only `caption` and `effect`.
 *
 * A track with no clips is excluded because it has no intervals — the duck would compile
 * to an empty envelope and the bed would play at full level.
 */
function duckCandidateTrackIds(project: Project): string[] {
  return project.timeline.tracks
    .filter(
      (track) =>
        track.type !== 'caption' && track.type !== 'effect' && track.clips.length > 0,
    )
    .map((track) => track.id);
}

/**
 * The half of a refusal that tells the caller what WOULD work.
 *
 * A refusal with no legal move named is a dead end, and run `137d8fd0` is what one costs:
 * `add_music` was called with `duckUnderTrackId: "layer_audio_5"`, an audio track that
 * existed and held nothing. The refusal said "Place the dialogue first, or omit
 * duckUnderTrackId" — so the model omitted it, laid the bed at full level, and the
 * editor's explicit instruction ("duck the wind right down") was never carried out. The
 * timeline it was refused against had `v_main` on it, full of clips, carrying the very
 * wind the bed was meant to drop under. The one fact that would have rescued the call was
 * the one fact the sentence withheld.
 */
function duckCandidateSentence(project: Project): string {
  const candidates = duckCandidateTrackIds(project);
  if (candidates.length === 0) {
    return (
      'No track in this project carries sound yet, so nothing can be ducked under. ' +
      'Place that audio first, or omit duckUnderTrackId to lay the bed at full level.'
    );
  }
  return (
    `Tracks with clips to duck under: ${candidates.join(', ')} — a video track counts ` +
    'when its clips carry the sound you mean. Or omit duckUnderTrackId to lay the bed ' +
    'at full level.'
  );
}

/**
 * Why a requested `duckUnderTrackId` cannot be honored, or `null` when it can.
 *
 * The validator would accept a duck at an unknown sidechain track and the render
 * would then apply no duck at all — a bed the model believes is under the voice
 * but that plays at full level. So the sidechain is resolved HERE, where a
 * specific sentence can fail the call before any edit exists.
 *
 * Every refusal names the tracks that would have worked ({@link duckCandidateSentence}).
 */
export function musicDuckSidechainIssue(
  project: Project,
  duckUnderTrackId: string | undefined,
): string | null {
  if (duckUnderTrackId === undefined || duckUnderTrackId.trim() === '') return null;
  const track = project.timeline.tracks.find((candidate) => candidate.id === duckUnderTrackId);
  if (!track) {
    return (
      `duckUnderTrackId "${duckUnderTrackId}" is not a track in this project. ` +
      duckCandidateSentence(project)
    );
  }
  // Caught here rather than deeper: `operation-contract.ts` refuses these too, but it does
  // so after the placement ops are built, so the message the caller sees names an
  // `adjust_audio` op it never wrote instead of the argument it passed.
  if (track.type === 'caption' || track.type === 'effect') {
    return (
      `duckUnderTrackId "${duckUnderTrackId}" is a ${track.type} track, which carries no ` +
      `sound to duck under. ${duckCandidateSentence(project)}`
    );
  }
  if (track.clips.length === 0) {
    return (
      `duckUnderTrackId "${duckUnderTrackId}" names a track with no clips, so there is ` +
      `nothing to duck under. ${duckCandidateSentence(project)}`
    );
  }
  return null;
}

/**
 * Where the picture ends — the latest clip end on any video track, 0 when there is none.
 *
 * The video tracks are the picture spine: captions and overlays sit *over* it and cannot
 * stand in for it, and an audio track is the thing being measured against. Exported so a
 * caller can see the number the bed was trimmed to.
 */
export function pictureEndSeconds(timeline: Timeline): number {
  return timeline.tracks
    .filter((track) => track.type === 'video')
    .flatMap((track) => track.clips)
    .reduce((latest, clip) => Math.max(latest, clip.end), 0);
}

/**
 * The operations that put a downloaded track on the timeline: bin, layer, clip,
 * and — when a sidechain was requested — the duck that keeps speech clear.
 *
 * Returned as ONE list so they land in one patch and invert together: a single
 * undo takes all of them back rather than leaving an orphan asset, an empty
 * layer, or an unducked bed behind.
 *
 * The layer is labelled `role: 'music'` at creation, which is what lets
 * `adjust_audio`'s `duckUnderTrackId` and the role-based ducking controller see
 * the bed. The role is set here because this caller *knows*; it is never
 * inferred from a track name (ADR 0112).
 *
 * The clip id is deterministic (`${layerId}_clip`) because the duck op must name
 * the clip it adjusts in the SAME list — a derived fallback id would not be
 * knowable before apply.
 *
 * Callers must resolve the sidechain first ({@link musicDuckSidechainIssue}):
 * this builder trusts that the track exists, so the failure lands as one
 * specific sentence rather than as a silent no-op at render.
 *
 * @param timeline - Current timeline, for choosing a free layer id.
 * @param asset - The downloaded track.
 * @param atSeconds - Desired timeline start (seconds); clamped to >= 0.
 * @param duckUnderTrackId - Dialogue track the bed should drop under, if any.
 */
export function buildAddMusicOps(
  timeline: Timeline,
  asset: Asset,
  atSeconds = 0,
  duckUnderTrackId?: string,
): AnyOperation[] {
  const start = Math.max(0, atSeconds);
  const layerId = nextMusicLayerId(timeline);
  const track = asset.durationSeconds ?? DEFAULT_MUSIC_SECONDS;
  // A BED IS TRIMMED TO THE PICTURE IT SCORES. Laying the whole track down regardless of
  // what it is scoring does not add music to a video — it adds video-length music and then
  // however many seconds of black the track happens to be longer than the film.
  //
  // Run `e8cb2636` scored a 49.8-second talking head with a 93.6-second track and shipped
  // a 93.6-second programme: 43.9 seconds of silence-under-music over an empty frame. The
  // run's own self-check caught it — "43.867s of the 93.633s programme has no picture under
  // it … that renders as black" — as a WARNING, after the edit, and the run completed
  // anyway. It is not a thing to warn about. It is a thing not to do.
  //
  // With no picture on the timeline there is nothing to score yet — a music-led montage
  // lays the song first and cuts to it — so the whole track goes down, which is also what
  // every existing caller and test expects of an empty timeline.
  const picture = pictureEndSeconds(timeline);
  const room = picture - start;
  // A sliver of room is not room. A bed starting a millisecond before the picture ends
  // would otherwise be trimmed to a millisecond, which the frame grid rounds to nothing and
  // the validator rejects as a zero-length clip. Below one frame at 60fps the placement
  // reads as deliberately past the end — the end-card sting — and the whole track goes down.
  const duration = room >= MIN_SCORED_SECONDS ? Math.min(track, room) : track;
  const sidechain = duckUnderTrackId?.trim();
  return [
    { type: 'add_asset', asset },
    { type: 'add_layer', layerId, layerType: 'audio', atIndex: 0, role: 'music' },
    {
      type: 'add_clip',
      trackId: layerId,
      assetId: asset.id,
      clipId: `${layerId}_clip`,
      start,
      end: start + duration,
      sourceStart: 0,
      sourceEnd: duration,
    },
    ...(sidechain !== undefined && sidechain !== ''
      ? [
          {
            type: 'adjust_audio' as const,
            clipId: `${layerId}_clip`,
            gainDb: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
            duckUnderTrackId: sidechain,
            duckAmountDb: DEFAULT_DUCK_DB,
          },
        ]
      : []),
  ];
}
