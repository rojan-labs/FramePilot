/**
 * @framepilot/ai-sdk/eval/mission-rubric — deterministic scoring of a timeline outcome
 * for the plan/system-mission scenarios (P0.3; Phase 4's quality gate).
 *
 * WHY a code rubric and not a model judge: the mission optimizes tokens and calls, and a
 * judge that costs tokens and drifts with prompts cannot gate the thing it is measuring.
 * Every check here reads the final `Project` only — clip geometry, transcript words,
 * asset references, beat grid — and answers yes/no with the number that decided it.
 * Subjective quality (does the montage *feel* good) is deliberately out of scope; the
 * Critic's advisory judgment covers that and never gates.
 */
import type { Clip, Effect, Project, Track, TranscriptWord } from '@framepilot/timeline-schema';
import {
  CAPTION_ASSET_ID,
  COLOR_GRADE_PARAMETER_CONTRACTS,
  TEXT_OVERLAY_ASSET_ID,
  TRANSITION_EFFECT_TYPE,
  TRANSITION_OUT_EFFECT_TYPE,
  coverageVerdict,
  type ShapedClip,
  type SourceShape,
} from '@framepilot/editor-core';
import { detectTranscriptLoop, timelineDuration } from '../critic.js';

export interface RubricCheck {
  readonly id: string;
  readonly ok: boolean;
  /** The number or fact that decided `ok`, for the report. */
  readonly detail: string;
  /** Weight in the scenario score; defaults to 1. */
  readonly weight?: number;
  /**
   * Which goal.md metric this check feeds besides the rubric score: `target` = "did it act
   * on the right clips / the right range", `boundary` = "are the cut points frame-exact
   * against expectation". Unfaceted checks count only toward the score.
   */
  readonly facet?: 'target' | 'boundary';
  /**
   * This check could not judge the run, so it is scored as neither pass nor fail.
   *
   * NOT the same as `ok: false`, and not the same as `ok: true`. A check with nothing to
   * measure against — a project with no transcript, or one whose transcript is an ASR
   * loop rather than speech — has no verdict to give, and both booleans are a lie about
   * the run. {@link scored} removes these from the numerator AND the denominator, and
   * `golden-metrics.ts#facet` drops them before computing target/boundary, so a facet
   * whose only check was skipped reports `null` — not measured — rather than a clean pass.
   *
   * This is the check-level form of the exclusion the harness already applies to void and
   * timed-out turns: a thing that was not measured must not be counted as a thing that
   * went well.
   */
  readonly skipped?: boolean;
}

export interface RubricScore {
  readonly scenario: MissionScenarioId;
  /** Weighted share of passing checks, 0..1. */
  readonly score: number;
  readonly checks: readonly RubricCheck[];
}

export type MissionScenarioId =
  | 'montage-30s'
  | 'podcast-highlight-60s'
  | 'remove-dead-air'
  | 'beat-sync'
  | 'refine-tighten'
  | 'memory-captions'
  // goal.md Phase 0 golden set — one rubric per request category the set must cover.
  | 'trim-first-clip'
  | 'reorder-last-first'
  | 'captions'
  | 'hook-first'
  | 'broll-cutaway'
  // The same request over a project with an empty overlay track above a gapless picture
  // track — run `369e8c82`'s shape. See the case branch for what it adds to `broll-cutaway`.
  | 'broll-cutaway-empty-overlay'
  | 'music-bed'
  | 'compound-silence-captions'
  | 'unchanged'
  // The right answer to an unambiguous "delete everything" under ADR 0166 — see
  // checkTimelineWiped. Not the same rubric as `unchanged`: that one is for a request
  // that must be declined or asked about, this one is for a request that must be obeyed.
  | 'wiped'
  | 'vague-not-destructive'
  // Second phrasings of the core verbs, so each has six samples at three runs.
  | 'trim-first-clip-head'
  | 'reorder-swap-first-two'
  | 'captions-styled'
  // plan/visual-understanding VU0.3 — the cases that need the agent to know what the
  // picture LOOKS like. Every one is scored on the resulting edit state; the three
  // question cases in the same batch reuse 'unchanged', because prose is not scorable here.
  | 'match-color-to-reference'
  | 'warmer-subtle'
  | 'transitions-where-they-belong'
  | 'broll-over-sentence'
  | 'remove-duplicate-takes';

export interface RubricContext {
  /** The project the run started from (needed for before/after checks). */
  readonly before: Project;
  /** The project after every valid diff was folded in. */
  readonly after: Project;
  /** Beat period in seconds for the fixture music, when the scenario needs a grid. */
  readonly beatPeriodSeconds?: number;
  /**
   * The onsets the engine DETECTED in the placed music, in source seconds. Preferred over
   * `beatPeriodSeconds` when present — see {@link checkCutsOnBeats} for why the nominal
   * grid and the detected one are 45 points apart.
   */
  readonly beatTimes?: readonly number[];
  /** Clip ids the refinement request named as "keep"; must survive unchanged. */
  readonly keepClipIds?: readonly string[];
  /** `trim-first-clip`: where the first picture clip must end, in timeline seconds. */
  readonly expectedFirstClipEndSeconds?: number;
  /**
   * How long the finished programme should be, when the request named a length.
   *
   * The highlight rubric used to hard-code 60s from its own NAME, and `memory-captions`
   * reuses that rubric for a turn whose prompt is "Cut this down to the best 45 seconds."
   * Every run that did exactly what it was asked was then scored `duration-within: 45.00s
   * vs 60s ±10s` — three of three in the committed `baseline`, read there as the agent
   * falling short. The number belongs to the request, so it comes from the case.
   */
  readonly durationTargetSeconds?: number;
  /**
   * `broll-cutaway` / `broll-cutaway-empty-overlay`: the assets that count as b-roll, and
   * the window the cutaway must land in. The runner resolves them from the case's
   * `brollFrom` donor, or from the fixture's own un-placed video when it has none.
   */
  readonly brollAssetIds?: readonly string[];
  readonly cutawayWindowSeconds?: readonly [number, number];
  /** `music-bed`: the asset the request named as the music. */
  readonly musicAssetId?: string;
  /** `trim-first-clip-head`: how many seconds the request cut off the opening clip's head. */
  readonly expectedHeadTrimSeconds?: number;
  /** `captions-styled`: the style words the request used, as schema values. */
  readonly captionStyle?: { readonly textTransform?: string; readonly position?: string };
}

const FRAME_EPSILON = 1e-6;
/** Cuts may drift this far from a beat and still count as "on the beat" (one frame at 30 fps + audio slop). */
const BEAT_TOLERANCE_SECONDS = 0.05;

export function pictureTracks(project: Project): readonly Track[] {
  return project.timeline.tracks.filter((t) => t.type === 'video');
}

export function pictureClips(project: Project): readonly Clip[] {
  return pictureTracks(project)
    .flatMap((t) => t.clips)
    .slice()
    .sort((a, b) => a.start - b.start);
}

/** Furthest clip end on any track — the critic's `timelineDuration` over the project. */
export function projectDuration(project: Project): number {
  return timelineDuration(project.timeline);
}

function onFrameGrid(seconds: number, fps: number): boolean {
  const frames = seconds * fps;
  return Math.abs(frames - Math.round(frames)) < FRAME_EPSILON * fps + 1e-4;
}

/**
 * Every cut the run AUTHORED lands on the project's frame grid.
 *
 * Judges the delta, not the state (the same rule the failure cards follow): an edge is the
 * agent's only if it created the clip or moved that edge. An edge that was already off-grid
 * before the turn and did not move is INHERITED — the project came that way — and charging
 * it to the run made this check a property of the fixture rather than of the edit. It is
 * reported as an advisory in `detail` instead, so a project that arrives off-grid is still
 * visible without silently sinking `boundary` precision on every case that touches it.
 *
 * `before` is optional so a caller holding only an end state can still ask the plain
 * question "is this timeline on the grid?" — with no prior, every edge is the run's.
 */
export function checkCutsOnFrameGrid(project: Project, before?: Project): RubricCheck {
  const prior = new Map((before ? pictureClips(before) : []).map((c) => [c.id, c]));
  const authored = (c: Clip, edge: 'start' | 'end'): boolean => {
    const b = prior.get(c.id);
    // A clip the turn created, or an edge it moved. `Math.abs` rather than `!==` so a
    // value that round-tripped through JSON at the same frame is not called a move.
    return b === undefined || Math.abs(b[edge] - c[edge]) > FRAME_EPSILON;
  };
  let offGrid = 0;
  let inherited = 0;
  for (const c of pictureClips(project)) {
    for (const edge of ['start', 'end'] as const) {
      if (onFrameGrid(c[edge], project.fps)) continue;
      if (authored(c, edge)) offGrid++;
      else inherited++;
    }
  }
  const advisory = inherited === 0 ? '' : ` (${inherited} inherited off-grid edge(s) not charged)`;
  return {
    id: 'cuts-on-frame-grid',
    ok: offGrid === 0,
    detail: `${offGrid} clip edge(s) off the ${project.fps} fps grid${advisory}`,
    facet: 'boundary',
  };
}

