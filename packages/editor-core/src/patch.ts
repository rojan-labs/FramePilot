/**
 * @framepilot/editor-core/patch — patch envelope and engine (PRD §8.4 / PLAN §1.3).
 *
 * A `Patch` is the only way edits reach a timeline: a named, reasoned bundle of
 * operations that is validated, previewed, applied transactionally, and reversible.
 * This module implements the transactional apply, inverse computation, and the
 * before/after diff. Undo/redo history lives in `history.ts`.
 */
import { type PatchId, createLogger } from '@framepilot/shared-types';
import type {
  Clip,
  Marker,
  Project,
  Timeline,
  Track,
  TranscriptWord,
} from '@framepilot/timeline-schema';
import { assertOperationContract } from './operation-contract.js';
import { applyOperation, invertOperation, type Operation } from './operations.js';
import {
  applyProjectOperation,
  invertProjectOperation,
  isProjectOperation,
  type ProjectOperation,
} from './project-operations.js';

const log = createLogger('editor-core:patch');

/** Any operation a patch can carry: a timeline op or a project (asset/folder) op. */
export type AnyOperation = Operation | ProjectOperation;

/** Who created the patch. */
export type PatchAuthor = 'user' | 'agent';

/** Patch lifecycle states (PRD §8.4). */
export type PatchStatus =
  | 'proposed'
  | 'validated'
  | 'previewed'
  | 'applied'
  | 'reverted'
  | 'failed';

export interface Patch {
  readonly patchId: PatchId;
  readonly createdBy: PatchAuthor;
  /** Human-readable rationale shown in the review UI. */
  readonly reason: string;
  /** Timeline and/or project (asset/folder) operations applied as one unit. */
  readonly operations: readonly AnyOperation[];
}

/** A timeline difference for the review UI (PLAN §1.3 / §4.3). */
export interface TimelineDiff {
  readonly before: Timeline;
  readonly after: Timeline;
  /** Summary lines describing what changed. */
  readonly summary: readonly string[];
}

/**
 * Thrown when a patch cannot be applied. Because operations are pure and the
 * caller's input timeline is never mutated, a throw leaves the original state
 * fully intact — apply is all-or-nothing (PRD §8.4 transactional apply).
 */
