import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MatteStartInlineCard, matteStartProposal } from './MatteStartInlineCard.js';
import type { MatteJobStore } from '../inspector/masks/matteJobStore.js';

const job = {
  assetId: 'asset',
  clipId: 'shot',
  sourceStart: 0,
  sourceEnd: 6,
  prompts: [],
  foreground: true,
  previewHeight: 540,
};
const result = {
  code: 'needs_editor_start',
  job: { ...job, timelineRevision: 3 },
  estimateSeconds: 3120,
};

const storeThat = (start: MatteJobStore['start']): MatteJobStore =>
  ({ start }) as unknown as MatteJobStore;

describe('matteStartProposal', () => {
  it('reads the prepared job and drops the agent’s stale revision', () => {
    expect(matteStartProposal(result)).toEqual({ job, estimateSeconds: 3120 });
  });

  it('offers nothing for any other failure or a malformed job', () => {
    expect(matteStartProposal({ code: 'pack_missing' })).toBeNull();
    expect(
      matteStartProposal({
        code: 'needs_editor_start',
        job: { ...job, sourceEnd: 0 },
        estimateSeconds: 1,
      }),
    ).toBeNull();
    expect(
      matteStartProposal({
        code: 'needs_editor_start',
        job: { ...job, prompts: 'all' },
        estimateSeconds: 1,
      }),
    ).toBeNull();
    expect(matteStartProposal({ code: 'needs_editor_start', job })).toBeNull();
    expect(matteStartProposal(null)).toBeNull();
  });
});

describe('MatteStartInlineCard', () => {
  it('shows the estimate and starts the Inspector’s own job at the CURRENT revision', async () => {
    const start = vi.fn<MatteJobStore['start']>(() => new Promise(() => undefined));
    render(
      <MatteStartInlineCard
        proposal={matteStartProposal(result)!}
        timelineRevision={11}
        store={storeThat(start)}
      />,
    );
    expect(screen.getByText(/about 52 minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith({ ...job, timelineRevision: 11 });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/review list/));
  });

  it('says why when the job could not start, and offers it again', async () => {
    const start = vi.fn<MatteJobStore['start']>(
      async () => 'This clip is already being processed.',
    );
    render(
      <MatteStartInlineCard
        proposal={matteStartProposal(result)!}
        timelineRevision={1}
        store={storeThat(start)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('This clip is already being processed.'),
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('starts nothing when dismissed', () => {
    const start = vi.fn<MatteJobStore['start']>();
    const { container } = render(
      <MatteStartInlineCard
        proposal={matteStartProposal(result)!}
        timelineRevision={1}
        store={storeThat(start)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(start).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});
