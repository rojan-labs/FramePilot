import { describe, expect, it } from 'vitest';
import { createTurnEmitter, reduceEvents, type AiEvent, type ViewNode } from '@framepilot/ai-sdk';
import { groupTimelineActions } from './actionGroupRows.js';

const turn = (turnId: string) => createTurnEmitter({ conversationId: 'c', turnId, now: () => 1 });

const nodesOf = (events: readonly AiEvent[]): readonly ViewNode[] => reduceEvents(events).nodes;

describe('groupTimelineActions', () => {
  it('folds a block of interleaved actions into one row per kind, in first-seen order', () => {
    const e = turn('t1');
    const rows = groupTimelineActions(
      nodesOf([
        e.userMessage('captions'),
        e.timelineAction('Deleted range', '0s'),
        e.timelineAction('Deleted range', '1s'),
        e.timelineAction('Added captions', 'cue 1'),
        e.timelineAction('Set caption cue', 'cue 1'),
        e.timelineAction('Added captions', 'cue 2'),
        e.timelineAction('Set caption cue', 'cue 2'),
        e.timelineAction('Set track caption style', 'bold'),
      ]),
    );
    expect(
      rows.map((row) =>
        row.kind === 'action_group' ? `${row.action}×${String(row.nodes.length)}` : row.kind,
      ),
    ).toEqual([
      'user',
      'Deleted range×2',
      'Added captions×2',
      'Set caption cue×2',
      // A kind that happened once stays an ordinary row.
      'timeline_action',
    ]);
  });

  it('never groups across anything else in the thread, or across turns', () => {
    const first = turn('t1');
    const second = turn('t2');
    const rows = groupTimelineActions(
      nodesOf([
        first.timelineAction('Trimmed clip', 'a'),
        first.timelineAction('Trimmed clip', 'b'),
        first.toolCall('call_1', 'get_timeline', 'completed'),
        first.timelineAction('Trimmed clip', 'c'),
        second.timelineAction('Trimmed clip', 'd'),
      ]),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      'action_group',
      'tool',
      'timeline_action',
      'timeline_action',
    ]);
  });

  it('keeps a group id stable while its block is still streaming in', () => {
    const e = turn('t1');
    const a = e.timelineAction('Added clip', '1');
    const b = e.timelineAction('Added clip', '2');
    const c = e.timelineAction('Added clip', '3');
    const before = groupTimelineActions(nodesOf([a, b]));
    const after = groupTimelineActions(nodesOf([a, b, c]));
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.kind === 'action_group' && after[0].nodes).toHaveLength(3);
  });
});
