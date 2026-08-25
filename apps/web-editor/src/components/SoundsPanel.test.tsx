/**
 * SoundsPanel — one test per row of the state matrix in
 * `plan/3rd-party-sourcing/CONTRACTS.md` §5, plus keyboard and the live region.
 *
 * Note the naming trap this file has to respect: Playwright's `getByRole(name)`
 * substring-matches by default while RTL matches exactly, so an `aria-label`
 * that passes here can still break the e2e spec. Labels are checked in both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Project } from '@framepilot/timeline-schema';
import type { MusicDownloadProgressWire, MusicTrackWire } from '@framepilot/shared-types';
import { SoundsPanel, formatDuration, musicAssetId } from './SoundsPanel.js';
import { resetDownloadRegistriesForTests } from '../editor/download-registry.js';

const bridgeCalls = vi.hoisted(() => ({
  search: vi.fn(),
  preview: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  desktop: vi.fn(() => true),
  progressListeners: [] as Array<(m: MusicDownloadProgressWire) => void>,
}));

vi.mock('../editor/bridge.js', () => ({
  isDesktop: () => bridgeCalls.desktop(),
  musicSearch: (...args: unknown[]) => bridgeCalls.search(...args),
  musicPreview: (...args: unknown[]) => bridgeCalls.preview(...args),
  musicDownload: (...args: unknown[]) => bridgeCalls.download(...args),
  musicDownloadCancel: (...args: unknown[]) => bridgeCalls.cancel(...args),
  onMusicDownloadProgress: (listener: (m: MusicDownloadProgressWire) => void) => {
    bridgeCalls.progressListeners.push(listener);
    return () => {
      bridgeCalls.progressListeners = bridgeCalls.progressListeners.filter((l) => l !== listener);
    };
  },
  // The download registry module imports both provider feeds; only the music one
  // is exercised here, but the named export has to exist for the import to bind.
  onStockDownloadProgress: () => () => {},
}));

function wireTrack(overrides: Partial<MusicTrackWire> = {}): MusicTrackWire {
  return {
    remoteId: 'ov-1',
    provider: 'openverse',
    title: 'Calm Bed',
    durationSeconds: 92,
    format: 'mp3',
    license: 'by',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attributionRequired: true,
    commercialUse: true,
    attribution: '"Calm Bed" by Ada is licensed under CC BY 4.0.',
    creator: 'Ada',
    ...overrides,
  };
}

const emptyProject = {
  id: 'p1',
  name: 'P',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  folders: [],
  timeline: { tracks: [] },
  transcript: [],
  markers: [],
  angleGroups: [],
  aiMemory: {},
  history: [],
} as unknown as Project;

function renderPanel(project: Project = emptyProject): {
  onAddMusic: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const onAddMusic = vi.fn();
  const { unmount } = render(<SoundsPanel project={project} onAddMusic={onAddMusic} />);
  return { onAddMusic, unmount };
}

/**
 * jsdom implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`, so
 * they are installed rather than spied on. `afterEach` puts back what was there.
 */
let objectUrlOriginals: Partial<typeof URL> | null = null;
function stubObjectUrls(): {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  const createObjectURL = vi.fn(() => 'blob:preview');
  const revokeObjectURL = vi.fn();
  objectUrlOriginals = {
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

/** Type a query and let the 300 ms debounce elapse. */
async function typeQuery(text: string): Promise<void> {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });
}

