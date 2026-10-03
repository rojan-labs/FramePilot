import { describe, expect, it } from 'vitest';
import { settlePlanSteps, type PlanStepView } from './planSteps.js';

const steps: readonly PlanStepView[] = [
  { id: '1', label: 'Map the footage', status: 'completed' },
  { id: '2', label: 'Cut the montage', status: 'running', detail: 'Placing shots' },
  { id: '3', label: 'Check the rhythm', status: 'pending' },
  { id: '4', label: 'Export', status: 'failed', detail: 'Render refused' },
];

describe('settlePlanSteps', () => {
  it('leaves a live run alone (same array)', () => {
    expect(settlePlanSteps(steps, false)).toBe(steps);
  });

  it('reads every unfinished step as stopped once the run ended, keeping settled ones', () => {
    expect(settlePlanSteps(steps, true).map((step) => step.status)).toEqual([
      'completed',
      'stopped',
      'stopped',
      'failed',
    ]);
  });

  it('is a no-op for a plan its producer already settled', () => {
    const settled = steps.filter((step) => step.status === 'completed' || step.status === 'failed');
    expect(settlePlanSteps(settled, true)).toBe(settled);
  });
});
