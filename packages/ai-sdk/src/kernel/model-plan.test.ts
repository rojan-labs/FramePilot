/** Tests for the model's own plan (`update_plan`) — the pure half the loop decides from. */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '../events.js';
import {
  type ModelPlanItem,
  MAX_PRIOR_MODEL_PLANS,
  MODEL_PLAN_MAX_ITEMS,
  describeOpenItems,
  mergeModelPlan,
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
});

// AL44 — harness run 18's plan held 24 items; its last `update_plan` sent two, and because the
// call REPLACED the list the four blocked masking items and everything delivered vanished from
// the plan, the report and the continuation record, with nothing said. These are that run's
// lists, verbatim.
describe('an update never loses an item silently (AL44)', () => {
  const RUN_18_PLAN: readonly ModelPlanItem[] = [
    item(
      'Review every clip; mark best 1–4s moment, reject shaky/soft/bad exposure',
      'done',
      'Contact sheets of all 20 sources',
    ),
    item('Music: detect beats/phrases, mark as markers', 'done', '129 BPM, 5 phrase markers'),
    item(
      'Music: ~60s section, fade out with fade to black',
      'done',
      'golden-storm 0–60.4s with fade-out',
    ),
    item('Story cut 58–62s on beats', 'done', '60.4s, 29 V1 clips on beats'),
    item('Reframe every shot 16:9→9:16', 'done', 'reframe_pan per clip'),
    item('Blurred-fill treatment on 1 wide aerial', 'done', 'bay-aerial'),
    item('Speed ramps', 'done', '9 ramps'),
    item('Freeze frame with flash', 'done', 'passenger 21s + white flash'),
    item('Transitions', 'done', '6 named transitions, verified'),
    item('Masking: shape-mask opener on hook', 'done', 'rounded-rect layer matte on cliff-aerial'),
    item(
      'Masking: text behind subject on summit hero word',
      'blocked',
      'Cut-out job the editor must start',
    ),
    item('Masking: split-screen 3-up on road build', 'done', 'split_left/mid/right at 19.3s'),
    item('Masking: text behind landscape (ridge)', 'blocked', 'Needs editor-started cut-out'),
    item('Masking: mask-reveal through car pillar', 'blocked', 'Needs editor-started cut-out'),
    item(
      'Masking: local sky/face grade masks',
      'blocked',
      'Add mask to existing grade in Inspector',
    ),
    item('Color', 'done', 'normalize + cinematic/warm/cool looks'),
    item('Effects', 'done', 'grain, vignette, leaks, halation'),
    item('Typography', 'done', '12 overlays'),
    item('Stickers/graphics (≤6)', 'done', '6 shapes'),
    item('Story captions (diary lines); .srt', 'done', '6 diary-line overlays'),
    item('Sound design: whooshes, risers, impacts, ambience', 'done', 'A_sfx + A_amb'),
    item('Mix: -14 LUFS, ≤-1 dBTP', 'done', 'Timeline peaks -3.5 dBTP'),
    item('QA: scrub cuts, crops, safe zones, text, audio', 'in_progress'),
    item('Deliverables: master, 16:9 alt, clean, shot list', 'pending'),
  ];
  const RUN_18_LAST_CALL: readonly ModelPlanItem[] = [
    item('QA: scrub cuts, crops, safe zones, text, audio', 'done', 'Transitions verified (10)'),
    item(
      'Deliverables: master, 16:9 alt, clean, shot list',
      'blocked',
      'Files render from the Export dialog',
    ),
  ];

  it('keeps every item run 18’s last call left out, in its place, with its status and note', () => {
    const merged = mergeModelPlan(RUN_18_PLAN, RUN_18_LAST_CALL)!;
    expect(merged.items).toHaveLength(24);
    expect(merged.items.map((it) => it.task)).toEqual(RUN_18_PLAN.map((it) => it.task));
    // The call's own two items carry the call's statuses; every other item is as it was.
    expect(merged.items.slice(22)).toEqual(RUN_18_LAST_CALL);
    expect(merged.items.slice(0, 22)).toEqual(RUN_18_PLAN.slice(0, 22));
    expect(merged.carried).toHaveLength(22);
    expect(merged.items.filter((it) => it.status === 'blocked').map((it) => it.task)).toEqual([
      'Masking: text behind subject on summit hero word',
      'Masking: text behind landscape (ridge)',
      'Masking: mask-reveal through car pillar',
      'Masking: local sky/face grade masks',
      'Deliverables: master, 16:9 alt, clean, shot list',
    ]);
  });

  it('says what it kept: the blocked ones by name and status, the done ones by count', () => {
    const merged = mergeModelPlan(RUN_18_PLAN, RUN_18_LAST_CALL)!;
    expect(modelPlanEcho(merged.items, merged.carried)).toBe(
      'Plan saved (19 done, 5 blocked). Kept 22 items your list left out, as they were: ' +
        '“Masking: text behind subject on summit hero word” (blocked), ' +
        '“Masking: text behind landscape (ridge)” (blocked), ' +
        '“Masking: mask-reveal through car pillar” (blocked), ' +
        '“Masking: local sky/face grade masks” (blocked), and 18 done items. An item leaves ' +
        'the plan only as done or blocked — list every item each call. Nothing is pending or ' +
        'in progress, so a reply without a tool call now ends the run — give your summary.',
    );
  });

  it('keeps an open item a call left out OPEN, so the run still has work', () => {
    const before = [
      item('Captions', 'pending'),
      item('Grade', 'in_progress'),
      item('Cut', 'done', 'x'),
    ];
    const merged = mergeModelPlan(before, [item('Grade', 'done', 'apply_color_grade')])!;
    expect(merged.items).toEqual([
      item('Captions', 'pending'),
      item('Grade', 'done', 'apply_color_grade'),
      item('Cut', 'done', 'x'),
    ]);
    expect(openPlanItems(merged.items)).toEqual([item('Captions', 'pending')]);
    expect(nextOpenItem(merged.items)).toEqual(item('Captions', 'pending'));
    expect(modelPlanEcho(merged.items, merged.carried)).toBe(
      'Plan saved (1 pending, 2 done). Kept 2 items your list left out, as they were: ' +
        '“Captions” (pending), and 1 done item. An item leaves the plan only as done or ' +
        'blocked — list every item each call. Next: “Captions”. The run continues while any ' +
        'item is pending or in progress.',
    );
  });

  it('a rewritten plan keeps the old wording’s open items until the model settles them', () => {
    const before = [item('Sound design', 'pending'), item('Mix', 'pending')];
    // Re-planned in new words: nothing matches, so both old items ride along, after the new.
    const merged = mergeModelPlan(before, [
      item('SFX: whooshes and risers', 'in_progress'),
      item('Loudness to -14 LUFS', 'pending'),
    ])!;
    expect(merged.items.map((it) => `${it.status}:${it.task}`)).toEqual([
      'pending:Sound design',
      'pending:Mix',
      'in_progress:SFX: whooshes and risers',
      'pending:Loudness to -14 LUFS',
    ]);
    expect(merged.carried.map((it) => it.task)).toEqual(['Sound design', 'Mix']);
    // Settling them by their words closes them; nothing is carried then.
    const settled = mergeModelPlan(merged.items, [
      item('Sound design', 'done', 'folded into SFX'),
      item('Mix', 'done', 'folded into loudness'),
      item('SFX: whooshes and risers', 'in_progress'),
      item('Loudness to -14 LUFS', 'pending'),
    ])!;
    expect(settled.carried).toEqual([]);
    expect(settled.items).toHaveLength(4);
  });

  it('a full replacement that names every earlier item is taken as sent, in its order', () => {
    const before = [item('A', 'pending'), item('B', 'pending')];
    const sent = [item('New first', 'pending'), item('B', 'in_progress'), item('A', 'done', 'a')];
    const merged = mergeModelPlan(before, sent)!;
    expect(merged).toEqual({ items: sent, carried: [] });
    expect(modelPlanEcho(merged.items, merged.carried)).not.toContain('Kept');
  });

  it('the first call has nothing to carry', () => {
    const sent = [item('A', 'pending')];
    expect(mergeModelPlan(undefined, sent)).toEqual({ items: sent, carried: [] });
  });

  it('matches an item by the label the briefing shows, so dropped markdown is the same item', () => {
    const merged = mergeModelPlan(
      [item('**Mix** to -14 LUFS', 'pending')],
      [item('Mix to -14 LUFS', 'done', 'normalize_loudness')],
    )!;
    expect(merged.carried).toEqual([]);
    expect(merged.items).toEqual([item('Mix to -14 LUFS', 'done', 'normalize_loudness')]);
  });

  it('matches exactly otherwise — a different word is a different item', () => {
    const merged = mergeModelPlan(
      [item('Mix to -14 LUFS', 'pending')],
      [item('mix to -14 LUFS', 'done', 'normalize_loudness')],
    )!;
    expect(merged.carried).toEqual([item('Mix to -14 LUFS', 'pending')]);
  });

  it('when the plan is full, gives up the oldest carried done items first', () => {
    const before = [
      item('old done 1', 'done', 'a'),
      item('old done 2', 'done', 'b'),
      item('still open', 'pending'),
    ];
    const sent = Array.from({ length: MODEL_PLAN_MAX_ITEMS - 2 }, (_, i) =>
      item(`new ${String(i)}`, 'pending'),
    );
    const merged = mergeModelPlan(before, sent)!;
    expect(merged.items).toHaveLength(MODEL_PLAN_MAX_ITEMS);
    expect(merged.carried.map((it) => it.task)).toEqual(['old done 2', 'still open']);
  });

  it('refuses the call when the open and blocked items it left out cannot fit', () => {
    const before = [item('open', 'pending'), item('stuck', 'blocked', 'no tool')];
    const sent = Array.from({ length: MODEL_PLAN_MAX_ITEMS - 1 }, (_, i) =>
      item(`new ${String(i)}`, 'pending'),
    );
    expect(mergeModelPlan(before, sent)).toBeUndefined();
  });
});
