/**
 * Tests for batch diff acceptance (Phase 11 M6): applies in order, stops at the
 * first invalid edit OR the first patch the checked apply rejects (the timeline
 * may have changed since the run proposed it), never half-applies a patch.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EditResult } from '@framepilot/ai-sdk';
import { applyDiffsInOrder } from './diffActions.js';

const edit = (valid: boolean, id: string): EditResult =>
  ({ validation: { valid, issues: [] }, patch: { patchId: id } }) as unknown as EditResult;

describe('applyDiffsInOrder', () => {
  it('applies every valid edit in order', () => {
    const apply = vi.fn((_patch: EditResult['patch']) => true);
    const result = applyDiffsInOrder([edit(true, 'a'), edit(true, 'b')], apply);
    expect(result).toEqual({ applied: 2, failedIndex: null });
    expect(apply.mock.calls.map((c) => c[0].patchId)).toEqual(['a', 'b']);
  });

  it('stops at the first invalid edit without applying it', () => {
    const apply = vi.fn((_patch: EditResult['patch']) => true);
    const result = applyDiffsInOrder([edit(true, 'a'), edit(false, 'b'), edit(true, 'c')], apply);
    expect(result).toEqual({ applied: 1, failedIndex: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('stops when the checked apply rejects a stale patch (timeline changed)', () => {
    // First patch lands; the second fails the store's re-validation at apply time.
    const apply = vi.fn((patch: EditResult['patch']) => patch.patchId === 'a');
    const result = applyDiffsInOrder([edit(true, 'a'), edit(true, 'b'), edit(true, 'c')], apply);
    expect(result).toEqual({ applied: 1, failedIndex: 1 });
    expect(apply).toHaveBeenCalledTimes(2); // 'a' ok, 'b' rejected, 'c' never tried
  });

  it('handles an empty list', () => {
    expect(
      applyDiffsInOrder(
        [],
        vi.fn(() => true),
      ),
    ).toEqual({ applied: 0, failedIndex: null });
  });
});
