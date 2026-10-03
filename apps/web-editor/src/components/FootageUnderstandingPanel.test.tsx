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
import {
  ensureMediaUnderstanding,
  type FootageMap,
  type VisualIndexClient,
  type VisualStatusResponse,
} from '@framepilot/ai-sdk';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { FootageUnderstandingPanel } from './FootageUnderstandingPanel.js';

// The panel's two external seams: the sidecar fetch and the AI config slot.
const fetchFootageMap = vi.fn();
const ensureProjectMediaUnderstanding = vi.fn();
const fetchVisualStatus = vi.fn();
vi.mock('../editor/visualIndex.js', () => ({
  fetchFootageMap: (input: unknown) => fetchFootageMap(input),
  fetchVisualStatus: (input: unknown) => fetchVisualStatus(input),
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
  // The panel asks for assetTime, so these fixtures are the footage's own seconds.
  timeBase: 'asset',
  unplacedAssets: [],
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
  // An engine that predates `failures` (or an unreachable status read) is the baseline:
  // every older test below must render exactly as it did before status was read.
  fetchVisualStatus.mockReset();
  fetchVisualStatus.mockResolvedValue(undefined);
  ensureProjectMediaUnderstanding.mockReset();
  window.localStorage.clear();
});

/** The footage map for a clip the AI has not (successfully) read. */
const unreadMap: FootageMap = {
  available: true,
  timeBase: 'asset',
  unplacedAssets: [],
  backend: 'twelvelabs',
  reason: 'not_indexed',
  durationSec: 0,
  summary: '',
  chapters: [],
  highlights: [],
};

/** The engine's status with the given per-asset failures, as the sidecar reports it. */
const statusWith = (failures: VisualStatusResponse['failures']): VisualStatusResponse => ({
  available: true,
  backend: 'twelvelabs',
  counts: {},
  indexedAssets: 0,
  totalAssets: 1,
  failures,
  keyConfigured: false,
});

// The real engine sentences for a clip TwelveLabs refused, before and after the engine
// learned to word them. Both used to reach the editor as something else entirely.
const OLD_ENGINE_REFUSAL = 'TwelveLabs API error (HTTP 400) (video_filesize_too_large).';
const NEW_ENGINE_REFUSAL =
  "TwelveLabs can't index ro.mp4: the file is larger than TwelveLabs accepts.";
const NEXT_STEP =
  'Export a copy it can take (smaller, shorter, or a standard H.264 MP4), import that, and read it instead.';

/**
 * Run the REAL media-understanding runtime against a sidecar whose index job stops with
 * `reason`, so the panel renders exactly what the runtime makes of the engine's words.
 */
let runtimeProject = 0;
function realRuntimeFailingWith(reason: string): () => Promise<unknown> {
  const client = {
    status: async () => statusWith([]),
    index: async () => ({ available: true, jobId: 'j', cursor: 1, total: 1, done: false, reason }),
  } as unknown as VisualIndexClient;
  runtimeProject += 1;
  const projectId = `p_rt_${runtimeProject}`;
  return () => ensureMediaUnderstanding({ client, projectId, twelveLabsKey: 'k' });
}

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
      timeBase: 'asset' as const,
      unplacedAssets: [],
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
      timeBase: 'asset' as const,
      unplacedAssets: [],
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
      timeBase: 'asset' as const,
      unplacedAssets: [],
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
      timeBase: 'asset' as const,
      unplacedAssets: [],
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
    expect(screen.queryByText(/last try/i)).toBeNull();
  });

  it('names the clip whose last read failed, says why, and offers to try again', async () => {
    /* Regression: a clip TwelveLabs refused answered the footage map with `not_indexed`,
       so the panel said "hasn't watched this footage yet" and the failure was invisible. */
    fetchFootageMap.mockResolvedValue(unreadMap);
    fetchVisualStatus.mockResolvedValue(
      statusWith([{ assetId: 'vid', reason: OLD_ENGINE_REFUSAL }]),
    );
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    // The asset's own name, from its path…
    expect(await screen.findByText('clip.mp4')).toBeTruthy();
    // …the engine's reason as a sentence about the FILE, with what to do about it…
    expect(
      screen.getByText(`TwelveLabs can't index this file (video_filesize_too_large). ${NEXT_STEP}`),
    ).toBeTruthy();
    // …and never the "not read yet" line that hid it.
    expect(screen.queryByText(/hasn’t watched this footage yet/i)).toBeNull();
    expect(screen.queryByText(/can’t be found on disk/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Status is read alongside the map on open — once, not per render.
    expect(fetchVisualStatus).toHaveBeenCalledTimes(1);
  });

  it('re-reads the failures after a successful retry, and shows the map', async () => {
    fetchFootageMap.mockResolvedValue(unreadMap);
    fetchVisualStatus.mockResolvedValue(
      statusWith([{ assetId: 'vid', reason: NEW_ENGINE_REFUSAL }]),
    );
    ensureProjectMediaUnderstanding.mockResolvedValue({
      status: 'ready',
      backend: 'twelvelabs',
      cache: 'miss',
    });
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText(`${NEW_ENGINE_REFUSAL} ${NEXT_STEP}`)).toBeTruthy();

    // The clip was replaced with one TwelveLabs takes: the map exists and nothing failed.
    fetchVisualStatus.mockResolvedValue(statusWith([]));
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Intro')).toBeTruthy();
    expect(ensureProjectMediaUnderstanding).toHaveBeenCalledTimes(1);
    expect(fetchVisualStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/last try/i)).toBeNull();
  });

  it('does not repeat the next step when the engine sentence already gives it', async () => {
    const preflight =
      'ro.mp4 is 12.3 GB; TwelveLabs accepts files up to 4.0 GB. Export a smaller proxy to index it with TwelveLabs.';
    fetchFootageMap.mockResolvedValue(unreadMap);
    fetchVisualStatus.mockResolvedValue(statusWith([{ assetId: 'vid', reason: preflight }]));
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText(preflight)).toBeTruthy();
  });

  it('counts the clips when several failed, and names one the editor no longer has', async () => {
    fetchFootageMap.mockResolvedValue(unreadMap);
    fetchVisualStatus.mockResolvedValue(
      statusWith([
        { assetId: 'vid', reason: NEW_ENGINE_REFUSAL },
        { assetId: 'gone', reason: null },
      ]),
    );
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText('The last try couldn’t read 2 clips.')).toBeTruthy();
    expect(screen.getByText('gone')).toBeTruthy();
    expect(screen.getByText('Reading the footage stopped without saying why.')).toBeTruthy();
  });

  it('renders as before when the status read fails outright', async () => {
    fetchFootageMap.mockResolvedValue(unreadMap);
    fetchVisualStatus.mockRejectedValue(new Error('boom'));
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/hasn’t watched this footage yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Read this footage/i })).toBeTruthy();
  });

  it('does not show old failures over a map that has chapters', async () => {
    fetchFootageMap.mockResolvedValue(mapWithChapters);
    fetchVisualStatus.mockResolvedValue(
      statusWith([{ assetId: 'other', reason: NEW_ENGINE_REFUSAL }]),
    );
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText('Intro')).toBeTruthy();
    expect(screen.queryByText(/last try/i)).toBeNull();
  });

  it.each([
    [NEW_ENGINE_REFUSAL, NEW_ENGINE_REFUSAL],
    [OLD_ENGINE_REFUSAL, "TwelveLabs can't index this file (video_filesize_too_large)."],
  ])('a failed read shows the engine’s reason, not "still reading": %j', async (raw, shown) => {
    fetchFootageMap.mockResolvedValue(unreadMap);
    ensureProjectMediaUnderstanding.mockImplementation(realRuntimeFailingWith(raw));
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Read this footage/i }));
    // One sentence from the engine, then the next step: no "didn't finish:" prefix.
    expect(await screen.findByText(`${shown} ${NEXT_STEP}`)).toBeTruthy();
    expect(screen.queryByText(/Still reading this footage/i)).toBeNull();
    expect(screen.queryByText(/can’t be found on disk/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('surfaces an unreachable engine honestly', async () => {
    fetchFootageMap.mockResolvedValue(undefined);
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/Can’t reach the engine/i)).toBeTruthy();
  });

  it('is modal in fact and now says so: focus is trapped and Tab cannot leave it', () => {
    render(
      <FootageUnderstandingPanel editor={fakeEditor()} project={project} open onClose={vi.fn()} />,
    );
    const panel = screen.getByRole('dialog', { name: 'Footage understanding' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    // The panel dims the app behind it, but focus used to stay outside it and Tab
    // walked straight out onto the controls the backdrop is covering.
    expect(panel.contains(document.activeElement)).toBe(true);

    const focusable = panel.querySelectorAll<HTMLElement>('button, a[href], input, select');
    focusable[focusable.length - 1]!.focus();
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});
