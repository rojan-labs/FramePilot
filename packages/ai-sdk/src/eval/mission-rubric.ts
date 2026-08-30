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
import { timelineDuration } from '../critic.js';

export interface RubricCheck {
  readonly id: string;
  readonly ok: boolean;
  /** The number or fact that decided `ok`, for the report. */
  readonly detail: string;
  /** Weight in the scenario score; defaults to 1. */
  readonly weight?: number;
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
  | 'memory-captions';

export interface RubricContext {
  /** The project the run started from (needed for before/after checks). */
  readonly before: Project;
  /** The project after every valid diff was folded in. */
  readonly after: Project;
  /** Beat period in seconds for the fixture music, when the scenario needs a grid. */
  readonly beatPeriodSeconds?: number;
  /** Clip ids the refinement request named as "keep"; must survive unchanged. */
  readonly keepClipIds?: readonly string[];
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

export function checkCutsOnFrameGrid(project: Project): RubricCheck {
  const offGrid = pictureClips(project).filter(
    (c) => !onFrameGrid(c.start, project.fps) || !onFrameGrid(c.end, project.fps),
  );
  return {
    id: 'cuts-on-frame-grid',
    ok: offGrid.length === 0,
    detail: `${offGrid.length} clip edge(s) off the ${project.fps} fps grid`,
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

export function checkValidRefs(project: Project): RubricCheck {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const dangling = project.timeline.tracks
    .flatMap((t) => t.clips)
    .filter((c) => !assetIds.has(c.assetId));
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
export function checkNoMidWordCuts(project: Project): RubricCheck {
  const words: readonly TranscriptWord[] = project.transcript;
  if (words.length === 0) return { id: 'no-mid-word-cuts', ok: true, detail: 'no transcript' };
  let midWord = 0;
  for (const clip of pictureClips(project)) {
    for (const edge of [clip.sourceStart, clip.sourceEnd]) {
      if (words.some((w) => w.start + 0.02 < edge && edge < w.end - 0.02)) midWord++;
    }
  }
  return { id: 'no-mid-word-cuts', ok: midWord === 0, detail: `${midWord} edge(s) inside a word` };
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

/** Share of picture cuts that land on the fixture's beat grid, anchored at the placed music. */
export function checkCutsOnBeats(project: Project, beatPeriodSeconds: number): RubricCheck {
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
  const onBeat = cuts.filter((t) => {
    const rel = t - offset;
    const nearest = Math.round(rel / beatPeriodSeconds) * beatPeriodSeconds;
    return Math.abs(rel - nearest) <= BEAT_TOLERANCE_SECONDS;
  }).length;
  const share = onBeat / cuts.length;
  return {
    id: 'cuts-on-beats',
    ok: share >= 0.8,
    detail: `${onBeat}/${cuts.length} cuts within ${BEAT_TOLERANCE_SECONDS}s of a beat (${(share * 100).toFixed(0)}%)`,
    weight: 2,
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
  };
}

export function checkHasCaptions(project: Project): RubricCheck {
  const captionClips = project.timeline.tracks
    .filter((t) => t.type === 'caption' || t.type === 'overlay')
    .flatMap((t) => t.clips);
  return { id: 'has-captions', ok: captionClips.length > 0, detail: `${captionClips.length} caption clip(s)`, weight: 2 };
}

const COMMON = (p: Project): RubricCheck[] => [
  checkValidRefs(p),
  checkNoOverlaps(p),
  checkCutsOnFrameGrid(p),
];

function scored(scenario: MissionScenarioId, checks: readonly RubricCheck[]): RubricScore {
  const total = checks.reduce((s, c) => s + (c.weight ?? 1), 0);
  const passed = checks.reduce((s, c) => s + (c.ok ? (c.weight ?? 1) : 0), 0);
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
        ...COMMON(p),
      ]);
    case 'podcast-highlight-60s':
      return scored(scenario, [
        checkChanged(ctx),
        checkDurationWithin(p, 60, 10),
        checkNoMidWordCuts(p),
        ...COMMON(p),
      ]);
    case 'remove-dead-air':
      return scored(scenario, [
        checkChanged(ctx),
        checkShorterThanBefore(ctx),
        checkNoMidWordCuts(p),
        checkMinClips(p, 2),
        ...COMMON(p),
      ]);
    case 'beat-sync':
      return scored(scenario, [
        checkChanged(ctx),
        checkHasMusic(p),
        checkCutsOnBeats(p, ctx.beatPeriodSeconds ?? 0.6),
        checkMinClips(p, 6),
        ...COMMON(p),
      ]);
    case 'refine-tighten':
      return scored(scenario, [
        checkChanged(ctx),
        checkShorterThanBefore(ctx),
        checkKeptClipsUntouched(ctx),
        ...COMMON(p),
      ]);
    case 'memory-captions':
      return scored(scenario, [checkChanged(ctx), checkHasCaptions(p), ...COMMON(p)]);
  }
}
