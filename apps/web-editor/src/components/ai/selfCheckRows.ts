/**
 * Folds a run's self-check notices into one sidebar row.
 *
 * The post-edit self-check reports its verdict, every failed or advisory check and the
 * repair outcome as separate notices. Rendered one per row they filled the sidebar under
 * the reply the editor actually wanted to read, on every run. They are one report, so they
 * render as one collapsed row that opens on demand.
 *
 * Grouping keys on the structured `SELF_CHECK_NOTICE_REASON` tag, never on the prose: the
 * notices that follow the pass in the same turn (a plan step that never reached an edit,
 * the run's failure card) are not part of it and must stay visible on their own.
 */
import { SELF_CHECK_NOTICE_REASON, type NoticeNode, type ViewNode } from '@framepilot/ai-sdk';

/** One self-check pass, rendered as a single disclosure row. */
export interface SelfCheckGroupRow {
  readonly kind: 'self_check_group';
  /** The first notice's id — stable while the pass streams in, so expansion survives. */
  readonly id: string;
  readonly turnId: string;
  /** Every notice of the pass, in emission order (the verdict first). */
  readonly notices: readonly NoticeNode[];
}

/** A row of the sidebar's activity stream. */
export type ActivityRow = ViewNode | SelfCheckGroupRow;

const SELF_CHECK_PREFIX = /^Deterministic self-check:\s*/;

function isSelfCheckNotice(node: ViewNode): node is NoticeNode {
  return node.kind === 'notice' && node.reason === SELF_CHECK_NOTICE_REASON;
}

/**
 * Replace each run of consecutive, same-turn self-check notices with one group row.
 *
 * @param nodes - The activity stream, in order.
 * @returns The same stream with every self-check pass collapsed into a {@link SelfCheckGroupRow}.
 */
export function groupSelfCheckNotices(nodes: readonly ViewNode[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let open: { id: string; turnId: string; notices: NoticeNode[] } | undefined;
  const close = (): void => {
    if (open) rows.push({ kind: 'self_check_group', ...open });
    open = undefined;
  };
  for (const node of nodes) {
    if (!isSelfCheckNotice(node)) {
      close();
      rows.push(node);
      continue;
    }
    if (open?.turnId !== node.turnId) {
      close();
      open = { id: node.id, turnId: node.turnId, notices: [] };
    }
    open.notices.push(node);
  }
  close();
  return rows;
}

/** What the collapsed row says: the verdict, and how much sits behind it. */
export interface SelfCheckSummary {
  /** The verdict sentence without the engineering prefix, e.g. "Passed with 3 warning(s)." */
  readonly verdict: string;
  /** Notices behind the disclosure (everything but the verdict itself). */
  readonly detailCount: number;
  /** A check failed — the row carries the warning tone even while collapsed. */
  readonly hasFailure: boolean;
}

/**
 * Derive the collapsed row's copy from a pass.
 *
 * @param group - One self-check pass.
 * @returns The verdict text, the hidden-notice count and whether any check failed.
 */
export function summarizeSelfCheck(group: SelfCheckGroupRow): SelfCheckSummary {
  const [first, ...rest] = group.notices;
  const verdictNode = first && SELF_CHECK_PREFIX.test(first.text) ? first : undefined;
  return {
    verdict: verdictNode ? verdictNode.text.replace(SELF_CHECK_PREFIX, '') : '',
    detailCount: verdictNode ? rest.length : group.notices.length,
    hasFailure: group.notices.some((notice) => notice.level !== 'info'),
  };
}

/**
 * The notices shown when the row opens: the verdict is already in the header, so it is
 * not repeated below it.
 */
export function selfCheckDetails(group: SelfCheckGroupRow): readonly NoticeNode[] {
  const [first, ...rest] = group.notices;
  return first && SELF_CHECK_PREFIX.test(first.text) ? rest : group.notices;
}
