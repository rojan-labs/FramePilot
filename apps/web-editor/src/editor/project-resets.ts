/**
 * The two "start again" edits Settings → Memory offers, as ordinary reversible patches.
 *
 * Neither is a special path: a memory reset is one `set_ai_memory` (whose inverse is the
 * record that was there), a timeline reset is one `remove_layer` per track plus one
 * `remove_marker` per marker (each lossless to undo). Both therefore land in the edit
 * history, persist the way every other edit does, and come back with ⌘Z.
 *
 * WHY they exist: an agent run inherits whatever the previous run left — a caption style
 * with pixel-sized padding, markers whose ids the next run will collide with. Run
 * `1603cd9c` (2026-09-08) spent its whole budget on exactly that inheritance. The editor
 * needs a one-click way to hand the assistant a clean slate without deleting the project.
 */
import type { Patch } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';

// Same cast the editor's own patch builders use (`patch-builders-base.ts`): a patch id is
// a branded string the store never derives meaning from.
const patchId = (stem: string): Patch['patchId'] =>
  `${stem}_${String(Date.now())}` as Patch['patchId'];

/** Does the project carry any AI memory worth clearing? */
export function hasAiMemory(project: Project): boolean {
  return Object.keys(project.aiMemory ?? {}).length > 0;
}

/**
 * Clear everything the assistant remembers about this project — preferences, accepted and
 * rejected edits, provenance. `null` when there is nothing to clear.
 */
export function resetAiMemoryPatch(project: Project): Patch | null {
  if (!hasAiMemory(project)) return null;
  return {
    patchId: patchId('reset_ai_memory'),
    createdBy: 'user',
    reason: 'Reset AI memory',
    operations: [{ type: 'set_ai_memory', memory: {} }],
  };
}

/** What a timeline reset would remove, for the confirmation copy. */
export function timelineResetSummary(project: Project): {
  readonly tracks: number;
  readonly clips: number;
  readonly markers: number;
} {
  const tracks = project.timeline.tracks;
  return {
    tracks: tracks.length,
    clips: tracks.reduce((sum, track) => sum + track.clips.length, 0),
    markers: project.markers.length,
  };
}

/**
 * Empty the timeline: every track with its clips and effect layers, and every marker.
 * The media bin, the transcript and the AI memory are untouched. `null` when the timeline
 * is already empty.
 */
export function resetTimelinePatch(project: Project): Patch | null {
  const { tracks, markers } = timelineResetSummary(project);
  if (tracks === 0 && markers === 0) return null;
  return {
    patchId: patchId('reset_timeline'),
    createdBy: 'user',
    reason: 'Reset timeline',
    operations: [
      ...project.timeline.tracks.map((track) => ({ type: 'remove_layer' as const, layerId: track.id })),
      ...project.markers.map((marker) => ({ type: 'remove_marker' as const, id: marker.id })),
    ],
  };
}
