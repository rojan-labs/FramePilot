/**
 * PlanApprovalCard tests (P11.3/P12.4): renders the drafted plan as a friendly
 * numbered list with Approve / Edit request / Cancel — no modal.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanApprovalCard } from './PlanApprovalCard.js';

const STEPS = ['Trim the intro', 'Add captions', 'Balance the audio', 'Export'];

describe('PlanApprovalCard', () => {
  it('renders every step, in order, with the step count in the title', () => {
    render(
      <PlanApprovalCard steps={STEPS} onApprove={() => {}} onEdit={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByText(/4-step plan/)).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(STEPS);
  });

  it('Approve calls onApprove and nothing else', () => {
    const onApprove = vi.fn();
    const onEdit = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlanApprovalCard steps={STEPS} onApprove={onApprove} onEdit={onEdit} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByTestId('ai-approval-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Cancel calls onCancel and nothing else', () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlanApprovalCard
        steps={STEPS}
        onApprove={onApprove}
        onEdit={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-approval-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('Edit request calls onEdit and nothing else', () => {
    const onEdit = vi.fn();
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlanApprovalCard steps={STEPS} onApprove={onApprove} onEdit={onEdit} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByTestId('ai-approval-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