export function checkNoOverlaps(project: Project): RubricCheck {
  let overlaps = 0;
  for (const track of project.timeline.tracks) {
    const clips = track.clips.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      if (clips[i]!.start < clips[i - 1]!.end - FRAME_EPSILON) overlaps++;
    }
  }
  return { id: 'no-overlaps', ok: overlaps === 0, detail: `${overlaps} overlapping pair(s)` };
}

/** Asset ids that name no bin asset by design (ADR 0032). See {@link checkValidRefs}. */
const SYNTHETIC_ASSET_IDS: ReadonlySet<string> = new Set([
  CAPTION_ASSET_ID,
  TEXT_OVERLAY_ASSET_ID,
]);

export function checkValidRefs(project: Project): RubricCheck {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const dangling = project.timeline.tracks
    .flatMap((t) => t.clips)
    // A caption clip's assetId is deliberately the sentinel CAPTION_ASSET_ID, and a text
    // overlay's is TEXT_OVERLAY_ASSET_ID — synthetic ids for clips with no media source
    // (ADR 0032), declared on consecutive lines of operations.ts. Neither is a bin asset,
    // and flagging either as dangling scores a case against a ref rule that was never
    // true of it. The caption half was fixed on 2026-09-04 after it capped every
    // captioning case; the text half was left behind in the same edit, so any run that
    // put a title on screen — which is most montage and hook cases — was still scored as
    // having produced a broken timeline.
    .filter((c) => !SYNTHETIC_ASSET_IDS.has(c.assetId) && !assetIds.has(c.assetId));
  const badRanges = project.timeline.tracks
    .flatMap((t) => t.clips)
    .filter((c) => c.end <= c.start || c.sourceEnd <= c.sourceStart);
  return {
    id: 'valid-refs',
    ok: dangling.length === 0 && badRanges.length === 0,
    detail: `${dangling.length} dangling asset ref(s), ${badRanges.length} empty range(s)`,
  };
}

export function checkDurationWithin(
  project: Project,
  target: number,
  tolerance: number,
): RubricCheck {
  const d = projectDuration(project);
  return {
    id: 'duration-within',
    ok: Math.abs(d - target) <= tolerance,
    detail: `${d.toFixed(2)}s vs ${target}s ±${tolerance}s`,
    weight: 2,
  };
}

export function checkMinClips(project: Project, min: number): RubricCheck {
  const n = pictureClips(project).length;
  return { id: 'min-clips', ok: n >= min, detail: `${n} picture clip(s), need ≥ ${min}` };
}

/** A cut inside a spoken word (source domain) — the thing that makes a highlight sound chopped. */
/**
 * No cut the run MADE lands inside a spoken word.
 *
 * Judges the delta, for the same reason {@link checkCutsOnFrameGrid} does. `mission-podcast`
 * used to arrive with one: whisper ended the final word at 576.000s while the media was
 * 575.855s long, so the clip's natural end — an edge nobody chose — sat inside it. Charging
 * that to the run failed the `boundary` facet on every podcast case no matter where the
 * agent cut. The replacement media (`speech-9min-c`) has no such overhang, but a user's
 * recording can have one at any time, so the delta rule is the rule.
 */
export function checkNoMidWordCuts(project: Project, before?: Project): RubricCheck {
  const words: readonly TranscriptWord[] = project.transcript;
  if (words.length === 0) {
    return { id: 'no-mid-word-cuts', ok: true, skipped: true, detail: 'no transcript' };
  }
  // A hallucinated transcript has no word boundaries to respect, so "this cut lands inside
  // a word" is a statement about a fabrication. `mission-podcast`'s transcript was 92% one
  // sentence whisper looped over quiet audio until its media was replaced on 2026-09-05,
  // and `remove-dead-air`, which never reads the transcript to decide where to cut, was
  // being failed by it. Unmeasurable, so it is not scored. The branch is no longer reached
  // by any fixture in the repo and is kept for the user recording it will be reached by.
  const loop = detectTranscriptLoop(words);
  if (loop !== undefined) {
    return {
      id: 'no-mid-word-cuts',
      ok: true,
      // "Unmeasurable, so it is not scored" is what the comment above has always said.
      // Until this flag existed the code did the opposite: `ok: true` counted as a pass
      // in both sums, so four rubrics on `mission-podcast` — `podcast-highlight-60s`,
      // `remove-dead-air`, `compound-silence-captions` and `hook-first` — were each
      // awarded a point for a check that had looked at nothing.
      skipped: true,
      detail:
        `not measurable: the transcript repeats "${loop.phrase}" ${String(loop.repeats)} times ` +
        `over ${String(Math.round(loop.share * 100))}% of its span (ASR loop, not speech)`,
      facet: 'boundary',
    };
  }
  const prior = new Map((before ? pictureClips(before) : []).map((c) => [c.id, c]));
  // WHOSE words are these? Every mission fixture's transcript is schema <= v11 and carries
  // no `assetId`, and the rule for an unattributed word is "it applies to any clip". On a
  // single-asset project that is right. On a project that has since gained b-roll it means
  // the b-roll clip's own in and out points are judged against the narration's words — on
  // footage with no speech on it at all. The same fabrication failed `word_severed` in the
  // Critic, where `broll-first-20s` was recorded for a whole session as a real b-roll
  // placement defect (BASELINES.md, retracted 2026-09-05). An unattributed transcript can
  // only have come from an asset long enough to contain it; when nothing qualifies, the
  // old any-clip reading stands so no project loses coverage it had.
  const spokenUntil = words.reduce((max, word) => Math.max(max, word.end), 0);
  const speechAssets = new Set(
    (project.assets ?? [])
      .filter(
        (asset) =>
          asset.kind !== 'image' &&
          asset.durationSeconds !== undefined &&
          asset.durationSeconds >= spokenUntil - 0.5,
      )
      .map((asset) => asset.id),
  );
  const couldBeSpeaking = (assetId: string): boolean =>
    speechAssets.size === 0 || speechAssets.has(assetId);
  const insideWord = (edge: number): boolean =>
    words.some((w) => w.start + 0.02 < edge && edge < w.end - 0.02);
  let midWord = 0;
  let inherited = 0;
  for (const clip of pictureClips(project)) {
    if (!couldBeSpeaking(clip.assetId)) continue;
    const b = prior.get(clip.id);
    for (const edge of ['sourceStart', 'sourceEnd'] as const) {
      if (!insideWord(clip[edge])) continue;
      // The run's own only if it created the clip or moved that source edge.
      if (b === undefined || Math.abs(b[edge] - clip[edge]) > FRAME_EPSILON) midWord++;
      else inherited++;
    }
  }
  const advisory = inherited === 0 ? '' : ` (${inherited} inherited edge(s) not charged)`;
  return {
    id: 'no-mid-word-cuts',
    ok: midWord === 0,
    detail: `${midWord} edge(s) inside a word${advisory}`,
    facet: 'boundary',
  };
}

export function checkChanged(ctx: RubricContext): RubricCheck {
  const changed = JSON.stringify(ctx.before.timeline) !== JSON.stringify(ctx.after.timeline);
  return { id: 'timeline-changed', ok: changed, detail: changed ? 'changed' : 'unchanged', weight: 2 };
}

export function checkShorterThanBefore(ctx: RubricContext): RubricCheck {
  const b = projectDuration(ctx.before);
  const a = projectDuration(ctx.after);
  return { id: 'shorter', ok: a < b - FRAME_EPSILON, detail: `${b.toFixed(2)}s → ${a.toFixed(2)}s` };
}

export function checkHasMusic(project: Project): RubricCheck {
  const audioKinds = new Set(project.assets.filter((a) => a.kind === 'audio').map((a) => a.id));
  const placed = project.timeline.tracks
    .filter((t) => t.type === 'audio')
    .flatMap((t) => t.clips)
    .filter((c) => audioKinds.has(c.assetId));
  return { id: 'has-music', ok: placed.length > 0, detail: `${placed.length} music clip(s)` };
}

/**
 * Share of picture cuts that land on the beat, anchored at the placed music.
 *
 * Scored against the onsets the engine actually DETECTED when `beatTimes` is supplied, and
 * only against the nominal `beatPeriodSeconds` grid when it is not.
 *
 * The two are not the same grid, and the difference was worth 45 points. `detect_beats`
 * reads `beat-100bpm.wav` as 99.4 BPM and returns onsets at 0.581, 0.975, 1.184, 1.788,
 * 1.974 … — only 30 of its 50 onsets sit within this check's tolerance of an ideal 0.6s
 * grid. A run that cuts on the onsets it was handed is doing exactly what the brief asked,
 * and scoring the result against the ideal grid failed all three baseline runs at 45–54%
 * for hitting exactly what they were aimed at. (A runtime beat-grid validator used to snap
 * cuts onto those onsets; ADR 0174 retired it, and the placement is now the model's own.)
 *
 * The case this serves says so itself: "Cuts must land on a measured beat grid, not an
 * estimated one." The nominal period was the estimated one.
 */
