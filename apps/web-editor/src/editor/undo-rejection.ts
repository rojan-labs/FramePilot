/**
 * D10 follow-up — record a rejection when a GLOBAL undo (Cmd+Z, menu Undo — anything
 * that calls `editor.undo()` outside `AiSidebar`'s own "Undo run" button) takes back an
 * AI-origin edit.
 *
 * `AiSidebar`'s "Undo run" button already does this for the run it just made
 * (`recordRejected` in its `undoRun` handler). Nothing recorded it for a plain Cmd+Z,
 * the History panel's click-to-jump, or any other caller of `editor.undo()` — the same
 * negative learning signal Undo run carries (the user watched the edit on the timeline
 * and took it back), just reached a different way.
 *
 * Pure and platform-agnostic: this only decides WHICH entries were undone and which of
 * those are AI-origin. It reacts to `Project.history` (the prop lifted from the editor
 * store), not the editor's own internal `EditHistory` — the same shape `Project.history`
 * already carries, so it needs no new field and no schema change.
 */
import type { HistoryEntry, Patch } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';

const historyEntries = (history: Project['history']): readonly HistoryEntry[] =>
  (Array.isArray(history) ? history : []) as readonly HistoryEntry[];

const isAgentAuthored = (patch: Patch): boolean => patch.createdBy === 'agent';

/**
 * The entries a history transition dropped off the tail, oldest-of-the-drop first —
 * or `[]` when the transition was not a clean undo/time-travel-backward.
 *
 * A "clean" undo/backward-jump is exactly a strict prefix relationship: `next` is
 * `previous` with zero or more entries removed from the END, nothing added, nothing
 * reordered, nothing in the surviving prefix changed. Anything else — a forward edit, a
 * redo, a bounded-history eviction (which drops from the FRONT, not the tail, per
 * `manual-patch-sync.ts`'s `suffixPrefixOverlap`), or an unrelated authoritative resync —
 * fails that check and is deliberately read as "not an undo" rather than guessed at.
 */
export function droppedTailEntries(
  previous: Project['history'],
  next: Project['history'],
): readonly HistoryEntry[] {
  const previousEntries = historyEntries(previous);
  const nextEntries = historyEntries(next);
  if (nextEntries.length >= previousEntries.length) return [];
  for (let index = 0; index < nextEntries.length; index += 1) {
    if (previousEntries[index]?.patch.patchId !== nextEntries[index]?.patch.patchId) return [];
  }
  return previousEntries.slice(nextEntries.length);
}

/**
 * Of the entries a history transition dropped off the tail, the AI-origin patches —
 * oldest-of-the-drop first, matching the order `AiSidebar`'s "Undo run" records in.
 *
 * Human edits are never recorded: only `patch.createdBy === 'agent'` qualifies, which is
 * true regardless of platform or whether the run was durable (desktop) or a single local
 * commit (browser) — both stamp the original patch's authorship, and `invertProjectPatch`
 * carries it onto the inverse too (`manual-patch-sync.ts`'s own note on this).
 */
export function agentPatchesUndone(
  previous: Project['history'],
  next: Project['history'],
): readonly Patch[] {
  return droppedTailEntries(previous, next)
    .map((entry) => entry.patch)
    .filter(isAgentAuthored);
}
