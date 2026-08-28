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
  /**
   * Deliverables the request named that this product has no tool for at all — see
   * {@link unmeetableDeliverables}. Recorded so the run states the gap rather than
   * silently shipping without them.
   */
  readonly unmeetable?: readonly UnmeetableDeliverable[];
}

/** A deliverable no registered tool can produce. */
export type UnmeetableDeliverable = 'voiceover' | 'soundEffects';

/** What each unmeetable deliverable reads as in a criterion an editor will see. */
export const UNMEETABLE_LABEL: Record<UnmeetableDeliverable, string> = {
  voiceover:
    'Spoken narration cannot be produced here — FramePilot has no text-to-speech. Record ' +
    'or import a voice track and it can be cut, timed, and captioned like any other audio.',
  soundEffects:
    'Sound effects cannot be sourced here — the stock libraries cover music and picture, ' +
    'not SFX. Import the effects you want and they can be placed on the timeline.',
};

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
 * Every noun an editor uses for one picture on a timeline, in one place.
 *
 * There were two lists and they had drifted. The shot-count reader carried the stills
 * nouns — added for run `4c9b5f82`, whose brief said "photos" forty times and named no
 * other material — and the coverage reader did not, so on the same class of brief a
 * duration and a shot count were readable and "apply a unified cinematic grade across all
 * photos" was not. Run `fc10301a` produced no coverage criteria at all, and the three
 * treatments it then omitted entirely (motion, grade, crop) were the three no check could
 * see. One list, two readers, and a test that asserts they stay one.
 */
const PICTURE_NOUN_SOURCE =
  'clips?|shots?|moments?|cuts?|scenes?|segments?|photos?|images?|pictures?|stills?';

/**
 * Words that make a number a count of SHOTS. "moment" is here because it is what editors
 * actually say ("use 20+ of the best moments"), and in a cut request a moment is a shot.
 *
 * Stills are here for the same reason. Run 4c9b5f82's brief said **photos** — "approximately
 * 61 hiking photos", "attempt to use all approximately 61 hiking photos" — forty times over
 * 12,000 characters, and named no other kind of material. Not one of those was a shot noun,
 * so the run's only checkable count was unreadable and `checkShotCount` reported `skipped`
 * over a montage that used ten of the sixty-one. A photo placed on a timeline is a shot.
 */
const SHOT_NOUNS = `${PICTURE_NOUN_SOURCE}|angles?`;

/** Time units that make a number a duration rather than a count. */
const TIME_UNITS = 's|sec|secs|second|seconds|m|min|mins|minutes';

/**
 * A number is a REQUIREMENT rather than an aspiration when the brief marks it as a floor —
 * `50+`, `at least 50`, `minimum 50`, `no fewer than 50`.
 *
 * This is the discriminator that keeps the floor honest on a long spec. The captured brief
 * states its requirement five times with a marker ("50+ visually distinct clips", "at least
 * 50 separate video clips", "Minimum clips: 50", "50+ clips minimum", "At least 50 genuinely
 * distinct clips") and ALSO says "Prefer 60-80" and "Target approximately 80-120 candidate
 * clips". Taking the largest number would make the acceptance floor 120 and fail a cut of 80
 * that did everything asked. Marked floors win; unmarked ones are only consulted when the
 * brief states no floor at all.
 *
 * "all" marks a floor too — "use all 61 photos" is a requirement stated the way people
 * actually state it, and run 4c9b5f82's brief said exactly that. A spurious "all" beside a
 * small number is harmless because marked floors are reduced by `Math.max`; the only way to
 * be wrong is a spuriously LARGE one, and {@link POOL_WORDS} already removes the case that
 * produces those.
 */
const FLOOR_MARKER =
  /\b(?:at least|no fewer than|minimum|min|at minimum|use all|all of|every one of|all)\b[^.\n]{0,24}$/;

/**
 * Words that make a number a size of the SEARCH POOL, not of the deliverable.
 *
 * "Target approximately 80-120 candidate clips, then select the strongest 50+" asks for a
 * wide search and a narrow cut. Counting the pool as the floor would demand the whole pool
 * end up on the timeline.
 */
const POOL_WORDS = /\b(?:candidates?|pool|library|options?)\b/;

/**
 * The near end of a range is the floor: "60-80 clips" promises 60, never 80.
 *
 * The same rule round 2 established for durations, where a pacing table's `0.3-0.6s per clip`
 * produced a 0.6-second target for a fifty-clip montage.
 */
const RANGE_TAIL = /^\s*(?:-|–|—|to)\s*\d+/;

