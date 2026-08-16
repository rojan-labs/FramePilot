/**
 * Tests for the clip right-click context menu (plan 3.4 Part 4), focused on the
 * point-react-refine trigger (P13.3): "Ask AI about this clip" calls `onAskAi`
 * with the clip id and closes the menu, and is absent when no handler is wired.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { ClipContextMenu, type ClipMenuTarget } from './ClipContextMenu.js';

const timeline: Timeline = {
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

function fakeEditor(): UseEditor {
  return {
    state: {
      timeline,
      history: { past: [], future: [] } as never,
      assets: [],
      folders: [],
      assetIds: ['a'],
      issues: [],
      selection: 'c1',
      selectedIds: ['c1'],
      playhead: 2,
      pxPerSecond: 40,
      markers: [],
      transcript: [],
      playing: false,
    },
    applyPatch: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    goto: vi.fn(),
    history: { entries: [], cursor: 0 },
    select: vi.fn(),
    selectMany: vi.fn(),
    clearSelection: vi.fn(),
    seek: vi.fn(),
    seekTransient: vi.fn(),
    applyPatchChecked: vi.fn(() => []),
    getPlayhead: () => 2,
    subscribePlayhead: () => () => {},
    setZoom: vi.fn(),
    toggleMarker: vi.fn(),
    setPlaying: vi.fn(),
    registerAssets: vi.fn(),
    replaceAuthoritativeProject: vi.fn(),
    canUndo: false,
    canRedo: false,
  };
}

const target: ClipMenuTarget = { clipId: 'c1', x: 10, y: 10 };

describe('ClipContextMenu', () => {
  it('does not render the Ask AI item when no handler is wired', () => {
    render(<ClipContextMenu editor={fakeEditor()} target={target} onClose={vi.fn()} />);
    expect(screen.queryByRole('menuitem', { name: /Ask AI/ })).toBeNull();
  });

  it('calls onAskAi with the clip id and closes the menu', () => {
    const onAskAi = vi.fn();
    const onClose = vi.fn();
    render(
      <ClipContextMenu editor={fakeEditor()} target={target} onClose={onClose} onAskAi={onAskAi} />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /Ask AI about this clip/ }));
    expect(onAskAi).toHaveBeenCalledWith('c1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
