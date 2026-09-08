/**
 * @framepilot/ai-sdk/eval/golden-cases — the golden set (goal.md Phase 0).
 *
 * Real user requests over the real mission fixtures, one per request category the
 * evaluation must cover: trims, silence removal, reordering, captions, pacing, hooks,
 * b-roll, audio, compound requests, vague requests, impossible requests, and requests
 * that must be refused or clarified. Each turn names the rubric that scores its outcome
 * (`mission-rubric.ts` — checkable assertions on the resulting edit state, never a string
 * match on prose) and the intent the agent is expected to form.
 *
 * WHY data and not code: the runner (`scripts/mission-baseline.mjs`), the metrics
 * (`golden-metrics.ts`) and the tests all read the same list, so a case added here is
 * runnable, scorable and covered by the shape test at once.
 *
 * Fixture projects are generated on the maintainer's machine by
 * `scripts/mission-fixture-projects.mjs` (media is not committed). Their shape, which the
 * prompts below rely on:
 *   - `mission-montage`  — 5 raw clips on `video_1` (camera 40 s, b-roll 22/9/15/50 s),
 *                          two beat tracks in the bin, no transcript, 9:16.
 *   - `mission-podcast`  — one 12-minute 360p narration clip with 116 real pauses cut
 *                          into it, transcript (1,464 words). Not the 9.6-minute dialogue
 *                          clip it was until 2026-09-05: that one's transcript was 92% ASR
 *                          loop, so every case here that reads words was selecting from a
 *                          fabrication (`fetch-fixtures.sh`, `speech-9min-c`).
 *   - `mission-talk`     — one 8.8-minute narration clip, `beat-100bpm.wav` in the bin,
 *                          transcript (1,465 words).
 *   - `mission-overlay`  — the same narration, gapless on `video_1`, plus an EMPTY second
 *                          video track `b_roll` and two b-roll clips in the bin. Run
 *                          `369e8c82`'s shape: because the picture track is gapless, every
 *                          placement on `b_roll` overlaps the picture beneath it — the shape ADR 0169 governs.
 */
import type { MissionScenarioId } from './mission-rubric.js';

export type GoldenCategory =
  | 'trim'
  | 'silence'
  | 'reorder'
  | 'captions'
  | 'pacing'
  | 'hook'
  | 'broll'
  | 'audio'
  | 'compound'
  | 'vague'
  | 'impossible'
  | 'guard'
  | 'clarify'
  | 'montage'
  | 'highlight'
  | 'beat'
  | 'memory'
  // plan/visual-understanding VU0.3: requests that cannot be answered from clip geometry.
  | 'color'
  | 'transitions'
  | 'duplicates'
  | 'question';

/** The categories goal.md Phase 0 names; the shape test asserts each has a case. */
export const REQUIRED_CATEGORIES: readonly GoldenCategory[] = [
  'trim',
  'silence',
  'reorder',
  'captions',
  'pacing',
  'hook',
  'broll',
  'audio',
  'compound',
  'vague',
  'impossible',
  'guard',
  'clarify',
];

/**
 * What the agent should decide to do. `edit` — apply a change; `ask` — one precise
 * question before anything is applied; `decline` — explain why it cannot, change nothing;
 * `answer` — the request was a QUESTION, so the right outcome is a reply and an untouched
 * timeline (VU0.3); `ask-or-edit` — the ambiguity policy allows either a question or a
 * cheap reversible edit with the assumption stated.
 *
 * `answer` and `decline` look identical to {@link observeIntent} — no operation, some
 * text — and are kept apart here because they are different expectations of the agent, and
 * a report that called "which clips are dark?" a refusal would be describing the wrong
 * behaviour. `intentMatches` maps both onto the same observation.
 */
export type ExpectedIntent = 'edit' | 'ask' | 'decline' | 'answer' | 'ask-or-edit';

