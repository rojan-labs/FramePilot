/** Tests for the model's own plan (`update_plan`) — the pure half the loop decides from. */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '../events.js';
import {
  type ModelPlanItem,
  MAX_PRIOR_MODEL_PLANS,
  blockedItemsRetryAction,
  MODEL_PLAN_MAX_ITEMS,
  describeOpenItems,
  modelPlanDigest,
  modelPlanEcho,
  modelPlanSteps,
  modelPlanObjectiveKey,
  modelPlanRecordsFromEvents,
  nextOpenItem,
  openPlanItems,
  parseModelPlan,
  parseModelPlanRecords,
  planForContinuation,
  unloadedDomainsForBlocked,
} from './model-plan.js';
import { LOADABLE_DOMAINS, type ToolDomain } from '../tool-domains.js';

const item = (task: string, status: ModelPlanItem['status'], note?: string): ModelPlanItem => ({
  task,
  status,
  ...(note ? { note } : {}),
});

describe('open items', () => {
  it('counts pending and in-progress as open, and never blocked', () => {
    // Blocked is an answer — the model has said no tool can do it — so a run may end on it.
    const plan = [
      item('a', 'done'),
      item('b', 'pending'),
      item('c', 'in_progress'),
      item('d', 'blocked', 'no tool'),
    ];
    expect(openPlanItems(plan).map((i) => i.task)).toEqual(['b', 'c']);
  });

  it('names the item already in progress as next, else the first pending one', () => {
    expect(nextOpenItem([item('a', 'pending'), item('b', 'in_progress')])?.task).toBe('b');
    expect(nextOpenItem([item('a', 'done'), item('b', 'pending')])?.task).toBe('b');
    expect(nextOpenItem([item('a', 'done'), item('b', 'blocked', 'why')])).toBeUndefined();
  });

  it('names at most four open items in a notice and counts the rest', () => {
    const plan = ['a', 'b', 'c', 'd', 'e', 'f'].map((task) => item(task, 'pending'));
    expect(describeOpenItems(plan)).toBe('“a”, “b”, “c”, “d” and 2 more');
  });
});

describe('modelPlanDigest', () => {
  it('moves when a status or a task changes, and not when only a note is reworded', () => {
    const before = [item('Grade', 'blocked', 'no LUT support')];
    expect(modelPlanDigest([item('Grade', 'blocked', 'no LUTs here')])).toBe(
      modelPlanDigest(before),
    );
    expect(modelPlanDigest([item('Grade', 'done')])).not.toBe(modelPlanDigest(before));
    expect(modelPlanDigest([item('Grade warm', 'blocked', 'x')])).not.toBe(modelPlanDigest(before));
  });
});

describe('modelPlanEcho', () => {
  it('confirms the counts and names what the loop will hold the run to next', () => {
    const echo = modelPlanEcho([
      item('Montage', 'done'),
      item('**Grade** warm', 'in_progress'),
      item('Ramps', 'pending'),
    ]);
    expect(echo).toBe(
      'Plan saved (1 pending, 1 in progress, 1 done). Next: “Grade warm”. The run continues ' +
        'while any item is pending or in progress.',
    );
  });

  it('says a reply now ends the run when nothing is open', () => {
    const echo = modelPlanEcho([item('Montage', 'done'), item('VO', 'blocked', 'no TTS')]);
    expect(echo).toContain('(1 done, 1 blocked)');
    expect(echo).toContain('a reply without a tool call now ends the run');
  });
});

describe('modelPlanSteps', () => {
  it('maps statuses onto the checklist the editor already has', () => {
    const steps = modelPlanSteps([
      item('Montage', 'done'),
      item('Grade', 'in_progress', 'shots 1–12'),
      item('Ramps', 'pending'),
      item('VO', 'blocked', 'There is no text-to-speech tool.'),
    ]);
    expect(steps).toEqual([
      { id: 'plan-item-1', label: 'Montage', status: 'completed' },
      { id: 'plan-item-2', label: 'Grade', status: 'running', detail: 'shots 1–12' },
      { id: 'plan-item-3', label: 'Ramps', status: 'pending' },
      {
        id: 'plan-item-4',
        label: 'VO',
        status: 'failed',
        detail: 'There is no text-to-speech tool.',
      },
    ]);
  });

  it('settles every open item as failed with the reason once the run has ended', () => {
    const steps = modelPlanSteps(
      [item('Montage', 'done'), item('Grade', 'in_progress'), item('Ramps', 'pending')],
      'Not done — the run ended first',
    );
    expect(steps.map((s) => [s.status, s.detail])).toEqual([
      ['completed', undefined],
      ['failed', 'Not done — the run ended first'],
      ['failed', 'Not done — the run ended first'],
    ]);
  });
});

/**
 * AL5 (#149): the plan crosses a run boundary — a resume, or the next run on the same request.
 * These pin the pure half: reading a plan back, and finding the right one for a continuation.
 */
