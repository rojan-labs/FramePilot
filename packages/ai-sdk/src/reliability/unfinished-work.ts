/**
 * @framepilot/ai-sdk/reliability/unfinished-work — what the run tried and never managed.
 *
 * ## Why this exists (GOLDEN-C.19)
 *
 * The agent run's completion report is a receipt for what LANDED: the applied edits, plus
 * the proposed ones the validator turned down ("Skipped"). It has never had a way to say
 * what the run set out to do and did not do. Desktop run `137d8fd0` closed a seven-part
 * brief with `**Applied 416 edits** in 49 steps, but the run did not finish cleanly` — and
 * nothing in that receipt said that captioning had been refused eleven times and never once
 * succeeded, or that `professional_audio` failed all ten times it was called. The editor's
 * only route to either fact was reading 49 steps of transcript.
 *
 * The run-level objective ledger could not answer it either: `remainingObjectives` was a
 * constant 1 across all 308 manifests of that run, because a run has ONE objective with a
 * catch-all acceptance criterion.
 *
 * So the honest answer is derived from what the runtime already observed — the settled
 * status of every tool call it made. A tool that was called, failed every time, and never
 * afterwards succeeded is a thing the run did not do, stated in the run's own terms and
 * costing no prompt tokens to produce.
 */

import type { ToolStatus } from '../events.js';

/** One settled tool call, in the order the run made it. */
export interface ToolAttempt {
  readonly tool: string;
  readonly status: ToolStatus;
  /**
   * Why it failed, in the words the model was given. Present only on a failure; the
   * repeat-guard's own refusal carries the ORIGINAL error rather than its wrapper prose,
   * because "captions must end after they start" is what the editor needs to read, not
   * "refused a repeat".
   */
  readonly failureReason?: string;
}

/** A tool the run called, never got a usable answer out of, and gave up on. */
export interface NeverSucceededTool {
  readonly tool: string;
  /** The LAST failure — the run's final word on this tool, not its first guess. */
  readonly reason: string;
}

/**
 * A settled status that means the call ANSWERED. `warning` counts: an advisory is a real
 * result the run could act on (the caption pass that landed with a note is still a caption
 * pass), and treating it as a failure would report finished work as unfinished.
 *
 * `running` never settles here, and `cancelled` is the editor stopping the run rather than
 * the tool being unable — neither is evidence either way, so both are ignored entirely.
 */
const SUCCESS_STATUSES: ReadonlySet<ToolStatus> = new Set<ToolStatus>(['completed', 'warning']);

/**
 * The tools that failed at least once and never succeeded, in first-call order.
 *
 * Order matters: a run's earliest dead end is usually the one that shaped everything after
 * it, so it should be the line that survives the report's cap.
 *
 * @param attempts - Every settled tool call of the run, in call order.
 * @returns One entry per tool that never succeeded, carrying its last failure reason.
 */
export function neverSucceededTools(
  attempts: readonly ToolAttempt[],
): readonly NeverSucceededTool[] {
  const succeeded = new Set<string>();
  /** Insertion-ordered: `Map` preserves first-call order for the surviving entries. */
  const lastFailure = new Map<string, string>();
  for (const attempt of attempts) {
    if (SUCCESS_STATUSES.has(attempt.status)) {
      succeeded.add(attempt.tool);
      continue;
    }
    if (attempt.status !== 'failed') continue;
    // A failure with no stated reason still proves the tool never worked; the report then
    // says so without one rather than dropping the line.
    lastFailure.set(attempt.tool, attempt.failureReason?.trim() ?? '');
  }
  const out: NeverSucceededTool[] = [];
  for (const [tool, reason] of lastFailure) {
    if (succeeded.has(tool)) continue;
    out.push({ tool, reason });
  }
  return out;
}
