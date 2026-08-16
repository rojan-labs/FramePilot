import { describe, expect, it } from 'vitest';
import type { AiEvent } from '@framepilot/ai-sdk';
import {
  emptyRunNotice,
  foldTurnEvent,
  initialTurnSignals,
  type TurnSignals,
} from './runOutcome.js';

const base = { id: 'e1', conversationId: 'c1', turnId: 't1', ts: 0 } as const;

/** Fold a list of events onto a fresh editing/chat signal set. */
function foldAll(editing: boolean, events: readonly AiEvent[]): TurnSignals {
  return events.reduce(foldTurnEvent, initialTurnSignals(editing));
}

describe('runOutcome.emptyRunNotice', () => {
  // Empty-run gating is intentionally OFF: a run that lands no timeline edit is
  // never scolded — read/agent runs (describe footage, answer a question, plan)
  // legitimately produce no edit, and their own output stands on its own.
  it('never gates an editing run that produced no edit', () => {
    const signals = foldAll(true, [
      { ...base, type: 'tool_call', toolName: 'get_timeline', status: 'completed' },
      { ...base, type: 'status', status: 'completed' },
    ]);
    expect(emptyRunNotice(signals)).toBeNull();
  });

  it('never gates a run whose analysis engine was unavailable', () => {
    const signals = foldAll(true, [
      {
        ...base,
        type: 'tool_result',
        toolCallId: 'tc1',
        summary: 'Detect beats — analysis engine unavailable',
      },
    ]);
    expect(emptyRunNotice(signals)).toBeNull();
  });

  it('stays silent when the run produced a timeline action', () => {
    const signals = foldAll(true, [
      { ...base, type: 'timeline_action', action: 'Trimmed', detail: 'clip a by 1s' },
    ]);
    expect(emptyRunNotice(signals)).toBeNull();
  });

  it('stays silent for a chat run (never expected to edit)', () => {
    const signals = foldAll(false, [
      { ...base, type: 'assistant_message', text: 'The timeline is a 10s montage.' } as AiEvent,
    ]);
    expect(emptyRunNotice(signals)).toBeNull();
  });

  it('stays silent for a cancelled empty run', () => {
    const signals = foldAll(true, [
      { ...base, type: 'tool_call', toolName: 'get_timeline', status: 'completed' },
      { ...base, type: 'status', status: 'cancelled' },
    ]);
    expect(signals.cancelled).toBe(true);
    expect(emptyRunNotice(signals)).toBeNull();
  });

  it('foldTurnEvent returns the same object when nothing relevant changed', () => {
    const start = initialTurnSignals(true);
    const next = foldTurnEvent(start, {
      ...base,
      type: 'assistant_delta',
      parentId: 'a',
      chunk: 'hi',
    });
    expect(next).toBe(start);
  });

  it('folds a usage event into signals.cost (P7.1/P7.2)', () => {
    const signals = foldAll(true, [{ ...base, type: 'usage', tokens: 240, usd: 0.01 }]);
    expect(signals.cost).toEqual({ tokens: 240, usd: 0.01 });
  });

  it('leaves signals.cost undefined until a usage event lands', () => {
    const signals = foldAll(true, [
      { ...base, type: 'timeline_action', action: 'Trimmed', detail: 'clip a by 1s' },
    ]);
    expect(signals.cost).toBeUndefined();
  });
});
