/**
 * @framepilot/ai-sdk/acceptance — what "done" means for a request, in checkable terms.
 *
 * ## Why this exists
 *
 * A run's objective was seeded from the request and never replaced: `objective.outcome`, the
 * single acceptance criterion, the committed decision and the criterion verification reported
 * against were all the same verbatim sentence the editor typed. `objective.provisional` was
 * documented as a placeholder that "yields to the first real interpretation", but nothing ever
 * produced one — `setObjective` had exactly one caller, the seed itself.
 *
 * The consequence was a verification that could only ever answer "did any operation succeed".
 * In the captured run a request for "20+ different best moments" was satisfied, as far as the
 * ledger was concerned, by an eight-shot timeline; the acceptance criterion was the request,
 * so nothing in it could be measured.
 *
 * ## What this reads, and what it deliberately does not
 *
 * Only conditions a deterministic check can settle against the timeline: a stated deliverable
 * length, and a stated minimum number of shots. Both are read the way
 * `critic.ts`'s `explicitDurationTargetSeconds` reads a duration — conservatively, requiring
 * the number to be attached to a deliverable word — because a wrong criterion is worse than a
 * missing one: it fails runs that did the work.
 *
 * Taste ("make it nice", "attractive"), rhythm ("beat synced") and retention ("retaining
 * watchers") are NOT extracted. They are real parts of the request and they belong to the
 * model's judgement; inventing a mechanical proxy for them would let a run pass or fail on a
 * measurement nobody asked for. They stay in the objective's prose.
 */

/** A condition the deterministic Critic can check against a finished timeline. */
export interface CheckableAcceptance {
  /** Stated deliverable length in seconds, when the request named one. */
  readonly durationSeconds?: number;
  /** Stated minimum number of distinct shots, when the request named one. */
  readonly minShotCount?: number;
}

/**
 * The lowest shot count worth treating as a target.
 *
 * "2 clips" is a description of an edit, not an acceptance condition, and small numbers appear
 * in ordinary prose far more often than they appear as requirements.
 */
const MIN_MEANINGFUL_SHOT_COUNT = 3;

/** Above this, the number is almost certainly not a shot count ("1000 subscribers"). */
const MAX_MEANINGFUL_SHOT_COUNT = 200;

/**
 * Words that make a number a count of SHOTS. "moment" is here because it is what editors
 * actually say ("use 20+ of the best moments"), and in a cut request a moment is a shot.
 */
const SHOT_NOUNS = 'clips?|shots?|moments?|cuts?|scenes?|segments?|angles?';

/**
 * Read a minimum shot count from ordinary creator language.
 *
 * Requires the number to sit next to a shot noun, so "30 second video" and "1080p" cannot be
 * mistaken for one. Both orders are accepted ("20+ moments", "at least 20 of the best shots"),
 * and a bare "a few clips" is deliberately not a number.
 */
export function explicitMinShotCount(prompt: string): number | undefined {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  // `20+ moments`, `at least 20 different best moments`, `use 20 clips`
  const pattern = new RegExp(`\\b(\\d+)\\s*\\+?\\s*(?:[a-z-]+\\s+){0,3}(?:${SHOT_NOUNS})\\b`);
  const match = pattern.exec(normalized);
  if (!match?.[1]) return undefined;
  // The pattern captures digits only, so this is always a number; the range check below is
  // what rejects both the implausible values and the absurd ones (a 400-digit string reads as
  // Infinity, which fails the upper bound).
  const count = Number(match[1]);
  if (count < MIN_MEANINGFUL_SHOT_COUNT || count > MAX_MEANINGFUL_SHOT_COUNT) return undefined;
  // A number that is really a duration ("30 second cuts") is not a shot count.
  if (
    new RegExp(`\\b${match[1]}\\s*(?:s|sec|secs|second|seconds|m|min|mins|minutes)\\b`).test(
      normalized,
    )
  ) {
    return undefined;
  }
  return count;
}

/**
 * The checkable conditions in a request, if any.
 *
 * @param prompt - The editor's request, verbatim.
 * @param durationSeconds - A duration already extracted by the caller (the Critic's own
 *   reader), so the two cannot disagree about what the request asked for.
 */
export function checkableAcceptance(
  prompt: string,
  durationSeconds: number | undefined,
): CheckableAcceptance {
  const minShotCount = explicitMinShotCount(prompt);
  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(minShotCount === undefined ? {} : { minShotCount }),
  };
}

/**
 * The acceptance criteria to record on the run's objective: one line per checkable condition,
 * then the request itself for everything judgement owns.
 *
 * The request stays LAST and always: it is the part no check settles, and dropping it would
 * narrow the run's memory of what was asked to whatever happened to be measurable.
 */
export function acceptanceCriteria(
  prompt: string,
  acceptance: CheckableAcceptance,
): readonly string[] {
  const criteria: string[] = [];
  if (acceptance.durationSeconds !== undefined) {
    criteria.push(`The finished sequence runs about ${String(acceptance.durationSeconds)}s.`);
  }
  if (acceptance.minShotCount !== undefined) {
    criteria.push(`The cut uses at least ${String(acceptance.minShotCount)} distinct shots.`);
  }
  criteria.push(prompt);
  return criteria;
}

/** True when at least one condition here can actually be checked. */
export function hasCheckableAcceptance(acceptance: CheckableAcceptance): boolean {
  return acceptance.durationSeconds !== undefined || acceptance.minShotCount !== undefined;
}
