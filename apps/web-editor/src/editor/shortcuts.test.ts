/**
 * Tests for the keyboard shortcut registry (plan 3.4 Part 3): chord
 * normalisation, platform glyph formatting, registry lookup, and a sampling of
 * `run` behaviours that exercise the clipboard and patch dispatch.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from './useEditor.js';
import {
  type Clipboard,
  type ShortcutDeps,
  SHORTCUTS,
  eventToChord,
  formatChord,
  hintFor,
  matchShortcut,
} from './shortcuts.js';

const ev = (init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe('eventToChord', () => {
  it('normalises plain, named, and modified keys', () => {
    expect(eventToChord(ev({ key: ' ' }))).toBe('space');
    expect(eventToChord(ev({ key: 'ArrowLeft' }))).toBe('left');
    expect(eventToChord(ev({ key: 'S' }))).toBe('s');
    expect(eventToChord(ev({ key: 'z', metaKey: true }))).toBe('mod+z');
    expect(eventToChord(ev({ key: 'Z', metaKey: true, shiftKey: true }))).toBe('mod+shift+z');
    expect(eventToChord(ev({ key: 'ArrowRight', shiftKey: true }))).toBe('shift+right');
  });

  it('omits Shift for printable symbol keys (it is implicit)', () => {
    expect(eventToChord(ev({ key: '?', shiftKey: true }))).toBe('?');
    expect(eventToChord(ev({ key: ',', shiftKey: false }))).toBe(',');
  });
});

describe('formatChord', () => {
  it('renders mac glyphs without separators', () => {
    expect(formatChord('mod+shift+z', true)).toBe('⌘⇧Z');
    expect(formatChord('left', true)).toBe('←');
  });
  it('renders PC labels joined with +', () => {
    expect(formatChord('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatChord('space', false)).toBe('Space');
  });
});

describe('matchShortcut / hintFor', () => {
  it('matches any chord listed for a shortcut', () => {
    expect(matchShortcut('mod+y')?.id).toBe('history.redo');
    expect(matchShortcut('mod+shift+z')?.id).toBe('history.redo');
    expect(matchShortcut('nope')).toBeNull();
  });
  it('rebinds mod+k from split to the command palette, freeing it for ⌘K (P12.2)', () => {
    expect(matchShortcut('mod+k')?.id).toBe('ai.commandPalette');
    expect(matchShortcut('s')?.id).toBe('edit.split');
    // `s` alone still splits; mod+k no longer does.
    expect(SHORTCUTS.find((s) => s.id === 'edit.split')?.keys).toEqual(['s']);
  });
  it('exposes a tooltip hint for a shortcut id', () => {
    expect(hintFor('edit.split', true)).toBe('S');
    expect(hintFor('history.undo', false)).toBe('Ctrl+Z');
    expect(hintFor('does.not.exist')).toBeNull();
  });
  it('every shortcut has at least one key and a unique id', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SHORTCUTS.every((s) => s.keys.length > 0)).toBe(true);
  });
});

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

function fakeEditor(selection: string | null, playhead = 2): UseEditor {
  return {
    state: {
      timeline,
      history: { past: [], future: [] } as never,
      assets: [],
      folders: [],
      assetIds: ['a'],
      issues: [],
      selection,
      selectedIds: selection ? [selection] : [],
      playhead,
      pxPerSecond: 40,
      markers: [
        { id: 'm1', time: 1 },
        { id: 'm2', time: 6 },
      ],
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

const deps = (editor: UseEditor, clipboard: Clipboard): ShortcutDeps => ({
  editor,
  fps: 30,
  clipboard,
  toggleHelp: vi.fn(),
  openSettings: vi.fn(),
  toggleHistory: vi.fn(),
  togglePalette: vi.fn(),
  requestZoom: vi.fn(),
  setTool: vi.fn(),
  toggleSnapping: vi.fn(),
});

const run = (id: string, d: ShortcutDeps): void => {
  SHORTCUTS.find((s) => s.id === id)!.run(d);
};

describe('shortcut run behaviours', () => {
  it('play/pause toggles the transport flag', () => {
    const editor = fakeEditor(null);
    run('transport.playpause', deps(editor, { current: null }));
    expect(editor.setPlaying).toHaveBeenCalledWith(true);
  });

  it('copy stores the selected clip; paste places it from the clipboard', () => {
    const editor = fakeEditor('c1');
    const clipboard: Clipboard = { current: null };
    run('edit.copy', deps(editor, clipboard));
    expect(clipboard.current?.id).toBe('c1');

    run('edit.paste', deps(editor, clipboard));
    expect(editor.applyPatch).toHaveBeenCalledOnce();
  });

  it('paste does nothing with an empty clipboard', () => {
    const editor = fakeEditor('c1');
    run('edit.paste', deps(editor, { current: null }));
    expect(editor.applyPatch).not.toHaveBeenCalled();
  });

  it('marker-next seeks to the next marker after the playhead', () => {
    const editor = fakeEditor(null, 2); // markers [1,6] → next is 6
    run('marker.next', deps(editor, { current: null }));
    expect(editor.seek).toHaveBeenCalledWith(6);
  });

  it('duplicate dispatches an add_clip patch for the selection', () => {
    const editor = fakeEditor('c1');
    run('edit.duplicate', deps(editor, { current: null }));
    expect(editor.applyPatch).toHaveBeenCalledOnce();
  });

  it('zoom-to-fit asks the timeline to fit via requestZoom', () => {
    const editor = fakeEditor(null);
    const d = deps(editor, { current: null });
    run('view.zoomFit', d);
    expect(d.requestZoom).toHaveBeenCalledWith('fit');
  });

  // The op type a delete shortcut produced, read off the mocked applyPatch call.
  const dispatchedDeleteType = (editor: UseEditor): string =>
    (editor.applyPatch as ReturnType<typeof vi.fn>).mock.calls[0]![0].operations[0].type;

  describe('delete honours the Ripple toggle (and Shift inverts)', () => {
    it('Ripple OFF: Delete lifts, Shift+Delete ripples (today’s behaviour)', () => {
      const lift = fakeEditor('c1');
      run('edit.delete', { ...deps(lift, { current: null }), rippleOnDelete: false });
      expect(dispatchedDeleteType(lift)).toBe('delete_range');

      const rip = fakeEditor('c1');
      run('edit.ripple', { ...deps(rip, { current: null }), rippleOnDelete: false });
      expect(dispatchedDeleteType(rip)).toBe('ripple_delete');
    });

    it('Ripple ON: Delete ripples, Shift+Delete lifts (inverted)', () => {
      const rip = fakeEditor('c1');
      run('edit.delete', { ...deps(rip, { current: null }), rippleOnDelete: true });
      expect(dispatchedDeleteType(rip)).toBe('ripple_delete');

      const lift = fakeEditor('c1');
      run('edit.ripple', { ...deps(lift, { current: null }), rippleOnDelete: true });
      expect(dispatchedDeleteType(lift)).toBe('delete_range');
    });

    it('defaults to lift when rippleOnDelete is unset', () => {
      const editor = fakeEditor('c1');
      run('edit.delete', deps(editor, { current: null }));
      expect(dispatchedDeleteType(editor)).toBe('delete_range');
    });
  });

  it('every shortcut runs without throwing given a populated context', () => {
    // Exercises the delegating one-liners (trim in/out, nudge, nav, transport,
    // history, view) — each just builds a patch or calls a store action.
    for (const shortcut of SHORTCUTS) {
      const editor = fakeEditor('c1');
      const clipboard: Clipboard = { current: timeline.tracks[0]!.clips[0]! };
      expect(() => shortcut.run(deps(editor, clipboard))).not.toThrow();
    }
  });
});
