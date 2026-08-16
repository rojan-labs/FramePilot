/** Tests for WAL snapshot & compaction (kernel/event-log.ts, §16.3, K5.3). */
import { describe, expect, it } from 'vitest';
import type { AiEvent } from '../events.js';
import { compactEventLog, snapshotEventLog } from './event-log.js';

const base = { conversationId: 'c1', turnId: 't1', ts: 0 };
// Loose fixture: tests only exercise id/type/status/turnId, so a structural cast keeps
// the cases readable without spelling out every event variant's full shape.
const ev = (over: Record<string, unknown>): AiEvent => ({ ...base, ...over }) as unknown as AiEvent;

describe('compactEventLog', () => {
  it('drops streaming delta events (superseded by their terminal event)', () => {
    const log: AiEvent[] = [
      ev({ id: 'u1', type: 'user_message', text: 'hi' }),
      ev({ id: 'd1', type: 'assistant_delta', parentId: 'a1', chunk: 'he' }),
      ev({ id: 'd2', type: 'assistant_delta', parentId: 'a1', chunk: 'llo' }),
      ev({ id: 'a1', type: 'assistant_message', text: 'hello' }),
      ev({ id: 'r0', type: 'reasoning_delta', parentId: 'r1', chunk: 'x' }),
    ];
    const compact = compactEventLog(log);
    expect(compact.map((e) => e.id)).toEqual(['u1', 'a1']);
    expect(compact.some((e) => e.type.endsWith('_delta'))).toBe(false);
  });

  it('keeps only the last event per id, preserving last-occurrence order', () => {
    const log: AiEvent[] = [
      ev({ id: 's1', type: 'status', status: 'thinking' }),
      ev({ id: 'tool', type: 'tool_call', name: 'analyze_silence' }),
      ev({ id: 's1', type: 'status', status: 'done' }), // re-emitted in place
    ];
    const compact = compactEventLog(log);
    expect(compact.map((e) => e.id)).toEqual(['tool', 's1']);
    const status = compact.find((e) => e.id === 's1');
    expect(status && 'status' in status ? status.status : undefined).toBe('done');
  });

  it('is a no-op on an already-compact log', () => {
    const log: AiEvent[] = [
      ev({ id: 'u1', type: 'user_message', text: 'hi' }),
      ev({ id: 'a1', type: 'assistant_message', text: 'yo' }),
    ];
    expect(compactEventLog(log)).toHaveLength(2);
    expect(compactEventLog([])).toEqual([]);
  });
});

describe('snapshotEventLog', () => {
  it('derives turn/event/dropped counts, last status, and last checkpoint', () => {
    const log: AiEvent[] = [
      ev({ id: 'u1', type: 'user_message', text: 'a', turnId: 't1' }),
      ev({ id: 'd1', type: 'assistant_delta', parentId: 'a1', chunk: 'x' }),
      ev({ id: 'a1', type: 'assistant_message', text: 'x', turnId: 't1' }),
      ev({ id: 'u2', type: 'user_message', text: 'b', turnId: 't2' }),
      ev({ id: 'ck', type: 'checkpoint', goal: 'g', ops: [], log: [], stepsCompleted: 1 }),
      ev({ id: 'st', type: 'status', status: 'cancelled' }),
    ];
    const snap = snapshotEventLog(log);
    expect(snap.turnCount).toBe(2);
    expect(snap.droppedCount).toBe(1); // the one assistant_delta
    expect(snap.eventCount).toBe(snap.events.length);
    expect(snap.lastStatus).toBe('cancelled');
    expect(snap.lastCheckpoint?.goal).toBe('g');
  });

  it('omits lastStatus/lastCheckpoint when the run has neither', () => {
    const snap = snapshotEventLog([ev({ id: 'u1', type: 'user_message', text: 'a' })]);
    expect(snap.lastStatus).toBeUndefined();
    expect(snap.lastCheckpoint).toBeUndefined();
    expect(snap.turnCount).toBe(1);
  });
});
