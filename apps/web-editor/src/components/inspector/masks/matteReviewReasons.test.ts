import { describe, expect, it } from 'vitest';
import { reviewReasonLabel, UNKNOWN_REVIEW_REASON } from './matteReviewReasons.js';

/** The worker's `ReviewReason` values (protocol.py), which the host passes through unchanged. */
const WORKER_REASONS = [
  'subject_lost',
  'estimates_disagree',
  'flow_inconsistent',
  'new_region',
  'edge_misaligned',
  'occlusion',
  'motion_blur',
];

describe('reviewReasonLabel', () => {
  it('gives every reason the pack emits a plain-words label, never its raw code', () => {
    for (const reason of WORKER_REASONS) {
      const label = reviewReasonLabel(reason);
      expect(label, reason).not.toBe(reason);
      expect(label, reason).not.toMatch(/_/u);
    }
    expect(reviewReasonLabel('edge_misaligned')).toBe('Edges disagreed');
    expect(reviewReasonLabel('')).toBe(UNKNOWN_REVIEW_REASON);
  });
});
