/**
 * Tests for the Footage understanding panel (plan FI5.1).
 *
 * Focus on the behavior the recent fix hardened: a normal open reads the engine's
 * cache (refresh:false — never re-bills), the "Rebuild" action forces refresh:true,
 * chapters render + seek on click, the playhead-driven active chapter is marked, and
 * an honest `not_indexed` map renders its coverage message rather than a fake map.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FootageMap } from '@framepilot/ai-sdk';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { FootageUnderstandingPanel } from './FootageUnderstandingPanel.js';

// The panel's two external seams: the sidecar fetch and the AI config slot.
const fetchFootageMap = vi.fn();
const ensureProjectMediaUnderstanding = vi.fn();
vi.mock('../editor/visualIndex.js', () => ({
  fetchFootageMap: (input: unknown) => fetchFootageMap(input),
  ensureProjectMediaUnderstanding: (input: unknown) => ensureProjectMediaUnderstanding(input),
}));
// A STABLE config ref (the real hook memoizes) — a fresh object each render would
// change `load`'s identity and spin the open-effect forever.
const stableConfig = { config: { twelveLabs: 'tl-key' } };
vi.mock('../editor/useAiConfig.js', () => ({
  useAiConfig: () => stableConfig,
}));

// The asset `vid` is placed 1:1 at timeline [0,30] so source time == timeline time,
// which lets a placed chapter seek and the active-chapter projection resolve.
const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'vid',
          trackId: 'v',
          start: 0,
          end: 30,
          sourceStart: 0,
          sourceEnd: 30,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const assets = [{ id: 'vid', path: '/media/clip.mp4', kind: 'video', durationSeconds: 30 }];

const project = {
  id: 'p1',
  name: 'Demo',
  timeline,
  assets,
  transcript: [],
} as unknown as Project;

/** A minimal editor whose playhead we can move to drive the active-chapter highlight. */
function fakeEditor(): UseEditor & { setPlayhead: (t: number) => void } {
  let playhead = 0;
  const listeners = new Set<() => void>();
  return {
    state: { timeline, assets } as never,
    seek: vi.fn(),
    getPlayhead: () => playhead,
    subscribePlayhead: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setPlayhead: (t: number) => {
      playhead = t;
      for (const l of listeners) l();
    },
  } as unknown as UseEditor & { setPlayhead: (t: number) => void };
}

// Asset-native (source-time) chapters tagged with their owning asset.
const mapWithChapters: FootageMap = {
  available: true,
  backend: 'twelvelabs',
  durationSec: 30,
  summary: 'A short demo of the product.',
  chapters: [
    { t0: 0, t1: 10, title: 'Intro', summary: 'setup', assetId: 'vid' },
    { t0: 10, t1: 30, title: 'Reveal', summary: 'payoff', assetId: 'vid' },
  ],
  highlights: [{ t0: 12, t1: 13, label: 'the punchline', score: 0.9, assetId: 'vid' }],
};

beforeEach(() => {
  fetchFootageMap.mockReset();
  window.localStorage.clear();
});

