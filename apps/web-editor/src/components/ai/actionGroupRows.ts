/**
 * Collapses a turn's run of timeline-action rows into one counted row per action kind.
 *
 * The orchestrator emits one `timeline_action` per applied operation. A caption
 * regeneration applies hundreds: run 001be135's caption turn rendered 1,047 rows —
 * "Deleted range" ×346, then "Added captions" and "Set caption cue" interleaved cue by cue
 * ×350 each — which buried the reply under a wall nobody reads row by row. Grouping by
 * kind within the contiguous block turns that into four rows, and 6,102 rows across the
 * whole conversation into 45.
 *
 * Only a contiguous block of one turn's actions is grouped: anything between two actions
 * (a tool call, a message, a diff card) ends the block, so the thread's order of events is
 * kept. Within a block, kinds appear in the order they first occurred; a kind that occurred
 * once stays a plain row.
 */
import type { TimelineActionNode } from '@framepilot/ai-sdk';
import type { ActivityRow } from './selfCheckRows.js';

/** Every action of one kind from a contiguous block of a turn's actions. */
export interface ActionGroupRow {
  readonly kind: 'action_group';
  /** Derived from the kind's first action, so it is stable while the block streams in. */
  readonly id: string;
  readonly turnId: string;
  readonly action: string;
  /** The grouped actions, in emission order. */
  readonly nodes: readonly TimelineActionNode[];
}

/**
 * Replace each contiguous block of a turn's `timeline_action` rows with one row per kind.
 *
 * @param rows - The activity stream, in order.
 * @returns The stream with every repeated action kind of a block folded into an
 *   {@link ActionGroupRow}; single actions and every other row are unchanged.
 */
export function groupTimelineActions(
  rows: readonly ActivityRow[],
): (ActivityRow | ActionGroupRow)[] {
  const out: (ActivityRow | ActionGroupRow)[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.kind !== 'timeline_action') {
      out.push(row);
      index += 1;
      continue;
    }
    const byAction = new Map<string, TimelineActionNode[]>();
    let end = index;
    while (end < rows.length) {
      const candidate = rows[end]!;
      if (candidate.kind !== 'timeline_action' || candidate.turnId !== row.turnId) break;
      const group = byAction.get(candidate.action);
      if (group) group.push(candidate);
      else byAction.set(candidate.action, [candidate]);
      end += 1;
    }
    for (const [action, nodes] of byAction) {
      const [first] = nodes;
      if (first === undefined) continue;
      if (nodes.length === 1) {
        out.push(first);
        continue;
      }
      out.push({
        kind: 'action_group',
        id: `${first.id}#group`,
        turnId: row.turnId,
        action,
        nodes,
      });
    }
    index = end;
  }
  return out;
}
