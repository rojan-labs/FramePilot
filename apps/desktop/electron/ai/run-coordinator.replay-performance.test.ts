import { describe, expect, it } from 'vitest';
import { RUN_PROTOCOL_SCHEMA_VERSION, type RunEventEnvelope } from '@framepilot/ai-sdk';
import { subscriptionPage } from './run-coordinator.js';

const event = (sequence: number): RunEventEnvelope => ({
  schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
  eventId: `event_${sequence}`,
  runId: 'run',
  projectId: 'project',
  sequence,
  occurredAt: sequence,
  kind: 'run.stream_event',
  payload: null,
});

describe('durable subscription replay paging', () => {
  const events = Array.from({ length: 100_000 }, (_, index) => event(index + 1));

  it('returns only the requested suffix page near a large run tail', () => {
    const page = subscriptionPage(events, 99_990, 5);
    expect(page.events.map((item) => item.sequence)).toEqual([99_991, 99_992, 99_993, 99_994, 99_995]);
    expect(page.hasMore).toBe(true);
  });

  it('marks the final page complete so the live subscriber can attach', () => {
    const page = subscriptionPage(events, 99_995, 10);
    expect(page.events.map((item) => item.sequence)).toEqual([99_996, 99_997, 99_998, 99_999, 100_000]);
    expect(page.hasMore).toBe(false);
  });

  it('handles an up-to-date or beyond-tail cursor without replay', () => {
    expect(subscriptionPage(events, 100_000, 10)).toEqual({ events: [], hasMore: false });
    expect(subscriptionPage(events, 200_000, 10)).toEqual({ events: [], hasMore: false });
  });
});
