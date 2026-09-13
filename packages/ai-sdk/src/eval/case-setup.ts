/**
 * Starting states a golden case needs that no committed fixture ships.
 *
 * WHY this is not a turn: a case that asks the MODEL to build its own precondition measures
 * two things and reports one. `remove-duplicate-takes` asked turn 1 to "use the opening shot
 * three times"; a model that placed three different moments of that shot produced no
 * duplicate in the rubric's sense (overlapping source of one asset), so turn 2 had nothing to
 * score — and a model that DID follow it had "drop the duplicate takes" read as "the repeats
 * you just placed". The precondition is a fact the case asserts, so the runner places it.
 *
 * Applied in memory by the harness; no fixture file is ever written.
 */
import type { Clip, Project } from '@framepilot/timeline-schema';
import type { GoldenCaseSetup } from './golden-cases.js';

/** Extra copies of the opening shot `repeat-opening-shot` places after the last clip. */
export const OPENING_SHOT_REPEATS = 2;

/**
 * Apply a case's setup to its fixture project.
 *
 * @param project - The composed fixture project.
 * @param setup - The case's setup, or `undefined` for the fixture as shipped.
 * @returns The project the first turn starts from.
 * @throws If the fixture cannot carry the setup — a case that silently ran without its
 *   precondition would be scored as though it had one.
 */
export function applyCaseSetup(project: Project, setup: GoldenCaseSetup | undefined): Project {
  if (setup === undefined) return project;
  return repeatOpeningShot(project);
}

/** The opening shot's exact source range, placed {@link OPENING_SHOT_REPEATS} more times. */
function repeatOpeningShot(project: Project): Project {
  const track = project.timeline.tracks.find(
    (candidate) => candidate.type === 'video' && candidate.clips.length > 0,
  );
  if (track === undefined) {
    throw new Error(
      `repeat-opening-shot needs a video track with clips, and project "${project.id}" has none.`,
    );
  }
  const ordered = [...track.clips].sort((a, b) => a.start - b.start);
  const opening = ordered[0]!;
  const length = opening.end - opening.start;
  let cursor = ordered.reduce((end, clip) => Math.max(end, clip.end), 0);
  const repeats: Clip[] = [];
  for (let copy = 1; copy <= OPENING_SHOT_REPEATS; copy++) {
    const suffix = `__repeat_${String(copy)}`;
    repeats.push({
      ...opening,
      id: `${opening.id}${suffix}`,
      start: cursor,
      end: cursor + length,
      // Ids must stay unique across the project; everything else — the source range above
      // all — is the same take, which is the point.
      effects: opening.effects.map((effect) => ({ ...effect, id: `${effect.id}${suffix}` })),
      keyframes: opening.keyframes.map((keyframe) => ({
        ...keyframe,
        id: `${keyframe.id}${suffix}`,
      })),
    });
    cursor += length;
  }
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: project.timeline.tracks.map((candidate) =>
        candidate.id === track.id ? { ...candidate, clips: [...candidate.clips, ...repeats] } : candidate,
      ),
    },
  };
}
