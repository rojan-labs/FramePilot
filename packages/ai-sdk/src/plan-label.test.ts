import { describe, expect, it } from 'vitest';
import { reduceEvents, createTurnEmitter } from './events.js';
import { parseAgentPlan, parsePlanLines } from './orchestrator.js';
import { plainPlanLabel } from './plan-label.js';

describe('plainPlanLabel', () => {
  it('keeps the words of bold, italic, code and link spans and drops their markers', () => {
    expect(
      plainPlanLabel(
        '**Section A — tighten the 9.133–12.167s pair** into *three* beats on `clip_1`, see [ref](https://x)',
      ),
    ).toBe('Section A — tighten the 9.133–12.167s pair into three beats on clip_1, see ref');
  });

  it('never touches underscores, so clip and asset ids stay exact', () => {
    const label = 'Trim clip__v1_asset_raw_skating_9133__split_12167 to 2s';
    expect(plainPlanLabel(label)).toBe(label);
  });

  it('leaves arithmetic asterisks alone and is idempotent', () => {
    expect(plainPlanLabel('Scale 2 * 3 * 4')).toBe('Scale 2 * 3 * 4');
    const once = plainPlanLabel('## **Rhythm pass** — adjust');
    expect(once).toBe('Rhythm pass — adjust');
    expect(plainPlanLabel(once)).toBe(once);
  });
});

describe('plan parsing and reduction produce plain labels', () => {
  it('a bold step is not mistaken for a bullet', () => {
    expect(parsePlanLines('**Trim the intro**\n- **Add captions**')).toEqual([
      'Trim the intro',
      'Add captions',
    ]);
    expect(
      parseAgentPlan('Here is the plan:\n1. **Section A** — tighten\n* *Coverage* repair').steps,
    ).toEqual(['Section A — tighten', 'Coverage repair']);
  });

  it('a plan recorded with markdown labels renders plain when reduced', () => {
    const em = createTurnEmitter({ conversationId: 'c', turnId: 't' });
    const view = reduceEvents([
      em.plan([{ id: 'step-1', label: '**Section B** — break the hold', status: 'pending' }]),
    ]);
    const plan = view.nodes.find((node) => node.kind === 'plan');
    expect(plan?.kind === 'plan' ? plan.steps[0]?.label : undefined).toBe(
      'Section B — break the hold',
    );
  });
});
