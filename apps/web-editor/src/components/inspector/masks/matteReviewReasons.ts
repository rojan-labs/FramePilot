/**
 * Why the pipeline flagged a moment, in plain words (BR6.5, plan 05 "NEEDS_REVIEW").
 *
 * **Session-scoped on purpose.** Schema v22 stores a flagged range as `{start, end}` and nothing
 * else, and adding a field to it would be a schema change with a migration — out of scope here.
 * So the reason a run gave is remembered for as long as the app is open, keyed by the artifact it
 * belongs to, and a project reopened later shows the honest fallback ("Needs a look") rather than
 * a reason invented to fill the space.
 */

/** The reasons the verify stage emits, mapped to words an editor reads (plan 05). */
const REASON_LABELS: Readonly<Record<string, string>> = {
  edge_disagreement: 'Edges disagreed',
  low_confidence: 'The subject was hard to read',
  occlusion: 'Subject partly hidden',
  new_object: 'New shape appeared',
  topology_change: 'The shape changed a lot',
  flicker: 'The edge flickered',
  fast_motion: 'The subject moved fast',
};

/** The fallback for a range whose reason this session never saw. */
export const UNKNOWN_REVIEW_REASON = 'Needs a look';

const reasons = new Map<string, string>();

const rangeKey = (artifactKey: string, start: number, end: number): string =>
  `${artifactKey}:${start.toFixed(6)}:${end.toFixed(6)}`;

/** Remember the reasons a finished run gave for its flagged ranges. */
export function rememberReviewReasons(
  artifactKey: string,
  ranges: readonly { readonly start: number; readonly end: number; readonly reason: string }[],
): void {
  for (const range of ranges) {
    reasons.set(rangeKey(artifactKey, range.start, range.end), reviewReasonLabel(range.reason));
  }
}

/** The plain-words label for one reason code; an unknown code is shown as it came. */
export function reviewReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? (reason.trim() === '' ? UNKNOWN_REVIEW_REASON : reason);
}

/** What to show beside a flagged range, or the honest fallback. */
export function reviewReasonFor(artifactKey: string, start: number, end: number): string {
  return reasons.get(rangeKey(artifactKey, start, end)) ?? UNKNOWN_REVIEW_REASON;
}

/** Forget every remembered reason (tests, closing a project). */
export function clearReviewReasons(): void {
  reasons.clear();
}
