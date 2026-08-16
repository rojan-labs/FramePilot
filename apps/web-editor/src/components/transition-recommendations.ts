/**
 * Context-aware transition suggestions for one cut.
 *
 * ## What this deliberately does not do
 *
 * It does not analyse the footage. Camera motion, scene brightness and music
 * energy would all make better suggestions, and every one of them needs an
 * analysis pass that may not have run — which would make the shelf appear and
 * disappear depending on state the user cannot see. Everything here is derived
 * from the TIMELINE alone, so the suggestions are always available, always
 * explicable, and never wrong for a reason nobody can inspect.
 *
 * (The analysis-backed suggestions belong with the footage-understanding work,
 * which already has the passes and the plumbing to say when they are ready.)
 *
 * ## Every suggestion carries its reason
 *
 * Not decoration. A suggestion with no stated reason is indistinguishable from a
 * random pick, and the first time one is wrong the whole shelf stops being
 * trusted. The reason is also what makes a suggestion *teach* something: "these
 * are two halves of one shot" is a fact about the edit the user may not have
 * noticed.
 */
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import {
  type CatalogTransition,
  getTransition,
} from '@framepilot/timeline-schema/transition-catalog';

export interface TransitionSuggestion {
  readonly transition: CatalogTransition;
  /** One sentence, shown under the tile and read out as its accessible name. */
  readonly reason: string;
}

/** Below this, a shot is a beat rather than a scene. */
const QUICK_SHOT_SECONDS = 1.6;
/** Above this, a shot has room for a transition that takes its time. */
const LONG_SHOT_SECONDS = 4;

const suggest = (id: string, reason: string): TransitionSuggestion | null => {
  const transition = getTransition(id);
  return transition === undefined ? null : { transition, reason };
};

/** The two clips a cut joins, in order, or `null` when there is no cut there. */
function cutClips(timeline: Timeline, toClipId: string): { from: Clip; to: Clip } | null {
  for (const track of timeline.tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    const index = ordered.findIndex((clip) => clip.id === toClipId);
    if (index <= 0) continue;
    return { from: ordered[index - 1]!, to: ordered[index]! };
  }
  return null;
}

/** The transition kind on the cut immediately before or after this one, if any. */
function neighbouringKind(timeline: Timeline, toClipId: string): string | null {
  for (const track of timeline.tracks) {
    const ordered = track.clips.slice().sort((a, b) => a.start - b.start);
    const index = ordered.findIndex((clip) => clip.id === toClipId);
    if (index < 0) continue;
    for (const neighbour of [ordered[index - 1], ordered[index + 1]]) {
      const effect = neighbour?.effects.find((e) => e.type === 'transition');
      const kind = effect?.params?.kind;
      if (typeof kind === 'string') return kind;
    }
  }
  return null;
}

/**
 * Up to `limit` suggestions for the cut entering `toClipId`, best first.
 *
 * Ordered by how specific the signal is: a fact about *these two clips* beats a
 * fact about the pace of the edit, which beats "this is usually safe".
 *
 * @param imageAssetIds - Asset ids that are stills. Optional; without it the
 *   still-specific suggestion is simply not made rather than guessed at.
 */
export function recommendTransitions(
  timeline: Timeline,
  toClipId: string,
  imageAssetIds: ReadonlySet<string> = new Set(),
  limit = 6,
): readonly TransitionSuggestion[] {
  const cut = cutClips(timeline, toClipId);
  if (cut === null) return [];
  const { from, to } = cut;
  const fromLength = from.end - from.start;
  const toLength = to.end - to.start;
  const out: (TransitionSuggestion | null)[] = [];

  // Most specific first: the two shots are two halves of the same take, which the
  // user may not have noticed and which changes what a transition should do.
  if (from.assetId === to.assetId && Math.abs(to.sourceStart - from.sourceEnd) < 0.5) {
    out.push(
      suggest('smooth-zoom', 'These are two halves of one shot — a drift hides the join.'),
      suggest('cross-dissolve', 'Same shot either side, so keep the treatment invisible.'),
    );
  }

  // Matching the neighbour is what makes a sequence feel edited rather than
  // decorated, and it is the single most common thing people do by hand.
  const neighbour = neighbouringKind(timeline, toClipId);
  if (neighbour !== null) {
    out.push(suggest(neighbour, 'Matches the transition on the cut next to this one.'));
  }

  if (imageAssetIds.has(from.assetId) && imageAssetIds.has(to.assetId)) {
    out.push(
      suggest('soft-dissolve', 'Two stills — a slow blend reads better than a hard join.'),
      suggest('luma-fade', 'Stills have no motion, so let the brightness carry the change.'),
    );
  }

  if (fromLength <= QUICK_SHOT_SECONDS && toLength <= QUICK_SHOT_SECONDS) {
    out.push(
      suggest('punch-zoom', 'Both shots are short — a fast hit keeps the pace.'),
      suggest('whip-pan-left', 'Quick cuts carry a whip well.'),
      suggest('flash', 'A flash lands on a beat without eating either shot.'),
    );
  } else if (fromLength >= LONG_SHOT_SECONDS && toLength >= LONG_SHOT_SECONDS) {
    out.push(
      suggest('soft-dissolve', 'Both shots have room — a slow dissolve suits the pace.'),
      suggest('light-leak', 'Long shots can carry a warmer, slower treatment.'),
    );
  }

  // The start and end of a sequence are the two places a fade to black is
  // actually right rather than merely available.
  const isLastCut = timeline.tracks.every((track) =>
    track.clips.every((clip) => clip.start <= to.start),
  );
  if (isLastCut) {
    out.push(suggest('fade-to-black', 'This is the last cut — a fade out closes the sequence.'));
  }

  out.push(
    suggest('cross-dissolve', 'The transition that is right more often than any other.'),
    suggest('soft-wipe', 'A feathered edge is a safe step up from a dissolve.'),
  );

  const seen = new Set<string>();
  const unique: TransitionSuggestion[] = [];
  for (const entry of out) {
    if (entry === null || seen.has(entry.transition.id)) continue;
    seen.add(entry.transition.id);
    unique.push(entry);
    if (unique.length >= limit) break;
  }
  return unique;
}
