/**
 * Tests for the clip right-click context menu (plan 3.4 Part 4): the
 * point-react-refine trigger (P13.3) and the UX-08 breadth pass — trim to
 * playhead, speed presets, add transition, reveal in bin — including the gating
 * that keeps the menu from offering an edit the patch builder would refuse.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { ClipContextMenu, type ClipMenuTarget } from './ClipContextMenu.js';

const clip = (id: string, start: number, end: number): Timeline['tracks'][0]['clips'][0] =>
  ({
    id,
    assetId: 'a',
    trackId: 'v',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
  }) as Timeline['tracks'][0]['clips'][0];

const timeline: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [clip('c1', 0, 4)] }],
};

/** Two butt-joined clips — the only shape a transition can be added to. */
const pairTimeline: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [clip('c1', 0, 4), clip('c2', 4, 8)] }],
};

function fakeEditor(over: { timeline?: Timeline; playhead?: number } = {}): UseEditor {
  const activeTimeline = over.timeline ?? timeline;
  const playhead = over.playhead ?? 2;
  return {
    state: {
      timeline: activeTimeline,
      history: { past: [], future: [] } as never,
      assets: [],
      folders: [],
      assetIds: ['a'],
      issues: [],
      selection: 'c1',
      selectedIds: ['c1'],
      playhead,
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
    getPlayhead: () => playhead,
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

  // UX-08: the menu was split / duplicate / delete / ripple delete, on the surface
  // where a right-click is the fastest route to anything.
  it('trims the clip start to the playhead', () => {
    const editor = fakeEditor();
    render(<ClipContextMenu editor={editor} target={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /Trim start to playhead/ }));
    expect(editor.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'trim_clip', clipId: 'c1', start: 2, end: 4 }],
      }),
    );
  });

  it('trims the clip end to the playhead', () => {
    const editor = fakeEditor();
    render(<ClipContextMenu editor={editor} target={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /Trim end to playhead/ }));
    expect(editor.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'trim_clip', clipId: 'c1', start: 0, end: 2 }],
      }),
    );
  });

  // A trim to a playhead outside the clip is either a no-op or a deletion, so the
  // menu must not offer it — the same rule that already disabled Split.
  it('disables both trims when the playhead is outside the clip', () => {
    render(
      <ClipContextMenu editor={fakeEditor({ playhead: 9 })} target={target} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('menuitem', { name: /Trim start to playhead/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('menuitem', { name: /Trim end to playhead/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('applies a speed preset, and marks the clip’s current rate as chosen', () => {
    const editor = fakeEditor();
    render(<ClipContextMenu editor={editor} target={target} onClose={vi.fn()} />);
    // 1x is the clip's rate, so that is the checked option.
    expect(screen.getByRole('menuitemradio', { name: '1×' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: '2×' }));
    expect(editor.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'set_clip_speed', clipId: 'c1', speed: 2 }],
      }),
    );
  });

  it('resets rather than sets when 1× is chosen — 1x IS "no speed change"', () => {
    const editor = fakeEditor();
    render(<ClipContextMenu editor={editor} target={target} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('menuitemradio', { name: '1×' }));
    expect(editor.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'set_clip_speed', clipId: 'c1', speed: null }],
      }),
    );
  });

  it('opens the transition picker at the cut, and offers nothing when no clip follows', () => {
    const onAddTransition = vi.fn();
    const { unmount } = render(
      <ClipContextMenu
        editor={fakeEditor({ timeline: pairTimeline })}
        target={target}
        onClose={vi.fn()}
        onAddTransition={onAddTransition}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /Add transition/ }));
    expect(onAddTransition).toHaveBeenCalledWith('c1', 10, 10);
    unmount();

    // The single-clip timeline has no following clip: the entry is there but dead,
    // rather than silently applying nothing.
    render(
      <ClipContextMenu
        editor={fakeEditor()}
        target={target}
        onClose={vi.fn()}
        onAddTransition={onAddTransition}
      />,
    );
    expect(screen.getByRole('menuitem', { name: /Add transition/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('reveals the clip’s source asset in the bin, and is absent where there is no bin', () => {
    const onRevealInBin = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <ClipContextMenu
        editor={fakeEditor()}
        target={target}
        onClose={onClose}
        onRevealInBin={onRevealInBin}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /Reveal in bin/ }));
    expect(onRevealInBin).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    render(<ClipContextMenu editor={fakeEditor()} target={target} onClose={vi.fn()} />);
    expect(screen.queryByRole('menuitem', { name: /Reveal in bin/ })).toBeNull();
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