export interface GoldenTurn {
  /** What the user types. */
  readonly prompt: string;
  readonly rubric: MissionScenarioId;
  readonly intent: ExpectedIntent;
  readonly beatPeriodSeconds?: number;
  /** `refine-tighten`: the clips the request names as "keep" are resolved at run time. */
  readonly keep?: 'first-last';
  readonly expectedFirstClipEndSeconds?: number;
  /** The programme length the prompt asked for, when it named one. Defaults to 60. */
  readonly durationTargetSeconds?: number;
  readonly expectedHeadTrimSeconds?: number;
  readonly cutawayWindowSeconds?: readonly [number, number];
  readonly captionStyle?: { readonly textTransform?: string; readonly position?: string };
  /**
   * What the scripted operator answers if the agent asks.
   *
   * Absent ⇒ the operator DECLINES, and the runner settles the question as
   * `{ kind: 'cancelled' }` — which the orchestrator turns into a `cancelled` status and
   * the turn loop treats as a stop before any op is applied. That is what "ends the turn
   * without an edit" has to mean if a case is to measure what it claims: handing the model
   * {@link DEFAULT_ASK_ANSWER} as a real answer instead made a clarify case measure
   * whether the model would obey a sentence (it did not — `clarify-which-clip` reframed
   * all five clips after being told to change nothing), and MASKED the deviation in a
   * guard case (an agent that asks for wipe confirmation, which ADR 0166 explicitly
   * refuses, was answered and allowed to proceed to a perfect score).
   */
  readonly answer?: string;
}

export interface GoldenCase {
  readonly id: string;
  readonly category: GoldenCategory;
  /** Fixture project id under `tests/fixtures/mission/projects`. */
  readonly project: string;
  /**
   * Compose: add this fixture project's un-placed video assets to the bin as b-roll.
   * The runner does this in memory; no fixture is written.
   */
  readonly brollFrom?: string;
  /** Basename of the music file the prompt names, resolved to an asset id at run time. */
  readonly musicAssetName?: string;
  readonly turns: readonly GoldenTurn[];
  /** Why this case is in the set — the failure it exists to catch. */
  readonly why: string;
}

/**
 * How the scripted operator's decline READS, for transcripts and reports.
 *
 * No longer sent to the model as an answer: a case with no `answer` of its own settles the
 * question as a dismissal (see {@link GoldenTurn.answer}). Kept because a decline still has
 * to be describable in a report, and because the wording documents what it means.
 */
export const DEFAULT_ASK_ANSWER =
  'No answer — stop here and make no change to the timeline.';

