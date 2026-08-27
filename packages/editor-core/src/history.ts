/**
 * Undo/redo history backed by reversible patches.
 *
 * Consecutive durable-run patches keep their own compact entries and share a groupId.
 * Undo/redo treats that contiguous run as one user action. This avoids repeatedly
 * flattening an ever-growing operation array after every agent step. Restart history
 * collapses each group once at serialization time so a long run still survives as one
 * undo step without paying that flattening cost on every live commit.
 */
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { quantizePatch } from './frame-grid.js';
import {
  applyPatch,
  applyProjectPatch,
  invertPatch,
  invertProjectPatch,
  type Patch,
} from './patch.js';

export interface HistoryEntry {
  readonly patch: Patch;
  readonly inverse: Patch;
  /** Exact patches represented by this entry, retained when a run group is collapsed. */
  readonly memberPatches?: readonly Patch[];
  readonly committedAt?: number;
  /** Consecutive entries carrying one id form one undo/redo action. */
  readonly groupId?: string;
}

export interface EditHistory {
  readonly entries: readonly HistoryEntry[];
  readonly cursor: number;
}

export const emptyHistory = (): EditHistory => ({ entries: [], cursor: 0 });
export const canUndo = (history: EditHistory): boolean => history.cursor > 0;
export const canRedo = (history: EditHistory): boolean => history.cursor < history.entries.length;

interface HistoryStep {
  readonly timeline: Timeline;
  readonly history: EditHistory;
}

export function commitPatch(
  timeline: Timeline,
  history: EditHistory,
  patch: Patch,
  committedAt?: number,
): HistoryStep {
  const inverse = invertPatch(timeline, patch);
  const next = applyPatch(timeline, patch);
  const entries = history.entries.slice(0, history.cursor);
  entries.push(committedAt === undefined ? { patch, inverse } : { patch, inverse, committedAt });
  return { timeline: next, history: { entries, cursor: entries.length } };
}

export function undo(timeline: Timeline, history: EditHistory): HistoryStep {
  if (!canUndo(history)) return { timeline, history };
  const entry = history.entries[history.cursor - 1]!;
  return {
    timeline: applyPatch(timeline, entry.inverse),
    history: { entries: history.entries, cursor: history.cursor - 1 },
  };
}

export function redo(timeline: Timeline, history: EditHistory): HistoryStep {
  if (!canRedo(history)) return { timeline, history };
  const entry = history.entries[history.cursor]!;
  return {
    timeline: applyPatch(timeline, entry.patch),
    history: { entries: history.entries, cursor: history.cursor + 1 },
  };
}

const clampCursor = (history: EditHistory, target: number): number =>
  Math.max(0, Math.min(history.entries.length, Math.trunc(target)));

export function goto(timeline: Timeline, history: EditHistory, targetCursor: number): HistoryStep {
  let step: HistoryStep = { timeline, history };
  const target = clampCursor(history, targetCursor);
  while (step.history.cursor > target) step = undo(step.timeline, step.history);
  while (step.history.cursor < target) step = redo(step.timeline, step.history);
  return step;
}

interface ProjectHistoryStep {
  readonly project: Project;
  readonly history: EditHistory;
}

/** Append one compact project patch. `groupId` changes undo semantics, not live storage shape. */
export function commitProjectPatch(
  project: Project,
  history: EditHistory,
  rawPatch: Patch,
  committedAt?: number,
  groupId?: string,
): ProjectHistoryStep {
  // ADR 0146: the frame grid, applied ONCE, here — before the patch is inverted, applied
  // or recorded, so all three see the same numbers. Not inside `applyOperation`: the
  // inverse is computed from the operation, so an apply that quantized privately would
  // invert to a different state than it applied from, and undo would drift a fraction of
  // a frame per edit. This is also the line that makes a manual trim land on the same
  // frame an AI trim does — the grid used to run only at the AI patch boundary.
  const patch = quantizePatch(rawPatch, project.fps);
  const inverse = invertProjectPatch(project, patch);
  const next = applyProjectPatch(project, patch);
  const entries = history.entries.slice(0, history.cursor);
  entries.push({
    patch,
    inverse,
    memberPatches: [patch],
    ...(committedAt === undefined ? {} : { committedAt }),
    ...(groupId === undefined ? {} : { groupId }),
  });
  return { project: next, history: { entries, cursor: entries.length } };
}

/**
 * Step back exactly one entry. Module-private and unguarded on purpose: every
 * caller establishes `cursor > 0` first (`undoProject` gates on {@link canUndo}
 * and re-checks in its loop condition; `gotoProject` loops only while the cursor
 * is above a target clamped to zero). A second guard here would be unreachable.
 */
function undoProjectOne(project: Project, history: EditHistory): ProjectHistoryStep {
  const entry = history.entries[history.cursor - 1]!;
  return {
    project: applyProjectPatch(project, entry.inverse),
    history: { entries: history.entries, cursor: history.cursor - 1 },
  };
}

/** Step forward exactly one entry. Unguarded for the same reason as {@link undoProjectOne}. */
function redoProjectOne(project: Project, history: EditHistory): ProjectHistoryStep {
  const entry = history.entries[history.cursor]!;
  return {
    project: applyProjectPatch(project, entry.patch),
    history: { entries: history.entries, cursor: history.cursor + 1 },
  };
}