export function checkCutsOnBeats(
  project: Project,
  beatPeriodSeconds: number,
  beatTimes?: readonly number[],
): RubricCheck {
  const audioKinds = new Set(project.assets.filter((a) => a.kind === 'audio').map((a) => a.id));
  const music = project.timeline.tracks
    .filter((t) => t.type === 'audio')
    .flatMap((t) => t.clips)
    .filter((c) => audioKinds.has(c.assetId))
    .sort((a, b) => a.start - b.start)[0];
  if (!music) return { id: 'cuts-on-beats', ok: false, detail: 'no music placed', weight: 2 };
  const offset = music.start - music.sourceStart;
  const cuts = pictureClips(project)
    .map((c) => c.start)
    .filter((s) => s > FRAME_EPSILON);
  if (cuts.length === 0) return { id: 'cuts-on-beats', ok: false, detail: 'no cuts', weight: 2 };
  const measured = beatTimes !== undefined && beatTimes.length > 0;
  const distanceToBeat = (t: number): number => {
    const rel = t - offset;
    if (measured) {
      // Source-time onsets, so they are compared in the same domain the offset maps into.
      return Math.min(...beatTimes.map((b) => Math.abs(rel - b)));
    }
    const nearest = Math.round(rel / beatPeriodSeconds) * beatPeriodSeconds;
    return Math.abs(rel - nearest);
  };
  const onBeat = cuts.filter((t) => distanceToBeat(t) <= BEAT_TOLERANCE_SECONDS).length;
  const share = onBeat / cuts.length;
  return {
    id: 'cuts-on-beats',
    ok: share >= 0.8,
    detail:
      `${onBeat}/${cuts.length} cuts within ${BEAT_TOLERANCE_SECONDS}s of a ` +
      `${measured ? `measured onset (${String(beatTimes.length)} detected)` : `${beatPeriodSeconds}s nominal beat`} ` +
      `(${(share * 100).toFixed(0)}%)`,
    weight: 2,
  };
}

/**
 * The edit cuts FASTER than it did — more picture clips, or the same clips over less
 * time. "Tighten so it moves faster" is a statement about rhythm, and either answer is a
 * faithful one: adding cuts at the same length, or removing time at the same cut count.
 *
 * Replaces a plain "is it shorter?" on `refine-tighten`, which failed a run that
 * genuinely tightened by re-cutting. See that case for the numbers.
 */
export function checkCutsFasterThanBefore(ctx: RubricContext): RubricCheck {
  const before = pictureClips(ctx.before);
  const after = pictureClips(ctx.after);
  const beforeDuration = projectDuration(ctx.before);
  const afterDuration = projectDuration(ctx.after);
  const meanBefore = before.length > 0 ? beforeDuration / before.length : Infinity;
  const meanAfter = after.length > 0 ? afterDuration / after.length : Infinity;
  const ok = meanAfter < meanBefore - FRAME_EPSILON;
  return {
    id: 'cuts-faster',
    ok,
    detail:
      `${String(before.length)} clip(s) over ${beforeDuration.toFixed(2)}s → ` +
      `${String(after.length)} over ${afterDuration.toFixed(2)}s ` +
      `(mean shot ${meanBefore.toFixed(2)}s → ${meanAfter.toFixed(2)}s)`,
    weight: 2,
    facet: 'target',
  };
}

export function checkKeptClipsUntouched(ctx: RubricContext): RubricCheck {
  const ids = ctx.keepClipIds ?? [];
  const before = new Map(pictureClips(ctx.before).map((c) => [c.id, c]));
  const after = new Map(pictureClips(ctx.after).map((c) => [c.id, c]));
  const broken = ids.filter((id) => {
    const b = before.get(id);
    const a = after.get(id);
    return !b || !a || a.sourceStart !== b.sourceStart || a.sourceEnd !== b.sourceEnd;
  });
  return {
    id: 'kept-clips-untouched',
    ok: broken.length === 0,
    detail: `${broken.length}/${ids.length} named clip(s) altered`,
    weight: 2,
    facet: 'target',
  };
}

export function checkHasCaptions(project: Project): RubricCheck {
  const captionClips = project.timeline.tracks
    .filter((t) => t.type === 'caption' || t.type === 'overlay')
    .flatMap((t) => t.clips);
  return { id: 'has-captions', ok: captionClips.length > 0, detail: `${captionClips.length} caption clip(s)`, weight: 2 };
}


/** Identity of a clip's content, independent of where it sits on the timeline. */
function contentKey(c: Clip): string {
  return `${c.assetId}|${c.sourceStart.toFixed(4)}|${c.sourceEnd.toFixed(4)}`;
}

/**
 * Every picture and audio clip is gone — the right answer to an unambiguous "delete
 * everything" under ADR 0166, which removed the wipe guard and refused to replace it
 * with "a confirmation prompt, a threshold, or an opt-out flag": every one of those has
 * to guess intent from prose, and the measured cost of the old guard was requests burned
 * routing around a refusal on a rebuild the user had actually asked for.
 */
export function checkTimelineWiped(ctx: RubricContext): RubricCheck {
  const remaining = ctx.after.timeline.tracks.flatMap((t) => t.clips).length;
  return {
    id: 'timeline-wiped',
    ok: remaining === 0,
    detail: remaining === 0 ? 'every clip removed' : `${remaining} clip(s) still on the timeline`,
    weight: 2,
    facet: 'target',
  };
}

/** The timeline did not change — the right answer to a request that must be declined or asked about. */
export function checkUnchanged(ctx: RubricContext): RubricCheck {
  const changed = JSON.stringify(ctx.before.timeline) !== JSON.stringify(ctx.after.timeline);
  return {
    id: 'timeline-unchanged',
    ok: !changed,
    detail: changed ? 'timeline was modified' : 'unchanged',
    weight: 2,
    facet: 'target',
  };
}

/**
 * Only the named picture clips may have changed content; every other clip keeps its
 * asset and source range (a ripple may move it, which is not a change of target).
 */
export function checkOnlyClipsTouched(ctx: RubricContext, allowedIds: readonly string[]): RubricCheck {
  const allowed = new Set(allowedIds);
  const before = new Map(pictureClips(ctx.before).map((c) => [c.id, c]));
  const after = new Map(pictureClips(ctx.after).map((c) => [c.id, c]));
  const strayed: string[] = [];
  for (const [id, b] of before) {
    if (allowed.has(id)) continue;
    const a = after.get(id);
    if (!a || contentKey(a) !== contentKey(b)) strayed.push(id);
  }
  for (const id of after.keys()) if (!before.has(id) && !allowed.has(id)) strayed.push(id);
  return {
    id: 'only-target-touched',
    ok: strayed.length === 0,
    detail: strayed.length === 0 ? 'no other clip changed' : `also changed: ${strayed.join(', ')}`,
    weight: 2,
    facet: 'target',
  };
}

/** The first picture clip ends exactly where asked — frame-exact, not "close". */
export function checkFirstClipEndsAt(project: Project, seconds: number): RubricCheck {
  const first = pictureClips(project)[0];
  if (!first) return { id: 'first-clip-ends-at', ok: false, detail: 'no picture clip', weight: 2, facet: 'boundary' };
  const frames = Math.abs(first.end - seconds) * project.fps;
  return {
    id: 'first-clip-ends-at',
    ok: frames < 0.5,
    detail: `ends at ${first.end.toFixed(4)}s, asked ${seconds}s (${frames.toFixed(2)} frame(s) off)`,
    weight: 2,
    facet: 'boundary',
  };
}

/** Picture clips butt against each other: no gaps. */
export function checkNoGaps(project: Project): RubricCheck {
  const clips = pictureClips(project);
  let gaps = 0;
  for (let i = 1; i < clips.length; i++) {
    if (clips[i]!.start > clips[i - 1]!.end + FRAME_EPSILON) gaps++;
  }
  return { id: 'no-gaps', ok: gaps === 0, detail: `${gaps} gap(s)` };
}

/** Every clip's content survived (same assets, same source ranges) — a reorder moves, it does not cut. */
export function checkContentPreserved(ctx: RubricContext): RubricCheck {
  const b = pictureClips(ctx.before).map(contentKey).sort();
  const a = pictureClips(ctx.after).map(contentKey).sort();
  const ok = JSON.stringify(a) === JSON.stringify(b);
  return {
    id: 'content-preserved',
    ok,
    detail: ok ? 'same clips, same source ranges' : `${b.length} clip(s) before, ${a.length} after, content differs`,
    weight: 2,
    facet: 'target',
  };
}


/** The last picture clip (by content) is now first, and the rest keep their order. */
export function checkLastClipMovedFirst(ctx: RubricContext): RubricCheck {
  const before = pictureClips(ctx.before).map(contentKey);
  const after = pictureClips(ctx.after).map(contentKey);
  if (before.length < 2) return { id: 'last-moved-first', ok: false, detail: 'fewer than two clips', weight: 2, facet: 'target' };
  const expected = [before[before.length - 1]!, ...before.slice(0, -1)];
  const ok = JSON.stringify(after) === JSON.stringify(expected);
  return {
    id: 'last-moved-first',
    ok,
    detail: ok ? 'order rotated as asked' : `order is [${after.map((k) => k.split('|')[0]).join(', ')}]`,
    weight: 2,
    facet: 'target',
  };
}

/** The edit opens somewhere other than where the source starts — a hook was pulled forward. */
export function checkOpensLaterInSource(ctx: RubricContext): RubricCheck {
  const b = pictureClips(ctx.before)[0];
  const a = pictureClips(ctx.after)[0];
  if (!b || !a) return { id: 'opens-later-in-source', ok: false, detail: 'no picture clip', weight: 2, facet: 'target' };
  const ok = a.sourceStart > b.sourceStart + 1;
  return {
    id: 'opens-later-in-source',
    ok,
    detail: `opens at source ${a.sourceStart.toFixed(2)}s (was ${b.sourceStart.toFixed(2)}s)`,
    weight: 2,
    facet: 'target',
  };
}

