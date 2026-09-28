/**
 * @framepilot/ai-sdk/kernel/model-plan — the run's checklist, written by the model.
 *
 * ## Why the model owns it
 *
 * A reply with no tool call used to end an agent run unless an up-front drafted plan
 * (`planFirst`, an off-by-default toggle capped at twelve steps and never updated by the
 * model) still had unreached steps. Run `d8d2e445` — a 27k-character travel-reel brief with
 * a 24-shot list, a typography system, masking, transitions, speed, stickers, captions and a
 * grade — made one montage in four steps, replied "Not done yet: colour, speed, transitions,
 * fade, masking & graphics, SFX & levels, deliverables", and COMPLETED. The model knew
 * exactly what was left. Nothing structural let it say so in a form the loop could honour.
 *
 * `update_plan` is that form (Claude Code's TodoWrite, in this product's terms): the model
 * writes the work the request asks for as a list, keeps each item's status current, and the
 * conductor keeps the run going while an item is open. Nothing here reads the model's prose
 * or the request — the list is structured data the model chose to write, and every rule
 * below is over its statuses.
 *
 * Pure: no I/O, no clock. Shared by the tool's result, the reducer's continuation rule,
 * the briefing, and the plan checklist the editor sees.
 */
import type { PlanStep } from '../events.js';
import { plainPlanLabel } from '../plan-label.js';

/** Most items one plan may hold — a whole brief, not a transcript of it. */
export const MODEL_PLAN_MAX_ITEMS = 40;
/** Characters of one item's task: a deliverable named in a line, not a paragraph. */
export const MODEL_PLAN_TASK_CHARS = 160;
/** Characters of one item's note — for a blocked item, why no tool can do it. */
export const MODEL_PLAN_NOTE_CHARS = 240;

/** Every status an item can hold, in the order the schema advertises them. */
export const MODEL_PLAN_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const;
export type ModelPlanStatus = (typeof MODEL_PLAN_STATUSES)[number];

/** One deliverable in the model's plan. */
export interface ModelPlanItem {
  readonly task: string;
  readonly status: ModelPlanStatus;
  /** Required for `blocked` (the schema enforces it): why no available tool can do it. */
  readonly note?: string;
}

/**
 * Is there still work on this item? `blocked` is NOT open: the model has said no available
 * tool can do it, which is an answer, and a run must be allowed to end on it.
 */
export function isOpenItem(item: ModelPlanItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress';
}

/** The items that are still pending or in progress, in plan order. */
export function openPlanItems(items: readonly ModelPlanItem[]): readonly ModelPlanItem[] {
  return items.filter(isOpenItem);
}

/**
 * The item the run should work on next: the one already in progress, else the first
 * pending one. `undefined` when nothing is open.
 */
export function nextOpenItem(items: readonly ModelPlanItem[]): ModelPlanItem | undefined {
  return items.find((item) => item.status === 'in_progress') ?? items.find(isOpenItem);
}

/** An item's task as one line of plain text (the model writes markdown — see plan-label.ts). */
export function planItemLabel(item: ModelPlanItem): string {
  return plainPlanLabel(item.task);
}

/**
 * A stable fingerprint of what the plan SAYS — every task and its status, in order.
 *
 * Notes are left out on purpose: re-wording why an item is blocked is not movement, and the
 * reducer reads a changed digest as "the plan moved since the run last said it was done".
 */
export function modelPlanDigest(items: readonly ModelPlanItem[]): string {
  return items.map((item) => `${item.status}:${item.task}`).join('\n');
}

/** How many items hold each status. */
export function modelPlanTally(items: readonly ModelPlanItem[]): Record<ModelPlanStatus, number> {
  const tally: Record<ModelPlanStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };
  for (const item of items) tally[item.status] += 1;
  return tally;
}

const STATUS_WORDS: Readonly<Record<ModelPlanStatus, string>> = {
  done: 'done',
  in_progress: 'in progress',
  pending: 'pending',
  blocked: 'blocked',
};

/**
 * What `update_plan` answers: the counts and the next open item, never the list back.
 *
 * The model just wrote the list; echoing it would bill it a second time on every call. What
 * it needs from the result is confirmation that the plan landed and what the loop will now
 * hold it to — which item is next, or that nothing is open and a reply ends the run.
 */
export function modelPlanEcho(items: readonly ModelPlanItem[]): string {
  const tally = modelPlanTally(items);
  const counts = MODEL_PLAN_STATUSES.filter((status) => tally[status] > 0)
    .map((status) => `${String(tally[status])} ${STATUS_WORDS[status]}`)
    .join(', ');
  const next = nextOpenItem(items);
  if (next === undefined) {
    return (
      `Plan saved (${counts}). Nothing is pending or in progress, so a reply without a ` +
      'tool call now ends the run — give your summary.'
    );
  }
  return (
    `Plan saved (${counts}). Next: “${planItemLabel(next)}”. The run continues while any ` +
    'item is pending or in progress.'
  );
}

/** The mark a line of the briefing's PLAN section carries for each status. */
const BRIEFING_MARK: Readonly<Record<ModelPlanStatus, string>> = {
  done: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  blocked: '[!]',
};

/**
 * The plan as the RUN STATE briefing shows it: one line per item, every item.
 *
 * Every item, not only the open ones, because `update_plan` replaces the whole list — a
 * model shown half of its plan would send half of it back. Notes ride only where they are
 * the point: why an item is blocked, and what an in-progress item is waiting on.
 */
export function modelPlanBriefingLines(items: readonly ModelPlanItem[]): readonly string[] {
  return items.map((item) => {
    const note =
      item.note !== undefined && (item.status === 'blocked' || item.status === 'in_progress')
        ? ` — ${item.note}`
        : '';
    return `${BRIEFING_MARK[item.status]} ${planItemLabel(item)}${note}`;
  });
}

/** The plan-step id of an item: positional, and never shared with a drafted `step-N`. */
function planItemId(index: number): string {
  return `plan-item-${String(index + 1)}`;
}

/**
 * The plan as the editor's checklist (`PlanEvent` steps).
 *
 * `blocked` renders as `failed` with the model's reason on the mark: the checklist has no
 * "blocked" state, and an item the run could not do is a red mark with a stated cause, not a
 * tick. `settledReason` is passed when the run has ENDED: every item still open settles as
 * failed with it, so no spinner outlives the run.
 */
export function modelPlanSteps(
  items: readonly ModelPlanItem[],
  settledReason?: string,
): PlanStep[] {
  return items.map((item, index): PlanStep => {
    const base = { id: planItemId(index), label: planItemLabel(item) };
    if (item.status === 'done') return { ...base, status: 'completed' };
    if (item.status === 'blocked') {
      return { ...base, status: 'failed', ...(item.note ? { detail: item.note } : {}) };
    }
    if (settledReason !== undefined) return { ...base, status: 'failed', detail: settledReason };
    return item.status === 'in_progress'
      ? { ...base, status: 'running', ...(item.note ? { detail: item.note } : {}) }
      : { ...base, status: 'pending' };
  });
}

/** How many open items a one-line account names before counting the rest. */
const OPEN_ITEMS_NAMED = 4;

/** The open items in one line — “A”, “B” and 3 more — for a notice. */
export function describeOpenItems(items: readonly ModelPlanItem[]): string {
  const open = openPlanItems(items);
  const named = open.slice(0, OPEN_ITEMS_NAMED).map((item) => `“${planItemLabel(item)}”`);
  const rest = open.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${String(rest)} more` : named.join(', ');
}
