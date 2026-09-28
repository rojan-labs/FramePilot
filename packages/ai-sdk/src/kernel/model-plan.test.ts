/** Tests for the model's own plan (`update_plan`) — the pure half the loop decides from. */
import { describe, expect, it } from 'vitest';
import {
  type ModelPlanItem,
  describeOpenItems,
  modelPlanDigest,
  modelPlanEcho,
  modelPlanSteps,
  nextOpenItem,
  openPlanItems,
} from './model-plan.js';

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
