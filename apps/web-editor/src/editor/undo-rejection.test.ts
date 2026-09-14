import type { HistoryEntry, Patch } from '@framepilot/editor-core';
import { describe, expect, it } from 'vitest';
import { agentPatchesUndone, droppedTailEntries } from './undo-rejection.js';

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

describe('droppedTailEntries', () => {
  it('returns the entries dropped off the tail by an undo, oldest-of-the-drop first', () => {
    const a = entry('a');
    const b = entry('b');
    const c = entry('c');
    expect(droppedTailEntries([a, b, c], [a]).map((e) => e.patch.patchId)).toEqual(['b', 'c']);
  });

  it('returns nothing for a forward edit (history grew)', () => {
    const a = entry('a');
    const b = entry('b');
    expect(droppedTailEntries([a], [a, b])).toEqual([]);
  });

  it('returns nothing for a redo back to the same length', () => {
    const a = entry('a');
    expect(droppedTailEntries([a], [a])).toEqual([]);
  });

  it('returns nothing for a bounded-history suffix rotation (front eviction, not an undo)', () => {
    const a = entry('a');
    const b = entry('b');
    const c = entry('c');
    // [a, b, c] -> [b, c]: shorter, but the survivors are the FRONT dropped, not the tail —
    // a strict prefix match is required, and an evicted front never has one.
    expect(droppedTailEntries([a, b, c], [b, c])).toEqual([]);
  });

  it('returns nothing for an unrelated history (no shared prefix)', () => {
    const a = entry('a');
    const b = entry('b');
    const x = entry('x');
    expect(droppedTailEntries([a, b], [x])).toEqual([]);
  });

  it('handles a missing/non-array history as empty', () => {
    expect(droppedTailEntries(undefined as unknown as [], [])).toEqual([]);
  });
});

describe('agentPatchesUndone', () => {
  it('keeps only AI-origin patches among the dropped tail, in drop order', () => {
    const human = entry('h', 'user');
    const ai1 = entry('a1', 'agent');
    const ai2 = entry('a2', 'agent');
    expect(
      agentPatchesUndone([human, ai1, ai2], []).map((p) => p.patchId),
    ).toEqual(['a1', 'a2']);
  });

  it('returns nothing when only a human entry was undone', () => {
    const human = entry('h', 'user');
    expect(agentPatchesUndone([human], [])).toEqual([]);
  });

  it('returns nothing when nothing was undone', () => {
    const ai = entry('a', 'agent');
    expect(agentPatchesUndone([ai], [ai])).toEqual([]);
  });
});