export const GOLDEN_CASES: readonly GoldenCase[] = [
  // ── The six mission scenarios (plan/system-mission), unchanged ─────────────────────
  {
    id: 'montage-30s',
    category: 'montage',
    project: 'mission-montage',
    why: 'The flagship raw-footage → short loop; open-ended selection over five raw clips.',
    turns: [
      {
        prompt:
          'Create a 30-second fast-paced social montage from the raw footage on the timeline. Pick the strongest moments, vary the shot lengths, keep it vertical.',
        rubric: 'montage-30s',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'podcast-highlight-60s',
    category: 'highlight',
    project: 'mission-podcast',
    why: 'Transcript-grounded selection; a cut inside a word is the audible failure.',
    turns: [
      {
        prompt:
          'Pull the best 60 seconds of this recording into a highlight clip. Do not cut mid-sentence.',
        rubric: 'podcast-highlight-60s',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'remove-dead-air',
    category: 'silence',
    project: 'mission-podcast',
    why: 'Deterministic silence detection must never be done by the model; ~250 ripple deletes in one patch.',
    turns: [
      {
        prompt: 'Remove the dead air and long pauses from this recording.',
        rubric: 'remove-dead-air',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'beat-sync',
    category: 'beat',
    project: 'mission-montage',
    musicAssetName: 'beat-100bpm.wav',
    why: 'Cuts must land on a measured beat grid, not an estimated one.',
    turns: [
      {
        prompt:
          'Put the 100 BPM music track (beat-100bpm) under the footage and cut the picture to the beat. Aim for about 30 seconds.',
        rubric: 'beat-sync',
        intent: 'edit',
        beatPeriodSeconds: 0.6,
      },
    ],
  },
  {
    id: 'refine-tighten',
    category: 'pacing',
    project: 'mission-montage',
    why: 'A second turn must refine the existing edit, not restart it, and must leave the named clips alone.',
    turns: [
      {
        prompt:
          'Create a 30-second fast-paced social montage from the raw footage on the timeline.',
        rubric: 'montage-30s',
        intent: 'edit',
      },
      {
        prompt:
          'Tighten the middle section so it moves faster, but keep the first and last clips exactly as they are.',
        rubric: 'refine-tighten',
        intent: 'edit',
        keep: 'first-last',
      },
    ],
  },
  {
    id: 'memory-captions',
    category: 'memory',
    project: 'mission-talk',
    why: 'Style decisions must survive across turns without being restated.',
    turns: [
      {
        prompt: 'Cut this down to the best 45 seconds.',
        rubric: 'podcast-highlight-60s',
        intent: 'edit',
        // The prompt says 45; the rubric's name says 60. The number the run is judged on
        // is the one the editor asked for.
        durationTargetSeconds: 45,
      },
      {
        prompt: 'Add captions in a bold, uppercase, centered style.',
        rubric: 'memory-captions',
        intent: 'edit',
      },
      {
        prompt: 'Trim the last clip by two seconds and keep the captions in the same style.',
        rubric: 'memory-captions',
        intent: 'edit',
      },
    ],
  },

  // ── goal.md Phase 0 additions — one per remaining category ─────────────────────────
  {
    id: 'trim-first-clip-10s',
    category: 'trim',
    project: 'mission-montage',
    why: 'Boundary precision: the requested cut must be frame-exact and touch nothing else.',
    turns: [
      {
        prompt: 'Trim the first clip so it ends at exactly 10 seconds.',
        rubric: 'trim-first-clip',
        intent: 'edit',
        expectedFirstClipEndSeconds: 10,
      },
    ],
  },
  {
    id: 'trim-opening-10s',
    category: 'trim',
    project: 'mission-montage',
    why: 'The same verb phrased from the head of the clip: "cut off the first N seconds" must move the source start, not the end.',
    turns: [
      {
        prompt: 'Cut the first 10 seconds off the opening clip.',
        rubric: 'trim-first-clip-head',
        intent: 'edit',
        expectedHeadTrimSeconds: 10,
      },
    ],
  },
  {
    id: 'reorder-last-first',
    category: 'reorder',
    project: 'mission-montage',
    why: 'Target resolution by position ("the last clip"); a reorder must move, never cut.',
    turns: [
      {
        prompt: 'Move the last clip to the very beginning of the timeline.',
        rubric: 'reorder-last-first',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'reorder-swap-first-two',
    category: 'reorder',
    project: 'mission-montage',
    why: 'A reorder phrased as a swap: two targets resolved by position, everything else left in place.',
    turns: [{ prompt: 'Swap the first two clips.', rubric: 'reorder-swap-first-two', intent: 'edit' }],
  },
  {
    id: 'captions-plain',
    category: 'captions',
    project: 'mission-talk',
    why: 'The plainest caption request; cues must sit inside the programme and carry text.',
    turns: [{ prompt: 'Add captions to this video.', rubric: 'captions', intent: 'edit' }],
  },
  {
    id: 'captions-uppercase-bottom',
    category: 'captions',
    project: 'mission-talk',
    why: 'Captions with two style words the schema can check: every cue must carry them, not just the first.',
    turns: [
      {
        prompt: 'Add captions in all caps at the bottom of the frame.',
        rubric: 'captions-styled',
        intent: 'edit',
        captionStyle: { textTransform: 'uppercase', position: 'bottom' },
      },
    ],
  },
  {
    id: 'hook-strongest-line',
    category: 'hook',
    project: 'mission-podcast',
    why: 'A hook is found in the transcript and pulled forward; the opening must start later in the source.',
    turns: [
      {
        prompt:
          'Start the video with the strongest line from the recording, then continue from the beginning as before.',
        rubric: 'hook-first',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'broll-first-20s',
    category: 'broll',
    project: 'mission-talk',
    brollFrom: 'mission-montage',
    why: 'A cutaway must land in the requested window as a non-overlapping clip (ADR 0140) without changing the running time.',
    turns: [
      {
        prompt:
          'Add b-roll from the clips in the bin over the first 20 seconds of the narration.',
        rubric: 'broll-cutaway',
        intent: 'edit',
        cutawayWindowSeconds: [0, 20],
      },
    ],
  },
  {
    id: 'broll-empty-overlay-track',
    category: 'broll',
    project: 'mission-overlay',
    why:
      'Not a second sample of the cutaway — the shape around it. An empty video track above a ' +
      'gapless picture track is where preview and export can disagree, and `broll-first-20s` ' +
      'cannot see it: `mission-talk` has no second video track, so neither the right answer ' +
      'nor the wrong one is expressible there. Since ADR 0169 both routes are correct — split ' +
      'the programme and cut in, or take a front layer — so what is scored is the outcome the ' +
      'editor sees, not the route: whatever the run stacks, the monitor must show it.',
    turns: [
      {
        prompt: 'Add b-roll from the bin over the first 20 seconds of the narration.',
        rubric: 'broll-cutaway-empty-overlay',
        intent: 'edit',
        cutawayWindowSeconds: [0, 20],
      },
    ],
  },
  {
    id: 'music-bed-quiet',
    category: 'audio',
    project: 'mission-talk',
    musicAssetName: 'beat-100bpm.wav',
    why: 'Audio placement plus level: the bed must run under the whole programme and be turned down.',
    turns: [
      {
        prompt:
          'Put the beat-100bpm track under the whole narration and turn it down so the voice stays clear.',
        rubric: 'music-bed',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'compound-silence-captions',
    category: 'compound',
    project: 'mission-podcast',
    why: 'Two steps in one request: both must land, and the captions must follow the tightened timing.',
    turns: [
      {
        prompt: 'Remove the dead air, then add captions.',
        rubric: 'compound-silence-captions',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'vague-make-better',
    category: 'vague',
    project: 'mission-montage',
    why: 'Ambiguity policy: ask one precise question, or make a cheap reversible edit and say what was assumed — never a sweeping one.',
    turns: [
      { prompt: 'Make it better.', rubric: 'vague-not-destructive', intent: 'ask-or-edit' },
    ],
  },
  {
    id: 'impossible-8k-drone',
    category: 'impossible',
    project: 'mission-podcast',
    why: 'Neither thing asked for exists (360p source, no drone footage); the agent must say so and change nothing.',
    turns: [
      {
        prompt: 'Upscale this to 8K and add the drone footage I shot yesterday.',
        rubric: 'unchanged',
        intent: 'decline',
      },
    ],
  },
  {
    id: 'guard-wipe-timeline',
    category: 'guard',
    project: 'mission-montage',
    // RESOLVED 2026-09-04, conforming this case to ADR 0166 rather than continuing to
    // score it against a requirement the product no longer implements.
    //
    // goal.md's "guard destructive intent" line asked for confirmation of scope before a
    // wipe. ADR 0166 considered that and removed the wipe guard outright, explicitly
    // refusing to replace it with "a confirmation prompt, a threshold, or an opt-out
    // flag" — every one of those has to guess intent from prose, and the measured cost of
    // the old guard was requests burned routing around a refusal on a rebuild the user had
    // actually asked for. That ADR is accepted and shipped (wipe-guard.ts is gone).
    //
    // Under it, the correct answer to "Delete everything on the timeline." — unambiguous,
    // nothing to ask about — is to delete everything: `intent: edit`, `rubric: wiped`
    // (checkTimelineWiped), not `intent: ask` / `rubric: unchanged`. This case was left
    // failing on purpose for one baseline cycle so the conflict was visible rather than
    // silently resolved; now that it has been read and the ADR is the newer, shipped
    // decision, the case is conformed to it. If goal.md's line is reinstated as a
    // requirement, revert this and reopen the conflict instead of re-adding a guard ADR
    // 0166 already rejected.
    why:
      'A full-track wipe on an unambiguous request is applied, not guarded — ADR 0166. ' +
      'See the comment above for the goal.md line this supersedes.',
    turns: [{ prompt: 'Delete everything on the timeline.', rubric: 'wiped', intent: 'edit' }],
  },
  {
    id: 'clarify-which-clip',
    category: 'clarify',
    project: 'mission-montage',
    why: 'Five clips, no selection, "the clip": the reference is not resolvable from the media, so the agent must ask, never guess.',
    turns: [{ prompt: 'Cut the clip a bit shorter.', rubric: 'unchanged', intent: 'ask' }],
  },
  // ── plan/visual-understanding VU0.3 — the cases that need the agent to SEE ──────────
  //
  // Split honestly by what a rubric can decide. The five below change the timeline, so
  // each has a rubric that reads the resulting edit state — which clip gained a grade and
  // on which axis, which cuts carry a transition and which deliberately do not, whether
  // the cutaway landed on the line the request named, whether the clips that went are the
  // repeated ones. Every one carries `no-collateral-changes`: an edit that also crops five
  // clips nobody mentioned is a failure, not a partial success.
  //
  // The three after them are QUESTIONS. A rubric cannot judge prose, so it does not try:
  // it scores that the run answered and changed nothing. Whether the answer is CORRECT is
  // the operator's call, against `tests/fixtures/mission/labels/` (VU0.2) — and the second
  // half of each of those cases, that the answer came without looking at a frame, is
  // already measured by `perception-metrics.ts` (`framesSeen`) rather than by the rubric.
  {
    id: 'match-color-to-first-clip',
    category: 'color',
    project: 'mission-montage',
    why:
      'Five clips from five different cameras, so clip 1 and clip 3 genuinely do not match — ' +
      'the fixture where "match this to that" has a real answer. What is scored is direction ' +
      'and containment: the named target gained the grade, the reference did NOT (grading the ' +
      'reference to look like the target is the plausible, silent, exactly-wrong edit), every ' +
      'parameter is inside the renderer contract and actually moves something, and nothing ' +
      'else on the timeline changed. The residual — how close the two shots now measure — is ' +
      'not scoreable from the project file, which carries no measurement; it is what the VU7 ' +
      'shot_match evidence route and the operator judge.',
    turns: [
      {
        prompt: "Match the third clip's color to the first clip.",
        rubric: 'match-color-to-reference',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'warmer-subtle',
    category: 'color',
    project: 'mission-montage',
    why:
      'The vaguest colour request there is, and the one the look table exists for. The rubric ' +
      'asserts what the table says rather than a number invented here: `warmer` is a warmth ' +
      'delta and nothing else, so every picture clip must carry a positive temperature, no ' +
      'clip may move exposure, contrast or saturation, and "a little" must stay well inside ' +
      'the contract. How MUCH temperature each shot needs depends on its measured luma and ' +
      'is the solver\'s business, so the rubric does not pin it. mission-montage rather than ' +
      'a one-clip project because "make IT warmer" over five clips is where a run either ' +
      'grades the sequence or grades one clip and reports success.',
    turns: [
      { prompt: 'Make it a little warmer.', rubric: 'warmer-subtle', intent: 'edit' },
    ],
  },
  {
    id: 'transitions-where-they-belong',
    category: 'transitions',
    project: 'mission-montage',
    why:
      'The whole request is about WHICH cuts, so the case needs a timeline with both kinds, ' +
      'and the fixture as shipped has only one kind — its five cuts all change source. So the ' +
      'first turn builds a montage, which produces continuity cuts (one shot carrying on into ' +
      'the next) alongside source changes, and the second turn is the request under test. The ' +
      'rubric then has an "elsewhere": a transition must land on at least one source change, ' +
      'and none may land on a continuity cut — the classic amateur tell, and the case ' +
      '`chooseTransition` returns null for no matter how large the measured deltas are. ' +
      'Deliberately not "a transition at EVERY source change": a montage that dissolves eight ' +
      'times is worse than one that dissolves twice, and a rubric demanding all of them would ' +
      'fail the better edit.',
    turns: [
      {
        prompt:
          'Create a 30-second fast-paced social montage from the raw footage on the timeline.',
        rubric: 'montage-30s',
        intent: 'edit',
      },
      {
        prompt: 'Add transitions where they belong.',
        rubric: 'transitions-where-they-belong',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'broll-over-sentence',
    category: 'broll',
    project: 'mission-talk',
    brollFrom: 'mission-montage',
    why:
      'Target resolution by SENTENCE, which is the one thing `broll-first-20s` cannot test — ' +
      'that case names a time window ("the first 20 seconds") and this one names a line, so ' +
      'the run has to find the words before it can place anything. mission-talk because it is ' +
      'the fixture with a real transcript; the line is the one the narration actually ' +
      'contains (the plan\'s example says "the sentence about traffic", and this footage is ' +
      'about football). WHAT the rubric does not judge, and says so: whether the b-roll it ' +
      'chose is ABOUT the line. That needs a verified label on the footage and the fixture ' +
      'b-roll has none — see tests/fixtures/mission/labels/README.md. The operator judges the ' +
      'footage choice; the harness judges the placement.',
    turns: [
      {
        prompt: 'Put b-roll from the bin over the line about the Champions League.',
        rubric: 'broll-over-sentence',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'remove-duplicate-takes',
    category: 'duplicates',
    project: 'mission-montage',
    why:
      'No committed fixture ships two takes of one action, so the repeats are BUILT by the ' +
      'first turn, which asks for them in as many words. That makes the case honest about ' +
      'what it measures: a duplicate here is two clips playing overlapping source of the same ' +
      'asset — a fact the project file proves — not tier 1\'s phash `duplicateOf`, which ' +
      'clusters two separate recordings and has no fixture to run against. Both halves are ' +
      'scored, because deleting most of the programme also removes every duplicate: the ' +
      'repeated material must be gone AND every un-repeated shot must survive.',
    turns: [
      {
        prompt:
          'Build a 30-second montage from this footage, and use the opening shot three times.',
        rubric: 'montage-30s',
        intent: 'edit',
      },
      {
        prompt: 'Drop the duplicate takes.',
        rubric: 'remove-duplicate-takes',
        intent: 'edit',
      },
    ],
  },
  {
    id: 'which-clips-show-host',
    category: 'question',
    project: 'mission-montage',
    why:
      'A question, not an edit: the right outcome is an answer and an untouched timeline. ' +
      'mission-montage because it has five clips of different material, so "which ones show ' +
      'the host" has an answer that is neither all of them nor none. THE ANSWER\'S ' +
      'CORRECTNESS IS JUDGED BY THE OPERATOR against the tier-1 subject labels in ' +
      'tests/fixtures/mission/labels/tier1.json — a rubric cannot read prose, and a keyword ' +
      'match on the reply would score the agent\'s vocabulary, not its knowledge. What the ' +
      'harness scores by itself is the other half of the claim, and the half this plan is ' +
      'actually about: the timeline is unchanged, and `perception-metrics.framesSeen` says ' +
      'whether the answer cost a frame. It must not.',
    turns: [
      { prompt: 'Which clips show the host?', rubric: 'unchanged', intent: 'answer' },
    ],
  },
  {
    id: 'whats-on-screen-at',
    category: 'question',
    project: 'mission-montage',
    why:
      'The narrowest form of the same claim: one moment, one shot. 0:42 falls inside the ' +
      'second clip of the shipped fixture, so the question resolves to a specific piece of ' +
      'footage rather than to the programme as a whole. Scored the same way and for the same ' +
      'reason: unchanged timeline here, answer correctness by the operator against ' +
      'tier2.json, frames seen by perception-metrics. A run that grabs a frame to answer this ' +
      'has demonstrated exactly the failure the plan exists to remove.',
    turns: [
      { prompt: "What's on screen at 0:42?", rubric: 'unchanged', intent: 'answer' },
    ],
  },
  {
    id: 'find-dark-clips',
    category: 'question',
    project: 'mission-montage',
    why:
      'The tier-0 question — exposure is measured, needs no key, no model and no network, and ' +
      'is the floor the whole ledger sits on. So this is the case that should pass first and ' +
      'on a machine with nothing configured. The answer is judged by the operator against the ' +
      'exposure classes in tier0.json (which are PROPOSED, not verified — see that ' +
      'directory\'s README, and never tune a threshold against them). The harness scores that ' +
      'nothing was edited and that no frame was rendered to find out.',
    turns: [
      { prompt: 'Which clips are underexposed?', rubric: 'unchanged', intent: 'answer' },
    ],
  },
];

/** Look a case up by id; `undefined` when the id is not in the set. */
export function goldenCase(id: string): GoldenCase | undefined {
  return GOLDEN_CASES.find((c) => c.id === id);
}
