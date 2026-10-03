import type { TimelineActionNode } from '@framepilot/ai-sdk';
import { ChevronRight, ICON_SIZE } from '../icons.js';
import type { ActionGroupRow } from './actionGroupRows.js';

/**
 * How many of a group's actions open at once. A caption pass groups ~350 per kind; listing
 * them all in one virtualised row would rebuild the very wall the group exists to replace,
 * and nobody reads past the first screens of identical rows anyway.
 */
export const MAX_LISTED_ACTIONS = 200;

export interface TimelineActionGroupProps {
  readonly group: ActionGroupRow;
  readonly expanded: boolean;
  readonly onToggleExpanded: (rowId: string, open: boolean) => void;
  /**
   * Render one action exactly as the stream would. Injected so the opened list keeps every
   * action behaviour (reference chips, reveal) without a second action renderer.
   */
  readonly renderAction: (node: TimelineActionNode) => JSX.Element;
}

/**
 * Every action of one kind from a run of a turn's actions, as one counted row —
 * "Deleted range ×346" — that opens on demand. Closed by default: the count is the
 * information; the individual rows are evidence.
 */
export function TimelineActionGroup({
  group,
  expanded,
  onToggleExpanded,
  renderAction,
}: TimelineActionGroupProps): JSX.Element {
  const count = group.nodes.length;
  const bodyId = `action-group-${group.id}`;
  const listed = expanded ? group.nodes.slice(0, MAX_LISTED_ACTIONS) : [];
  const unlisted = count - listed.length;
  return (
    <div
      className="ai-event ai-event--action ai-action-group"
      role="listitem"
      data-expanded={expanded}
    >
      <span className="ai-step-slot">
        <span className="ai-step-node" data-solid="true" aria-hidden="true" />
      </span>
      <div className="ai-step-body ai-action-group-body">
        <button
          type="button"
          className="ai-action-group-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${group.action}: ${String(count)} changes`}
          onClick={() => onToggleExpanded(group.id, !expanded)}
        >
          <span className="ai-action-label">{group.action}</span>
          <span className="ai-action-group-count tabular">×{count}</span>
          <ChevronRight
            size={ICON_SIZE.sm}
            aria-hidden="true"
            className="ai-action-group-chevron"
          />
        </button>
        {expanded && (
          <div
            id={bodyId}
            className="ai-action-group-list"
            role="list"
            aria-label={`${group.action} changes`}
          >
            {listed.map((node) => (
              <div key={node.id}>{renderAction(node)}</div>
            ))}
            {unlisted > 0 && (
              <p className="ai-action-group-more">
                …and {unlisted} more {unlisted === 1 ? 'change' : 'changes'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
