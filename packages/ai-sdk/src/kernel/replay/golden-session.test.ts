/**
 * The parity oracle's own contract (plan/LANGCHAIN-MIGRATION.md M0.2).
 *
 * The corpus test proves sessions round-trip; these prove the comparator does its job
 * when they DON'T — which is the only situation it exists for. A comparator that
 * quietly reports "identical" on a real divergence would let every phase from M6 onward
 * pass its exit criterion while diverging.
 */
import { describe, expect, it } from 'vitest';
import type { AiEvent } from '../../events.js';
import type { AnyOperation } from '@framepilot/editor-core';
import {
  GOLDEN_SESSION_VERSION,
  compareSessions,
  formatComparison,
  parseSession,
  serializeSession,
  terminalStatusOf,
  toGoldenSession,
  type GoldenSession,
  type RunOutcome,
} from './golden-session.js';

const event = (seq: number, type: 'status' | 'notification', extra: object): AiEvent =>
  ({
    id: `turn_1:${type}:${String(seq)}`,
    conversationId: 'conv_1',
    turnId: 'turn_1',
    ts: 1000,
    type,
    ...extra,
  }) as AiEvent;

const running = event(1, 'status', { status: 'thinking' });
const finished = event(2, 'status', { status: 'completed' });

const op = (clipId: string): AnyOperation =>
  ({ type: 'trim_clip', clipId, start: 0, end: 2 }) as unknown as Operation;

const outcome: RunOutcome = { events: [running, finished], operations: [op('clip_a')] };

const session = toGoldenSession('demo', 'a'.repeat(50), 'tighten the intro', outcome);

describe('terminalStatusOf', () => {
  it('reads the LAST status, not the first — a run passes through several', () => {
    expect(terminalStatusOf([running, finished])).toBe('completed');
  });

  it('returns undefined when a run emitted no status at all', () => {
    expect(terminalStatusOf([])).toBeUndefined();
    expect(terminalStatusOf([event(1, 'notification', { text: 'hi' })])).toBeUndefined();
  });
});

describe('serialize / parse', () => {
  it('round-trips a session unchanged', () => {
    expect(parseSession(serializeSession(session))).toEqual(session);
  });

  it('refuses a fixture written by an incompatible version rather than misreading it', () => {
    const stale = serializeSession({ ...session, version: GOLDEN_SESSION_VERSION + 1 });
    expect(() => parseSession(stale)).toThrow(/Regenerate the corpus/);
  });
});

describe('compareSessions', () => {
  it('reports identical for the run it was recorded from', () => {
    const comparison = compareSessions(session, outcome);
    expect(comparison.identical).toBe(true);
    expect(comparison.divergences).toEqual([]);
    expect(formatComparison(comparison)).toBe('demo: identical');
  });

  it('catches a changed event id — the §7.4 contract, not cosmetic', () => {
    const renumbered = { ...finished, id: 'turn_1:status:99' } as AiEvent;
    const comparison = compareSessions(session, { ...outcome, events: [running, renumbered] });
    expect(comparison.identical).toBe(false);
    expect(comparison.divergences).toContainEqual({
      path: 'events[1].id',
      expected: 'turn_1:status:2',
      actual: 'turn_1:status:99',
    });
  });

  it('catches a dropped event, reporting the length AND the missing element', () => {
    const comparison = compareSessions(session, { ...outcome, events: [running] });
    expect(comparison.divergences).toContainEqual({
      path: 'events.length',
      expected: 2,
      actual: 1,
    });
    expect(comparison.divergences.some((d) => d.path.startsWith('events[1]'))).toBe(true);
  });

  it('catches a changed terminal status', () => {
    const failed = event(2, 'status', { status: 'failed' });
    const comparison = compareSessions(session, { ...outcome, events: [running, failed] });
    expect(comparison.divergences).toContainEqual({
      path: 'terminalStatus',
      expected: 'completed',
      actual: 'failed',
    });
  });

  it('catches a changed operation — a different edit is the worst divergence', () => {
    const comparison = compareSessions(session, { ...outcome, operations: [op('clip_b')] });
    expect(comparison.divergences).toContainEqual({
      path: 'operations[0].clipId',
      expected: 'clip_a',
      actual: 'clip_b',
    });
  });

  it('reports EVERY divergence, not just the first', () => {
    // A phase's exit criterion is that each divergence is enumerated and accepted,
    // which is impossible if the comparator stops at one.
    const comparison = compareSessions(session, {
      events: [
        event(1, 'status', { status: 'generating' }),
        event(2, 'status', { status: 'failed' }),
      ],
      operations: [op('clip_b')],
    });
    expect(comparison.divergences.length).toBeGreaterThan(2);
  });

  it('distinguishes an absent field from a present one', () => {
    const withExtra = { ...finished, extra: 'x' } as unknown as AiEvent;
    const comparison = compareSessions(session, { ...outcome, events: [running, withExtra] });
    expect(comparison.divergences).toContainEqual({
      path: 'events[1].extra',
      expected: undefined,
      actual: 'x',
    });
  });

  it('treats an array replaced by an object as a divergence, not a crash', () => {
    const comparison = compareSessions(session, {
      ...outcome,
      operations: { nope: true } as unknown as readonly AnyOperation[],
    });
    expect(comparison.identical).toBe(false);
  });
});

describe('formatComparison', () => {
  it('names the diverging paths so a failure is readable without dumping the streams', () => {
    const comparison = compareSessions(session, { ...outcome, operations: [op('clip_b')] });
    const report = formatComparison(comparison);
    expect(report).toContain('operations[0].clipId');
    expect(report).toContain('"clip_a"');
    expect(report).toContain('"clip_b"');
  });

  it('truncates a very long report rather than printing thousands of lines', () => {
    const manyEvents = Array.from({ length: 60 }, (_value, index) =>
      event(index, 'notification', { text: `a${String(index)}` }),
    );
    const otherEvents = Array.from({ length: 60 }, (_value, index) =>
      event(index, 'notification', { text: `b${String(index)}` }),
    );
    const big: GoldenSession = toGoldenSession('big', 'b'.repeat(50), 'p', {
      events: manyEvents,
      operations: [],
    });
    const report = formatComparison(compareSessions(big, { events: otherEvents, operations: [] }));
    expect(report).toContain('… and');
    expect(report.split('\n').length).toBeLessThan(25);
  });
});
