/**
 * Edit-pulse derivation: WHICH clips a just-committed edit touched, and HOW.
 *
 * WHY: when the AI applies a patch (or the user hits undo/redo), the timeline
 * snaps to its new state with no visual account of what happened — the user
 * has to diff the before/after in their head. This hook watches the store's
 * edit history (the single source of truth for every committed edit — AI and
 * manual alike) and derives a short-lived "pulse": the touched clip/track ids
 * plus the kind of change, which TimelineView turns into a highlight + motion
 * pass. Pure derivation over history — the store itself is untouched.
 *
 * The pulse is transient UI state (like a toast): it clears itself after
 * {@link EDIT_PULSE_MS} and is never persisted.
 */
import { useEffect, useRef, useState } from 'react';
import type { AnyOperation, EditHistory, Patch } from '@framepilot/editor-core';

/** How a pulse came about — drives the highlight colour/label. */
export type EditPulseKind = 'apply' | 'undo' | 'redo';

/** One transient highlight window over the clips an edit touched. */
export interface EditPulse {
  readonly kind: EditPulseKind;
  /** Who committed the edit — `agent` pulses get the AI accent treatment. */
  readonly author: Patch['createdBy'];
  /** Clips the edit directly referenced (trimmed, moved, added, split, …). */
  readonly clipIds: ReadonlySet<string>;
  /** Tracks hit by range ops (ripple/delete_range) whose later clips shifted. */
  readonly trackIds: ReadonlySet<string>;
  /** Monotonic token so an identical follow-up edit still restarts the pulse. */
  readonly token: number;
}

/** How long a pulse stays visible. Long enough to notice, short enough to never lag the next edit. */
export const EDIT_PULSE_MS = 1600;

/** Collect the clip/track ids an operation list touches (exported for tests). */
export function touchedByOperations(operations: readonly AnyOperation[]): {
  clipIds: Set<string>;
  trackIds: Set<string>;
} {
  const clipIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const op of operations) {
    const record = op as unknown as Record<string, unknown>;
    if (typeof record['clipId'] === 'string') clipIds.add(record['clipId'] as string);
    const clip = record['clip'] as { id?: unknown } | undefined;
    if (clip && typeof clip.id === 'string') clipIds.add(clip.id);
    // Range ops shift everything after them on the track — highlight at track level.
    if (
      (op.type === 'ripple_delete' || op.type === 'delete_range') &&
      typeof record['trackId'] === 'string'
    ) {
      trackIds.add(record['trackId'] as string);
    }
  }
  return { clipIds, trackIds };
}

/**
 * Derive the pulse for a history transition, or `null` when nothing committed
 * (selection/seek/zoom re-renders reach here too). Exported for tests.
 */
export function pulseForHistoryChange(
  previous: EditHistory,
  next: EditHistory,
  token: number,
): EditPulse | null {
  if (next === previous) return null;
  if (next.cursor > previous.cursor) {
    // Forward: a fresh apply (entries grew) or a redo (cursor advanced over
    // an existing entry). Everything between the cursors just landed.
    const kind: EditPulseKind = next.entries.length > previous.entries.length ? 'apply' : 'redo';
    const clipIds = new Set<string>();
    const trackIds = new Set<string>();
    let author: Patch['createdBy'] = 'user';
    for (const entry of next.entries.slice(previous.cursor, next.cursor)) {
      const touched = touchedByOperations(entry.patch.operations);
      touched.clipIds.forEach((id) => clipIds.add(id));
      touched.trackIds.forEach((id) => trackIds.add(id));
      if (entry.patch.createdBy === 'agent') author = 'agent';
    }
    return { kind, author, clipIds, trackIds, token };
  }
  if (next.cursor < previous.cursor) {
    // Backward: undo. The undone entries' INVERSE ops describe what the
    // timeline just did (restored clips, reversed shifts) — pulse those.
    const clipIds = new Set<string>();
    const trackIds = new Set<string>();
    let author: Patch['createdBy'] = 'user';
    for (const entry of previous.entries.slice(next.cursor, previous.cursor)) {
      const touched = touchedByOperations([...entry.patch.operations, ...entry.inverse.operations]);
      touched.clipIds.forEach((id) => clipIds.add(id));
      touched.trackIds.forEach((id) => trackIds.add(id));
      if (entry.patch.createdBy === 'agent') author = 'agent';
    }
    return { kind: 'undo', author, clipIds, trackIds, token };
  }
  return null;
}

/**
 * Watch an edit history and expose the current transient pulse (or `null`).
 *
 * @param history - `editor.state.history` from {@link useEditor}.
 * @returns The active pulse; `null` once it expires or before any edit.
 */
export function useEditPulse(history: EditHistory): EditPulse | null {
  const [pulse, setPulse] = useState<EditPulse | null>(null);
  const previousRef = useRef(history);
  const tokenRef = useRef(0);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = history;
    const next = pulseForHistoryChange(previous, history, (tokenRef.current += 1));
    if (!next) return undefined;
    setPulse(next);
    const timer = setTimeout(() => {
      // Only clear our own pulse — a newer one owns the state now.
      setPulse((current) => (current?.token === next.token ? null : current));
    }, EDIT_PULSE_MS);
    return () => clearTimeout(timer);
  }, [history]);

  return pulse;
}
