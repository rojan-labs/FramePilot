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

function renderPanel(project: Project = emptyProject): { onAddMusic: ReturnType<typeof vi.fn> } {
  const onAddMusic = vi.fn();
  render(<SoundsPanel project={project} onAddMusic={onAddMusic} />);
  return { onAddMusic };
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
    bridgeCalls.search.mockReset();
    bridgeCalls.preview.mockReset();
    bridgeCalls.download.mockReset();
    bridgeCalls.cancel.mockReset();
    bridgeCalls.progressListeners = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Default, loading, results, empty
  // -------------------------------------------------------------------------

  it('shows a prompt describing what to search for, with no spinner', () => {
    renderPanel();
    expect(screen.getByText(/Search by mood or instrument/)).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
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
    // One request for the settled text, not one per keystroke.
    expect(bridgeCalls.search).toHaveBeenCalledTimes(1);
    expect(bridgeCalls.search).toHaveBeenCalledWith('calm');
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
