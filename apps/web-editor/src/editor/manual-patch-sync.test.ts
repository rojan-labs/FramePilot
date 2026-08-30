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
   * Undoing an AI edit must send the inverse down the patch lane.
   *
   * The old assertion here pinned the opposite (`[]`) and justified it with a fallthrough:
   * App only suppresses the full autosave when this returns patches, so an AI undo was
   * supposed to reach disk as a debounced full snapshot. That snapshot was cancelled by the
   * effect cleanup the moment the user made one more edit inside the 2s window, so the undo
   * reached disk NEVER and the host kept applying edits to a document that still contained
   * the AI change. The fallthrough was the bug, not the design.
   *
   * `invertProjectPatch` copies `createdBy`, so this inverse is stamped `'agent'` even
   * though the user asked for it; authorship of a forward patch says who wrote it, but for
   * an inverse it only says what was undone.
   */
  it('sends the inverse when an AI edit is undone', () => {
    const manual = entry('manual');
    const agent = entry('agent', 'agent');
    // The user undoes the agent edit: history loses its newest entry.
    expect(
      manualPatchesForHistoryTransition([manual, agent], [manual]).map((item) => item.patchId),
    ).toEqual(['agent_inverse']);
  });

  /**
   * The renderer hands AI an intentionally history-less copy of the project
   * (`projectForAi`), and anything the AI sidebar derives from it inherits `history: []`.
   *
   * Read as a history transition, that empty array used to satisfy `prefix === next.length`
   * and produce the inverses of every real user edit — committed straight to disk while the
   * on-screen timeline never moved, so the first sign of it was the user's work missing
   * after a reload. An absent history is unknown, not reverted.
   */
  it('never reads an empty next history as an undo of everything', () => {
    const first = entry('u1');
    const second = entry('u2');
    expect(manualPatchesForHistoryTransition([first, second], [])).toEqual([]);
    expect(manualPatchesForHistoryTransition([first, second], undefined as never)).toEqual([]);
  });

  it('still excludes agent-authored forward patches after an undo diverges', () => {
    const a = entry('a');
    const b = entry('b');
    const agent = entry('agent', 'agent');
    // b is undone, then the agent's own edit lands on the new branch: the inverse of the
    // user's edit must ship, the agent's forward patch must not (the host already has it).
    expect(
      manualPatchesForHistoryTransition([a, b], [a, agent]).map((item) => item.patchId),
    ).toEqual(['b_inverse']);
  });
});
