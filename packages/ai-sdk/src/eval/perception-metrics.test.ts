import { describe, expect, it } from 'vitest';
import type { Patch } from '@framepilot/editor-core';
import type { AiEvent } from '../events.js';
import {
  measurePerceptionTurn,
  pictureFactsInPrompt,
  summarizePerception,
  type PerceptionTurnMetrics,
} from './perception-metrics.js';

const T0 = 2_000_000;
let seq = 0;

function ev(type: AiEvent['type'], extra: Record<string, unknown> = {}): AiEvent {
  seq += 1;
  return {
    id: `e_${String(seq)}`,
    conversationId: 'c',
    turnId: 't',
    ts: T0 + seq,
    type,
    ...extra,
  } as unknown as AiEvent;
}

/** A call that ran and finished, as two events under ONE id — the real event shape. */
function call(toolName: string, extra: Record<string, unknown> = {}): AiEvent[] {
  seq += 1;
  const id = `tc_${String(seq)}`;
  const base = { id, conversationId: 'c', turnId: 't', type: 'tool_call', toolName, ...extra };
  return [
    { ...base, ts: T0 + seq, status: 'running' },
    { ...base, ts: T0 + seq + 1, status: 'completed' },
  ] as unknown as AiEvent[];
}

function diff(ops: readonly unknown[], valid = true): AiEvent {
  return ev('diff', { edit: { validation: { valid }, ops } });
}

function patch(operations: Patch['operations']): Patch {
  return { patchId: 'p1' as Patch['patchId'], createdBy: 'agent', reason: 'test', operations };
}

describe('measurePerceptionTurn — frames', () => {
  it('counts one frame per get_frame call, not per event', () => {
    const events = [...call('get_frame'), ...call('get_frame')];
    expect(measurePerceptionTurn(events).framesSeen).toBe(2);
  });

  it('reads a multi-frame call from the args summary rather than guessing', () => {
    const events = call('get_frame', { argsSummary: 'review 3 frames at 12.0s' });
    expect(measurePerceptionTurn(events).framesSeen).toBe(3);
  });

  it('does not count a call that never finished', () => {
    const running = call('get_frame')[0]!;
    expect(measurePerceptionTurn([running]).framesSeen).toBe(0);
  });

  it('is zero for a run that only read the timeline', () => {
    const events = [...call('get_timeline'), ...call('get_clips')];
    expect(measurePerceptionTurn(events).framesSeen).toBe(0);
  });
});

describe('measurePerceptionTurn — perception calls', () => {
  it('counts the four pull surfaces and names them', () => {
    const events = [
      ...call('search_visual'),
      ...call('describe_footage'),
      ...call('search_visual'),
      ...call('get_timeline'),
    ];
    const m = measurePerceptionTurn(events);
    expect(m.perceptionCalls).toBe(3);
    expect(m.perceptionCallsByTool).toEqual({ search_visual: 2, describe_footage: 1 });
  });
});

