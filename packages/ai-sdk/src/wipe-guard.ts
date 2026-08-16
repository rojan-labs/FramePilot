/**
 * Timeline wipe guard — agent continuity protection.
 *
 * WHY: an agent that decides to "start fresh" can repeatedly destroy prior work and
 * prevent a project from converging. This deterministic guard rejects a call whose
 * deletes clear every clip on a multi-clip track, or whose remove_layer drops a
 * populated track, when that work existed before the current run.
 */

import type { AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';

export interface WipeGuardContext {
  readonly baselineClipIds: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Only an explicit PROJECT-WIDE reset disables continuity protection.
 *
 * Ordinary editing verbs are deliberately absent. "remove silence", "redo captions",
 * "clear the caption track", or "rebuild the intro" authorize a scoped edit, not the
 * destruction of unrelated timeline work. A future scoped destructive-authority model
 * may permit a named track/range without weakening protection elsewhere.
 *
 * "start over"/"begin again"/"start fresh" carry the same requirement: a narrower object
 * named right after the phrase — "start over with just the intro", "start over on the
 * color grade" — is a scoped request, not a full reset, so it must NOT disable the guard
 * for the rest of the run (a later unrelated delete on a different track would then go
 * undetected). Only two shapes count as a full reset: the bare phrase with nothing (or
 * only "from scratch") after it, or the phrase followed by an explicit
 * project/timeline/everything object — mirroring the delete/remove branch below exactly.
 */
const FULL_RESET_INTENT =
  /(?:\b(?:start|begin)\s+(?:over|again|fresh)(?:\s+from\s+scratch)?\b(?=\s*(?:[.,!?]|$))|\b(?:start|begin)\s+(?:over|again|fresh)(?:\s+from\s+scratch)?\b\s+(?:on\s+|with\s+)?(?:(?:the\s+)?(?:entire\s+|whole\s+|all\s+)?(?:project|timeline)|everything)\b|\bfrom\s+scratch\b|\b(?:delete|remove|clear|wipe|erase|empty|discard|scrap)\s+(?:the\s+)?(?:entire\s+|whole\s+|all\s+)?(?:project|timeline)\b|\b(?:delete|remove|clear|wipe|erase)\s+everything\b)/i;

const COVERAGE_EPSILON = 1e-6;

export function wipeGuardFor(
  userPrompt: string | undefined,
  baseline: Project,
): WipeGuardContext | undefined {
  if (userPrompt && FULL_RESET_INTENT.test(userPrompt)) return undefined;
  const baselineClipIds = new Map<string, ReadonlySet<string>>();
  for (const track of baseline.timeline.tracks) {
    baselineClipIds.set(track.id, new Set(track.clips.map((clip) => clip.id)));
  }
  return { baselineClipIds };
}

export function detectTimelineWipe(
  ops: readonly AnyOperation[],
  working: Project,
  guard: WipeGuardContext | undefined,
): string | null {
  if (!guard) return null;

  for (const op of ops) {
    if (op.type !== 'remove_layer') continue;
    const track = working.timeline.tracks.find((t) => t.id === op.layerId);
    if (!track || track.clips.length < 2) continue;
    const baseline = guard.baselineClipIds.get(op.layerId);
    if (!track.clips.some((clip) => baseline?.has(clip.id))) continue;
    return (
      `this would remove track "${op.layerId}" and every clip on it ` +
      `(${track.clips.length} clips), including work that existed before this ` +
      "run. The timeline you were given is the user's progress so far — continue " +
      'from it, never restart it. Make targeted edits instead: delete_clip, ' +
      'trim_clip, split_clip, or move_clip. If the editor truly wants this entire ' +
      'track discarded, ask them to state that scope explicitly rather than treating ' +
      'a local remove/redo request as permission to wipe unrelated work.'
    );
  }

  const coveredClipIdsByTrack = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.type !== 'ripple_delete' && op.type !== 'delete_range') continue;
    const track = working.timeline.tracks.find((t) => t.id === op.trackId);
    if (!track) continue;
    const covered = coveredClipIdsByTrack.get(op.trackId) ?? new Set<string>();
    for (const clip of track.clips) {
      if (clip.start >= op.start - COVERAGE_EPSILON && clip.end <= op.end + COVERAGE_EPSILON) {
        covered.add(clip.id);
      }
    }
    coveredClipIdsByTrack.set(op.trackId, covered);
  }
  for (const [trackId, covered] of coveredClipIdsByTrack) {
    const track = working.timeline.tracks.find((t) => t.id === trackId);
    if (!track || track.clips.length < 2 || covered.size !== track.clips.length) continue;
    const baseline = guard.baselineClipIds.get(trackId);
    const destroysPriorWork = [...covered].some((clipId) => baseline?.has(clipId));
    if (!destroysPriorWork) continue;
    return (
      `this would delete every clip on track "${trackId}" (${covered.size} clips), ` +
      'including work that existed before this run. Continue from the current timeline ' +
      'with targeted trim/split/move/delete operations. A scoped cleanup request does ' +
      'not authorize a full-track wipe.'
    );
  }
  return null;
}
