/**
 * What the last AI run actually changed, in the words a video editor uses
 * (P8.2 "changed").
 *
 * The run footer used to say "Made 3 edits" and stop. That is a receipt for the
 * agent's bookkeeping, not an account of the cut: three edits could be three
 * trims or a trim, a transition and a caption layer, and the user had to reopen
 * the activity log and read operation cards to find out which. The grouped line
 * this builds — "Trimmed clip ×2 · Added transition" — is the same information
 * the log already carries, said once, where the eye already is.
 *
 * The duration delta is the other half. Length is the single fact an editor
 * checks after any automated pass ("did it take 20 seconds out of my 60?"), and
 * it was nowhere on screen.
 *
 * Semantic op names come from the AI layer's own `describeOperation` (P4.1) —
 * the same source the history reel and the diff cards use — so a new operation
 * type gets a real label in all three places at once, or a humanized fallback in
 * none of them differently.
 */
import { describeOperation, type ProjectNames } from '@framepilot/ai-sdk';
import type { AnyOperation } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';

/** One run's edit, as the summary needs it: its operations and the timelines around them. */
export interface RunEdit {
  readonly operations: readonly AnyOperation[];
  readonly before?: Timeline | undefined;
  readonly after?: Timeline | undefined;
}

/** One semantic action and how many times the run performed it. */
export interface RunChangeGroup {
  readonly action: string;
  readonly count: number;
}

export interface RunChangeSummary {
  /** Operation groups, most frequent first; ties keep the order they happened in. */
  readonly groups: readonly RunChangeGroup[];
  /**
   * Programme length after the run, and the change from before it — omitted when
   * the run's edits carried no before/after timelines (some fixtures and older
   * events do not), because a delta of "unknown" must not render as 0.
   */
  readonly durationAfterSeconds?: number;
  readonly durationDeltaSeconds?: number;
}

/** Programme length: the last frame any clip on any track ends on. */
export function timelineDurationSeconds(timeline: Timeline): number {
  let end = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) if (clip.end > end) end = clip.end;
  }
  return end;
}

/**
 * Summarize a run's edits for the sidebar footer.
 *
 * @param edits - The run's valid edits, in the order they were applied.
 * @param names - Optional id→name resolver, threaded to `describeOperation`.
 * @returns Grouped semantic actions plus the programme-length change, when known.
 */
export function summarizeRunChanges(
  edits: readonly RunEdit[],
  names?: ProjectNames,
): RunChangeSummary {
  const counts = new Map<string, number>();
  for (const edit of edits) {
    for (const op of edit.operations) {
      const { action } = describeOperation(op, names);
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  // Insertion order is the order the operations happened, so a stable sort on
  // count alone already gives "most of what it did, first, then chronological".
  const groups = [...counts]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);

  const before = edits.find((edit) => edit.before !== undefined)?.before;
  const after = [...edits].reverse().find((edit) => edit.after !== undefined)?.after;
  if (!before || !after) return { groups };

  const afterSeconds = timelineDurationSeconds(after);
  return {
    groups,
    durationAfterSeconds: afterSeconds,
    durationDeltaSeconds: afterSeconds - timelineDurationSeconds(before),
  };
}

/** `Trimmed clip ×2 · Added transition` — empty string when the run changed nothing. */
export function formatRunChangeGroups(groups: readonly RunChangeGroup[]): string {
  return groups
    .map(({ action, count }) => (count === 1 ? action : `${action} ×${String(count)}`))
    .join(' · ');
}

/**
 * `−12.4s` / `+3.0s` — the change in programme length, with a real minus sign.
 *
 * Returns null below a tenth of a second: a run that only restyled captions
 * shifts the length by float noise, and "+0.0s" reads as a claim that something
 * moved.
 */
export function formatDurationDelta(deltaSeconds: number): string | null {
  const rounded = Math.round(deltaSeconds * 10) / 10;
  if (rounded === 0) return null;
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}s`;
}