describe('measurePerceptionTurn — numeric guessing', () => {
  it('counts a grade with no measurement as a guess', () => {
    const events = [diff([{ type: 'apply_color_grade' }])];
    expect(measurePerceptionTurn(events).numericGuess).toEqual({
      total: 1,
      grounded: 0,
      guessed: 1,
      rate: 1,
    });
  });

  it('counts a grade that measured first as grounded', () => {
    const events = [...call('measure_color'), diff([{ type: 'apply_color_grade' }])];
    expect(measurePerceptionTurn(events).numericGuess.rate).toBe(0);
  });

  it('does not credit a measurement that happened after the edit', () => {
    const events = [diff([{ type: 'apply_color_grade' }]), ...call('measure_color')];
    expect(measurePerceptionTurn(events).numericGuess.guessed).toBe(1);
  });

  it('credits the VU3/VU4 solvers by name so the baseline and the fix score alike', () => {
    const events = [...call('match_color'), diff([{ type: 'apply_color_grade' }])];
    expect(measurePerceptionTurn(events).numericGuess.rate).toBe(0);
  });

  it('judges transitions the same way as grades', () => {
    const events = [diff([{ type: 'add_transition' }, { type: 'trim_clip' }])];
    const m = measurePerceptionTurn(events);
    expect(m.numericGuess.total).toBe(1);
    expect(m.numericGuess.rate).toBe(1);
  });

  it('ignores operations from a proposal that failed validation', () => {
    const events = [diff([{ type: 'apply_color_grade' }], false)];
    expect(measurePerceptionTurn(events).numericGuess.rate).toBeNull();
  });

  it('reports null, not zero, when the turn graded nothing', () => {
    expect(measurePerceptionTurn([diff([{ type: 'trim_clip' }])]).numericGuess.rate).toBeNull();
  });

  it('reads recorded patches in preference to diff events', () => {
    const events = [...call('measure_color'), diff([{ type: 'trim_clip' }])];
    const applied = [patch([{ type: 'apply_color_grade', clipId: 'c1', params: {} }] as never)];
    const m = measurePerceptionTurn(events, applied);
    expect(m.numericGuess.total).toBe(1);
    expect(m.numericGuess.grounded).toBe(1);
  });

  it('accepts a compact op recorded as a bare type string', () => {
    const events = [diff(['add_transition'])];
    expect(measurePerceptionTurn(events).numericGuess.total).toBe(1);
  });
});

describe('pictureFactsInPrompt', () => {
  it('is zero on the rows the model reads today', () => {
    const text = 'c12[0–4.2s], c13[4.2–9s], c14[9–12s]';
    expect(pictureFactsInPrompt(text)).toEqual({ rows: 3, withFacts: 0, rate: 0 });
  });

  it('counts a row that carries facts after its time span', () => {
    const text = 'c12[61–66.4s] · MS man at desk · static · bright warm, c13[66.4–70s]';
    const m = pictureFactsInPrompt(text);
    expect(m.rows).toBe(2);
    expect(m.withFacts).toBe(1);
    expect(m.rate).toBe(0.5);
  });

  it('reports null rather than a rate when nothing was shown', () => {
    expect(pictureFactsInPrompt('(no clips)').rate).toBeNull();
  });
});

describe('summarizePerception', () => {
  const turn = (over: Partial<PerceptionTurnMetrics> = {}): PerceptionTurnMetrics => ({
    framesSeen: 0,
    perceptionCalls: 0,
    perceptionCallsByTool: {},
    numericGuess: { total: 0, grounded: 0, guessed: 0, rate: null },
    ...over,
  });

  it('divides frames by accepted edits', () => {
    const s = summarizePerception([turn({ framesSeen: 3 }), turn({ framesSeen: 1 })], 8, 2);
    expect(s.framesSeenPerEdit).toBe(0.5);
    expect(s.perceptionCallsPerRun).toBe(0);
  });

  it('reports null per-edit frames when nothing was accepted', () => {
    expect(summarizePerception([turn({ framesSeen: 2 })], 0, 1).framesSeenPerEdit).toBeNull();
  });

  it('merges per-tool counts across turns', () => {
    const s = summarizePerception(
      [
        turn({ perceptionCalls: 2, perceptionCallsByTool: { search_visual: 2 } }),
        turn({ perceptionCalls: 1, perceptionCallsByTool: { search_visual: 1 } }),
      ],
      1,
      1,
    );
    expect(s.perceptionCallsByTool).toEqual({ search_visual: 3 });
    expect(s.perceptionCallsPerRun).toBe(3);
  });

  it('aggregates the guess rate over operations, not over turns', () => {
    const s = summarizePerception(
      [
        turn({ numericGuess: { total: 3, grounded: 0, guessed: 3, rate: 1 } }),
        turn({ numericGuess: { total: 1, grounded: 1, guessed: 0, rate: 0 } }),
      ],
      4,
      1,
    );
    expect(s.numericGuessRate).toBe(0.75);
  });

  it('reports null guess rate when no grade or transition was applied', () => {
    expect(summarizePerception([turn(), turn()], 2, 1).numericGuessRate).toBeNull();
  });
});
