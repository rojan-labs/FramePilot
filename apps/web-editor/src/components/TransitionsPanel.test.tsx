/**
 * The transitions panel, and the browsing state behind it.
 *
 * WebGL does not exist in jsdom, so the hover shader never runs here — which is
 * fine, because what these tests are for is the part a screenshot cannot check:
 * that the right transition lands on the right cut, that shelves persist, and
 * that an empty view says something the user can act on.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { TransitionsPanel } from './TransitionsPanel.js';
import { TRANSITION_LIBRARY_STORAGE_KEYS } from './useTransitionLibrary.js';
import { useEditor, type UseEditor } from '../editor/useEditor.js';

const timeline = (): Timeline => ({
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'a',
          assetId: 'a1',
          trackId: 'v1',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
        {
          id: 'b',
          assetId: 'a1',
          trackId: 'v1',
          start: 4,
          end: 8,
          sourceStart: 4,
          sourceEnd: 8,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
});

/**
 * Mount the panel against a real editor store, exposing the store so a test can
 * assert what a click actually committed.
 *
 * The store lives INSIDE the rendered tree (rather than beside it in a
 * `renderHook`) so a patch re-renders the panel the way it does in the app.
 */
function mountPanel(source: Timeline = timeline()): {
  latest: () => UseEditor;
  unmount: () => void;
} {
  let latest!: UseEditor;
  function Host(): JSX.Element {
    const editor = useEditor(source);
    latest = editor;
    return <TransitionsPanel editor={editor} />;
  }
  const view = render(<Host />);
  return { latest: () => latest, unmount: view.unmount };
}

const transitionOn = (editor: UseEditor, clipId: string) =>
  editor.state.timeline.tracks[0]!.clips.find((c) => c.id === clipId)!.effects.find(
    (e) => e.type === 'transition',
  );

beforeEach(() => {
  for (const key of TRANSITION_LIBRARY_STORAGE_KEYS) localStorage.removeItem(key);
});

describe('TransitionsPanel', () => {
  it('lists the whole catalog', () => {
    const { unmount } = mountPanel();
    const grid = screen.getByRole('list', { name: 'transitions' });
    expect(within(grid).getAllByRole('listitem').length).toBeGreaterThanOrEqual(50);
    unmount();
  });

  it('says which cut a click will land on', () => {
    const { unmount } = mountPanel();
    expect(screen.getByRole('status').textContent).toContain('the cut before');
    unmount();
  });

  it('applies a transition to the resolved cut', () => {
    const panel = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Glitch\./ }));
    expect(transitionOn(panel.latest(), 'b')?.params.kind).toBe('glitch');
    panel.unmount();
  });

  it('uses the entry’s own default duration, not one global number', () => {
    // A whip pan wants 0.28s and a soft dissolve wants 1.2s; a single default
    // would be wrong for both, and the catalog is where that judgement lives.
    const panel = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Whip Pan Left\./ }));
    expect(Number(transitionOn(panel.latest(), 'b')?.params.durationSeconds)).toBeCloseTo(0.28);
    panel.unmount();
  });

  it('removes the transition when the hard cut is chosen', () => {
    const panel = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Glitch\./ }));
    expect(transitionOn(panel.latest(), 'b')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^Cut\./ }));
    expect(transitionOn(panel.latest(), 'b')).toBeUndefined();
    panel.unmount();
  });

  it('searches by direction, by feel and by name', () => {
    const { unmount } = mountPanel();
    const search = screen.getByRole('searchbox', { name: 'search transitions' });
    fireEvent.change(search, { target: { value: 'left' } });
    const grid = screen.getByRole('list', { name: 'transitions' });
    const labels = within(grid)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(labels.some((l) => l.includes('Push Left'))).toBe(true);
    expect(labels.some((l) => l.includes('Whip Pan Left'))).toBe(true);
    expect(labels.some((l) => l.includes('Cross Dissolve'))).toBe(false);
    unmount();
  });

  it('offers an actionable empty state rather than a blank grid', () => {
    const { unmount } = mountPanel();
    fireEvent.change(screen.getByRole('searchbox', { name: 'search transitions' }), {
      target: { value: 'zzzznope' },
    });
    expect(screen.getByText(/Try a direction/)).toBeTruthy();
    unmount();
  });

  it('keeps favourites across a remount', () => {
    const first = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add Glitch to favourites' }));
    first.unmount();

    const second = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Favourites/ }));
    const grid = screen.getByRole('list', { name: 'transitions' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(1);
    expect(grid.textContent).toContain('Glitch');
    second.unmount();
  });

  it('collects what was applied on the recents shelf, newest first', () => {
    const panel = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Glitch\./ }));
    fireEvent.click(screen.getByRole('button', { name: /^Ripple\./ }));
    fireEvent.click(screen.getByRole('button', { name: /^Recently used/ }));
    const items = within(screen.getByRole('list', { name: 'transitions' })).getAllByRole(
      'listitem',
    );
    expect(items[0]?.textContent).toContain('Ripple');
    expect(items[1]?.textContent).toContain('Glitch');
    panel.unmount();
  });

  it('tells the user how to fill an empty shelf', () => {
    const { unmount } = mountPanel();
    fireEvent.click(screen.getByRole('button', { name: /^My presets/ }));
    expect(screen.getByText(/Save as preset/)).toBeTruthy();
    unmount();
  });

  it('carries the transition id on a drag, not a serialized transition', () => {
    // The timeline resolves the id through the same builder every other route
    // uses; carrying a built effect instead would be a second mutation path.
    const { unmount } = mountPanel();
    const data = new Map<string, string>();
    fireEvent.dragStart(screen.getByRole('button', { name: /^Glitch\./ }), {
      dataTransfer: {
        setData: (type: string, value: string) => data.set(type, value),
        get effectAllowed() {
          return 'copy';
        },
        set effectAllowed(_v: string) {
          /* written by the handler */
        },
      },
    });
    expect(data.get('application/x-framepilot-transition')).toBe('glitch');
    unmount();
  });

  it('refuses to promise a transition when there is no cut', () => {
    const { unmount } = mountPanel({ tracks: [{ id: 'v1', type: 'video', clips: [] }] });
    expect(screen.getByRole('status').textContent).toContain('put two clips end to end');
    unmount();
  });
});