export class PatchError extends Error {
  constructor(
    readonly patchId: PatchId,
    /** Index of the failing operation within the patch. */
    readonly operationIndex: number,
    override readonly cause: unknown,
  ) {
    super(
      `Patch ${patchId} failed at operation ${operationIndex}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'PatchError';
  }
}

/**
 * Apply a patch transactionally (all-or-nothing).
 *
 * The semantic operation contract is enforced here, not only by AI/MCP assembly.
 * That makes lock/range/keyframe/effect/audio safety a property of the canonical
 * patch authority for every caller.
 */
export function applyPatch(timeline: Timeline, patch: Patch): Timeline {
  let working = timeline;
  for (let i = 0; i < patch.operations.length; i += 1) {
    const op = patch.operations[i]!;
    if (isProjectOperation(op)) {
      throw new PatchError(
        patch.patchId,
        i,
        new Error(`Operation "${op.type}" is project-scoped; use applyProjectPatch.`),
      );
    }
    try {
      assertOperationContract(working, op);
      working = applyOperation(working, op);
    } catch (cause) {
      throw new PatchError(patch.patchId, i, cause);
    }
  }
  return working;
}

/** Apply a mixed timeline/project patch transactionally at project scope. */
export function applyProjectPatch(project: Project, patch: Patch): Project {
  log.action('applyProjectPatch', {
    patchId: patch.patchId,
    ops: patch.operations.map((o) => o.type),
  });
  let working = project;
  for (let i = 0; i < patch.operations.length; i += 1) {
    const op = patch.operations[i]!;
    try {
      if (isProjectOperation(op)) {
        working = applyProjectOperation(working, op);
      } else {
        assertOperationContract(working.timeline, op);
        working = { ...working, timeline: applyOperation(working.timeline, op) };
      }
    } catch (cause) {
      log.error('applyProjectPatch failed', {
        patchId: patch.patchId,
        opIndex: i,
        op: op.type,
        cause: String(cause),
      });
      throw new PatchError(patch.patchId, i, cause);
    }
  }
  return working;
}

/**
 * Op types that never write any track's clip array, so a `restore_clips` cannot
 * subsume them and they always survive a collapse. Anything not listed here and
 * not clip-addressed aborts the collapse rather than being guessed at.
 */
const NON_CLIP_INVERSE_OPS: ReadonlySet<string> = new Set([
  'set_track_flags',
  'set_track_caption_style',
  'move_layer',
  'add_effect_layer',
  'remove_effect_layer',
  'move_effect_layer',
  'trim_effect_layer',
  'set_effect_layer_params',
  'set_effect_layer_enabled',
  'restore_effect_layer',
]);

/** Map every clip id in a timeline to the track holding it. */
function clipTrackIndex(timeline: Timeline, into: Map<string, string>): Map<string, string> {
  for (const track of timeline.tracks) {
    for (const clip of track.clips) into.set(clip.id, track.id);
  }
  return into;
}

/**
 * Collapse redundant whole-track clip snapshots accumulated by lossy operations.
 * Conservative by construction: when the collapse cannot prove equivalence it returns
 * `null` and the caller keeps the original inverse byte-for-byte.
 */
export function collapseClipSnapshots<T extends AnyOperation>(
  timelineBefore: Timeline,
  timelineAfter: Timeline,
  inverseOps: readonly T[],
): T[] | null {
  const candidates = new Set<string>();
  for (const op of inverseOps) {
    if (op.type === 'restore_clips') candidates.add(op.trackId);
  }
  for (const id of [...candidates]) {
    const onBoth =
      timelineBefore.tracks.some((t) => t.id === id) &&
      timelineAfter.tracks.some((t) => t.id === id);
    if (!onBoth) candidates.delete(id);
  }
  if (candidates.size === 0) return null;

  const clipTrack = clipTrackIndex(timelineAfter, clipTrackIndex(timelineBefore, new Map()));
  const kept: T[] = [];

  for (const op of inverseOps) {
    if (op.type === 'restore_clips') {
      if (candidates.has(op.trackId)) continue;
      kept.push(op);
      continue;
    }
    if (op.type === 'add_layer' || op.type === 'remove_layer') {
      if (candidates.has(op.layerId)) return null;
      kept.push(op);
      continue;
    }
    const clipId = (op as { readonly clipId?: unknown }).clipId;
    if (typeof clipId === 'string') {
      const owner = clipTrack.get(clipId);
      if (owner === undefined) return null;
      const toTrackId = (op as { readonly toTrackId?: unknown }).toTrackId;
      const touched = typeof toTrackId === 'string' ? [owner, toTrackId] : [owner];
      const covered = touched.filter((id) => candidates.has(id));
      if (covered.length === 0) {
        kept.push(op);
        continue;
      }
      if (covered.length !== touched.length) return null;
      continue;
    }
    if (isProjectOperation(op) || NON_CLIP_INVERSE_OPS.has(op.type)) {
      kept.push(op);
      continue;
    }
    return null;
  }

  for (const id of candidates) {
    const track = timelineBefore.tracks.find((t) => t.id === id)!;
    kept.push({
      type: 'restore_clips',
      trackId: id,
      clips: track.clips.map((clip) => structuredClone(clip)),
    } as unknown as T);
  }
  return kept.length < inverseOps.length ? kept : null;
}

export function invertPatch(timelineBefore: Timeline, patch: Patch): Patch {
  let working = timelineBefore;
  const inverseOps: Operation[] = [];
  for (const op of patch.operations) {
    if (isProjectOperation(op)) {
      throw new Error(`Operation "${op.type}" is project-scoped; use invertProjectPatch.`);
    }
    assertOperationContract(working, op);
    inverseOps.unshift(...invertOperation(working, op));
    working = applyOperation(working, op);
  }
  return {
    patchId: `${patch.patchId}__inverse` as PatchId,
    createdBy: patch.createdBy,
    reason: `Revert: ${patch.reason}`,
    operations: collapseClipSnapshots(timelineBefore, working, inverseOps) ?? inverseOps,
  };
}

export function invertProjectPatch(projectBefore: Project, patch: Patch): Patch {
  let working = projectBefore;
  const inverseOps: AnyOperation[] = [];
  for (const op of patch.operations) {
    if (isProjectOperation(op)) {
      inverseOps.unshift(...invertProjectOperation(working, op));
      working = applyProjectOperation(working, op);
    } else {
      assertOperationContract(working.timeline, op);
      inverseOps.unshift(...invertOperation(working.timeline, op));
      working = { ...working, timeline: applyOperation(working.timeline, op) };
    }
  }
  return {
    patchId: `${patch.patchId}__inverse` as PatchId,
    createdBy: patch.createdBy,
    reason: `Revert: ${patch.reason}`,
    operations:
      collapseClipSnapshots(projectBefore.timeline, working.timeline, inverseOps) ?? inverseOps,
  };
}

export function revertPatch(timeline: Timeline, inversePatch: Patch): Timeline {
  return applyPatch(timeline, inversePatch);
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export function diffTimeline(before: Timeline, after: Timeline): TimelineDiff {
  const summary: string[] = [];
  const beforeTracks = new Map(before.tracks.map((t) => [t.id, t]));
  const afterTracks = new Map(after.tracks.map((t) => [t.id, t]));

  for (const [trackId, afterTrack] of afterTracks) {
    if (!beforeTracks.has(trackId)) {
      summary.push(`track ${trackId} added (${afterTrack.clips.length} clip(s))`);
    }
  }
  for (const [trackId, beforeTrack] of beforeTracks) {
    const afterTrack = afterTracks.get(trackId);
    if (!afterTrack) {
      summary.push(`track ${trackId} removed`);
      continue;
    }
    summary.push(...diffTrackClips(trackId, beforeTrack.clips, afterTrack.clips));
  }

  if (summary.length === 0) summary.push('no changes');
  return { before, after, summary };
}

/**
 * Compute a project-wide review diff over every persistent project axis that can be
 * changed by a patch: timeline, assets, folders, markers, and transcript.
 */
export function diffProject(before: Project, after: Project): TimelineDiff {
  const timeline = diffTimeline(before.timeline, after.timeline);
  const projectSummary = [
    ...diffAssets(before, after),
    ...diffFolders(before, after),
    ...diffMarkers(before, after),
    ...diffTranscript(before, after),
  ];
  if (projectSummary.length === 0) return timeline;
  const timelineLines =
    timeline.summary.length === 1 && timeline.summary[0] === 'no changes' ? [] : timeline.summary;
  return {
    before: timeline.before,
    after: timeline.after,
    summary: [...timelineLines, ...projectSummary],
  };
}

function diffAssets(before: Project, after: Project): string[] {
  const lines: string[] = [];
  const beforeById = new Map(before.assets.map((a) => [a.id, a]));
  const afterById = new Map(after.assets.map((a) => [a.id, a]));
  const loc = (folderId?: string): string => folderId ?? 'root';
  for (const asset of after.assets) {
    const prev = beforeById.get(asset.id);
    if (!prev) {
      lines.push(`asset ${asset.id} added (${loc(asset.folderId)})`);
    } else if (prev.folderId !== asset.folderId) {
      lines.push(`asset ${asset.id} moved (${loc(prev.folderId)} → ${loc(asset.folderId)})`);
    }
  }
  for (const asset of before.assets) {
    if (!afterById.has(asset.id)) lines.push(`asset ${asset.id} removed`);
  }
  return lines;
}

function diffFolders(before: Project, after: Project): string[] {
  const lines: string[] = [];
  const beforeById = new Map(before.folders.map((f) => [f.id, f]));
  const afterById = new Map(after.folders.map((f) => [f.id, f]));
  for (const folder of after.folders) {
    const prev = beforeById.get(folder.id);
    if (!prev) {
      lines.push(`folder ${folder.id} added ("${folder.name}")`);
    } else if (prev.name !== folder.name) {
      lines.push(`folder ${folder.id} renamed ("${prev.name}" → "${folder.name}")`);
    } else if (prev.parentId !== folder.parentId) {
      lines.push(`folder ${folder.id} moved`);
    }
  }
  for (const folder of before.folders) {
    if (!afterById.has(folder.id)) lines.push(`folder ${folder.id} removed`);
  }
  return lines;
}

/**
 * `markers` and `transcript` are optional on a Project — older files and lightweight
 * callers (the diff preview builds a project from the pending patch) legitimately omit
 * them. Reading them directly made the whole diff throw for those projects, which took
 * the review UI down with it, so both axes normalize to an empty list first.
 */
const markersOf = (project: Project): readonly Marker[] => project.markers ?? [];
const transcriptOf = (project: Project): readonly TranscriptWord[] => project.transcript ?? [];

function diffMarkers(before: Project, after: Project): string[] {
  const lines: string[] = [];
  const beforeMarkers = markersOf(before);
  const afterMarkers = markersOf(after);
  const beforeById = new Map(beforeMarkers.map((marker) => [marker.id, marker]));
  const afterById = new Map(afterMarkers.map((marker) => [marker.id, marker]));
  for (const marker of afterMarkers) {
    const previous = beforeById.get(marker.id);
    if (!previous) lines.push(`marker ${marker.id} added at ${round(marker.time)}s`);
    else if (JSON.stringify(previous) !== JSON.stringify(marker)) {
      lines.push(`marker ${marker.id} changed`);
    }
  }
  for (const marker of beforeMarkers) {
    if (!afterById.has(marker.id)) lines.push(`marker ${marker.id} removed`);
  }
  return lines;
}

function diffTranscript(before: Project, after: Project): string[] {
  const beforeWords = transcriptOf(before);
  const afterWords = transcriptOf(after);
  if (JSON.stringify(beforeWords) === JSON.stringify(afterWords)) return [];
  const changedAssets = new Set<string>();
  for (const word of [...beforeWords, ...afterWords]) {
    if (word.assetId) changedAssets.add(word.assetId);
  }
  const scope =
    changedAssets.size === 0 ? '' : ` across ${String(changedAssets.size)} attributed asset(s)`;
  return [`transcript updated (${beforeWords.length} → ${afterWords.length} word(s)${scope})`];
}

/** Index clips by id — shared by the human-readable and structured diffs. */
const toClipMap = (clips: readonly Clip[]): Map<string, Clip> =>
  new Map(clips.map((c) => [c.id, c]));

function diffTrackClips(
  trackId: string,
  before: readonly Clip[],
  after: readonly Clip[],
): string[] {
  const lines: string[] = [];
  const beforeById = toClipMap(before);
  const afterById = toClipMap(after);

  for (const clip of after) {
    const prev = beforeById.get(clip.id);
    if (!prev) {
      lines.push(`[${trackId}] + clip ${clip.id} (${fmtRange(clip)})`);
    } else if (!clipsEqual(prev, clip)) {
      lines.push(`[${trackId}] ~ clip ${clip.id} (${fmtRange(prev)} → ${fmtRange(clip)})`);
    }
  }
  for (const clip of before) {
    if (!afterById.has(clip.id)) {
      lines.push(`[${trackId}] - clip ${clip.id} (${fmtRange(clip)})`);
    }
  }
  return lines;
}

const fmtRange = (clip: Clip): string => `${round(clip.start)}–${round(clip.end)}s`;
const round = (n: number): number => Math.round(n * 1000) / 1000;
const clipsEqual = (a: Clip, b: Clip): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Structured diff
// ---------------------------------------------------------------------------

export interface ChangedRegion {
  readonly trackId: string;
  readonly clipId: string;
  readonly kind: 'added' | 'removed' | 'modified';
  readonly beforeRange: { start: number; end: number } | null;
  readonly afterRange: { start: number; end: number } | null;
}

const toRange = (clip: Clip): { start: number; end: number } => ({
  start: clip.start,
  end: clip.end,
});

const regionPosition = (region: ChangedRegion): number =>
  (region.afterRange ?? region.beforeRange)!.start;

function diffTrackClipRegions(
  trackId: string,
  before: readonly Clip[],
  after: readonly Clip[],
): ChangedRegion[] {
  const beforeById = toClipMap(before);
  const afterById = toClipMap(after);
  const regions: ChangedRegion[] = [];

  for (const clip of after) {
    const prev = beforeById.get(clip.id);
    if (!prev) {
      regions.push({
        trackId,
        clipId: clip.id,
        kind: 'added',
        beforeRange: null,
        afterRange: toRange(clip),
      });
    } else if (!clipsEqual(prev, clip)) {
      regions.push({
        trackId,
        clipId: clip.id,
        kind: 'modified',
        beforeRange: toRange(prev),
        afterRange: toRange(clip),
      });
    }
  }
  for (const clip of before) {
    if (!afterById.has(clip.id)) {
      regions.push({
        trackId,
        clipId: clip.id,
        kind: 'removed',
        beforeRange: toRange(clip),
        afterRange: null,
      });
    }
  }
  return regions.sort((a, b) => regionPosition(a) - regionPosition(b));
}

export function structuredDiffTimeline(before: Timeline, after: Timeline): ChangedRegion[] {
  const beforeTracks = new Map(before.tracks.map((t) => [t.id, t] as const));
  const afterTracks = new Map(after.tracks.map((t) => [t.id, t] as const));

  const orderedTrackIds = [
    ...after.tracks.map((t) => t.id),
    ...before.tracks.map((t) => t.id).filter((id) => !afterTracks.has(id)),
  ];

  const regions: ChangedRegion[] = [];
  for (const trackId of orderedTrackIds) {
    const beforeClips = (beforeTracks.get(trackId) as Track | undefined)?.clips ?? [];
    const afterClips = (afterTracks.get(trackId) as Track | undefined)?.clips ?? [];
    regions.push(...diffTrackClipRegions(trackId, beforeClips, afterClips));
  }
  return regions;
}
