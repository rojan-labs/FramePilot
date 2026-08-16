import { describe, expect, it } from 'vitest';
import { shouldAutoCommitAiDiff } from './patch-settlement.js';

describe('shouldAutoCommitAiDiff', () => {
  // Reversal of a previously deliberate rule ("commits only an explicitly verified diff").
  // Requiring a perceptual verdict before writing meant an auto run withheld every edit
  // until a 30s–4min render batch cleared it. Review no longer decides whether an edit may
  // exist, only what is worth saying about one that already does — so it cannot gate the
  // commit. Reasoned inline so it is not silently re-reverted; see plan/INSTANT-APPLY.md.
  it('commits under auto-commit policy regardless of any review verdict', () => {
    expect(shouldAutoCommitAiDiff('auto_commit', 'verified')).toBe(true);
    expect(shouldAutoCommitAiDiff('auto_commit', 'unverified')).toBe(true);
    expect(shouldAutoCommitAiDiff('auto_commit', undefined)).toBe(true);
  });

  // The policy itself is still honoured: a run a host explicitly started under `review`
  // never writes on its own. Nothing produces that policy today, but durable runs recorded
  // before this change still parse and replay with it.
  it('never commits under review policy', () => {
    expect(shouldAutoCommitAiDiff('review', 'verified')).toBe(false);
    expect(shouldAutoCommitAiDiff('review', undefined)).toBe(false);
  });
});
