import type { HistoryEntry, Patch } from '@framepilot/editor-core';
import { describe, expect, it } from 'vitest';
import { manualPatchesForHistoryTransition } from './manual-patch-sync.js';

const patch = (id: string, createdBy: Patch['createdBy'] = 'user'): Patch => ({
  patchId: id as Patch['patchId'],
  createdBy,
  reason: id,
  operations: [],
});

const entry = (id: string, createdBy: Patch['createdBy'] = 'user'): HistoryEntry => ({
  patch: patch(id, createdBy),
  inverse: patch(`${id}_inverse`, createdBy),
});

describe('manualPatchesForHistoryTransition', () => {
  it('returns appended manual edits in commit order', () => {
    const a = entry('a');
    const b = entry('b');
    expect(manualPatchesForHistoryTransition([a], [a, b]).map((item) => item.patchId)).toEqual([
      'b',
    ]);
  });

  it('returns inverses newest-first for undo/time travel', () => {
    const a = entry('a');
    const b = entry('b');
    const c = entry('c');
    expect(
      manualPatchesForHistoryTransition([a, b, c], [a]).map((item) => item.patchId),
    ).toEqual(['c_inverse', 'b_inverse']);
  });

  it('handles an undo followed by a divergent new edit', () => {
    const a = entry('a');
    const b = entry('b');
    const c = entry('c');
    expect(manualPatchesForHistoryTransition([a, b], [a, c]).map((item) => item.patchId)).toEqual([
      'b_inverse',
      'c',
    ]);
  });

  it('does not treat bounded-history suffix rotation as an undo', () => {
    const a = entry('a');
    const b = entry('b');
    const c = entry('c');
    const d = entry('d');
    expect(manualPatchesForHistoryTransition([a, b, c], [b, c, d]).map((item) => item.patchId)).toEqual([
      'd',
    ]);
  });

  it('excludes agent-authored history because the durable AI path owns it', () => {
    const a = entry('a');
    const agent = entry('agent', 'agent');
    expect(manualPatchesForHistoryTransition([a], [a, agent])).toEqual([]);
  });

  /**
   * Undoing an AI edit sends NOTHING down the patch lane, and that is load-bearing.
   *
   * `invertProjectPatch` stamps the inverse with the original patch's `createdBy`
   * (editor-core/patch.ts), so an agent patch's inverse is `'agent'` too and the filter
   * above drops it. The undo still reaches disk — App.tsx only sets
   * `suppressFullAutosaveOnce` when this returns patches, so an empty result falls through
   * to the full-project autosave, which writes the reverted state.
   *
   * Pinned explicitly because auto-apply makes Undo the entire safety net: it works today
   * through a fallthrough rather than a designed path, and a future change that starts
   * suppressing autosave unconditionally would silently strand every AI undo in memory.
   */
  it('sends no patch for an AI undo, leaving full autosave to persist it', () => {
    const manual = entry('manual');
    const agent = entry('agent', 'agent');
    // The user undoes the agent edit: history loses its newest entry.
    expect(manualPatchesForHistoryTransition([manual, agent], [manual])).toEqual([]);
  });
});
