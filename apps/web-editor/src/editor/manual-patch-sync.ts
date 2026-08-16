import type { HistoryEntry, Patch } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';

const historyEntries = (history: Project['history']): readonly HistoryEntry[] =>
  (Array.isArray(history) ? history : []) as readonly HistoryEntry[];

const sameEntry = (left: HistoryEntry, right: HistoryEntry): boolean =>
  left.patch.patchId === right.patch.patchId;

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
 * Translate one editor-history transition into the exact user patches that move the host
 * from the previous applied state to the next one. Forward edits/redo use the recorded
 * patch; undo/time-travel uses recorded inverses newest-first. Agent-authored history is
 * excluded because the durable AI path already owns those host commits.
 */
export function manualPatchesForHistoryTransition(
  previousHistory: Project['history'],
  nextHistory: Project['history'],
): readonly Patch[] {
  const previous = historyEntries(previousHistory);
  const next = historyEntries(nextHistory);
  if (previous === next) return [];

  const prefix = commonPrefixLength(previous, next);
  let candidates: Patch[];

  if (prefix === previous.length) {
    candidates = next.slice(prefix).map((entry) => entry.patch);
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
      ...next.slice(prefix).map((entry) => entry.patch),
    ];
  } else {
    const overlap = suffixPrefixOverlap(previous, next);
    if (overlap === 0) return [];
    candidates = next.slice(overlap).map((entry) => entry.patch);
  }

  return candidates.filter((patch) => patch.createdBy === 'user');
}
