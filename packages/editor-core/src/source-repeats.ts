/**
 * Picture clips that replay material another clip already plays.
 *
 * WHY THIS IS IN EDITOR-CORE (TRACKING.md Q5): asked to "drop the duplicate takes", a live
 * run deleted two UNIQUE clips — two different moments of the same asset — because nothing
 * the agent could read said which clips repeat each other. The only definition of a repeated
 * take lived in the eval rubric, where the product could not see it, so the model fell back
 * to asset identity and destroyed distinct footage. One definition, here, is read by the
 * prompt's clip rows, by `get_clips`, and by the rubric that scores the run — so what the
 * agent is told is a repeat and what it is scored against can never disagree.
 *
 * A repeat is a fact the project file proves: two picture clips of the SAME asset whose
 * SOURCE ranges overlap by more than {@link REPEATED_SOURCE_OVERLAP_SECONDS}. It is
 * deliberately not a perceptual similarity (tier 1's phash `duplicateOf`), which clusters
 * two separate recordings of one action and is a judgement, not a fact.
 */
import type { Clip, Project } from '@framepilot/timeline-schema';

/** Source seconds two clips of one asset must share before they are the same take twice. */
export const REPEATED_SOURCE_OVERLAP_SECONDS = 0.5;

/** Every clip on a picture (video) track, in timeline order. */
function pictureClipsInOrder(project: Project): readonly Clip[] {
  return project.timeline.tracks
    .filter((track) => track.type === 'video')
    .flatMap((track) => track.clips)
    .slice()
    .sort((a, b) => a.start - b.start);
}

function sharedSourceSeconds(a: Clip, b: Clip): number {
  return Math.min(a.sourceEnd, b.sourceEnd) - Math.max(a.sourceStart, b.sourceStart);
}

/**
 * Every pair of picture clips that plays the same material of the same asset twice.
 *
 * @param project - The project to read.
 * @returns `[earlier, later]` pairs in timeline order; empty when nothing repeats.
 */
export function repeatedSourcePairs(project: Project): readonly (readonly [Clip, Clip])[] {
  const clips = pictureClipsInOrder(project);
  const pairs: (readonly [Clip, Clip])[] = [];
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const earlier = clips[i]!;
      const later = clips[j]!;
      if (earlier.assetId !== later.assetId) continue;
      if (sharedSourceSeconds(earlier, later) > REPEATED_SOURCE_OVERLAP_SECONDS) {
        pairs.push([earlier, later]);
      }
    }
  }
  return pairs;
}

/**
 * For each clip that repeats earlier material, the FIRST clip on the timeline that already
 * plays it.
 *
 * Only the later clip of a pair is named, and always against the earliest original: "keep
 * the first, the rest replay it" is the reading an editor means by duplicate takes, and a
 * clip named as its own original's repeat would invite deleting the one worth keeping.
 *
 * @param project - The project to read.
 * @returns `clipId → originalClipId`; empty when nothing repeats.
 */
export function repeatedSourceOf(project: Project): ReadonlyMap<string, string> {
  const originals = new Map<string, string>();
  for (const [earlier, later] of repeatedSourcePairs(project)) {
    if (originals.has(later.id)) continue;
    originals.set(later.id, originals.get(earlier.id) ?? earlier.id);
  }
  return originals;
}
