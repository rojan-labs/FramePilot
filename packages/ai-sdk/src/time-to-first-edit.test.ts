/**
 * Time-to-first-visible-edit — the FRAMEPILOT-95 Phase E budget metric.
 *
 * Wall-clock alone cannot say whether the agent behaves like an editor or like a researcher:
 * a run can finish quickly and still feel broken if nothing moves on the timeline for the
 * first ninety seconds. This measures the gap between the run starting and the editor first
 * SEEING their project change.
 *
 * Derived from the events the Phase-0 harness already captures, so a real-media run reports
 * it with no extra instrumentation — and reports NOTHING when there was no visible edit,
 * rather than a zero that would read as "instant".
 */
import { describe, expect, it } from 'vitest';
import type { AiEvent } from './events.js';
import { captureAgentRunQuality } from './agent-run-quality.js';

const base = { conversationId: 'conversation', turnId: 'turn' } as const;

const status = (ts: number, s: 'completed' | 'cancelled'): AiEvent =>
  ({ ...base, id: `status_${String(ts)}`, ts, type: 'status', status: s }) as AiEvent;

const reasoning = (ts: number): AiEvent =>
  ({
    ...base,
    id: `reasoning_${String(ts)}`,
    ts,
    type: 'reasoning',
    summaries: [],
    done: true,
  }) as AiEvent;

const timelineAction = (ts: number): AiEvent =>
  ({
    ...base,
    id: `action_${String(ts)}`,
    ts,
    type: 'timeline_action',
    action: 'Deleted range',
    detail: '0s–3s',
    refs: [],
  }) as AiEvent;

const capture = (events: readonly AiEvent[]) =>
  captureAgentRunQuality({
    routeMode: 'agent',
    events,
    projectRevisionBefore: 0,
    projectRevisionAfter: 1,
  });

describe('timeToFirstEditMs', () => {
  it('measures from the first event to the first visible timeline change', () => {
    // 1000ms of reading and thinking, then the timeline moves.
    const events = [
      reasoning(500),
      reasoning(900),
      timelineAction(1500),
      status(4000, 'completed'),
    ];
    expect(capture(events).timeToFirstEditMs).toBe(1000);
  });

  it('ignores later edits — only the FIRST one ends the wait', () => {
    const events = [
      reasoning(500),
      timelineAction(1500),
      timelineAction(3000),
      status(4000, 'completed'),
    ];
    expect(capture(events).timeToFirstEditMs).toBe(1000);
  });

  it('is absent — not zero — when the run never moved the timeline', () => {
    // The captured caption run's real failure shape: lots of activity, nothing visible.
    // A zero here would report the worst possible run as the fastest possible one.
    const events = [reasoning(500), reasoning(900), status(4000, 'completed')];
    expect(capture(events).timeToFirstEditMs).toBeUndefined();
  });

  it('is distinct from wall clock', () => {
    const events = [reasoning(0), timelineAction(1000), status(9000, 'completed')];
    const metrics = capture(events);
    expect(metrics.timeToFirstEditMs).toBe(1000);
    expect(metrics.wallClockMs).toBe(9000);
  });

  it('still reports the wait on a run that was cancelled after its first edit', () => {
    const events = [reasoning(0), timelineAction(700), status(2000, 'cancelled')];
    expect(capture(events).timeToFirstEditMs).toBe(700);
  });

  it('prefers a host-observed measurement over the event-derived one', () => {
    // A host that can time the actual paint is closer to what the editor experienced.
    const events = [reasoning(0), timelineAction(1000), status(4000, 'completed')];
    const metrics = captureAgentRunQuality({
      routeMode: 'agent',
      events,
      projectRevisionBefore: 0,
      projectRevisionAfter: 1,
      timeToFirstEditMs: 1234,
    });
    expect(metrics.timeToFirstEditMs).toBe(1234);
  });

  it('rejects a negative host measurement rather than recording it', () => {
    expect(() =>
      captureAgentRunQuality({
        routeMode: 'agent',
        events: [reasoning(0)],
        timeToFirstEditMs: -1,
      }),
    ).toThrow(RangeError);
  });

  it('reports nothing for an empty run', () => {
    expect(capture([]).timeToFirstEditMs).toBeUndefined();
  });
});
