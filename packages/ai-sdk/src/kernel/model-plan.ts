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
import { z } from 'zod/v4';
import type { AiEvent, PlanStep } from '../events.js';
import { plainPlanLabel } from '../plan-label.js';
import { DOMAIN_SUMMARY, LOADABLE_DOMAINS, type ToolDomain } from '../tool-domains.js';

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

/** A tool domain a run can pin with `load_tools` (every domain but `core`). */
export type LoadableToolDomain = Exclude<ToolDomain, 'core'>;

/**
 * The tool domains a plan that gives up on an item has not yet tried: every loadable domain
 * this run never loaded, in `load_tools` index order. Empty when nothing is blocked or every
 * domain is loaded.
 *
 * A blocked item is right only when no available tool can do it, and the model cannot see a
 * tool it has not loaded. Harness run 8 blocked "SFX design" as "no SFX assets in project"
 * without ever loading `sourcing`, whose summary names sound effects, so `search_music`
 * never came up. Read off run state (the plan's statuses and which domains were loaded),
 * never off an item's words.
 */
export function unloadedDomainsForBlocked(
  items: readonly ModelPlanItem[],
  loaded: ReadonlySet<ToolDomain>,
): readonly LoadableToolDomain[] {
  if (!items.some((item) => item.status === 'blocked')) return [];
  return LOADABLE_DOMAINS.filter((domain) => !loaded.has(domain));
}

/** Each domain with the summary the model chooses domains by: `sourcing (…); tracking (…)`. */
export function describeToolDomains(domains: readonly LoadableToolDomain[]): string {
  return domains.map((domain) => `${domain} (${DOMAIN_SUMMARY[domain]})`).join('; ');
}

/**
 * The one instruction the blocked-item continuation carries (AL39): which items the plan
 * left blocked, which domains the run never loaded and what each covers, and the two
 * answers that end it — load and retry, or confirm the item blocked.
 *
 * Harness run 16 left "Sound design and mix — blocked: No SFX in the bin" and ended without
 * loading `sourcing`, though every `update_plan` result had named it. A sentence inside a
 * tool result did not change what the model did (run 8 had done the same before it existed),
 * so the conductor now buys one turn that exists only to answer it.
 */