describe('FootageUnderstandingPanel', () => {
  it('reads the cache on open (refresh:false) and renders chapters + highlights', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    const editor = fakeEditor();
    render(<FootageUnderstandingPanel editor={editor} project={project} open onClose={vi.fn()} />);

    expect(await screen.findByText('Intro')).toBeTruthy();
    expect(screen.getByText('Reveal')).toBeTruthy();
    expect(screen.getByText('the punchline')).toBeTruthy();
    // A normal open must NOT force a refresh (that re-bills the API) and must ask for
    // asset-native times so the map reflects the footage, not the current edit.
    expect(fetchFootageMap).toHaveBeenCalledTimes(1);
    expect(fetchFootageMap.mock.calls[0]?.[0]).toMatchObject({ refresh: false, assetTime: true });
  });

  it('shows the footage structure but disables seeking when the asset is unplaced', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    const editor = fakeEditor();
    // Empty timeline: nothing placed, so chapters render (structure) but cannot seek.
    (editor.state as { timeline: Timeline }).timeline = { tracks: [] };
    render(<FootageUnderstandingPanel editor={editor} project={project} open onClose={vi.fn()} />);
    const intro = await screen.findByText('Intro');
    const introButton = intro.closest('button');
    expect(introButton?.getAttribute('data-unplaced')).toBe('true');
    expect((introButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(intro);
    expect(editor.seek).not.toHaveBeenCalled();
  });

  it('seeks to a chapter start when a chapter is clicked', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    const editor = fakeEditor();
    render(<FootageUnderstandingPanel editor={editor} project={project} open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('Reveal'));
    expect(editor.seek).toHaveBeenCalledWith(10);
  });

  it('marks the chapter under the playhead as active', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    const editor = fakeEditor();
    render(<FootageUnderstandingPanel editor={editor} project={project} open onClose={vi.fn()} />);
    const intro = await screen.findByText('Intro');
    const introButton = intro.closest('button');
    expect(introButton?.getAttribute('data-active')).toBe('true');

    // Move the playhead into the second chapter — the active row follows.
    act(() => editor.setPlayhead(15));
    await waitFor(() => {
      expect(screen.getByText('Reveal').closest('button')?.getAttribute('data-active')).toBe(
        'true',
      );
    });
    expect(intro.closest('button')?.getAttribute('data-active')).toBeNull();
  });

  it('forces a refresh only when Rebuild is pressed', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    const editor = fakeEditor();
    render(<FootageUnderstandingPanel editor={editor} project={project} open onClose={vi.fn()} />);
    await screen.findByText('Intro');
    fireEvent.click(screen.getByRole('button', { name: /Rebuild the footage map/ }));
    await waitFor(() => expect(fetchFootageMap).toHaveBeenCalledTimes(2));
    expect(fetchFootageMap.mock.calls[1]?.[0]).toMatchObject({ refresh: true });
  });

  it('teaches with info cards on first open, then remembers the dismissal', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    const { unmount } = render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    // The teaching deck is present for a first-time editor (no dismissal stored yet).
    expect(
      await screen.findByText('Highlights', { selector: '.understanding-learn-title' }),
    ).toBeTruthy();

    // Dismissing it persists the choice (the deck then animates out via AnimatePresence).
    fireEvent.click(screen.getByRole('button', { name: /Dismiss the guide/i }));
    await waitFor(() =>
      expect(window.localStorage.getItem('fp:understanding:learn-dismissed')).toBe('1'),
    );
    unmount();

    // …so reopening a returning editor's panel does not teach again.
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    await screen.findByText('Intro');
    expect(screen.queryByText('Highlights', { selector: '.understanding-learn-title' })).toBeNull();
    // The guide toggle brings the deck back on demand.
    fireEvent.click(screen.getByRole('button', { name: /Show the guide/i }));
    expect(
      await screen.findByText('Highlights', { selector: '.understanding-learn-title' }),
    ).toBeTruthy();
  });

  it('offers to read unread footage instead of a dead end, and shows the map after', async () => {
    /* Regression: unread footage used to say "index it in the media bin", where no such
       action exists, and Rebuild only re-fetched a map that could never appear. */
    const unread: FootageMap = {
      available: true,
      backend: 'twelvelabs',
      reason: 'not_indexed',
      durationSec: 0,
      summary: '',
      chapters: [],
      highlights: [],
    };
    fetchFootageMap.mockResolvedValue(unread);
    ensureProjectMediaUnderstanding.mockImplementation(
      async (input: { onEvent?: (e: unknown) => void }) => {
        input.onEvent?.({ type: 'progress', backend: 'twelvelabs', message: 'Preparing (1/2).' });
        return { status: 'ready', backend: 'twelvelabs', cache: 'miss' };
      },
    );
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    const read = await screen.findByRole('button', { name: /Read this footage/i });

    // Once the footage IS read, the same fetch returns a real map.
    fetchFootageMap.mockResolvedValue({
      available: true,
      backend: 'twelvelabs',
      reason: null,
      durationSec: 30,
      summary: 'A demo.',
      chapters: [{ t0: 0, t1: 10, title: 'Intro', summary: 'setup', assetId: 'vid' }],
      highlights: [],
    } satisfies FootageMap);
    fireEvent.click(read);
    expect(await screen.findByText('Intro')).toBeTruthy();
    expect(ensureProjectMediaUnderstanding).toHaveBeenCalledTimes(1);
  });

  it('reports honestly when reading the footage fails, and offers a retry', async () => {
    fetchFootageMap.mockResolvedValue({
      available: true,
      backend: 'twelvelabs',
      reason: 'not_indexed',
      durationSec: 0,
      summary: '',
      chapters: [],
      highlights: [],
    } satisfies FootageMap);
    ensureProjectMediaUnderstanding.mockResolvedValue({
      status: 'unavailable',
      backend: 'twelvelabs',
      reason: 'invalid_api_key',
      message: 'nope',
    });
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Read this footage/i }));
    expect(await screen.findByText(/key was rejected/i)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Try again/i })).toBeTruthy();
  });

  it('renders the honest coverage message for a not_indexed map', async () => {
    fetchFootageMap.mockResolvedValue({
      available: true,
      backend: 'twelvelabs',
      reason: 'not_indexed',
      durationSec: 0,
      summary: '',
      chapters: [],
      highlights: [],
    } satisfies FootageMap);
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/hasn’t watched this footage yet/i)).toBeTruthy();
  });

  it('surfaces an unreachable engine honestly', async () => {
    fetchFootageMap.mockResolvedValue(undefined);
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/Can’t reach the engine/i)).toBeTruthy();
  });
});
