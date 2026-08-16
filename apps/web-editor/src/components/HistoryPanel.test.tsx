/**
 * Tests for the project history panel: empty state, edit rows with author
 * badges, the You/AI filter, and click/nav time-travel through the real store.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Patch } from '@framepilot/editor-core';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { trimClipPatch } from '../editor/patch-builders.js';
import { HistoryPanel } from './HistoryPanel.js';

const clipTimeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const baseProject: Project = {
  id: 'p',
  name: 'Test',
  version: 9,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  transcript: [],
  angleGroups: [],
  aiMemory: {},
  history: [],
  timeline: clipTimeline,
  assets: [],
  folders: [],
  markers: [],
};

/** An agent-authored trim, so the author badge / filter can be exercised. */
const agentTrim = (): Patch => ({
  patchId: 'agent_1' as Patch['patchId'],
  createdBy: 'agent',
  reason: 'Tightened the intro',
  // Shrinks further than the user edit (→2), so it stays valid when applied after it.
  operations: [{ type: 'trim_clip', clipId: 'c1', start: 0, end: 1 }],
});

function Host(): JSX.Element {
  const editor = useEditor(clipTimeline, { assetIds: ['a'] });
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          const patch = trimClipPatch(editor.state.timeline, 'c1', 0, 2);
          if (patch) editor.applyPatch(patch);
        }}
      >
        user-edit
      </button>
      <button type="button" onClick={() => editor.applyPatch(agentTrim())}>
        agent-edit
      </button>
      <span aria-label="clip end">{editor.state.timeline.tracks[0]!.clips[0]!.end}</span>
      <HistoryPanel editor={editor} project={baseProject} open onClose={() => {}} />
    </div>
  );
}

describe('HistoryPanel', () => {
  it('shows the empty state before any edit', () => {
    render(<Host />);
    expect(screen.getByText('No edits yet')).toBeDefined();
  });

  it('lists an edit with a human label, the origin node, and the You badge', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'user-edit' }));
    expect(screen.getByText('Trimmed clip')).toBeDefined();
    expect(screen.getByText('Project opened')).toBeDefined();
    // "You" also names the filter chip, so scope to the author badge.
    expect(screen.getByText('You', { selector: '.hist-author-badge' })).toBeDefined();
  });

  it('filters rows by author', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'user-edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'agent-edit' }));
    // Both edits are trim_clip → two "Trimmed clip" labels.
    expect(screen.getAllByText('Trimmed clip')).toHaveLength(2);

    // Filter to AI: only the agent edit (with its reason) remains.
    fireEvent.click(screen.getByRole('button', { name: 'AI' }));
    expect(screen.getAllByText('Trimmed clip')).toHaveLength(1);
    expect(screen.getByText('Tightened the intro')).toBeDefined();
  });

  it('time-travels to the start via the nav control', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'user-edit' }));
    expect(screen.getByLabelText('clip end').textContent).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Jump to start' }));
    expect(screen.getByLabelText('clip end').textContent).toBe('4');
  });

  it('jumps to a specific edit when its row is clicked', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'user-edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to start' }));
    expect(screen.getByLabelText('clip end').textContent).toBe('4');

    // Redo back to the (now-dimmed) edit by clicking its row.
    fireEvent.click(screen.getByTitle('Redo to this point'));
    expect(screen.getByLabelText('clip end').textContent).toBe('2');
  });

  it('renders nothing when closed', () => {
    function ClosedHost(): JSX.Element {
      const editor = useEditor(clipTimeline, { assetIds: ['a'] });
      return <HistoryPanel editor={editor} project={baseProject} open={false} onClose={() => {}} />;
    }
    const { container } = render(<ClosedHost />);
    expect(container.querySelector('.history-panel')).toBeNull();
  });
});
