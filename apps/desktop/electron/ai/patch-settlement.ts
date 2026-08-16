import type { DiffEvent } from '@framepilot/ai-sdk';

/**
 * Whether an AI diff may be written to the authoritative project as it arrives.
 *
 * Authorization is the run's patch policy plus the patch engine's own validation, which the
 * commit path re-runs against the current revision before anything is written. It is
 * deliberately NOT conditional on perceptual review.
 *
 * This used to additionally require `verification === 'verified'`, which meant an "auto"
 * run still withheld every edit until a multi-minute render batch cleared it — auto apply
 * that was not auto. Review is now a reader that reports findings against edits already on
 * the timeline (see plan/INSTANT-APPLY.md), so gating the commit on it would hold the work
 * back for a verdict that no longer decides whether the work may exist. The safety property
 * that matters is unchanged and is enforced where it belongs: nothing invalid commits, every
 * commit is revision-checked, and every commit is reversible through grouped undo.
 */
export function shouldAutoCommitAiDiff(
  patchPolicy: 'review' | 'auto_commit',
  _verification: DiffEvent['verification'],
): boolean {
  return patchPolicy === 'auto_commit';
}
