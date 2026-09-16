import type { NoticeNode } from '@framepilot/ai-sdk';
import { AlertTriangle, Check, ChevronRight, ICON_SIZE } from '../icons.js';
import { type SelfCheckGroupRow, selfCheckDetails, summarizeSelfCheck } from './selfCheckRows.js';

export interface SelfCheckGroupProps {
  readonly group: SelfCheckGroupRow;
  readonly expanded: boolean;
  readonly onToggleExpanded: (rowId: string, open: boolean) => void;
  /**
   * Render one notice exactly as the stream would. Injected so the disclosed checks keep
   * every notice behavior (tone, details, copy) without a second notice implementation.
   */
  readonly renderNotice: (notice: NoticeNode) => JSX.Element;
}

/**
 * One run's self-check as a single collapsed row: the verdict stays readable at a glance,
 * the individual checks open on demand. Collapsed by default whatever the verdict — a
 * failed check turns the row's tone to warning so it is still findable while closed.
 */
export function SelfCheckGroup({
  group,
  expanded,
  onToggleExpanded,
  renderNotice,
}: SelfCheckGroupProps): JSX.Element {
  const { verdict, detailCount, hasFailure } = summarizeSelfCheck(group);
  const details = selfCheckDetails(group);
  const bodyId = `self-check-${group.id}`;
  const Icon = hasFailure ? AlertTriangle : Check;
  return (
    <div
      className="ai-event ai-self-check"
      role="listitem"
      data-expanded={expanded}
      data-tone={hasFailure ? 'warning' : 'idle'}
    >
      <button
        type="button"
        className="ai-self-check-toggle"
        aria-expanded={details.length > 0 ? expanded : undefined}
        aria-controls={details.length > 0 ? bodyId : undefined}
        disabled={details.length === 0}
        onClick={() => onToggleExpanded(group.id, !expanded)}
      >
        <Icon
          size={ICON_SIZE.sm}
          aria-hidden="true"
          className="ai-tone-icon"
          data-tone={hasFailure ? 'warning' : 'idle'}
        />
        <span className="ai-self-check-title">Self-check</span>
        {verdict && <span className="ai-self-check-verdict">{verdict}</span>}
        {detailCount > 0 && (
          <span className="ai-self-check-count tabular">
            {detailCount} note{detailCount === 1 ? '' : 's'}
          </span>
        )}
        {details.length > 0 && (
          <ChevronRight size={ICON_SIZE.sm} aria-hidden="true" className="ai-self-check-chevron" />
        )}
      </button>
      {expanded && details.length > 0 && (
        <div id={bodyId} className="ai-self-check-body" role="list" aria-label="Self-check notes">
          {details.map((notice) => (
            <div key={notice.id}>{renderNotice(notice)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
