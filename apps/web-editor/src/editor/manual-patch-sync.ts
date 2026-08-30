import type { HistoryEntry, Patch } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';

const historyEntries = (history: Project['history']): readonly HistoryEntry[] =>
  (Array.isArray(history) ? history : []) as readonly HistoryEntry[];

const sameEntry = (left: HistoryEntry, right: HistoryEntry): boolean =>
  left.patch.patchId === right.patch.patchId;

const isUserAuthored = (patch: Patch): boolean => patch.createdBy === 'user';

function commonPrefixLength(
  previous: readonly HistoryEntry[],
  next: readonly HistoryEntry[],
): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && sameEntry(previous[index]!, next[index]!)) index += 1;
  return index;
}

/**
 * Durable history is a bounded suffix. Once it reaches its entry cap, a normal new edit
 * shifts the previous suffix left by one. Detect the longest previous-suffix/next-prefix
 * overlap so dropping an old restart-history entry is never mistaken for an undo.
 */
function suffixPrefixOverlap(
  previous: readonly HistoryEntry[],
  next: readonly HistoryEntry[],
): number {
  const limit = Math.min(previous.length, next.length);
  for (let length = limit; length > 0; length -= 1) {
    const previousStart = previous.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (!sameEntry(previous[previousStart + index]!, next[index]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

/**
 * Translate one editor-history transition into the exact patches that move the host from
 * the previous applied state to the next one. Forward edits/redo use the recorded patch;
 * undo/time-travel uses recorded inverses newest-first.
 *
 * Two authorship rules, and they are not symmetric:
 *
 * - Forward agent-authored patches are excluded: the durable AI path already committed
 *   them to the host, so re-sending them is at best a replay.
 * - Agent-authored INVERSES are kept. `invertProjectPatch` (editor-core) stamps an inverse
 *   with the original patch's `createdBy`, so undoing an AI edit produces an `'agent'`
 *   patch even though the user is the one who asked for it — and the host was never told.
 *   Filtering those out left the undo with no durable path of its own: it relied on the
 *   debounced full-project autosave, which the very next edit cancelled, so the host went
 *   on applying edits to a document that still contained the AI change.
 */
export function manualPatchesForHistoryTransition(
  previousHistory: Project['history'],
  nextHistory: Project['history'],
): readonly Patch[] {
  const previous = historyEntries(previousHistory);
  const next = historyEntries(nextHistory);
  if (previous === next) return [];
  // An absent history is UNKNOWN, not "reverted". Projects that never carried history
  // reach this function — the AI-facing copy is built with `history: []` on purpose — and
  // reading that as a time-travel to the start of the session would commit the inverses of
  // the user's real edits to disk while the on-screen timeline never moved. A genuine undo
  // back to an empty history is still persisted, by the full-document save that an empty
  // result falls through to.
  if (next.length === 0) return [];

  const prefix = commonPrefixLength(previous, next);
  let candidates: Patch[];

  if (prefix === previous.length) {
    candidates = next.slice(prefix).map((entry) => entry.patch).filter(isUserAuthored);
  } else if (prefix === next.length) {
    candidates = previous
      .slice(prefix)
      .reverse()
      .map((entry) => entry.inverse);
  } else if (prefix > 0) {
    candidates = [
      ...previous
        .slice(prefix)
        .reverse()
        .map((entry) => entry.inverse),
      ...next.slice(prefix).map((entry) => entry.patch).filter(isUserAuthored),
    ];
  } else {
    const overlap = suffixPrefixOverlap(previous, next);
    if (overlap === 0) return [];
    candidates = next.slice(overlap).map((entry) => entry.patch).filter(isUserAuthored);
  }

  return candidates;
}
