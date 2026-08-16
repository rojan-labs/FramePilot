/**
 * Batch diff acceptance (Phase 11 M6, ADR 0033).
 *
 * Applies multiple proposed edits in order through the SAME validated patch path the
 * editor uses (`apply` = `useEditor.applyPatchChecked`). Each edit is re-checked
 * against the CURRENT timeline at apply time — the batch was proposed against the
 * project as it was when the run started, and an earlier edit in the batch (or the
 * user) may have changed it since. The batch **stops at the first edit that fails to
 * apply** and never half-applies (the patch engine itself is atomic per patch). Pure
 * over an injected `apply` so it is unit-testable without the React store.
 */
import type { EditResult } from '@framepilot/ai-sdk';

export interface BatchResult {
  /** How many edits were applied before stopping (or all of them). */
  readonly applied: number;
  /** Index of the first edit that failed to apply, or null if all applied. */
  readonly failedIndex: number | null;
}

/**
 * Apply a list of edits in order, stopping at the first one that does not apply.
 *
 * @param edits - The proposed edits, applied front to back.
 * @param apply - Commits one patch through the checked editor path; returns
 *   whether the patch actually applied (validated against the current timeline).
 * @returns How many applied and where (if anywhere) the batch stopped.
 */
export function applyDiffsInOrder(
  edits: readonly EditResult[],
  apply: (patch: EditResult['patch']) => boolean,
): BatchResult {
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (!edit || !edit.validation.valid) return { applied: index, failedIndex: index };
    if (!apply(edit.patch)) return { applied: index, failedIndex: index };
  }
  return { applied: edits.length, failedIndex: null };
}