describe('a plan across a run boundary', () => {
  const brief = 'Edit a vertical travel reel from the 24-shot list, grade it warm, add captions.';
  const briefPlan = [
    item('Build the montage', 'done', 'add_clip ×24'),
    item('Warm grade', 'in_progress', 'waiting on measure_color'),
    item('Captions', 'pending'),
    item('Export', 'blocked', 'Export is a dialog'),
  ];

  it('keys a plan by its request, ignoring the whitespace around it', () => {
    expect(modelPlanObjectiveKey(`  ${brief}\n`)).toBe(modelPlanObjectiveKey(brief));
    expect(modelPlanObjectiveKey(brief)).not.toBe(modelPlanObjectiveKey(`${brief} Also a hook.`));
    expect(modelPlanObjectiveKey('continue')).not.toBe(modelPlanObjectiveKey(brief));
  });

  it('reads a written plan back with every status and note as it was', () => {
    expect(parseModelPlan(JSON.parse(JSON.stringify(briefPlan)))).toEqual(briefPlan);
  });

  it('refuses anything that is not a plan — never throws, never half-reads', () => {
    expect(parseModelPlan(undefined)).toBeUndefined();
    expect(parseModelPlan('a plan')).toBeUndefined();
    expect(parseModelPlan([])).toBeUndefined();
    expect(parseModelPlan([{ task: 'a', status: 'finished' }])).toBeUndefined();
    expect(parseModelPlan([{ task: '   ', status: 'pending' }])).toBeUndefined();
    expect(parseModelPlan([{ task: 'a', status: 'pending', extra: 1 }])).toBeUndefined();
    // One bad item drops the list: a plan missing an item would be re-sent without it.
    expect(parseModelPlan([briefPlan[0], { task: 'b' }])).toBeUndefined();
    const tooMany = Array.from({ length: MODEL_PLAN_MAX_ITEMS + 1 }, (_, i) =>
      item(`t${String(i)}`, 'pending'),
    );
    expect(parseModelPlan(tooMany)).toBeUndefined();
  });

  it("finds each request's LAST plan in a conversation, and skips a checklist the model did not write", () => {
    const first = createTurnEmitter({ conversationId: 'c', turnId: 't1' });
    const second = createTurnEmitter({ conversationId: 'c', turnId: 't2' });
    const other = createTurnEmitter({ conversationId: 'c', turnId: 't3' });
    const key = modelPlanObjectiveKey(brief);
    const opened = [item('Build the montage', 'in_progress'), item('Captions', 'pending')];
    const events = [
      first.plan([{ id: 'step-1', label: 'Drafted', status: 'pending' }]),
      first.plan([], { objectiveKey: key, items: opened }),
      other.plan([], { objectiveKey: modelPlanObjectiveKey('add a title'), items: opened }),
      // The follow-up "continue" run works toward the brief, so its plan is the brief's too.
      second.plan([], { objectiveKey: key, items: briefPlan }),
      second.plan([], { objectiveKey: 'junk', items: [{ task: '' }] } as never),
    ];
    const records = modelPlanRecordsFromEvents(events);
    expect(records.map((record) => record.items)).toEqual([opened, briefPlan]);
    expect(planForContinuation(records, brief)).toEqual(briefPlan);
    expect(planForContinuation(records, 'add a title')).toEqual(opened);
  });

  it('gives a request no earlier run planned no plan', () => {
    const records = [{ objectiveKey: modelPlanObjectiveKey(brief), items: briefPlan }];
    expect(planForContinuation(records, 'Make a 15s teaser')).toBeUndefined();
    expect(planForContinuation(undefined, brief)).toBeUndefined();
  });

  it('keeps only well-formed records from an untrusted list, newest last and bounded', () => {
    const records = Array.from({ length: MAX_PRIOR_MODEL_PLANS + 2 }, (_, i) => ({
      objectiveKey: `k${String(i)}`,
      items: [item(`t${String(i)}`, 'pending')],
    }));
    const parsed = parseModelPlanRecords([...records, { objectiveKey: 'x', items: 'no' }, 7]);
    expect(parsed).toHaveLength(MAX_PRIOR_MODEL_PLANS);
    expect(parsed.at(-1)?.objectiveKey).toBe(`k${String(MAX_PRIOR_MODEL_PLANS + 1)}`);
    expect(parseModelPlanRecords({ objectiveKey: 'k0' })).toEqual([]);
  });
});

describe('a blocked item and the domains the run never loaded (AL39)', () => {
  const blocked: ModelPlanItem[] = [
    { task: 'Build the montage', status: 'done' },
    { task: 'Sound design and mix', status: 'blocked', note: 'No SFX in the bin' },
  ];

  it('lists every loadable domain not loaded, in index order, only when an item is blocked', () => {
    const loaded = new Set<ToolDomain>(['color', 'captions']);
    expect(unloadedDomainsForBlocked(blocked, loaded)).toEqual(
      LOADABLE_DOMAINS.filter((domain) => domain !== 'color' && domain !== 'captions'),
    );
    expect(unloadedDomainsForBlocked([{ task: 'Cut', status: 'done' }], new Set())).toEqual([]);
    expect(unloadedDomainsForBlocked(blocked, new Set<ToolDomain>(LOADABLE_DOMAINS))).toEqual([]);
  });

  it('names the blocked items, each domain with its summary, and both ways to answer', () => {
    const action = blockedItemsRetryAction(blocked, ['sourcing']);
    expect(action).toContain('Your plan leaves “Sound design and mix” blocked');
    expect(action).toContain('sourcing (find and place stock footage, music and sound effects');
    expect(action).not.toContain('Build the montage');
    expect(action).toContain('load_tools');
    expect(action).toContain('reply without a tool call and the item stays blocked.');
  });

  it('counts blocked items past the fourth instead of naming them all', () => {
    const many: ModelPlanItem[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((task) => ({
      task,
      status: 'blocked',
      note: 'why',
    }));
    expect(blockedItemsRetryAction(many, ['media'])).toContain('“A”, “B”, “C”, “D” and 2 more');
  });
});
