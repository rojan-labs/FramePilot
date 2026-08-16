/**
 * Tests for the toast system (plan 3.4 Part 4): the editor-fed error toast on a
 * rejected patch, manual dismissal, and auto-expiry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Patch } from '@framepilot/editor-core';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { Toasts, useToasts } from './Toasts.js';

const timeline: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [] }],
};

const badPatch: Patch = {
  patchId: 'bad' as Patch['patchId'],
  createdBy: 'user',
  reason: 'invalid',
  operations: [{ type: 'trim_clip', clipId: 'missing', start: 0, end: 1 }],
};

function IssueHost(): JSX.Element {
  const editor = useEditor(timeline);
  return (
    <div>
      <button type="button" onClick={() => editor.applyPatch(badPatch)}>
        break
      </button>
      <Toasts editor={editor} />
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Toasts (editor issues)', () => {
  it('raises one error toast per rejected edit and dismisses on click', () => {
    render(<IssueHost />);
    fireEvent.click(screen.getByRole('button', { name: 'break' }));
    const host = screen.getByLabelText('notifications');
    expect(host.querySelectorAll('.toast.is-error')).toHaveLength(1);
    // Re-applying the same invalid patch keeps it at one (deduped by signature).
    fireEvent.click(screen.getByRole('button', { name: 'break' }));
    expect(host.querySelectorAll('.toast.is-error')).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(host.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('does not announce a committed edit (history panel owns that now)', () => {
    function AppliedHost(): JSX.Element {
      const editor = useEditor(timeline, ['a']);
      return (
        <div>
          <button
            type="button"
            onClick={() =>
              editor.applyPatch({
                patchId: 'ok' as Patch['patchId'],
                createdBy: 'user',
                reason: 'add',
                operations: [
                  {
                    type: 'add_clip',
                    trackId: 'v',
                    assetId: 'a',
                    start: 0,
                    end: 2,
                    sourceStart: 0,
                    sourceEnd: 2,
                    clipId: 'c1',
                  },
                ],
              })
            }
          >
            edit
          </button>
          <span aria-label="clip count">{editor.state.timeline.tracks[0]!.clips.length}</span>
          <Toasts editor={editor} />
        </div>
      );
    }
    render(<AppliedHost />);
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    // The edit landed…
    expect(screen.getByLabelText('clip count').textContent).toBe('1');
    // …but no success toast is raised.
    const host = screen.getByLabelText('notifications');
    expect(host.querySelectorAll('.toast')).toHaveLength(0);
  });
});

/** Harness exposing the queue so push/auto-dismiss can be driven directly. */
function QueueHost({
  onReady,
}: {
  onReady: (push: ReturnType<typeof useToasts>['push']) => void;
}): JSX.Element {
  const queue = useToasts();
  onReady(queue.push);
  return (
    <ul aria-label="queue">
      {queue.toasts.map((t) => (
        <li key={t.id}>{t.message}</li>
      ))}
    </ul>
  );
}

describe('useToasts queue', () => {
  it('auto-dismisses a toast after its tone timeout', () => {
    vi.useFakeTimers();
    let push: ReturnType<typeof useToasts>['push'] = () => {};
    render(<QueueHost onReady={(p) => (push = p)} />);
    act(() => push({ tone: 'success', message: 'Saved' }));
    expect(screen.getByText('Saved')).toBeDefined();
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