/**
 * `20+ moments`, `at least 20 different best moments`, `use 20 clips`.
 *
 * `(?<![\d.])` is what stops the fractional tail of a decimal reading as a count: a beat-map
 * table row `| 2 | 0.50s | 15 |` otherwise offers `50` to every pattern here, because `.` is a
 * non-word character and `\b` matches between it and the digit.
 */
const SHOT_COUNT_NUMBER_FIRST = new RegExp(
  `(?<![\\d.])(\\d+)(\\s*\\+)?\\s*(?:(?:-|–|—|to)\\s*\\d+\\s*)?(?:[a-z-]+\\s+){0,3}(?:${SHOT_NOUNS})\\b`,
  'g',
);

/**
 * `minimum clips: 50`, `clip count 50` — how a written SPEC states the same requirement.
 *
 * Only counted when a requirement word is present, so ordinary prose that happens to put a
 * number after a clip noun ("cuts 30 frames later") cannot be mistaken for a floor.
 */
const SHOT_COUNT_NOUN_FIRST = new RegExp(
  `\\b(?:min|minimum|at least|no fewer than|count|total|target)\\b[^.\\n]{0,20}?` +
    `(?:${SHOT_NOUNS})\\b[^.\\n]{0,12}?(?<![\\d.])(\\d+)`,
  'g',
);

/**
 * Is THIS occurrence of a number really a duration ("30 second cuts")?
 *
 * Asked of the matched span's own neighbourhood, never of the whole document. The guard used
 * to test the entire normalized prompt, so a match at index 218 was invalidated by unrelated
 * text thousands of characters away: a captured brief stated `50+ visually distinct clips` in
 * its opening requirement and `0.50s` in a beat-map EXAMPLE table, and the table won. That
 * silently removed the only checkable condition in a 9,885-character brief, which left
 * `checkShotCount` reporting `skipped` and let a one-clip timeline report `completed`.
 */
function readsAsDuration(normalized: string, index: number, digits: string): boolean {
  return new RegExp(`^${digits}\\s*(?:${TIME_UNITS})\\b`).test(
    normalized.slice(index, index + digits.length + 12),
  );
}

/** One stated count, with whether the brief marked it as a floor. */
interface StatedCount {
  readonly value: number;
  readonly isFloor: boolean;
}

/** Every plausible shot count in the prompt, each tagged as a marked floor or an aspiration. */
function statedShotCounts(normalized: string): StatedCount[] {
  const found: StatedCount[] = [];
  const collect = (pattern: RegExp, floorByConstruction: boolean): void => {
    // Fresh `lastIndex` per call: these are module-level `g` regexes, and a leftover offset
    // from a previous prompt would silently skip the head of this one.
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const digits = match[1];
      if (digits === undefined) continue;
      const at = match.index + match[0].indexOf(digits);
      // The pattern captures digits only, so this is always a number; the range check is what
      // rejects both the implausible values and the absurd ones (a 400-digit string reads as
      // Infinity, which fails the upper bound).
      const value = Number(digits);
      if (value < MIN_MEANINGFUL_SHOT_COUNT || value > MAX_MEANINGFUL_SHOT_COUNT) continue;
      if (readsAsDuration(normalized, at, digits)) continue;
      if (POOL_WORDS.test(match[0])) continue;
      const plus = match[2] !== undefined;
      const isFloor =
        floorByConstruction ||
        plus ||
        FLOOR_MARKER.test(normalized.slice(Math.max(0, at - 40), at));
      // A range's far end is never a floor, and the near end is already what was captured.
      if (!floorByConstruction && RANGE_TAIL.test(normalized.slice(at + digits.length))) {
        found.push({ value, isFloor: false });
        continue;
      }
      found.push({ value, isFloor });
    }
  };
  collect(SHOT_COUNT_NUMBER_FIRST, false);
  collect(SHOT_COUNT_NOUN_FIRST, true);
  return found;
}

/**
 * Read a minimum shot count from ordinary creator language.
 *
 * Requires the number to sit next to a shot noun, so "30 second video" and "1080p" cannot be
 * mistaken for one. Both orders are accepted ("20+ moments", "at least 20 of the best shots",
 * "minimum clips: 50"), and a bare "a few clips" is deliberately not a number.
 *
 * EVERY stated count is read rather than the first, because a long brief states its
 * requirement repeatedly and first-match-wins made which one counted an accident of ordering
 * — a brief opening with a throwaway "a few 3-shot sequences" would have set the target to 3.
 * Marked floors ("50+", "at least 50") win over aspirations ("prefer 60-80"), and the largest
 * marked floor is the one the cut has to clear. When nothing is marked, the SMALLEST stated
 * count is used: a wrong criterion fails runs that did the work, so an unmarked number is
 * read as the least it could mean.
 */
