import { describe, expect, it } from 'vitest';
import { createTurnEmitter, reduceEvents, type AiEvent } from '@framepilot/ai-sdk';
import { visibleWindowStart } from './activityWindow.js';

function conversation(turns: number) {
  const events: AiEvent[] = [];
  for (let index = 0; index < turns; index += 1) {
    const e = createTurnEmitter({ conversationId: 'c', turnId: `t${String(index)}`, now: () => 1 });
    events.push(e.userMessage(`ask ${String(index)}`), e.assistant(e.assistantId, 'ok'));
  }
  return reduceEvents(events).nodes;
}

describe('visibleWindowStart', () => {
  it('starts at the n-th most recent message', () => {
    const nodes = conversation(5);
    const start = visibleWindowStart(nodes, 2);
    expect(nodes[start]).toMatchObject({ kind: 'user', text: 'ask 3' });
  });

  it('renders everything when there are no more turns than the window', () => {
    expect(visibleWindowStart(conversation(2), 3)).toBe(0);
    expect(visibleWindowStart(conversation(3), 3)).toBe(0);
    expect(visibleWindowStart([], 3)).toBe(0);
  });

  it('always keeps at least the newest turn', () => {
    const nodes = conversation(4);
    expect(nodes[visibleWindowStart(nodes, 0)]).toMatchObject({ text: 'ask 3' });
  });
});
