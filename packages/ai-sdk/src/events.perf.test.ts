/**
 * Performance budget for the streaming reducer (Phase 11 M9, ADR 0033).
 *
 * The sidebar renders a pure function of the event log, so the reducer must fold a
 * very long log cheaply and — critically — **collapse streamed deltas in place** so a
 * 20k-delta turn becomes ONE assistant node, not 20k rows. This guards the "60fps at
 * 20k+ events" requirement at its root: the render never sees 20k nodes for one reply.
 * Mirrors the Phase 8 performance-budget approach (docs/guides/performance-budgets.md).
 */
import { describe, expect, it } from 'vitest';
import { type AiEvent, createTurnEmitter, reduceEvents } from './events.js';

/** Generous CI-safe budget; the reducer is O(n) and typically far under this. */
const BUDGET_MS = 250;

describe('reduceEvents performance', () => {
  it('folds 20k delta events into one assistant node within budget', () => {
    const emit = createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 0 });
    const events: AiEvent[] = [emit.userMessage('go')];
    for (let i = 0; i < 20_000; i += 1) events.push(emit.delta(emit.assistantId, 'x'));
    events.push(emit.status('completed'));

    const started = performance.now();
    const view = reduceEvents(events);
    const elapsed = performance.now() - started;

    // 20k deltas collapse to a single assistant node (+ the user node) — not 20k rows.
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[1]).toMatchObject({ kind: 'assistant', streaming: true });
    expect(view.status).toBe('completed');
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('keeps a mixed 20k-event log node count bounded by distinct ids', () => {
    const emit = createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 0 });
    const events: AiEvent[] = [];
    // 10k tool-status re-emissions on 100 tools → 100 nodes, not 10k.
    for (let i = 0; i < 10_000; i += 1) {
      const id = `tool_${i % 100}`;
      events.push(emit.toolCall(id, 'find_silence', i % 2 === 0 ? 'running' : 'completed'));
    }
    const view = reduceEvents(events);
    expect(view.nodes).toHaveLength(100);
  });
});
