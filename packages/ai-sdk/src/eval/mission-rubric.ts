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
import type { Clip, Project, Track, TranscriptWord } from '@framepilot/timeline-schema';
import {
  CAPTION_ASSET_ID,
  TEXT_OVERLAY_ASSET_ID,
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
  | 'captions-styled';

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
  }
}