describe('SoundsPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridgeCalls.desktop.mockReturnValue(true);
    // Every mount now browses, so the bridge must answer from the first render.
    // Individual tests override this with the tracks they care about.
    bridgeCalls.search.mockReset().mockResolvedValue({ ok: true, tracks: [] });
    bridgeCalls.preview.mockReset();
    bridgeCalls.download.mockReset();
    bridgeCalls.cancel.mockReset();
    bridgeCalls.progressListeners = [];
    // The registry is a module singleton by design — it has to outlive the
    // panel. That makes it shared state between tests, so it is cleared here.
    resetDownloadRegistriesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (objectUrlOriginals !== null) {
      Object.assign(URL, objectUrlOriginals);
      objectUrlOriginals = null;
    }
  });

  // -------------------------------------------------------------------------
  // Default, loading, results, empty
  // -------------------------------------------------------------------------

  it('browses the catalogue on mount instead of showing an empty panel', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    renderPanel();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    // The empty box IS the browse — no words, fired immediately, no debounce.
    expect(bridgeCalls.search).toHaveBeenCalledWith('');
    // Labelled for a screen reader, not with a line of prose above the list:
    // the panel is a sidebar, and the tracks are what it is for.
    expect(screen.getByRole('list', { name: 'Openly licensed music' })).toBeDefined();
    expect(document.querySelectorAll('.sounds-hint')).toHaveLength(0);
  });

  it('does not search until the user stops typing', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ca' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calm' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    // One request for the settled text, not one per keystroke. The mount browse
    // is not among them either: typing before it fired retired it, exactly as a
    // superseded search is retired.
    expect(bridgeCalls.search.mock.calls).toEqual([['calm']]);
  });

  it('renders skeleton rows while the first search is in flight', async () => {
    bridgeCalls.search.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calm' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // Skeletons carry the real row class, so their height matches a result and
    // nothing shifts when the list lands.
    const list = screen.getByRole('list');
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(list.querySelectorAll('.sounds-row--skeleton').length).toBeGreaterThan(0);
  });

  it('lists results with title, duration and licence', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    renderPanel();
    await typeQuery('calm');

    expect(screen.getByText('Calm Bed')).toBeDefined();
    expect(screen.getByText('1:32')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Credit required · Ada' })).toBeDefined();
  });

  it('announces the result count politely', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack(), wireTrack({ remoteId: 'ov-2' })],
    });
    const { container } = render(<SoundsPanel project={emptyProject} onAddMusic={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calm' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('2 tracks found');
  });

  it('says which query matched nothing and suggests broadening', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [] });
    renderPanel();
    await typeQuery('zzzz');
    expect(screen.getByText(/No tracks matched/)).toBeDefined();
    expect(screen.getByText(/zzzz/)).toBeDefined();
  });

  it('dims previous results while re-searching instead of clearing them', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    renderPanel();
    await typeQuery('calm');
    expect(screen.getByText('Calm Bed')).toBeDefined();

    bridgeCalls.search.mockReturnValue(new Promise(() => undefined));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calmer' } });
    // The old rows are still on screen — a list that blanks on every keystroke
    // makes the panel feel broken while it works.
    expect(screen.getByText('Calm Bed')).toBeDefined();
    expect(screen.getByRole('list').className).toContain('is-stale');
  });

  // -------------------------------------------------------------------------
  // Licence labelling
  // -------------------------------------------------------------------------

  it('labels a CC0 row too — silence would read as "unknown"', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack({ attributionRequired: false, license: 'cc0', creator: undefined })],
    });
    renderPanel();
    await typeQuery('calm');
    expect(screen.getByRole('link', { name: 'No credit needed' })).toBeDefined();
  });

  it('links a licence badge to its terms without letting the page reach back', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    renderPanel();
    await typeQuery('calm');
    const link = screen.getByRole('link', { name: 'Credit required · Ada' });
    expect(link.getAttribute('href')).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('still labels a row whose provider supplied no licence URL', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack({ licenseUrl: undefined })],
    });
    renderPanel();
    await typeQuery('calm');
    expect(screen.getByText('Credit required · Ada')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  it.each([
    ['offline', 'No network connection.'],
    ['rate_limited', 'Too many searches in a row. Try again in a moment.'],
    ['provider_unavailable', 'The music provider is not responding. Try again shortly.'],
    ['timeout', 'The music provider took too long to answer.'],
  ] as const)('shows the specific sentence for %s', async (error, sentence) => {
    bridgeCalls.search.mockResolvedValue({ ok: false, error });
    renderPanel();
    await typeQuery('calm');
    expect(screen.getByRole('alert').textContent).toBe(sentence);
  });

  it('shows nothing at all when a search is cancelled by a newer one', async () => {
    // The user typed another letter. Telling them so would be noise.
    bridgeCalls.search.mockResolvedValue({ ok: false, error: 'cancelled' });
    renderPanel();
    await typeQuery('calm');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Audition
  // -------------------------------------------------------------------------

  it('puts the spinner on the row that is loading, not the whole list', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack(), wireTrack({ remoteId: 'ov-2', title: 'Second' })],
    });
    bridgeCalls.preview.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Play Calm Bed' }));
    await act(async () => Promise.resolve());
    // The other row stays fully interactive throughout.
    expect(
      (screen.getByRole('button', { name: 'Play Second' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole('list').getAttribute('aria-busy')).not.toBe('true');
  });

  it('reports a preview failure on that row and leaves the list usable', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack(), wireTrack({ remoteId: 'ov-2', title: 'Second' })],
    });
    bridgeCalls.preview.mockResolvedValue({ ok: false, error: 'offline' });
    renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Play Calm Bed' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('No network connection.'),
    );
    expect(screen.getByRole('button', { name: 'Play Second' })).toBeDefined();
  });

  it('lets only the newest audition reach the speakers when two previews race', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack(), wireTrack({ remoteId: 'ov-2', title: 'Second' })],
    });
    let resolveFirst: (value: unknown) => void = () => undefined;
    let resolveSecond: (value: unknown) => void = () => undefined;
    bridgeCalls.preview
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();

    renderPanel();
    await typeQuery('calm');
    fireEvent.click(screen.getByRole('button', { name: 'Play Calm Bed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play Second' }));

    // The abandoned first preview lands LAST — the order the clicks did not ask
    // for, and the one a network makes routine.
    await act(async () => {
      resolveSecond({ ok: true, contentType: 'audio/mpeg', data: new ArrayBuffer(4) });
      await Promise.resolve();
      resolveFirst({ ok: true, contentType: 'audio/mpeg', data: new ArrayBuffer(4) });
      await Promise.resolve();
    });

    // One blob and one `play()`. Without the generation guard the straggler
    // created a second blob over the ref — leaking the live one for the life of
    // the document — and played on top of it, unreachable by the next stop.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Stop Second' })).toBeDefined();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  it('adds the downloaded track with its provenance intact', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockResolvedValue({
      ok: true,
      asset: {
        relativePath: 'media/p1/Calm_Bed.mp3',
        kind: 'audio',
        durationSeconds: 92,
        media: null,
        deduped: false,
        source: {
          provider: 'openverse',
          remoteId: 'ov-1',
          license: 'by',
          attributionRequired: true,
          attribution: '"Calm Bed" by Ada is licensed under CC BY 4.0.',
          creator: 'Ada',
          fetchedAt: '2026-08-23T12:00:00.000Z',
        },
      },
    });
    const { onAddMusic } = renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAddMusic).toHaveBeenCalledTimes(1));
    // This is the D2 obligation becoming durable — without it the Credits view
    // is empty and the feature is unsafe, not merely incomplete.
    expect(onAddMusic.mock.calls[0]?.[0]).toMatchObject({
      path: 'media/p1/Calm_Bed.mp3',
      kind: 'audio',
      source: { attributionRequired: true, creator: 'Ada' },
    });
  });

  it('shows determinate progress and a cancel control while downloading', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => Promise.resolve());

    act(() => {
      for (const listener of bridgeCalls.progressListeners) {
        listener({
          operationId: 'x',
          remoteId: 'ov-1',
          phase: 'downloading',
          completedBytes: 50,
          totalBytes: 100,
        });
      }
    });

    const bar = screen.getByRole('progressbar', { name: 'Downloading Calm Bed' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByRole('button', { name: 'Cancel downloading Calm Bed' })).toBeDefined();
  });

  it('returns the row to idle with no error text after a cancel', async () => {
    // The user cancelled on purpose; an error would be a lie about what happened.
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockResolvedValue({ ok: false, error: 'cancelled' });
    renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeDefined());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a download alive, with its progress and Cancel, across a tab switch', async () => {
    // The Sounds tab unmounts when the user switches tabs — which is exactly
    // what someone does after queuing a download. Before the registry, coming
    // back showed an idle row while the bytes were still arriving in main.
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => Promise.resolve());
    unmount();

    // Progress that arrives while the panel is away is still recorded.
    act(() => {
      for (const listener of bridgeCalls.progressListeners) {
        listener({
          operationId: 'x',
          remoteId: 'ov-1',
          phase: 'downloading',
          completedBytes: 70,
          totalBytes: 100,
        });
      }
    });

    renderPanel();
    await typeQuery('calm');
    const bar = screen.getByRole('progressbar', { name: 'Downloading Calm Bed' });
    expect(bar.getAttribute('aria-valuenow')).toBe('70');
    expect(screen.getByRole('button', { name: 'Cancel downloading Calm Bed' })).toBeDefined();
  });

  it('refuses to start a second download of a track already in flight', async () => {
    // The row's own Enter shortcut can reach `add` while the progress bar is up,
    // and two downloads would fight over the same destination file.
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await typeQuery('calm');

    const row = screen.getAllByRole('listitem')[0] as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    await act(async () => Promise.resolve());
    fireEvent.keyDown(row, { key: 'Enter' });
    await act(async () => Promise.resolve());

    expect(bridgeCalls.download).toHaveBeenCalledTimes(1);
  });

  it('offers Retry with the reason after a failed download', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockResolvedValue({ ok: false, error: 'disk_full' });
    renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Not enough disk space to save this track.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('states plainly when a non-commercial track is refused', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockResolvedValue({ ok: false, error: 'non_commercial_only' });
    renderPanel();
    await typeQuery('calm');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain("can't be used in monetized videos"),
    );
  });

  it('marks a track already in the project instead of offering Add again', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    const withTrack = {
      ...emptyProject,
      assets: [
        {
          id: 'music_openverse_ov_1',
          path: 'media/p1/Calm_Bed.mp3',
          kind: 'audio',
          source: {
            provider: 'openverse',
            remoteId: 'ov-1',
            license: 'by',
            attributionRequired: true,
            fetchedAt: '2026-08-23T12:00:00.000Z',
          },
        },
      ],
    } as unknown as Project;

    renderPanel(withTrack);
    await typeQuery('calm');

    expect(screen.getByText('In this project')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  it('is one tab stop, with arrows moving between rows', async () => {
    bridgeCalls.search.mockResolvedValue({
      ok: true,
      tracks: [wireTrack(), wireTrack({ remoteId: 'ov-2', title: 'Second' })],
    });
    const { container } = render(<SoundsPanel project={emptyProject} onAddMusic={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calm' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.sounds-row'));
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);

    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
  });

  it('adds on Enter and auditions on Space', async () => {
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockResolvedValue({ ok: false, error: 'cancelled' });
    bridgeCalls.preview.mockResolvedValue({ ok: false, error: 'offline' });
    const { container } = render(<SoundsPanel project={emptyProject} onAddMusic={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calm' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    const row = container.querySelector<HTMLElement>('.sounds-row')!;
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(bridgeCalls.download).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(row, { key: ' ' });
    await waitFor(() => expect(bridgeCalls.preview).toHaveBeenCalledTimes(1));
  });

  it('leaves Enter to the control that has focus inside the row', async () => {
    // The row's own Enter handler used to fire regardless of what was focused,
    // so Enter on Cancel started a SECOND download of the track the user was
    // trying to stop, and Enter on the licence link was swallowed.
    bridgeCalls.search.mockResolvedValue({ ok: true, tracks: [wireTrack()] });
    bridgeCalls.download.mockImplementation(() => new Promise(() => undefined));
    render(<SoundsPanel project={emptyProject} onAddMusic={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'calm' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(bridgeCalls.download).toHaveBeenCalledTimes(1));

    const cancel = screen.getByRole('button', { name: /cancel/i });
    fireEvent.keyDown(cancel, { key: 'Enter', bubbles: true });
    expect(bridgeCalls.download).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Browser build
  // -------------------------------------------------------------------------

  it('explains why it cannot work in the browser instead of showing a dead input', () => {
    bridgeCalls.desktop.mockReturnValue(false);
    renderPanel();
    expect(screen.getByRole('note').textContent).toContain('desktop');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('renders minutes and zero-padded seconds', () => {
    expect(formatDuration(92)).toBe('1:32');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(0)).toBe('0:00');
  });

  it('never renders a negative time', () => {
    expect(formatDuration(-3)).toBe('0:00');
  });
});

describe('musicAssetId', () => {
  it('is stable and filesystem-safe for the same provider track', () => {
    expect(musicAssetId(wireTrack())).toBe('music_openverse_ov_1');
    expect(musicAssetId(wireTrack())).toBe(musicAssetId(wireTrack()));
  });
});
