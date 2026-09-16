import { describe, expect, it } from 'vitest';
import { SELF_CHECK_NOTICE_REASON, type NoticeNode, type ViewNode } from '@framepilot/ai-sdk';
import { groupSelfCheckNotices, selfCheckDetails, summarizeSelfCheck } from './selfCheckRows.js';

let seq = 0;
function notice(text: string, over: Partial<NoticeNode> = {}): NoticeNode {
  seq += 1;
  return {
    kind: 'notice',
    id: `n${String(seq)}`,
    ts: seq,
    turnId: 't1',
    level: 'info',
    text,
    ...over,
  };
}
const tagged = (text: string, over: Partial<NoticeNode> = {}): NoticeNode =>
  notice(text, { reason: SELF_CHECK_NOTICE_REASON, ...over });

describe('groupSelfCheckNotices', () => {
  it('folds one pass into a single row and leaves the notices around it alone', () => {
    const before = notice('Steering applied: tighter');
    const verdict = tagged('Deterministic self-check: Passed with 2 warning(s).');
    const failed = tagged('Trackers carry motion: none', { level: 'warning' });
    const advisory = tagged('Transcript looks real: looped');
    // Emitted right after the pass in the same turn, but not part of it.
    const after = notice('1 planned step never reached an edit.');
    const rows = groupSelfCheckNotices([before, verdict, failed, advisory, after]);

    expect(rows.map((row) => row.kind)).toEqual(['notice', 'self_check_group', 'notice']);
    expect(rows[1]).toMatchObject({ id: verdict.id, notices: [verdict, failed, advisory] });
    expect(rows[2]).toBe(after);
  });

  it('keeps passes from different turns apart, so each run keeps its own verdict', () => {
    const first = tagged('Deterministic self-check: Passed.', { turnId: 'a' });
    const second = tagged('Deterministic self-check: Failed.', { turnId: 'b' });
    const rows = groupSelfCheckNotices([first, second]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'self_check_group')).toBe(true);
  });

  it('never groups an untagged notice, even one that reads like the verdict', () => {
    const legacy = notice('Deterministic self-check: Passed.');
    expect(groupSelfCheckNotices([legacy])).toEqual([legacy]);
  });

  it('returns a stream with no self-check unchanged', () => {
    const nodes: ViewNode[] = [notice('a'), notice('b', { level: 'error' })];
    expect(groupSelfCheckNotices(nodes)).toEqual(nodes);
  });
});

describe('summarizeSelfCheck / selfCheckDetails', () => {
  it('lifts the verdict into the header and keeps only the checks behind it', () => {
    const verdict = tagged('Deterministic self-check: Passed with 1 warning(s).');
    const check = tagged('No words cut through: frame 91', { level: 'warning' });
    const [row] = groupSelfCheckNotices([verdict, check]);
    if (row?.kind !== 'self_check_group') throw new Error('expected a group row');

    expect(summarizeSelfCheck(row)).toEqual({
      verdict: 'Passed with 1 warning(s).',
      detailCount: 1,
      hasFailure: true,
    });
    expect(selfCheckDetails(row)).toEqual([check]);
  });

  it('shows every notice when the pass has no recognisable verdict line', () => {
    const repair = tagged('The repair pass looked at the failed checks and proposed no change.');
    const [row] = groupSelfCheckNotices([repair]);
    if (row?.kind !== 'self_check_group') throw new Error('expected a group row');

    expect(summarizeSelfCheck(row)).toEqual({ verdict: '', detailCount: 1, hasFailure: false });
    expect(selfCheckDetails(row)).toEqual([repair]);
  });
});