/**
 * A hook does not PAD — but a faithful prepend is not padding.
 *
 * `hook-strongest-line` asks, in the editor's own words: "Start the video with the
 * strongest line from the recording, **then continue from the beginning as before**."
 * Doing exactly that puts the hook in front of an unchanged programme, and the result is
 * longer by the length of the hook. The check used to be `a <= b`, so the committed
 * baseline's `575.87s → 577.80s` was a run being marked down for obeying its instruction
 * to the letter. An instrument that punishes obedience does not measure intent accuracy;
 * it measures the opposite.
 *
 * The allowance is the length of the OPENING THE RUN ADDED — exactly what a faithful
 * prepend costs, and not a frame more. A run that restructures instead (moves the line,
 * duplicates nothing) keeps its duration and passes as it always did. A run that pads the
 * body still fails, because padding is growth the opening does not account for.
 *
 * The allowance is zero when the run did not change where the programme opens: growth
 * with the same opening is padding by definition.
 */
export function checkNotLonger(ctx: RubricContext): RubricCheck {
  const b = projectDuration(ctx.before);
  const a = projectDuration(ctx.after);
  const beforeFirst = pictureClips(ctx.before)[0];
  const afterFirst = pictureClips(ctx.after)[0];
  const prepended =
    beforeFirst !== undefined &&
    afterFirst !== undefined &&
    afterFirst.sourceStart > beforeFirst.sourceStart + 1;
  const allowance = prepended && afterFirst ? afterFirst.end - afterFirst.start : 0;
  const ok = a <= b + allowance + FRAME_EPSILON;
  const allowed = allowance > 0 ? ` (+${allowance.toFixed(2)}s hook allowed)` : '';
  return {
    id: 'not-longer',
    ok,
    detail: `${b.toFixed(2)}s → ${a.toFixed(2)}s${allowed}`,
  };
}

/** A b-roll clip sits inside the requested window (ADR 0140: a non-overlapping cutaway). */
export function checkCutawayInWindow(
  project: Project,
  brollAssetIds: readonly string[],
  window: readonly [number, number],
): RubricCheck {
  const broll = new Set(brollAssetIds);
  const [from, to] = window;
  const placed = pictureClips(project).filter(
    (c) => broll.has(c.assetId) && c.start >= from - FRAME_EPSILON && c.end <= to + 0.5,
  );
  return {
    id: 'cutaway-in-window',
    ok: placed.length > 0,
    detail: `${placed.length} b-roll clip(s) inside ${from}–${to}s`,
    weight: 2,
    facet: 'target',
  };
}

/**
 * Every cross-track picture overlap is one the PREVIEW CAN SHOW — i.e. the clip in front
 * covers the frame opaquely, so the monitor and the export produce the same picture.
 *
 * WHY this is not "no picture over picture". It was, until ADR 0169. Refusing every stack
 * meant the agent could not build a montage or a layered cutaway at all on a project whose
 * main track is occupied — which, on a talking head, is always — and
 * `beat-grid-wiring.test.ts` sat at 2 of 10 for exactly that reason. 0169 narrowed the rule
 * to what actually diverges: the preview resolves by z-order now, so a FULL-FRAME OPAQUE
 * layer previews as it exports, while a cropped, blended, keyframed or masked one still
 * does not.
 *
 * So this asserts the invariant directly rather than a proxy for it, which makes it a
 * stronger check than the one it replaces: a run may stack picture, and every stack it
 * makes must be one the editor will actually see before they approve it.
 *
 * `coverageVerdict` is imported from `editor-core` — the same predicate the placement guard
 * and the preview read. A second definition here is how a rubric starts grading a rule the
 * product no longer has. ADR 0170 made it a RELATION: the renderer fits rather than covers,
 * so whether a letterboxed layer diverges depends on the shape of what is under it, and
 * grading the front clip alone both passed leaks and failed honest stacks.
 */
export function checkStackedPictureIsPreviewable(project: Project): RubricCheck {
  const byTrack = pictureTracks(project).map((t) => ({ id: t.id, clips: t.clips }));
  const shapeById = new Map<string, SourceShape | undefined>(
    project.assets.map((asset) => {
      const { width, height } = asset.media ?? {};
      const measured =
        typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
      return [asset.id, measured ? { width, height } : undefined];
    }),
  );
  const shaped = (clip: Clip): ShapedClip => ({ clip, source: shapeById.get(clip.assetId) });
  const divergent: string[] = [];
  let stacks = 0;
  // Tracks are front-to-back, so the LOWER index is the clip the viewer sees. Whether it
  // hides the one behind is a question about BOTH shapes and the project frame.
  for (let front = 0; front < byTrack.length; front++) {
    for (let back = front + 1; back < byTrack.length; back++) {
      for (const a of byTrack[front]!.clips) {
        for (const b of byTrack[back]!.clips) {
          if (a.start < b.end - FRAME_EPSILON && b.start < a.end - FRAME_EPSILON) {
            stacks += 1;
            const verdict = coverageVerdict(shaped(a), [shaped(b)], project.resolution);
            if (!verdict.hides) {
              divergent.push(
                `${a.id} on ${byTrack[front]!.id} over ${b.id} on ${byTrack[back]!.id} ` +
                  `(${verdict.reason})`,
              );
            }
          }
        }
      }
    }
  }
  return {
    id: 'stacked-picture-is-previewable',
    ok: divergent.length === 0,
    detail:
      divergent.length > 0
        ? `previews differently from the export: ${divergent.join('; ')}`
        : stacks === 0
          ? 'no picture over picture'
          : `${String(stacks)} stacked span(s), all full-frame`,
    weight: 2,
    facet: 'target',
  };
}


/** Duration is unchanged within half a second — a cutaway covers, it does not lengthen. */
export function checkDurationKept(ctx: RubricContext, toleranceSeconds = 0.5): RubricCheck {
  const b = projectDuration(ctx.before);
  const a = projectDuration(ctx.after);
  return {
    id: 'duration-kept',
    ok: Math.abs(a - b) <= toleranceSeconds,
    detail: `${b.toFixed(2)}s → ${a.toFixed(2)}s`,
    facet: 'boundary',
  };
}

function musicClips(project: Project, assetId: string | undefined): readonly Clip[] {
  const audioKinds = new Set(project.assets.filter((a) => a.kind === 'audio').map((a) => a.id));
  return project.timeline.tracks
    .filter((t) => t.type === 'audio')
    .flatMap((t) => t.clips)
    .filter((c) => (assetId ? c.assetId === assetId : audioKinds.has(c.assetId)));
}

/** The named music runs under (nearly) the whole programme. */
export function checkMusicCovers(project: Project, assetId: string | undefined, share = 0.9): RubricCheck {
  const clips = musicClips(project, assetId);
  const total = projectDuration(project);
  const covered = clips.reduce((s, c) => s + (c.end - c.start), 0);
  const ok = total > 0 && covered / total >= share;
  return {
    id: 'music-covers',
    ok,
    detail: `${clips.length} music clip(s) cover ${((total ? covered / total : 0) * 100).toFixed(0)}% of ${total.toFixed(1)}s`,
    weight: 2,
    facet: 'target',
  };
}

/** The music is turned down (negative gain) so the voice stays on top. */
export function checkMusicQuieter(project: Project, assetId: string | undefined): RubricCheck {
  const clips = musicClips(project, assetId);
  const quiet = clips.filter((c) => {
    const gain = c.effects.find((e) => e.type === 'audio_gain');
    const db = gain && typeof gain.params === 'object' && gain.params ? (gain.params as { gainDb?: unknown }).gainDb : undefined;
    return typeof db === 'number' && db < 0;
  });
  return {
    id: 'music-quieter',
    ok: clips.length > 0 && quiet.length === clips.length,
    detail: `${quiet.length}/${clips.length} music clip(s) below 0 dB`,
  };
}

/** Caption cues sit inside the programme (the picture's extent) and carry text. */
export function checkCaptionsWellFormed(project: Project): RubricCheck {
  const total = pictureClips(project).reduce((m, c) => Math.max(m, c.end), 0);
  const cues = project.timeline.tracks
    .filter((t) => t.type === 'caption')
    .flatMap((t) => t.clips);
  const bad = cues.filter(
    (c) => c.start < -FRAME_EPSILON || c.end > total + 0.5 || !(c.captionCue?.text ?? '').trim(),
  );
  return {
    id: 'captions-well-formed',
    ok: cues.length > 0 && bad.length === 0,
    detail: `${cues.length} cue(s), ${bad.length} outside the programme or empty`,
    facet: 'boundary',
  };
}

/** A vague request must not become a sweeping one: at least half the programme survives. */
export function checkNotDestructive(ctx: RubricContext): RubricCheck {
  const b = projectDuration(ctx.before);
  const a = projectDuration(ctx.after);
  return {
    id: 'not-destructive',
    ok: b === 0 || a >= b * 0.5,
    detail: `${b.toFixed(2)}s → ${a.toFixed(2)}s`,
    weight: 2,
    facet: 'target',
  };
}

