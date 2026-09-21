import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { CapabilityPackJobWire } from '@framepilot/shared-types';
import { formatElapsed, formatEta, JobsPanel, useCapabilityPackJobs } from './JobsPanel.js';

const job = (overrides: Partial<CapabilityPackJobWire> = {}): CapabilityPackJobWire => ({
  id: 'job-1',
  kind: 'matte',
  label: 'Remove background',
  clipId: 'clip-7',
  priority: 'focused',
  state: 'running',
  progress: { phase: 'self_correct', completed: 30, total: 120, round: 2, etaSeconds: 300 },
  resumed: false,
  ...overrides,
});

describe('JobsPanel', () => {
  it('never draws a one-unit step as a finished job: model loading is named and uncounted', () => {
    render(
      <JobsPanel
        jobs={[job({ progress: { phase: 'prepare', completed: 1, total: 1 }, resumed: true, startedAt: Date.now() - 95 * 60_000 })]}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Loading models')).toBeTruthy();
    expect(screen.queryByText('prepare')).toBeNull();
    const bar = screen.getByRole('progressbar', { name: 'Remove background progress' });
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('data-indeterminate')).toBe('true');
    expect(screen.getByText(/1 h 35 min so far/)).toBeTruthy();
  });

  it('says a running job is pausing, not paused, until it reaches a checkpoint', () => {
    render(<JobsPanel jobs={[job({ pausePending: true })]} onAction={vi.fn()} />);
    expect(screen.getByText('Pausing after this step')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Pause Remove background' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('formats elapsed time to the minute', () => {
    expect(formatElapsed(20)).toBe('Just started');
    expect(formatElapsed(12 * 60)).toBe('12 min so far');
    expect(formatElapsed(2 * 3600)).toBe('2 h so far');
  });

  it('shows name, clip, phase with round, progress and ETA for a running job', () => {
    render(<JobsPanel jobs={[job()]} onAction={vi.fn()} onShowClip={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeTruthy();
    expect(screen.getByText('1 active')).toBeTruthy();
    expect(screen.getByText('Clip clip-7')).toBeTruthy();
    expect(screen.getByText(/Self-correcting \(round 2\)/)).toBeTruthy();
    expect(screen.getByText('About 5 min left in this step')).toBeTruthy();
    expect(screen.getByText('30 of 120')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Remove background progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
  });

  it('offers pause, cancel and show clip for a running job and wires each to its action', () => {
    const onAction = vi.fn();
    const onShowClip = vi.fn();
    render(<JobsPanel jobs={[job()]} onAction={onAction} onShowClip={onShowClip} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause Remove background' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Remove background' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show clip for Remove background' }));
    expect(onAction.mock.calls).toEqual([
      ['job-1', 'pause'],
      ['job-1', 'cancel'],
    ]);
    expect(onShowClip).toHaveBeenCalledWith('clip-7');
    expect(screen.queryByRole('button', { name: 'Resume Remove background' })).toBeNull();
  });

  it('names paused, export-paused, resumed, failed and finished states with the right actions', () => {
    const onAction = vi.fn();
    render(
      <JobsPanel
        jobs={[
          job({ id: 'p', state: 'paused' }),
          job({ id: 'e', label: 'Export-paused job', state: 'paused_export', resumed: true }),
          job({ id: 'f', label: 'Failed job', state: 'failed', error: 'Disk full or folder not writable.' }),
          { ...job({ id: 'd', label: 'Done job', state: 'completed' }), clipId: undefined } as unknown as CapabilityPackJobWire,
        ]}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume Remove background' }));
    expect(onAction).toHaveBeenCalledWith('p', 'resume');
    expect(screen.getByRole('listitem', { name: 'Export-paused job: Paused during export' })).toBeTruthy();
    expect(screen.getByText(/Resumed after restart/)).toBeTruthy();
    expect(screen.getByText('Disk full or folder not writable.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel Done job' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show clip/ })).toBeNull();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByText('2 active')).toBeTruthy();
  });

  it('shows an empty state', () => {
    render(<JobsPanel jobs={[]} onAction={vi.fn()} />);
    expect(screen.getByText('No background jobs.')).toBeTruthy();
  });

  it('formats ETAs in plain words', () => {
    expect(formatEta(20)).toBe('Less than a minute left');
    expect(formatEta(3_600)).toBe('About 1 h left');
    expect(formatEta(5_400)).toBe('About 1 h 30 min left');
  });
});

describe('useCapabilityPackJobs', () => {
  it('loads the list, follows pushes, sends actions, and unsubscribes', async () => {
    let push: ((jobs: readonly CapabilityPackJobWire[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      capabilityPackJobs: vi.fn(async () => [job()]),
      onCapabilityPackJobsChanged: vi.fn((handler: (jobs: readonly CapabilityPackJobWire[]) => void) => {
        push = handler;
        return unsubscribe;
      }),
      capabilityPackJobAction: vi.fn(async () => true),
    };
    const { result, unmount } = renderHook(() => useCapabilityPackJobs(bridge));
    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    act(() => push?.([job({ state: 'completed' })]));
    expect(result.current.jobs[0]?.state).toBe('completed');
    result.current.act('job-1', 'cancel');
    expect(bridge.capabilityPackJobAction).toHaveBeenCalledWith({ jobId: 'job-1', action: 'cancel' });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
    expect(renderHook(() => useCapabilityPackJobs(null)).result.current.jobs).toEqual([]);
  });
});