/** Undo one manual entry or every contiguous entry from the latest durable run. */
export function undoProject(project: Project, history: EditHistory): ProjectHistoryStep {
  if (!canUndo(history)) return { project, history };
  const groupId = history.entries[history.cursor - 1]?.groupId;
  let step: ProjectHistoryStep = { project, history };
  do {
    step = undoProjectOne(step.project, step.history);
    if (groupId === undefined) break;
  } while (
    step.history.cursor > 0 &&
    step.history.entries[step.history.cursor - 1]?.groupId === groupId
  );
  return step;
}

/** Redo one manual entry or every contiguous entry from the next durable run. */
export function redoProject(project: Project, history: EditHistory): ProjectHistoryStep {
  if (!canRedo(history)) return { project, history };
  const groupId = history.entries[history.cursor]?.groupId;
  let step: ProjectHistoryStep = { project, history };
  do {
    step = redoProjectOne(step.project, step.history);
    if (groupId === undefined) break;
  } while (
    step.history.cursor < step.history.entries.length &&
    step.history.entries[step.history.cursor]?.groupId === groupId
  );
  return step;
}

/** History-panel time travel remains entry-precise even inside a group. */
export function gotoProject(
  project: Project,
  history: EditHistory,
  targetCursor: number,
): ProjectHistoryStep {
  let step: ProjectHistoryStep = { project, history };
  const target = clampCursor(history, targetCursor);
  while (step.history.cursor > target) step = undoProjectOne(step.project, step.history);
  while (step.history.cursor < target) step = redoProjectOne(step.project, step.history);
  return step;
}

export interface PersistedHistoryLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export const DEFAULT_DURABLE_HISTORY_LIMITS: Required<PersistedHistoryLimits> = {
  maxEntries: 100,
  maxBytes: 4 * 1024 * 1024,
};

function estimatedJsonBytes(value: unknown, stopAfter: number): number {
  const stack: unknown[] = [value];
  let bytes = 0;
  while (stack.length > 0 && bytes <= stopAfter) {
    const current = stack.pop();
    if (current === null) bytes += 4;
    else if (typeof current === 'string') bytes += current.length * 2 + 2;
    else if (typeof current === 'number') bytes += 16;
    else if (typeof current === 'boolean') bytes += 5;
    else if (Array.isArray(current)) {
      bytes += current.length + 2;
      for (const item of current) stack.push(item);
    } else if (typeof current === 'object' && current !== undefined) {
      const entries = Object.entries(current);
      bytes += entries.length + 2;
      for (const [key, item] of entries) {
        bytes += key.length * 2 + 3;
        stack.push(item);
      }
    }
  }
  return bytes;
}

function mergedReason(entries: readonly HistoryEntry[]): string {
  let reason = entries[0]!.patch.reason;
  for (let index = 1; index < entries.length; index += 1) {
    const next = entries[index]!.patch.reason;
    reason = reason === next ? next : `${reason}; ${next}`;
  }
  return reason;
}

/**
 * Collapse contiguous live group entries once, only when producing restart history.
 * Forward operations retain commit order; inverse operations run newest-to-oldest,
 * exactly matching the former incrementally-flattened grouped entry semantics.
 */
export function collapseHistoryGroups(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const collapsed: HistoryEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const first = entries[index]!;
    if (first.groupId === undefined) {
      collapsed.push({ ...first });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < entries.length && entries[end]!.groupId === first.groupId) end += 1;
    const group = entries.slice(index, end);
    if (group.length === 1) {
      collapsed.push({ ...first });
      index = end;
      continue;
    }

    const last = group[group.length - 1]!;
    collapsed.push({
      patch: {
        ...first.patch,
        reason: mergedReason(group),
        operations: group.flatMap((entry) => entry.patch.operations),
      },
      inverse: {
        ...last.inverse,
        operations: [...group].reverse().flatMap((entry) => entry.inverse.operations),
      },
      memberPatches: group.flatMap((entry) => entry.memberPatches ?? [entry.patch]),
      ...(first.committedAt === undefined ? {} : { committedAt: first.committedAt }),
      groupId: first.groupId,
    });
    index = end;
  }
  return collapsed;
}

export const toPersistedHistory = (
  history: EditHistory,
  limits: PersistedHistoryLimits = {},
): HistoryEntry[] => {
  const cursor = Math.min(history.cursor, history.entries.length);
  const applied = collapseHistoryGroups(history.entries.slice(0, cursor));
  const maxEntries = Math.max(0, Math.trunc(limits.maxEntries ?? applied.length));
  if (limits.maxBytes === undefined) {
    return applied.slice(Math.max(0, applied.length - maxEntries));
  }

  const maxBytes = Math.max(0, limits.maxBytes);
  let start = applied.length;
  let bytes = 2;
  while (start > 0 && applied.length - start < maxEntries) {
    const entry = applied[start - 1]!;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) break;
    const entryBytes = estimatedJsonBytes(entry, remaining);
    if (entryBytes > remaining) break;
    bytes += entryBytes + 1;
    start -= 1;
  }
  return applied.slice(start);
};

export const fromPersistedHistory = (entries: readonly HistoryEntry[]): EditHistory => ({
  entries: entries.map((entry) => ({ ...entry })),
  cursor: entries.length,
});