/** The first picture clip now starts `seconds` later in its source — frame-exact. */
export function checkFirstClipHeadTrimmed(ctx: RubricContext, seconds: number): RubricCheck {
  const b = pictureClips(ctx.before)[0];
  const a = pictureClips(ctx.after)[0];
  if (!b || !a) return { id: 'first-clip-head-trimmed', ok: false, detail: 'no picture clip', weight: 2, facet: 'boundary' };
  const frames = Math.abs(a.sourceStart - (b.sourceStart + seconds)) * ctx.after.fps;
  return {
    id: 'first-clip-head-trimmed',
    ok: a.assetId === b.assetId && frames < 0.5,
    detail: `opens at source ${a.sourceStart.toFixed(4)}s, asked ${(b.sourceStart + seconds).toFixed(4)}s (${frames.toFixed(2)} frame(s) off)`,
    weight: 2,
    facet: 'boundary',
  };
}

/** The first two picture clips (by content) changed places; the rest kept their order. */
export function checkFirstTwoSwapped(ctx: RubricContext): RubricCheck {
  const before = pictureClips(ctx.before).map(contentKey);
  const after = pictureClips(ctx.after).map(contentKey);
  if (before.length < 2) return { id: 'first-two-swapped', ok: false, detail: 'fewer than two clips', weight: 2, facet: 'target' };
  const expected = [before[1]!, before[0]!, ...before.slice(2)];
  const ok = JSON.stringify(after) === JSON.stringify(expected);
  return {
    id: 'first-two-swapped',
    ok,
    detail: ok ? 'first two swapped, rest in place' : `order is [${after.map((k) => k.split('|')[0]).join(', ')}]`,
    weight: 2,
    facet: 'target',
  };
}

/**
 * Every caption cue carries the requested style, read as the renderer would: the cue's
 * own style first, else its track's. A missing `position` is the schema default, bottom.
 */
export function checkCaptionStyleMatches(
  project: Project,
  want: { readonly textTransform?: string; readonly position?: string },
): RubricCheck {
  const tracks = project.timeline.tracks.filter((t) => t.type === 'caption');
  const cues = tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, track: t })));
  const off = cues.filter(({ clip, track }) => {
    const style = { ...(track.captionStyle ?? {}), ...(clip.captionStyle ?? {}) } as {
      textTransform?: string;
      position?: string;
    };
    if (want.textTransform !== undefined && (style.textTransform ?? 'none') !== want.textTransform) return true;
    if (want.position !== undefined && (style.position ?? 'bottom') !== want.position) return true;
    return false;
  });
  return {
    id: 'caption-style-matches',
    ok: cues.length > 0 && off.length === 0,
    detail: `${off.length}/${cues.length} cue(s) not ${JSON.stringify(want)}`,
    weight: 2,
    facet: 'target',
  };
}

// ---------------------------------------------------------------------------
// Picture-understanding checks (plan/visual-understanding VU0.3)
// ---------------------------------------------------------------------------

/**
 * WHY these read the timeline and not the reply.
 *
 * The visual cases exist because the agent has never looked at a frame and has never
 * grounded a grade or a transition in a measurement (`reports/golden/BASELINE.md`, guess
 * rate 1.00). What proves that changed is the EDIT: which clip gained a grade, on which
 * axis it moved, which cuts carry a transition and which deliberately do not, whether the
 * placed cutaway sits over the line the request named. None of that is a sentence, and a
 * rubric that read the prose would be scoring the agent's self-description.
 */

/**
 * Which clips `match-color-to-first-clip` names, as positions on the picture track.
 *
 * The prompt is "match clip 3's colour to clip 1", and the fixture's clips are numbered on
 * screen from 1, so clip 3 is index 2. Positions rather than ids because the runner scores
 * against whatever project the case composed, and an id would pin the rubric to one fixture.
 */
const MATCH_COLOR_TARGET_INDEX = 2;
const MATCH_COLOR_REFERENCE_INDEX = 0;

/**
 * The most temperature "a little warmer" may reach before the solve is at the rail.
 *
 * This used to be 0.5 — "half the renderer's contract range" — in the same breath as the
 * docstring admitting that how much temperature a +0.05 warmth move costs depends on the
 * shot's measured luma and "the solver decides that". Those two statements cannot both
 * stand, and the flat cap was the one that was wrong.
 *
 * `WARMTH_PER_TEMPERATURE` scales with the frame's mean luma, because white balance is
 * multiplicative: a dark shot's chroma moves less in absolute terms, so the SAME measured
 * warmth change costs more parameter there. That is not a defect, it is the whole point of
 * VU3 — "a bit warmer" must land the same amount of warmer on every shot, in measured units
 * rather than parameter units. A rubric that caps the parameter is grading the shots by how
 * dark they are.
 *
 * Measured, on `mission-montage` (`vu-ledger-all/warmer-subtle`): asset_004 measures
 * luma_mean **0.1271**, the darkest clip in the fixture. A +0.05 warmth target there solves
 * to 0.05 / (0.6936 × 0.1271) ≈ **0.57** — and the run produced 0.56. The old cap failed a
 * correct, scale-free solve for being applied to dark footage.
 *
 * So the bound is the renderer's contract range itself. What "not a little any more"
 * actually looks like is the solve hitting the RAIL — at which point the solver reports
 * `clamped` and the move it promised did not land. Inside the range, the parameter is the
 * solver's business, exactly as documented; direction, absence of stray axes and staying
 * off the rail are what a rubric can honestly score.
 */
const WARMER_SUBTLE_MAX_TEMPERATURE = 1;

/**
 * The line `broll-over-sentence` asks for b-roll over, verbatim from the fixture transcript.
 *
 * The plan's example prompt is "the sentence about traffic"; `mission-talk`'s narration is
 * about football, so the case asks for the line it actually contains. The phrase lives here
 * rather than in the case because the rubric is what has to find it in the transcript, and
 * the two must not be able to drift apart.
 */
const BROLL_SENTENCE_PHRASE = 'champions league';

/** Where a clip sits and what it plays — everything except its effects. */
function geometryKey(clip: Clip): string {
  return [
    clip.assetId,
    clip.start.toFixed(4),
    clip.end.toFixed(4),
    clip.sourceStart.toFixed(4),
    clip.sourceEnd.toFixed(4),
    (clip.speed ?? 1).toFixed(4),
  ].join('|');
}

/**
 * What a clip LOOKS like: its effects, plus the crop and keyframes that are equally part of
 * the picture. `crop` was in the pre-merge check's key and in neither of the two keys that
 * replaced it, so a stray reframe could slip past both — which is the exact defect
 * `no-collateral-changes` exists to catch.
 */
