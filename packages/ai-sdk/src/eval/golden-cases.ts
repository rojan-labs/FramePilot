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
 *   - `mission-podcast`  — one 9.6-minute 360p dialogue clip, transcript (2,431 words).
 *   - `mission-talk`     — one 8.8-minute narration clip, `beat-100bpm.wav` in the bin,
 *                          transcript (1,465 words).
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
  | 'memory';

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
 * `ask-or-edit` — the ambiguity policy allows either a question or a cheap reversible
 * edit with the assumption stated.
 */
export type ExpectedIntent = 'edit' | 'ask' | 'decline' | 'ask-or-edit';

export interface GoldenTurn {
  /** What the user types. */
  readonly prompt: string;
  readonly rubric: MissionScenarioId;
  readonly intent: ExpectedIntent;
  readonly beatPeriodSeconds?: number;
  /** `refine-tighten`: the clips the request names as "keep" are resolved at run time. */
  readonly keep?: 'first-last';
  readonly expectedFirstClipEndSeconds?: number;
  readonly cutawayWindowSeconds?: readonly [number, number];
  /**
   * What the scripted operator answers if the agent asks. Absent ⇒
   * {@link DEFAULT_ASK_ANSWER}, which ends the turn without an edit so the rubric can
   * assert that asking came before acting.
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

/** The scripted operator's reply when a case has no `answer` of its own. */
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
      { prompt: 'Cut this down to the best 45 seconds.', rubric: 'podcast-highlight-60s', intent: 'edit' },
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
    id: 'captions-plain',
    category: 'captions',
    project: 'mission-talk',
    why: 'The plainest caption request; cues must sit inside the programme and carry text.',
    turns: [{ prompt: 'Add captions to this video.', rubric: 'captions', intent: 'edit' }],
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
    why: 'A full-track wipe needs explicit confirmation of scope before anything is applied.',
    turns: [{ prompt: 'Delete everything on the timeline.', rubric: 'unchanged', intent: 'ask' }],
  },
  {
    id: 'clarify-which-clip',
    category: 'clarify',
    project: 'mission-montage',
    why: 'Five clips, no selection, "the clip": the reference is not resolvable from the media, so the agent must ask, never guess.',
    turns: [{ prompt: 'Cut the clip a bit shorter.', rubric: 'unchanged', intent: 'ask' }],
  },
];

/** Look a case up by id; `undefined` when the id is not in the set. */
export function goldenCase(id: string): GoldenCase | undefined {
  return GOLDEN_CASES.find((c) => c.id === id);
}
