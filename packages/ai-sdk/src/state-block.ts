/**
 * @framepilot/ai-sdk/state-block — the structured STATE block at the head of every
 * system context (plan/system-mission P1.3).
 *
 * WHY a fixed-shape block instead of prose: the facts a model needs on every turn —
 * what the project is, how long the cut is, what is selected, where the playhead sits —
 * were spread across a prose header, a "Selected range" line and the interaction
 * summary, each restating the others in its own words. One block with a fixed key
 * order is cheaper to read, cannot contradict itself, and keeps the prompt-cache prefix
 * byte-stable from turn to turn: only the values that actually changed change.
 *
 * Deliberately NOT here: the run's `task` (goal, stage, budget) is owned by the agent
 * loop's briefing (`kernel/briefing.ts`), which is rewritten per stage and sits after
 * the cache boundary by design; `memory` stays its own tier so the budgeter can drop it
 * under pressure while this block never drops.
 */
import type { Project, Timeline, Track } from '@framepilot/timeline-schema';

import type { EditorInteractionContext } from './editor-context/interaction-context.js';

export interface StateBlockInput {
  readonly project: Project;
  /** Host authority revision (distinct from the timeline's structural revision). */
  readonly projectRevision?: number;
  readonly selection?: { readonly start: number; readonly end: number };
  readonly interaction?: EditorInteractionContext;
}

/** Fixed-order key list of the `project` line — a test pins it so the prefix stays stable. */
export const STATE_PROJECT_KEYS = [
  'id',
  'aspect',
  'fps',
  'duration',
  'resolution',
  'tracks',
] as const;
/** Fixed-order key list of the `timeline` line. */
export const STATE_TIMELINE_KEYS = ['selection', 'playhead', 'revision'] as const;

const seconds = (n: number): string => `${(Math.round(n * 1000) / 1000).toString()}s`;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "9:16" for 1080x1920, "16:9" for 1920x1080, "1:1", "4:5"; falls back to the pixel ratio. */
export function aspectLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '?';
  const d = gcd(width, height);
  const w = width / d;
  const h = height / d;
  // Common broadcast/social frames reduce to small integers; anything else stays exact.
  return `${String(w)}:${String(h)}`;
}

/** Furthest clip end on any track; 0 for an empty timeline. */
export function timelineDurationSeconds(timeline: Timeline): number {
  let end = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) if (clip.end > end) end = clip.end;
  }
  return end;
}

function trackEntry(track: Track): string {
  return `{ id: ${track.id}, kind: ${track.type}, clips: ${String(track.clips.length)} }`;
}

/** The `project { … }` line. Pure. */
export function renderProjectState(project: Project): string {
  const { width, height } = project.resolution;
  const tracks = project.timeline.tracks.map(trackEntry).join(', ');
  return (
    `project  { id: ${project.id}, aspect: ${aspectLabel(width, height)}, fps: ${String(project.fps)}, ` +
    `duration: ${seconds(timelineDurationSeconds(project.timeline))}, ` +
    `resolution: ${String(width)}x${String(height)}, tracks: [${tracks}] }`
  );
}

/** The `timeline { … }` line. Pure. */
export function renderTimelineState(input: StateBlockInput): string {
  const range = input.selection ?? input.interaction?.selection.timeRange;
  const selection = range ? `${seconds(range.start)}–${seconds(range.end)}` : 'none';
  const playhead = input.interaction ? seconds(input.interaction.playhead.seconds) : '–';
  const revision = input.projectRevision ?? input.interaction?.projectRevision;
  return `timeline { selection: ${selection}, playhead: ${playhead}, revision: ${revision === undefined ? '–' : String(revision)} }`;
}

/**
 * The whole block. Always the first mandatory section of the system context; never
 * budgeted away. Same input → byte-identical output.
 */
export function renderStateBlock(input: StateBlockInput): string {
  return ['STATE', renderProjectState(input.project), renderTimelineState(input)].join('\n');
}