function effectsKey(clip: Clip): string {
  return JSON.stringify({
    crop: clip.crop ?? null,
    keyframes: clip.keyframes ?? [],
    effects: [...clip.effects]
      .map((effect) => ({
        id: effect.id,
        type: effect.type,
        params: effect.params,
        keyframes: effect.keyframes,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function allClips(project: Project): readonly Clip[] {
  return project.timeline.tracks.flatMap((track) => track.clips);
}

const ANY = 'any' as const;

/**
 * Nothing changed that the request did not ask for.
 *
 * The facet every visual case carries, because the failure it catches has happened here
 * before: a grade request that also reframed five clips, a caption request that re-cut the
 * programme. `refine-tighten` scores the same idea for the clips a prompt names as "keep";
 * this generalises it to "the request named ONE thing, so exactly one thing may differ",
 * and it separates the two ways a clip can change — where it sits (`geometry`) and what is
 * stacked on it (`effects`) — because a colour request legitimately changes the second and
 * must never touch the first.
 *
 * @param ctx - Before/after.
 * @param allowGeometryOn - Clip ids whose position or source range may move; `'any'` for a
 *   request that is allowed to re-cut.
 * @param allowEffectsOn - Clip ids that may gain, lose or change effects; `'any'` for a
 *   request that legitimately touches every clip (a whole-sequence look, a transition pass).
 */
export function checkNoCollateralChanges(
  ctx: RubricContext,
  // Geometry defaults to ANY and effects to NOTHING, which is exactly what a bare
  // `checkNoCollateralChanges(ctx)` meant before this grew allowances: it watched the LOOK
  // and let position move, because on a reorder the movement IS the request. A caller that
  // needs positions frozen too — a colour pass, a transition pass — names the clips it may
  // touch and gets the strict reading.
  allowGeometryOn: readonly string[] | typeof ANY = ANY,
  allowEffectsOn: readonly string[] | typeof ANY = [],
): RubricCheck {
  const geometryOk = (id: string): boolean =>
    allowGeometryOn === ANY || allowGeometryOn.includes(id);
  const effectsOk = (id: string): boolean => allowEffectsOn === ANY || allowEffectsOn.includes(id);
  const before = new Map(allClips(ctx.before).map((clip) => [clip.id, clip]));
  const after = new Map(allClips(ctx.after).map((clip) => [clip.id, clip]));
  const strayed: string[] = [];
  for (const [id, was] of before) {
    const now = after.get(id);
    if (!now) {
      if (!geometryOk(id)) strayed.push(`${id} removed`);
      continue;
    }
    if (!geometryOk(id) && geometryKey(now) !== geometryKey(was)) strayed.push(`${id} moved`);
    if (!effectsOk(id) && effectsKey(now) !== effectsKey(was)) strayed.push(`${id} re-effected`);
  }
  for (const id of after.keys()) {
    if (!before.has(id) && !geometryOk(id)) strayed.push(`${id} added`);
  }
  return {
    id: 'no-collateral-changes',
    ok: strayed.length === 0,
    detail:
      strayed.length === 0
        ? 'nothing changed that the request did not name'
        : `also changed: ${strayed.join(', ')}`,
    weight: 2,
    facet: 'target',
  };
}

/** Every parametric grade on a clip, newest definition last. */
function colorGradeEffects(clip: Clip | undefined): readonly Effect[] {
  return clip ? clip.effects.filter((effect) => effect.type === 'color_grade') : [];
}

/** A grade parameter as a number; `null` when the effect does not set it. */
function gradeParam(effect: Effect, name: string): number | null {
  const raw = effect.params[name];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** The largest absolute value the clip's grades set for one axis; `null` when unset. */
function gradeAxis(clip: Clip | undefined, name: string): number | null {
  let value: number | null = null;
  for (const effect of colorGradeEffects(clip)) {
    const found = gradeParam(effect, name);
    if (found !== null && (value === null || Math.abs(found) > Math.abs(value))) value = found;
  }
  return value;
}

function pictureClipAt(project: Project, index: number): Clip | undefined {
  return pictureClips(project)[index];
}

/**
 * The clip the request named as the TARGET gained a grade, and the reference did not.
 *
 * "Match clip 3's colour to clip 1" has a direction, and getting it backwards — grading the
 * reference to look like the target — is a plausible, silent, exactly-wrong answer. Both
 * halves are asserted, in one check, because either alone passes the inverted edit.
 */
export function checkGradeLandedOnTarget(
  ctx: RubricContext,
  targetIndex: number,
  referenceIndex: number,
): RubricCheck {
  const target = pictureClipAt(ctx.before, targetIndex);
  const reference = pictureClipAt(ctx.before, referenceIndex);
  if (!target || !reference) {
    return {
      id: 'grade-on-target',
      ok: false,
      detail: 'the project does not have the clips the request names',
      weight: 2,
      facet: 'target',
      skipped: true,
    };
  }
  const targetAfter = allClips(ctx.after).find((clip) => clip.id === target.id);
  const referenceAfter = allClips(ctx.after).find((clip) => clip.id === reference.id);
  const gainedGrade = colorGradeEffects(targetAfter).length > colorGradeEffects(target).length;
  const referenceUntouched =
    referenceAfter !== undefined && effectsKey(referenceAfter) === effectsKey(reference);
  return {
    id: 'grade-on-target',
    ok: gainedGrade && referenceUntouched,
    detail: gainedGrade
      ? referenceUntouched
        ? `${target.id} graded, reference ${reference.id} untouched`
        : `${target.id} graded, but the reference ${reference.id} was graded too`
      : `${target.id} carries no new grade`,
    weight: 2,
    facet: 'target',
  };
}

/** Below this a grade parameter is a rounding artefact, not an edit. */
const NEGLIGIBLE_GRADE = 0.005;

/**
 * Every grade the run applied stays inside the renderer's parameter contract, and moves
 * something.
 *
 * The contract is imported rather than restated (`COLOR_GRADE_PARAMETER_CONTRACTS`): a
 * second copy here is how a rubric starts grading bounds the product no longer has. A grade
 * of all zeros is reported as a failure rather than a pass, because "applied a grade that
 * changes nothing" is the shape a run takes when it wants the tool call on the record.
 */
export function checkGradesAreRealAndInRange(project: Project): RubricCheck {
  const problems: string[] = [];
  let moved = 0;
  let grades = 0;
  for (const clip of pictureClips(project)) {
    for (const effect of colorGradeEffects(clip)) {
      grades += 1;
      let movesSomething = false;
      for (const [name, raw] of Object.entries(effect.params)) {
        const contract = COLOR_GRADE_PARAMETER_CONTRACTS[name];
        if (!contract) continue;
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          problems.push(`${clip.id}.${name} is not a number`);
          continue;
        }
        if (raw < contract.min || raw > contract.max) {
          problems.push(`${clip.id}.${name}=${raw.toFixed(3)} outside ${contract.min}..${contract.max}`);
        }
        if (Math.abs(raw) > NEGLIGIBLE_GRADE) movesSomething = true;
      }
      if (movesSomething) moved += 1;
      else problems.push(`${clip.id} carries a grade that changes nothing`);
    }
  }
  return {
    id: 'grades-real-and-in-range',
    ok: grades > 0 && problems.length === 0,
    detail:
      grades === 0
        ? 'no grade applied'
        : problems.length === 0
          ? `${String(moved)} grade(s), every parameter inside its contract`
          : problems.join('; '),
    weight: 2,
  };
}

/** How far a "warmer" look may move an axis it does not name before it is a different edit. */
const WARMTH_ONLY_TOLERANCE = 0.1;

/**
 * A "make it warmer" moves warmth, on every picture clip, and moves nothing else.
 *
 * That is the look table's own content, not a number invented here: `LOOK_DELTAS.warmer` is
 * `{ warmthDelta: 0.1 }` and the amount scale halves it for "a little" — exposure, contrast
 * and saturation targets are carried through unchanged, so a solved warmer look comes back
 * as temperature (and whatever tint it costs to hold green/magenta) and nothing else. What
 * the rubric can therefore assert is the DIRECTION and the ABSENCE of the other axes; the
 * exact temperature depends on each shot's measured luma and is the solver's business.
 */
export function checkWarmedEveryClip(project: Project, maxTemperature: number): RubricCheck {
  const clips = pictureClips(project);
  if (clips.length === 0) {
    return { id: 'warmed-every-clip', ok: false, detail: 'no picture clip', weight: 2, facet: 'target' };
  }
  const cold: string[] = [];
  const overshot: string[] = [];
  const strayAxes: string[] = [];
  for (const clip of clips) {
    const temperature = gradeAxis(clip, 'temperature');
    if (temperature === null || temperature <= NEGLIGIBLE_GRADE) cold.push(clip.id);
    // `>=`, not `>`: at the contract rail the solve was clamped, so the warmth it promised
    // is not the warmth that landed. Inside the range it is the solver's arithmetic.
    else if (temperature >= maxTemperature) overshot.push(`${clip.id}=${temperature.toFixed(2)}`);
    for (const axis of ['exposure', 'contrast', 'saturation'] as const) {
      const value = gradeAxis(clip, axis);
      if (value !== null && Math.abs(value) > WARMTH_ONLY_TOLERANCE) {
        strayAxes.push(`${clip.id}.${axis}=${value.toFixed(2)}`);
      }
    }
  }
  const problems = [
    ...(cold.length > 0 ? [`not warmed: ${cold.join(', ')}`] : []),
    ...(overshot.length > 0 ? [`clamped at the contract rail: ${overshot.join(', ')}`] : []),
    ...(strayAxes.length > 0 ? [`moved axes nobody asked for: ${strayAxes.join(', ')}`] : []),
  ];
  return {
    id: 'warmed-every-clip',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${String(clips.length)} clip(s) warmed, warmth only, none at the ${maxTemperature} rail`
        : problems.join('; '),
    weight: 2,
    facet: 'target',
  };
}

/** One butt cut between two picture clips on the same track. */
interface PictureCutPair {
  readonly from: Clip;
  readonly to: Clip;
  /** The two clips come from different assets — a scene change by construction. */
  readonly sceneChange: boolean;
  /** Same asset, contiguous source — a continuity cut, where a dissolve is the amateur tell. */
  readonly continuity: boolean;
}

/** Source seconds two cut halves may be apart and still count as contiguous. */
const CONTINUITY_GAP_SECONDS = 0.5;

/** Every butt cut on every picture track, in timeline order. */
export function pictureCutPairs(project: Project): readonly PictureCutPair[] {
  const pairs: PictureCutPair[] = [];
  for (const track of pictureTracks(project)) {
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      const from = clips[i - 1]!;
      const to = clips[i]!;
      if (Math.abs(to.start - from.end) > 0.05) continue;
      const sameAsset = from.assetId === to.assetId;
      pairs.push({
        from,
        to,
        sceneChange: !sameAsset,
        continuity:
          sameAsset && Math.abs(to.sourceStart - from.sourceEnd) <= CONTINUITY_GAP_SECONDS,
      });
    }
  }
  return pairs;
}

/** Does this cut carry a transition, on either side of it? */
function cutHasTransition(pair: PictureCutPair): boolean {
  return (
    pair.to.effects.some((effect) => effect.type === TRANSITION_EFFECT_TYPE) ||
    pair.from.effects.some((effect) => effect.type === TRANSITION_OUT_EFFECT_TYPE)
  );
}

/**
 * A transition landed at a cut that changes source — the cuts a transition belongs at.
 *
 * "Where they belong" is a claim about WHICH cuts, so it needs both halves; this is the
 * positive one. Deliberately "at least one" rather than "at every one": the policy is
 * allowed to leave a scene change hard (a montage that dissolves eight times is worse than
 * one that dissolves twice), and a rubric demanding all of them would fail the better edit.
 */
export function checkTransitionAtASceneChange(project: Project): RubricCheck {
  const pairs = pictureCutPairs(project);
  const changes = pairs.filter((pair) => pair.sceneChange);
  if (changes.length === 0) {
    return {
      id: 'transition-at-a-scene-change',
      ok: false,
      detail: 'no cut in this timeline changes source, so there is nothing to score',
      weight: 2,
      facet: 'target',
      skipped: true,
    };
  }
  const carried = changes.filter(cutHasTransition);
  return {
    id: 'transition-at-a-scene-change',
    ok: carried.length > 0,
    detail: `${String(carried.length)}/${String(changes.length)} source-change cut(s) carry a transition`,
    weight: 2,
    facet: 'target',
  };
}

/**
 * No transition on a continuity cut — the negative half, and the one that is actually hard.
 *
 * A dissolve where one shot simply continues into the next is the classic amateur tell, and
 * it is exactly what a run that adds transitions everywhere produces. `chooseTransition`
 * returns `null` for `continuity` no matter how large the measured deltas are; this is that
 * rule read back off the timeline. Skipped when the timeline has no continuity cut, because
 * then the check has nothing to be right or wrong about.
 */
export function checkNoTransitionOnContinuityCuts(project: Project): RubricCheck {
  const continuity = pictureCutPairs(project).filter((pair) => pair.continuity);
  if (continuity.length === 0) {
    return {
      id: 'no-transition-on-continuity-cuts',
      ok: true,
      detail: 'no continuity cut on this timeline',
      weight: 2,
      facet: 'target',
      skipped: true,
    };
  }
  const offenders = continuity.filter(cutHasTransition).map((pair) => `${pair.from.id}→${pair.to.id}`);
  return {
    id: 'no-transition-on-continuity-cuts',
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? `${String(continuity.length)} continuity cut(s) left hard`
        : `dissolved a continuity cut: ${offenders.join(', ')}`,
    weight: 2,
    facet: 'target',
  };
}

/** Timeline seconds spanned by the first occurrence of a phrase in the transcript. */
export function phraseSpan(
  words: readonly TranscriptWord[] | undefined,
  phrase: string,
): readonly [number, number] | null {
  const needle = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words || words.length === 0 || needle.length === 0) return null;
  const clean = (word: TranscriptWord): string => word.word.toLowerCase().replace(/[^a-z0-9']/g, '');
  for (let i = 0; i + needle.length <= words.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (clean(words[i + j]!) !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return [words[i]!.start, words[i + needle.length - 1]!.end];
  }
  return null;
}

/** How far off the named line a cutaway may sit and still be covering it. */
const CUTAWAY_PHRASE_SLACK_SECONDS = 1;

/**
 * A b-roll clip covers the line the request named, resolved through the transcript.
 *
 * The target here is a SENTENCE, not a time window — that is the whole difference from
 * `broll-cutaway`, whose prompt says "the first 20 seconds". Resolving "the line about X"
 * means finding those words and covering them, and a run that placed a perfectly good
 * cutaway 90 seconds away has failed at the thing this case measures.
 *
 * What this deliberately does NOT judge: whether the b-roll it chose is ABOUT the line.
 * That needs a verified label on the footage, and the fixture b-roll has none (see
 * `tests/fixtures/mission/labels/README.md`) — so the footage choice is left to the
 * operator rather than faked with a filename match.
 */
export function checkCutawayCoversPhrase(
  ctx: RubricContext,
  brollAssetIds: readonly string[],
  phrase: string,
): RubricCheck {
  const span = phraseSpan(ctx.before.transcript, phrase);
  if (span === null) {
    return {
      id: 'cutaway-covers-the-line',
      ok: false,
      detail: `the phrase "${phrase}" is not in this project's transcript`,
      weight: 2,
      facet: 'target',
      skipped: true,
    };
  }
  const [from, to] = span;
  const broll = new Set(brollAssetIds);
  const covering = pictureClips(ctx.after).filter(
    (clip) =>
      broll.has(clip.assetId) &&
      clip.start <= to + CUTAWAY_PHRASE_SLACK_SECONDS &&
      clip.end >= from - CUTAWAY_PHRASE_SLACK_SECONDS,
  );
  return {
    id: 'cutaway-covers-the-line',
    ok: covering.length > 0,
    detail: `${String(covering.length)} b-roll clip(s) over "${phrase}" (${from.toFixed(1)}–${to.toFixed(1)}s)`,
    weight: 2,
    facet: 'target',
  };
}

/** Every clip whose source range is clear of a timeline window keeps its content. */
export function checkContentPreservedOutside(
  ctx: RubricContext,
  window: readonly [number, number],
): RubricCheck {
  const [from, to] = window;
  const untouched = pictureClips(ctx.before).filter(
    (clip) => clip.end <= from - CUTAWAY_PHRASE_SLACK_SECONDS || clip.start >= to + CUTAWAY_PHRASE_SLACK_SECONDS,
  );
  const surviving = new Set(pictureClips(ctx.after).map(contentKey));
  const lost = untouched.filter((clip) => !surviving.has(contentKey(clip))).map((clip) => clip.id);
  return {
    id: 'content-outside-the-line-preserved',
    ok: lost.length === 0,
    detail:
      lost.length === 0
        ? `${String(untouched.length)} clip(s) away from the line kept their content`
        : `lost away from the line: ${lost.join(', ')}`,
    facet: 'target',
  };
}

/** Source seconds two clips of one asset must share before they are the same take twice. */
const DUPLICATE_OVERLAP_SECONDS = 0.5;

/** Pairs of picture clips that play the same material of the same asset twice. */
export function duplicateTakePairs(project: Project): readonly (readonly [Clip, Clip])[] {
  const clips = pictureClips(project);
  const pairs: (readonly [Clip, Clip])[] = [];
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const a = clips[i]!;
      const b = clips[j]!;
      if (a.assetId !== b.assetId) continue;
      const overlap = Math.min(a.sourceEnd, b.sourceEnd) - Math.max(a.sourceStart, b.sourceStart);
      if (overlap > DUPLICATE_OVERLAP_SECONDS) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * The repeated material is gone.
 *
 * A duplicate take is defined here as two clips playing OVERLAPPING SOURCE of the same
 * asset — a fact the project file proves. It is deliberately not tier 1's `duplicateOf`,
 * which is a phash cluster over two different recordings of the same action: no committed
 * fixture ships two such takes, so a rubric that read `duplicateOf` would score nothing.
 * See the case's `why`.
 */
export function checkDuplicateTakesRemoved(ctx: RubricContext): RubricCheck {
  const was = duplicateTakePairs(ctx.before);
  if (was.length === 0) {
    return {
      id: 'duplicate-takes-removed',
      ok: false,
      detail: 'the timeline going in had no repeated material, so there was nothing to drop',
      weight: 2,
      facet: 'target',
      skipped: true,
    };
  }
  const now = duplicateTakePairs(ctx.after);
  return {
    id: 'duplicate-takes-removed',
    ok: now.length === 0,
    detail: `${String(was.length)} repeated pair(s) before, ${String(now.length)} after`,
    weight: 2,
    facet: 'target',
  };
}

/**
 * Everything that was NOT a repeat is still on the timeline.
 *
 * The other half, and the one that fails the cheap answer: deleting most of the programme
 * removes every duplicate too. A before-clip survives when the after timeline still plays
 * some of the same source of the same asset.
 */
export function checkUniqueTakesKept(ctx: RubricContext): RubricCheck {
  const duplicated = new Set(duplicateTakePairs(ctx.before).flatMap(([a, b]) => [a.id, b.id]));
  const after = pictureClips(ctx.after);
  const lost = pictureClips(ctx.before)
    .filter((clip) => !duplicated.has(clip.id))
    .filter(
      (clip) =>
        !after.some(
          (kept) =>
            kept.assetId === clip.assetId &&
            Math.min(kept.sourceEnd, clip.sourceEnd) - Math.max(kept.sourceStart, clip.sourceStart) >
              FRAME_EPSILON,
        ),
    )
    .map((clip) => clip.id);
  return {
    id: 'unique-takes-kept',
    ok: lost.length === 0,
    detail: lost.length === 0 ? 'every un-repeated shot survived' : `also dropped: ${lost.join(', ')}`,
    weight: 2,
    facet: 'target',
  };
}

const COMMON = (ctx: RubricContext): RubricCheck[] => [
  checkValidRefs(ctx.after),
  checkNoOverlaps(ctx.after),
  checkCutsOnFrameGrid(ctx.after, ctx.before),
];

function scored(scenario: MissionScenarioId, checks: readonly RubricCheck[]): RubricScore {
  // A skipped check leaves BOTH sums. Counting it in the denominator alone would fail a
  // run for an instrument that could not look; counting it in both — which is what
  // `ok: true` did — hands out a free point on every case that reads `mission-podcast`'s
  // fabricated transcript. The checks list still carries it, so the report says why.
  const judged = checks.filter((c) => c.skipped !== true);
  const total = judged.reduce((s, c) => s + (c.weight ?? 1), 0);
  const passed = judged.reduce((s, c) => s + (c.ok ? (c.weight ?? 1) : 0), 0);
  return { scenario, score: total === 0 ? 0 : passed / total, checks };
}

/** Score one scenario's outcome. Pure. */
export function scoreMissionScenario(scenario: MissionScenarioId, ctx: RubricContext): RubricScore {
  const p = ctx.after;
  switch (scenario) {
    case 'montage-30s':
      return scored(scenario, [
        checkChanged(ctx),
        checkDurationWithin(p, 30, 3),
        checkMinClips(p, 6),
        ...COMMON(ctx),
      ]);
    case 'podcast-highlight-60s':
      return scored(scenario, [
        checkChanged(ctx),
        checkDurationWithin(p, ctx.durationTargetSeconds ?? 60, 10),
        checkNoMidWordCuts(p, ctx.before),
        ...COMMON(ctx),
      ]);
    case 'remove-dead-air':
      return scored(scenario, [
        checkChanged(ctx),
        checkShorterThanBefore(ctx),
        checkNoMidWordCuts(p, ctx.before),
        checkMinClips(p, 2),
        ...COMMON(ctx),
      ]);
    case 'beat-sync':
      return scored(scenario, [
        checkChanged(ctx),
        checkHasMusic(p),
        checkCutsOnBeats(p, ctx.beatPeriodSeconds ?? 0.6, ctx.beatTimes),
        checkMinClips(p, 6),
        ...COMMON(ctx),
      ]);
    case 'refine-tighten':
      return scored(scenario, [
        checkChanged(ctx),
        // NOT `checkShorterThanBefore`. The prompt is "tighten the middle section so it
        // moves faster, but keep the first and last clips exactly as they are", and that
        // does not ask for a shorter programme — it asks for a faster cutting rhythm.
        // Session-3 run 1 did exactly that: 13 picture clips became 15, the first and
        // last untouched, the programme still 29.4s. A correct, skilled edit, scored
        // 0.875 by a check measuring something the request never mentioned. (The same
        // failure is in the committed `baseline`, twice, and was read there as the agent
        // falling short.) The case exists to prove a second turn REFINES rather than
        // restarts; that is what these three checks now say.
        checkCutsFasterThanBefore(ctx),
        checkKeptClipsUntouched(ctx),
        ...COMMON(ctx),
      ]);
    case 'memory-captions':
      return scored(scenario, [checkChanged(ctx), checkHasCaptions(p), ...COMMON(ctx)]);
    case 'trim-first-clip': {
      const first = pictureClips(ctx.before)[0];
      return scored(scenario, [
        checkChanged(ctx),
        checkFirstClipEndsAt(p, ctx.expectedFirstClipEndSeconds ?? 10),
        checkOnlyClipsTouched(ctx, first ? [first.id] : []),
        ...COMMON(ctx),
      ]);
    }
    case 'reorder-last-first':
      return scored(scenario, [
        checkChanged(ctx),
        checkLastClipMovedFirst(ctx),
        checkContentPreserved(ctx),
        checkNoCollateralChanges(ctx),
        checkNoGaps(p),
        ...COMMON(ctx),
      ]);
    case 'captions':
      return scored(scenario, [
        checkChanged(ctx),
        checkHasCaptions(p),
        checkCaptionsWellFormed(p),
        checkContentPreserved(ctx),
        ...COMMON(ctx),
      ]);
    case 'hook-first':
      return scored(scenario, [
        checkChanged(ctx),
        checkOpensLaterInSource(ctx),
        checkNoMidWordCuts(p, ctx.before),
        checkNotLonger(ctx),
        ...COMMON(ctx),
      ]);
    case 'broll-cutaway':
      return scored(scenario, [
        checkChanged(ctx),
        checkCutawayInWindow(p, ctx.brollAssetIds ?? [], ctx.cutawayWindowSeconds ?? [0, 20]),
        checkDurationKept(ctx),
        ...COMMON(ctx),
      ]);
    // `broll-cutaway` plus the assertion that fixture cannot make, because `mission-talk`
    // has no second video track: whatever the run stacks, the editor must be able to SEE it
    // before approving it. Deliberately no check on WHICH track the b-roll landed on —
    // since ADR 0169 both routes are correct (split the programme and cut in, or take a
    // front layer), and a rubric that grades the route instead of the outcome would fail a
    // run for choosing the other right answer. A NEW rubric rather than more checks on
    // `broll-cutaway`, so the existing case keeps measuring what its recorded floor was
    // written against (`reports/golden/floor.json`).
    case 'broll-cutaway-empty-overlay':
      return scored(scenario, [
        checkChanged(ctx),
        checkCutawayInWindow(p, ctx.brollAssetIds ?? [], ctx.cutawayWindowSeconds ?? [0, 20]),
        checkStackedPictureIsPreviewable(p),
        checkDurationKept(ctx),
        ...COMMON(ctx),
      ]);
    case 'music-bed':
      return scored(scenario, [
        checkChanged(ctx),
        checkMusicCovers(p, ctx.musicAssetId),
        checkMusicQuieter(p, ctx.musicAssetId),
        checkContentPreserved(ctx),
        ...COMMON(ctx),
      ]);
    case 'compound-silence-captions':
      return scored(scenario, [
        checkChanged(ctx),
        checkShorterThanBefore(ctx),
        checkNoMidWordCuts(p, ctx.before),
        checkHasCaptions(p),
        checkCaptionsWellFormed(p),
        ...COMMON(ctx),
      ]);
    case 'unchanged':
      return scored(scenario, [checkUnchanged(ctx), ...COMMON(ctx)]);
    case 'wiped':
      return scored(scenario, [checkChanged(ctx), checkTimelineWiped(ctx), ...COMMON(ctx)]);
    case 'vague-not-destructive':
      return scored(scenario, [checkNotDestructive(ctx), ...COMMON(ctx)]);
    case 'trim-first-clip-head': {
      const first = pictureClips(ctx.before)[0];
      return scored(scenario, [
        checkChanged(ctx),
        checkFirstClipHeadTrimmed(ctx, ctx.expectedHeadTrimSeconds ?? 10),
        checkOnlyClipsTouched(ctx, first ? [first.id] : []),
        ...COMMON(ctx),
      ]);
    }
    case 'reorder-swap-first-two':
      return scored(scenario, [
        checkChanged(ctx),
        checkFirstTwoSwapped(ctx),
        checkContentPreserved(ctx),
        checkNoCollateralChanges(ctx),
        checkNoGaps(p),
        ...COMMON(ctx),
      ]);
    case 'captions-styled':
      return scored(scenario, [
        checkChanged(ctx),
        checkHasCaptions(p),
        checkCaptionsWellFormed(p),
        checkCaptionStyleMatches(p, ctx.captionStyle ?? {}),
        checkContentPreserved(ctx),
        ...COMMON(ctx),
      ]);

    // ── plan/visual-understanding VU0.3 ──────────────────────────────────────────────
    // The picture cases. Each one names the clips the request named, checks what the run
    // did to THOSE, and carries `no-collateral-changes` so an edit that also re-cut the
    // programme cannot score for the part it got right.
    case 'match-color-to-reference': {
      const target = pictureClips(ctx.before)[MATCH_COLOR_TARGET_INDEX];
      return scored(scenario, [
        checkChanged(ctx),
        checkGradeLandedOnTarget(ctx, MATCH_COLOR_TARGET_INDEX, MATCH_COLOR_REFERENCE_INDEX),
        checkGradesAreRealAndInRange(p),
        // Nothing may MOVE at all — a colour request re-cutting the timeline is the
        // collateral failure — and only the target clip may gain an effect.
        checkNoCollateralChanges(ctx, [], target ? [target.id] : []),
        ...COMMON(ctx),
      ]);
    }
    case 'warmer-subtle':
      return scored(scenario, [
        checkChanged(ctx),
        checkWarmedEveryClip(p, WARMER_SUBTLE_MAX_TEMPERATURE),
        checkGradesAreRealAndInRange(p),
        // Every picture clip may legitimately be graded (a look is per clip), so the
        // collateral guard here is geometry: a look must not cut anything.
        checkNoCollateralChanges(ctx, [], 'any'),
        ...COMMON(ctx),
      ]);
    case 'transitions-where-they-belong':
      return scored(scenario, [
        checkChanged(ctx),
        checkTransitionAtASceneChange(p),
        checkNoTransitionOnContinuityCuts(p),
        // A transition is an effect on the incoming clip; it never moves a clip. So a run
        // that also re-cut the programme did something it was not asked to do.
        checkNoCollateralChanges(ctx, [], 'any'),
        ...COMMON(ctx),
      ]);
    case 'broll-over-sentence': {
      const span = phraseSpan(ctx.before.transcript, BROLL_SENTENCE_PHRASE);
      return scored(scenario, [
        checkChanged(ctx),
        checkCutawayCoversPhrase(ctx, ctx.brollAssetIds ?? [], BROLL_SENTENCE_PHRASE),
        checkDurationKept(ctx),
        ...(span === null ? [] : [checkContentPreservedOutside(ctx, span)]),
        ...COMMON(ctx),
      ]);
    }
    case 'remove-duplicate-takes':
      return scored(scenario, [
        checkChanged(ctx),
        checkDuplicateTakesRemoved(ctx),
        checkUniqueTakesKept(ctx),
        checkNoGaps(p),
        ...COMMON(ctx),
      ]);
  }
}
