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

/** A per-clip treatment a request can demand of the WHOLE cut. */
export type CoverageTreatment = 'crop' | 'grade' | 'motion' | 'speed';

/** A condition the deterministic Critic can check against a finished timeline. */
export interface CheckableAcceptance {
  /** Stated deliverable length in seconds, when the request named one. */
  readonly durationSeconds?: number;
  /** Stated minimum number of distinct shots, when the request named one. */
  readonly minShotCount?: number;
  /**
   * Treatments the request demanded of EVERY clip.
   *
   * The gap this closes: a brief whose text is dominated by "every clip", "per clip",
   * "across clips" was structurally invisible to acceptance, because the two conditions read
   * before this — a duration and a shot count — are both counts of the whole. So a run that
   * graded one clip of forty-seven and put its Ken Burns move on that same one clip satisfied
   * every criterion it had and reported "All checks passed".
   */
  readonly coverage?: readonly CoverageTreatment[];
  /**
   * True when the request asks for a rendered/exported FILE as its deliverable.
   *
   * The agent cannot produce one — render and export have no route from the AI panel
   * (`sidecar-executor.ts` refuses them with "use the Export dialog"). That is a reasonable
   * product boundary and it was invisible: run 2's brief closed with "One final rendered 30s
   * vertical MP4", the run never attempted it, never mentioned it, and reported completed.
   * Recording it is what lets the run say so.
   */
  readonly deliverableFile?: boolean;
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
 * Words that make a statement about EVERY clip rather than about one.
 *
 * "across clips" and "per clip" are here because that is how editors write it — "light grade
 * across clips", "a subtle zoom per clip" — and both mean the whole cut.
 */
const UNIVERSAL_QUANTIFIER = /\b(every|each|all|across|per|throughout)\b/;

/** The clip nouns a universal statement attaches to. */
const CLIP_NOUN = /\b(clips?|shots?|moments?|cuts?|scenes?|segments?)\b/;

/**
 * How a treatment is named in ordinary creator language.
 *
 * Read per LINE, not per document: a brief says "Every clip must be reframed … and apply a
 * subtle dynamic zoom/pan per clip" on one line and "Light color grade for consistency across
 * clips" on another, and matching document-wide would let any universal quantifier anywhere
 * pull in every treatment mentioned anywhere.
 */
const TREATMENT_WORDS: readonly (readonly [CoverageTreatment, RegExp])[] = [
  ['crop', /\b(reframe[sd]?|reframing|crop(?:ped|ping)?|fill the (?:full )?(?:vertical )?frame)\b/],
  ['grade', /\b(grade[sd]?|grading|colou?r[- ]?correct(?:ed|ion)?)\b/],
  ['motion', /\b(ken burns|zoom(?:ing)?|pan(?:ning)?|drift|push[- ]?in|punch[- ]?in)\b/],
  ['speed', /\b(speed ramp|ramp(?:ed|ing)?|slow[- ]?mo(?:tion)?|retim(?:e|ed|ing))\b/],
];

/**
 * Treatments a request demands of every clip, read line by line.
 *
 * Requires BOTH a universal quantifier and a clip noun on the same line as the treatment, so
 * "punch in on the reveal" (one moment) and "grade the opening" (one span) are not mistaken
 * for whole-cut requirements.
 */
export function explicitCoverage(prompt: string): readonly CoverageTreatment[] {
  const found = new Set<CoverageTreatment>();
  for (const rawLine of prompt.split(/[\n.;]/)) {
    const line = rawLine.toLowerCase();
    if (!UNIVERSAL_QUANTIFIER.test(line) || !CLIP_NOUN.test(line)) continue;
    for (const [treatment, pattern] of TREATMENT_WORDS) {
      if (pattern.test(line)) found.add(treatment);
    }
  }
  return [...found];
}

/**
 * A request for a FILE, not just an edit: a render or export verb next to something that
 * names a file. "Export the video" and "one final rendered MP4" both qualify; "render the
 * captions legible" does not, because nothing there is a file.
 */
const DELIVERABLE_FILE =
  /\b(render(?:ed|ing)?|export(?:ed|ing)?|deliver(?:ed|able)?)\b[^.\n]{0,60}\b(mp4|mov|webm|file|video|deliverable)\b|\b(mp4|mov|webm|file|deliverable)\b[^.\n]{0,40}\b(render(?:ed|ing)?|export(?:ed|ing)?)\b/;

/** Does this request ask for a rendered or exported file as its deliverable? */
export function asksForRenderedFile(prompt: string): boolean {
  return DELIVERABLE_FILE.test(prompt.toLowerCase());
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
  const coverage = explicitCoverage(prompt);
  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(minShotCount === undefined ? {} : { minShotCount }),
    ...(coverage.length === 0 ? {} : { coverage }),
    ...(asksForRenderedFile(prompt) ? { deliverableFile: true } : {}),
  };
}

/**
 * The criterion standing in for everything the request asks that no check can settle.
 *
 * It used to be the request PASTED IN — `criteria.push(prompt)`. The intent was right (the
 * unmeasurable half of the ask must not be forgotten) and the mechanism was a copy: the run
 * already persists the request verbatim as `objective.request`, one field away, and the
 * copy then rode along into `decisions`, `objectives`, `nextAction` and every telemetry row
 * that carries the working state. In a captured run that was a ~7,000-token brief stored
 * five times over, and `briefing.ts` has to filter four of those copies back out as noise
 * before it can render anything.
 *
 * A pointer keeps the meaning and drops the duplication. Nothing is lost: every reader of
 * the criteria holds the objective it belongs to.
 */
export const JUDGEMENT_CRITERION =
  'Everything else the request asks for — taste, pacing, structure — which no automatic ' +
  'check settles. Judge it against the request itself.';

/**
 * The acceptance criteria to record on the run's objective: one line per checkable condition,
 * then {@link JUDGEMENT_CRITERION} for everything judgement owns.
 */
export function acceptanceCriteria(acceptance: CheckableAcceptance): readonly string[] {
  const criteria: string[] = [];
  if (acceptance.durationSeconds !== undefined) {
    criteria.push(`The finished sequence runs about ${String(acceptance.durationSeconds)}s.`);
  }
  if (acceptance.minShotCount !== undefined) {
    criteria.push(`The cut uses at least ${String(acceptance.minShotCount)} distinct shots.`);
  }
  for (const treatment of acceptance.coverage ?? []) {
    criteria.push(`Every picture clip carries its ${COVERAGE_LABEL[treatment]}.`);
  }
  if (acceptance.deliverableFile === true) {
    criteria.push('A rendered file is delivered (the Export dialog, not this panel).');
  }
  criteria.push(JUDGEMENT_CRITERION);
  return criteria;
}

/** How each treatment reads in a criterion an editor will see. */
export const COVERAGE_LABEL: Record<CoverageTreatment, string> = {
  crop: 'own reframe',
  grade: 'colour grade',
  motion: 'own motion (zoom/pan)',
  speed: 'speed change',
};

/** True when at least one condition here can actually be checked. */
export function hasCheckableAcceptance(acceptance: CheckableAcceptance): boolean {
  return (
    acceptance.durationSeconds !== undefined ||
    acceptance.minShotCount !== undefined ||
    (acceptance.coverage?.length ?? 0) > 0 ||
    acceptance.deliverableFile === true
  );
}
