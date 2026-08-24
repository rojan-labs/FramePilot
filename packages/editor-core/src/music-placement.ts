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
 * Why a requested `duckUnderTrackId` cannot be honored, or `null` when it can.
 *
 * The validator would accept a duck at an unknown sidechain track and the render
 * would then apply no duck at all — a bed the model believes is under the voice
 * but that plays at full level. So the sidechain is resolved HERE, where a
 * specific sentence can fail the call before any edit exists.
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
      'Pass the id of the dialogue track the bed should drop under.'
    );
  }
  if (track.clips.length === 0) {
    return (
      `duckUnderTrackId "${duckUnderTrackId}" names a track with no clips, so there is ` +
      'nothing to duck under. Place the dialogue first, or omit duckUnderTrackId.'
    );
  }
  return null;
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
  const duration = asset.durationSeconds ?? DEFAULT_MUSIC_SECONDS;
  const layerId = nextMusicLayerId(timeline);
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
