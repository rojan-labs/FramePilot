/**
 * TaskRunView tests (P8.2): the parallel "what's running" view groups tasks by
 * running vs settled rather than arrival order, so two concurrently running
 * tasks render as simultaneous cards — never sequentially.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskView } from '@framepilot/ai-sdk';
import { TaskRunView } from './TaskRunView.js';

function task(overrides: Partial<TaskView> & Pick<TaskView, 'taskId' | 'label'>): TaskView {
  return { ts: 0, turnId: 't1', status: 'running', ...overrides };
}

describe('TaskRunView', () => {
  it('renders nothing when there are no tasks', () => {
    const { container } = render(<TaskRunView tasks={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('defaults collapsed with the most recent running task, then reveals concurrent work', () => {
    render(
      <TaskRunView
        tasks={[
          task({ taskId: 'beats', label: 'Finding the beats' }),
          task({ taskId: 'scenes', label: 'Finding the scenes' }),
        ]}
      />,
    );
    const toggle = screen.getByRole('button', { name: /Activity/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const preview = screen.getByLabelText('Most recent plan task');
    expect(within(preview).getByText('Finding the scenes')).toBeTruthy();
    expect(within(preview).queryByText('Finding the beats')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const runningGroup = screen.getByTestId('ai-tasks-running');
    // Both are present together in the SAME group — concurrent, not one-at-a-time.
    expect(within(runningGroup).getByText('Finding the beats')).toBeTruthy();
    expect(within(runningGroup).getByText('Finding the scenes')).toBeTruthy();
    expect(within(runningGroup).getAllByText('Running…')).toHaveLength(2);
    // No settled group yet — neither task has finished.
    expect(screen.queryByTestId('ai-tasks-settled')).toBeNull();
  });

  it('moves a task to the settled row once it finishes, independent of the others', () => {
    render(
      <TaskRunView
        tasks={[
          task({
            taskId: 'beats',
            label: 'Finding the beats',
            status: 'completed',
            runtimeMs: 420,
          }),
          task({ taskId: 'scenes', label: 'Finding the scenes' }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    const running = screen.getByTestId('ai-tasks-running');
    const settled = screen.getByTestId('ai-tasks-settled');
    expect(within(running).getByText('Finding the scenes')).toBeTruthy();
    expect(within(settled).getByText('Finding the beats')).toBeTruthy();
    expect(within(settled).getByText('420ms')).toBeTruthy();
  });

  it('renders a failed task with its status label, not a fabricated success', () => {
    render(
      <TaskRunView tasks={[task({ taskId: 'x', label: 'Rendering preview', status: 'failed' })]} />,
    );
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('labels a degraded task as a warning instead of implying nothing changed', () => {
    render(
      <TaskRunView tasks={[task({ taskId: 'x', label: 'Add final polish', status: 'warning' })]} />,
    );
    expect(screen.getByText('Warning')).toBeTruthy();
    expect(screen.queryByText('No change')).toBeNull();
  });

  it('resets to collapsed when a new run replaces the task set', () => {
    const { rerender } = render(
      <TaskRunView tasks={[task({ taskId: 'first', label: 'First run task' })]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    expect(screen.getByRole('button', { name: /Activity/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    rerender(
      <TaskRunView tasks={[task({ taskId: 'second', turnId: 't2', label: 'Second run task' })]} />,
    );

    expect(screen.getByRole('button', { name: /Activity/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByText('Second run task')).toBeTruthy();
  });
});
