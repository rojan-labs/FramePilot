/**
 * What a wrong clip id is told.
 *
 * The same finding as `dca15af` ("a wrong track id is answered with the right ones"), one
 * level down. A clip id the model got wrong is almost never a wild guess: it is `clip_01`
 * for `clip_001`, or an asset id, or a track id — an identity the author has already read
 * somewhere and re-typed from memory. Answering it with "Use get_clips to list real ids"
 * spends a whole turn on a fact that is in hand at the moment the error is thrown.
 *
 * So the answer carries the fact instead: the nearest real ids first, then what is actually
 * on the timeline, bounded at eight with a count for the rest. No model call, no fuzzy
 * *resolution* — nothing here decides what the author meant, it only says what exists.
 */
import type { Clip, Project, Timeline } from '@framepilot/timeline-schema';

/** At most this many real clips are listed back; beyond it the count carries the rest. */
const NAMED_CLIPS = 8;

/** At most this many near-miss ids are offered before the timeline listing. */
const NEAREST_IDS = 3;

/**
 * How alike two ids must be to be worth naming as a near miss, as a share of the longer
 * id. `clip_01` → `clip_001` scores 0.875; two unrelated ids of the same shape score far
 * below this, and naming them would be a guess dressed as help.
 */
const NEAREST_MIN_SIMILARITY = 0.6;

/** The project fields this needs — so a caller can pass a working copy, not a whole file. */
export type ClipCandidateProject = Pick<Project, 'timeline'> & Partial<Pick<Project, 'assets'>>;

/** Levenshtein distance, iterative two-row form. Small ids, no dependency. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** 1 for identical ids, 0 for nothing in common. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

interface PlacedClip {
  readonly clip: Clip;
  readonly trackId: string;
}

/**
 * Every clip, in timeline order: tracks in the order the project stores them, clips within
 * a track by start time. Deterministic, so the same wrong id always gets the same answer.
 */
function timelineClips(timeline: Timeline): readonly PlacedClip[] {
  return timeline.tracks.flatMap((track) =>
    [...track.clips]
      .sort((x, y) => x.start - y.start || x.id.localeCompare(y.id))
      .map((clip) => ({ clip, trackId: track.id })),
  );
}

/** `40` rather than `40.00`, `62.5` rather than `62.500000001`. */
const seconds = (value: number): string => String(Number(value.toFixed(2)));

/** `clip_003 (V1 40–62s)` — the id, where it lives, and when it plays. */
const describeClip = ({ clip, trackId }: PlacedClip): string =>
  `${clip.id} (${trackId} ${seconds(clip.start)}–${seconds(clip.end)}s)`;

/** Up to {@link NAMED_CLIPS} clips, with a count and a pointer when there are more. */
function listClips(clips: readonly PlacedClip[]): string {
  const named = clips.slice(0, NAMED_CLIPS);
  const rest = clips.length - named.length;
  const listed = named.map(describeClip).join(', ');
  return rest > 0 ? `${listed}, …and ${String(rest)} more; get_clips lists them all` : listed;
}

/**
 * The clip ids that DO exist, phrased as one line to append to an unknown-clip message.
 *
 * The answer changes with what the wrong id turns out to BE:
 * - an asset id → the clips cut from that asset, because "clip_001 is an asset id" is the
 *   whole correction and the right clip is one of a handful rather than one of fifty;
 * - a track id → the clips on that track, same reason;
 * - anything else → the near misses by string similarity first, then the timeline.
 *
 * @param project - The project (or working copy) the id was resolved against.
 * @param wrongId - The id that resolved to nothing.
 * @returns One line, always non-empty, with no leading space — callers join it themselves.
 */
export function clipCandidates(project: ClipCandidateProject, wrongId: string): string {
  const clips = timelineClips(project.timeline);
  if (clips.length === 0) return 'This timeline has no clips yet.';

  const asset = project.assets?.find((candidate) => candidate.id === wrongId);
  if (asset) {
    const fromAsset = clips.filter((placed) => placed.clip.assetId === wrongId);
    return fromAsset.length === 0
      ? `"${wrongId}" is an asset id, and no clip on the timeline uses it yet.`
      : `"${wrongId}" is an asset id — clips on it: ${listClips(fromAsset)}.`;
  }

  const track = project.timeline.tracks.find((candidate) => candidate.id === wrongId);
  if (track) {
    const onTrack = clips.filter((placed) => placed.trackId === wrongId);
    return onTrack.length === 0
      ? `"${wrongId}" is a track id, and it has no clips.`
      : `"${wrongId}" is a track id — clips on it: ${listClips(onTrack)}.`;
  }

  const nearest = clips
    .map((placed) => ({ id: placed.clip.id, score: similarity(wrongId, placed.clip.id) }))
    .filter((scored) => scored.score >= NEAREST_MIN_SIMILARITY)
    // Ties keep timeline order: `sort` is stable, and the input already is.
    .sort((x, y) => y.score - x.score)
    .slice(0, NEAREST_IDS)
    .map((scored) => scored.id);

  const closest = nearest.length > 0 ? `Closest real clip ids: ${nearest.join(', ')}. ` : '';
  return `${closest}Clips on the timeline: ${listClips(clips)}.`;
}
