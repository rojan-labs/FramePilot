/**
 * Which part of a long conversation the sidebar renders.
 *
 * Opening a conversation used to lay out every turn it ever had — run 001be135 was 11,424
 * events and thousands of rows — before the editor could read the one they came back for.
 * The sidebar now renders the most recent turns and offers the earlier ones on demand.
 * Only the RENDERED rows are windowed: the conversation is still folded whole, so Undo run,
 * the plan dock, export and every review card keep reading the complete log.
 */
import type { ViewNode } from '@framepilot/ai-sdk';

/** How many of the most recent turns a conversation opens with. */
export const INITIAL_VISIBLE_TURNS = 3;
/** How many earlier turns each "Show earlier messages" reveals. */
export const REVEAL_TURNS_STEP = 5;
/** The single id of the "Show earlier messages" row (there is at most one, at the top). */
export const EARLIER_TURNS_ROW_ID = 'earlier-turns';

/** The "Show earlier messages" row at the top of a windowed conversation. */
export interface EarlierTurnsRow {
  readonly kind: 'earlier_turns';
  readonly id: typeof EARLIER_TURNS_ROW_ID;
  /** How many of the editor's earlier messages (turns) are not rendered yet. */
  readonly hiddenTurns: number;
}

/**
 * Where the rendered window starts: the node index of the `turns`-th most recent user
 * message, or `0` when the conversation has no more turns than that.
 *
 * Scans back from the tail and stops at the window's first message, so the cost is the
 * size of the window, not of the conversation.
 *
 * @param nodes - The conversation's view nodes, in order.
 * @param turns - How many of the most recent turns to render (at least one).
 */
export function visibleWindowStart(nodes: readonly ViewNode[], turns: number): number {
  const wanted = Math.max(1, Math.floor(turns));
  let seen = 0;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]?.kind !== 'user') continue;
    seen += 1;
    if (seen === wanted) return index;
  }
  return 0;
}
