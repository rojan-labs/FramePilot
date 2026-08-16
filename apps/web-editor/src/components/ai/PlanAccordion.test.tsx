import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanNode } from '@framepilot/ai-sdk';
import { PlanAccordion, recentPlanStep } from './PlanAccordion.js';

const plan: PlanNode = {
  kind: 'plan',
  id: 'plan:1',
  ts: 0,
  turnId: 'turn:1',
  steps: [
    { id: 'one', label: 'Map footage', status: 'completed' },
    { id: 'two', label: 'Build montage', status: 'running', detail: 'Placing hero shots' },
    { id: 'three', label: 'Verify rhythm', status: 'pending' },
  ],
};

describe('PlanAccordion', () => {
  it('previews the active step and reveals the full ledger on demand', () => {
    const onExpandedChange = vi.fn();
    const { rerender } = render(
      <PlanAccordion node={plan} expanded={false} onExpandedChange={onExpandedChange} />,
    );

    expect(screen.getByRole('list', { name: 'Current plan step' }).children).toHaveLength(1);
    expect(screen.getByText('Build montage')).toBeTruthy();
    expect(screen.queryByText('Map footage')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Plan/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    rerender(<PlanAccordion node={plan} expanded onExpandedChange={onExpandedChange} />);
    expect(screen.getByRole('list', { name: 'All plan steps' }).children).toHaveLength(3);
  });

  it('uses the most recently completed step when nothing is active', () => {
    const settled = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.id === 'two' ? { ...step, status: 'completed' as const } : step,
      ),
    };

    expect(recentPlanStep(settled)?.id).toBe('two');
  });
});
