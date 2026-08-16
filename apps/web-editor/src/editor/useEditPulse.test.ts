/**
 * Edit-pulse derivation tests: given a history transition, the pulse must name
 * exactly the clips/tracks the edit touched, classify apply vs undo vs redo,
 * and attribute agent-authored patches — the data TimelineView's highlight
 * pass runs on.
 */
import { describe, expect, it } from 'vitest';
import type { AnyOperation, EditHistory, Patch } from '@framepilot/editor-core';
import { pulseForHistoryChange, touchedByOperations } from './useEditPulse.js';

const patch = (
  operations: AnyOperation[],
  createdBy: Patch['createdBy'] = 'user',
  id = 'p1',
): Patch => ({ patchId: id as Patch['patchId'], createdBy, reason: 'test', operations });

const entry = (forward: Patch, inverse: Patch): EditHistory['entries'][number] => ({
  patch: forward,
  inverse,
});

const emptyHistory: EditHistory = { entries: [], cursor: 0 };

describe('touchedByOperations', () => {
  it('collects clipId, embedded clip ids, and range-op track ids', () => {
    const { clipIds, trackIds } = touchedByOperations([
      { type: 'trim_clip', clipId: 'c1', start: 0, end: 2 } as unknown as AnyOperation,
      {
        type: 'add_clip',
        clip: { id: 'c2', trackId: 't1' },
      } as unknown as AnyOperation,
      { type: 'ripple_delete', trackId: 't2', start: 0, end: 1 } as unknown as AnyOperation,
    ]);
    expect(clipIds).toEqual(new Set(['c1', 'c2']));
    expect(trackIds).toEqual(new Set(['t2']));
  });
});

describe('pulseForHistoryChange', () => {
  const trim = { type: 'trim_clip', clipId: 'c1', start: 0, end: 2 } as unknown as AnyOperation;
  const untrim = { type: 'trim_clip', clipId: 'c1', start: 0, end: 4 } as unknown as AnyOperation;
  const applied: EditHistory = {
    entries: [entry(patch([trim], 'agent'), patch([untrim]))],
    cursor: 1,
  };

  it('returns null when the history reference is unchanged (seek/zoom renders)', () => {
    expect(pulseForHistoryChange(applied, applied, 1)).toBeNull();
  });

  it('classifies a fresh commit as apply and carries the author', () => {
    const pulse = pulseForHistoryChange(emptyHistory, applied, 1);
    expect(pulse).toMatchObject({ kind: 'apply', author: 'agent', token: 1 });
    expect(pulse!.clipIds).toEqual(new Set(['c1']));
  });

  it('classifies a cursor retreat as undo and includes inverse targets', () => {
    const undone: EditHistory = { entries: applied.entries, cursor: 0 };
    const pulse = pulseForHistoryChange(applied, undone, 2);
    expect(pulse).toMatchObject({ kind: 'undo', author: 'agent' });
    expect(pulse!.clipIds).toEqual(new Set(['c1']));
  });

  it('classifies a cursor advance over existing entries as redo', () => {
    const undone: EditHistory = { entries: applied.entries, cursor: 0 };
    const pulse = pulseForHistoryChange(undone, applied, 3);
    expect(pulse).toMatchObject({ kind: 'redo' });
  });

  it('returns null when only unrelated state changed (same cursor, new ref)', () => {
    const same: EditHistory = { entries: applied.entries, cursor: 1 };
    expect(pulseForHistoryChange(applied, same, 4)).toBeNull();
  });

  it('marks track-level pulses for ripple deletes', () => {
    const ripple = {
      type: 'ripple_delete',
      trackId: 't1',
      start: 0,
      end: 1,
    } as unknown as AnyOperation;
    const next: EditHistory = {
      entries: [entry(patch([ripple]), patch([]))],
      cursor: 1,
    };
    const pulse = pulseForHistoryChange(emptyHistory, next, 5);
    expect(pulse!.trackIds).toEqual(new Set(['t1']));
    expect(pulse!.author).toBe('user');
  });
});