export function blockedItemsRetryAction(
  items: readonly ModelPlanItem[],
  unloaded: readonly LoadableToolDomain[],
): string {
  const blocked = items.filter((item) => item.status === 'blocked');
  const named = blocked.slice(0, OPEN_ITEMS_NAMED).map((item) => `“${planItemLabel(item)}”`);
  const rest = blocked.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} and ${String(rest)} more` : named.join(', ');
  return (
    `Your plan leaves ${list} blocked, and this run never loaded these tool domains: ` +
    `${describeToolDomains(unloaded)}. Blocked is right only when none of them can do the ` +
    'item. load_tools for any domain that could, set that item back to in_progress with ' +
    'update_plan and do it; or, if none could, reply without a tool call and the item stays ' +
    'blocked.'
  );
}

// ---------------------------------------------------------------------------
// Across a boundary: a resumed run, and the run that continues this one's request (AL5, #149)
// ---------------------------------------------------------------------------

/**
 * A plan as it crosses a run boundary: the items, and WHICH request they are the plan for.
 *
 * The plan used to live in conductor state only, so a resumed run and the follow-up that
 * carries on with the same request both started with none, and the model re-planned from
 * the brief — redoing work its own list already said was done. `objectiveKey` is what lets
 * the next run find the right list: a follow-up "continue" run works toward the brief, so
 * ITS plan is keyed by the brief too, and a third message continuing the brief picks up the
 * second run's list rather than the first's. Nothing here reads any text for meaning: the key
 * is a fingerprint of the objective the conductor already resolved, compared for equality.
 */
export interface ModelPlanRecord {
  /** {@link modelPlanObjectiveKey} of the request the run worked toward. */
  readonly objectiveKey: string;
  readonly items: readonly ModelPlanItem[];
}

/** Most earlier plans a host hands a run — one per request still in the reader's window. */
export const MAX_PRIOR_MODEL_PLANS = 8;

/**
 * The fingerprint a plan's request is matched by: FNV-1a (32-bit) over the trimmed text,
 * with its length. A key, not the text, because the plan event carrying it is re-emitted on
 * every `update_plan` call and a brief can be 27k characters.
 */
export function modelPlanObjectiveKey(objectiveText: string): string {
  const text = objectiveText.trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${String(text.length)}:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * One item as it comes back off disk or over IPC. Bounded like the tool's own schema, but
 * without its authoring rules (a `done` note, a `blocked` reason): those govern what the
 * model may WRITE, and a list it already wrote is carried as it was.
 */
const PersistedPlanItemSchema = z
  .object({
    task: z.string().trim().min(1).max(MODEL_PLAN_TASK_CHARS),
    status: z.enum(MODEL_PLAN_STATUSES),
    note: z.string().max(MODEL_PLAN_NOTE_CHARS).optional(),
  })
  .strict();

const PersistedPlanSchema = z.array(PersistedPlanItemSchema).min(1).max(MODEL_PLAN_MAX_ITEMS);

const PersistedPlanRecordSchema = z
  .object({
    objectiveKey: z.string().min(1).max(64),
    items: PersistedPlanSchema,
  })
  .strict();

/**
 * A plan read back from a checkpoint, a conversation log or an IPC request, or `undefined`
 * for anything that is not one. Never throws: a plan that cannot be read costs the run its
 * carried list — it re-plans, as before — never its correctness.
 */
export function parseModelPlan(value: unknown): readonly ModelPlanItem[] | undefined {
  const parsed = PersistedPlanSchema.safeParse(value);
  return parsed.success ? parsed.data.map(toPlanItem) : undefined;
}

/** {@link parseModelPlan} for a keyed record. */
export function parseModelPlanRecord(value: unknown): ModelPlanRecord | undefined {
  const parsed = PersistedPlanRecordSchema.safeParse(value);
  return parsed.success
    ? { objectiveKey: parsed.data.objectiveKey, items: parsed.data.items.map(toPlanItem) }
    : undefined;
}

/**
 * Earlier plans from an untrusted source (the desktop renderer): each record that parses,
 * the newest {@link MAX_PRIOR_MODEL_PLANS}. Anything that is not a list is no plans.
 */
export function parseModelPlanRecords(value: unknown): readonly ModelPlanRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ModelPlanRecord[] = [];
  for (const entry of value) {
    const record = parseModelPlanRecord(entry);
    if (record !== undefined) records.push(record);
  }
  return records.slice(-MAX_PRIOR_MODEL_PLANS);
}

function toPlanItem(item: z.infer<typeof PersistedPlanItemSchema>): ModelPlanItem {
  return {
    task: item.task,
    status: item.status,
    ...(item.note === undefined ? {} : { note: item.note }),
  };
}

/**
 * The plans a conversation's runs ended with, for the next run to continue: per request, the
 * list its LAST plan event carried, oldest first, the newest {@link MAX_PRIOR_MODEL_PLANS}.
 *
 * Every plan event the model's list produces carries its record (`PlanEvent.modelPlan`), and
 * the last one a run emits holds the list as the run left it — the settle-at-end event keeps
 * the true statuses in the record even though its checklist marks open items failed.
 */
export function modelPlanRecordsFromEvents(events: readonly AiEvent[]): ModelPlanRecord[] {
  const latest = new Map<string, ModelPlanRecord>();
  for (const event of events) {
    if (event.type !== 'plan' || event.modelPlan === undefined) continue;
    const record = parseModelPlanRecord(event.modelPlan);
    if (record === undefined) continue;
    // Re-inserted so the map's order is "last written", and the bound keeps the newest.
    latest.delete(record.objectiveKey);
    latest.set(record.objectiveKey, record);
  }
  return [...latest.values()].slice(-MAX_PRIOR_MODEL_PLANS);
}

/**
 * The plan a run continuing `objectiveText` starts with: the newest earlier record for that
 * same request, items exactly as they were — open items stay open, done and blocked stay
 * done and blocked. `undefined` when no earlier run planned that request.
 */
export function planForContinuation(
  records: readonly ModelPlanRecord[] | undefined,
  objectiveText: string,
): readonly ModelPlanItem[] | undefined {
  const key = modelPlanObjectiveKey(objectiveText);
  return [...(records ?? [])].reverse().find((record) => record.objectiveKey === key)?.items;
}
