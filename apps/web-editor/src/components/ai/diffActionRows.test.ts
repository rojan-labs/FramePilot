import { describe, expect, it } from 'vitest';
import type { DiffNode, TimelineActionNode, ViewNode } from '@framepilot/ai-sdk';
import { dropActionsListedByDiff } from './diffActionRows.js';

let seq = 0;
function action(turnId = 't1'): TimelineActionNode {
  seq += 1;
  return {
    kind: 'timeline_action',
    id: `a${String(seq)}`,
    ts: seq,
    turnId,
    action: 'Deleted range',
    detail: '1s–2s',
  };
}
function diff(turnId = 't1', id = `d${String(++seq)}`): DiffNode {
  return { kind: 'diff', id, ts: seq, turnId } as unknown as DiffNode;
}
const everyDiff = (node: ViewNode): boolean => node.kind === 'diff';

describe('dropActionsListedByDiff', () => {
  it('drops the action rows emitted right before their diff card', () => {
    const card = diff();
    const rows = dropActionsListedByDiff([action(), action(), card], everyDiff);
    expect(rows).toEqual([card]);
  });

  it('drops action rows that follow the card in the same turn', () => {
    const card = diff();
    expect(dropActionsListedByDiff([card, action(), action()], everyDiff)).toEqual([card]);
  });

  it('keeps actions whose diff was folded away, so a landed change stays visible', () => {
    const folded = diff('t1', 'folded');
    const actions = [action(), action()];
    const rows = dropActionsListedByDiff([...actions, folded], (n) => n.id !== 'folded');
    expect(rows).toEqual([...actions, folded]);
  });

  it('keeps actions beside a diff card from another turn', () => {
    const other = diff('t2');
    const actions = [action('t1')];
    expect(dropActionsListedByDiff([...actions, other], everyDiff)).toEqual([...actions, other]);
  });

  it('keeps actions with no card beside them', () => {
    const user = { kind: 'user', id: 'u', ts: 0, turnId: 't1' } as unknown as ViewNode;
    const actions = [action()];
    expect(dropActionsListedByDiff([user, ...actions], everyDiff)).toEqual([user, ...actions]);
  });
});
