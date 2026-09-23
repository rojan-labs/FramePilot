/**
 * Drops the per-operation action rows that a diff card already lists.
 *
 * The orchestrator emits one `timeline_action` per applied operation and then the turn's
 * `diff`. The diff card's accordion lists those same operations with the same chips, so
 * rendering both put every change on screen twice — a 161-change run read as the card
 * followed by 161 loose "Deleted range" rows. The card is the one place to read them.
 *
 * Only a run of actions that sits directly beside a diff card of the same turn is dropped.
 * Actions with no card to hold them (the card was folded into a plan step, or never came)
 * stay visible, so nothing that landed disappears from the thread.
 */
import type { ViewNode } from '@framepilot/ai-sdk';

/**
 * Remove every run of consecutive `timeline_action` nodes that is adjacent to a
 * rendered diff card from the same turn.
 *
 * @param nodes - The conversation's view nodes, in order.
 * @param isRenderedDiff - Whether a diff node renders as its own card (not folded away).
 * @returns The nodes without the redundant action rows.
 */
export function dropActionsListedByDiff(
  nodes: readonly ViewNode[],
  isRenderedDiff: (node: ViewNode) => boolean,
): ViewNode[] {
  const cardsTurn = (node: ViewNode | undefined, turnId: string): boolean =>
    node !== undefined && node.kind === 'diff' && node.turnId === turnId && isRenderedDiff(node);
  const kept: ViewNode[] = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index]!;
    if (node.kind !== 'timeline_action') {
      kept.push(node);
      index += 1;
      continue;
    }
    let end = index;
    while (end < nodes.length && nodes[end]!.kind === 'timeline_action') end += 1;
    const run = nodes.slice(index, end);
    const listed = cardsTurn(nodes[index - 1], node.turnId) || cardsTurn(nodes[end], node.turnId);
    if (!listed) kept.push(...run);
    index = end;
  }
  return kept;
}