export function explicitMinShotCount(prompt: string): number | undefined {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  const counts = statedShotCounts(normalized);
  if (counts.length === 0) return undefined;
  const floors = counts.filter((c) => c.isFloor).map((c) => c.value);
  if (floors.length > 0) return Math.max(...floors);
  return Math.min(...counts.map((c) => c.value));
}

/**
 * A number sits next to a shot noun somewhere, but no floor could be read from it.
 *
 * The self-diagnosing half of the bug above: `checkShotCount` reporting `skipped — no shot
 * count was asked for` is indistinguishable, in the run record, from a brief that genuinely
 * stated none. On the captured run that line was the only trace of the failure and nothing
 * surfaced it. A brief long enough to be a spec, mentioning a number beside a clip noun and
 * still yielding nothing, is worth saying out loud — as a WARNING, which never blocks a run.
 */
const SPEC_LENGTH_CHARS = 1500;

/** Does this request mention a clip count that {@link explicitMinShotCount} could not read? */
export function mentionsUnreadableShotCount(prompt: string): boolean {
  if (prompt.length < SPEC_LENGTH_CHARS) return false;
  if (explicitMinShotCount(prompt) !== undefined) return false;
  SHOT_COUNT_NUMBER_FIRST.lastIndex = 0;
  return SHOT_COUNT_NUMBER_FIRST.test(prompt.trim().toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Words that make a statement about EVERY clip rather than about one.
 *
 * "across clips" and "per clip" are here because that is how editors write it — "light grade
 * across clips", "a subtle zoom per clip" — and both mean the whole cut.
 */
const UNIVERSAL_QUANTIFIER = /\b(every|each|all|across|per|throughout)\b/;

/**
 * The picture nouns a universal statement attaches to — the same list the shot-count
 * reader uses, because "every photo" and "every clip" are the same requirement.
 */
const CLIP_NOUN = new RegExp(`\\b(?:${PICTURE_NOUN_SOURCE})\\b`);

/**
 * How a treatment is named in ordinary creator language.
 *
 * Read per LINE, not per document: a brief says "Every clip must be reframed … and apply a
 * subtle dynamic zoom/pan per clip" on one line and "Light color grade for consistency across
 * clips" on another, and matching document-wide would let any universal quantifier anywhere
 * pull in every treatment mentioned anywhere.
 */
const TREATMENT_WORDS: readonly (readonly [CoverageTreatment, RegExp])[] = [
  // `no black bars` and `safe area` are crop requirements stated as their consequence,
  // which is how a delivery spec writes them ("9:16 … no black bars, no stretched photos").
  [
    'crop',
    /\b(reframe[sd]?|reframing|crop(?:ped|ping)?|fill the (?:full )?(?:vertical )?frame|no black bars|safe areas?)\b/,
  ],
  ['grade', /\b(grade[sd]?|grading|colou?r[- ]?correct(?:ed|ion)?)\b/],
  // `animation`/`motion`/`movement`/`parallax` are how a STILLS brief asks for the same
  // thing a video brief calls a push-in: "create motion inside them", "do not apply the
  // same animation to every image". Naming only the camera-move vocabulary meant the one
  // kind of footage that cannot move on its own was the one kind whose motion requirement
  // was invisible.
  [
    'motion',
    /\b(ken burns|zoom(?:ing)?|pan(?:ning)?|drift|push[- ]?in|punch[- ]?in|animat(?:e|ed|ion|ions)|motion|movement|parallax)\b/,
  ],
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

/**
 * The same request, written as a SECTION rather than a sentence.
 *
 * A long brief does not say "produce a rendered MP4" mid-paragraph; it ends with a heading
 * and puts the deliverable under it:
 *
 *     # FINAL DELIVERABLE
 *
 *     Create the finished Instagram Reel.
 *
 * {@link DELIVERABLE_FILE} bounds its gap with `[^.\n]{0,60}`, which cannot cross the
 * newline, so run `fc10301a`'s brief — whose closing section is exactly the above — read as
 * asking for no file at all. The run never attempted an export, never said it could not,
 * and handed back a timeline against a request for a video.
 *
 * The heading is required to BE a deliverable heading, and the noun has to appear within a
 * couple of lines of it. Precedent: {@link GENERATED_VOICEOVER} already reads the
 * scene-template field form (`**Voiceover:** …`) for the same reason — a structured brief
 * states its requirements as structure, and reading only prose misses them all.
 *
 * The leading marker class is horizontal-only (` \t\r`, not `\s`). A `\s` there also matches
 * the newline the `(?:^|\n)` alternation just consumed, so every blank line in a brief is two
 * ways to reach the same position — quadratic backtracking on a prompt the user writes, re-run
 * on every turn's prompt build. Markdown heading marks never span lines, so nothing real is lost.
 */
const DELIVERABLE_HEADING =
  /(?:^|\n)[ \t\r*_#>-]*(?:final )?deliverable[s]?\b[^\n]*(?:\n[^\n]*){0,3}?\b(mp4|mov|webm|file|video|reel|short|montage|edit)\b/;

/** Does this request ask for a rendered or exported file as its deliverable? */
export function asksForRenderedFile(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return DELIVERABLE_FILE.test(normalized) || DELIVERABLE_HEADING.test(normalized);
}

/** The narration nouns editors use, in both spellings. */
const VOICEOVER_NOUN = 'voice[- ]?over|narration|narrator|tts|text[- ]to[- ]speech|ai voice';

/**
 * Spoken narration the agent would have to GENERATE.
 *
 * Deliberately narrow, in two forms that both mean "one that does not exist yet":
 * an explicit verb ("add a voiceover", "write the narration"), or an INDEFINITE article
 * ("a reel with a voiceover"). "Cut on the voiceover" and "duck the music under the
 * narration" name audio the project already has, and the agent handles both — flagging
 * those would be a false alarm on ordinary work, which is worse than a missed disclosure.
 */
const GENERATED_VOICEOVER = new RegExp(
  `\\b(?:add|generate|create|make|write|record|produce|need|want)\\b[^.\n]{0,40}\\b(?:${VOICEOVER_NOUN})\\b` +
    `|\\bwith (?:a|an|some)\\b[^.\n]{0,20}\\b(?:${VOICEOVER_NOUN})\\b` +
    // A scene template's own FIELD — "**Voiceover:** …", "- Voiceover or dialogue". This is
    // how the captured brief asked, per scene, and neither form above could see it: there is
    // no verb and no article, just a heading the writer expects the agent to fill in.
    `|(?:^|\n)[\\s*_#>-]*(?:${VOICEOVER_NOUN})\\b[^\n]{0,20}:`,
);

/** Sound effects to be SOURCED — whooshes, impacts, risers, stingers. */
const SOURCED_SOUND_EFFECTS =
  /\b(sound\s?effects?|sfx|foley|whoosh(?:es)?|riser[s]?|stinger[s]?|bass hit[s]?|swoosh(?:es)?)\b/;

/**
 * Deliverables this product genuinely cannot produce, so a run can say so instead of
 * quietly omitting them.
 *
 * The precedent is {@link CheckableAcceptance.deliverableFile}, which exists for exactly
 * this reason and covered exactly one case. A captured brief also asked, per scene, for
 * voiceover and for sound effects — naming a sound-effects search tool it believed it had.
 * Neither exists in the tool registry: there is no text-to-speech tool and no SFX catalogue
 * (`search_music` is music, `search_stock` is picture). The run searched for neither,
 * mentioned neither, and would have delivered a silent, effect-less cut against a brief
 * whose every scene specified both.
 *
 * Recording the gap is disclosure, not capability. Whether to BUILD narration or SFX
 * sourcing is a separate product decision; being honest about their absence is not.
 */
export function unmeetableDeliverables(prompt: string): UnmeetableDeliverable[] {
  const normalized = prompt.toLowerCase();
  const missing: UnmeetableDeliverable[] = [];
  if (GENERATED_VOICEOVER.test(normalized)) missing.push('voiceover');
  if (SOURCED_SOUND_EFFECTS.test(normalized)) missing.push('soundEffects');
  return missing;
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
  const unmeetable = unmeetableDeliverables(prompt);
  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(minShotCount === undefined ? {} : { minShotCount }),
    ...(coverage.length === 0 ? {} : { coverage }),
    ...(asksForRenderedFile(prompt) ? { deliverableFile: true } : {}),
    ...(unmeetable.length === 0 ? {} : { unmeetable }),
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
  // Stated as a criterion so the run has to answer for it. A deliverable the product cannot
  // make is not a reason to say nothing — it is the one thing the editor most needs told,
  // because they will otherwise discover it by watching a silent cut.
  for (const deliverable of acceptance.unmeetable ?? []) {
    criteria.push(UNMEETABLE_LABEL[deliverable]);
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
    acceptance.deliverableFile === true ||
    (acceptance.unmeetable?.length ?? 0) > 0
  );
}
