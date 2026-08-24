/**
 * StockPanel — one test per row of the state matrix in
 * `plan/3rd-party-sourcing/photo-video/CONTRACTS.md` §5, plus the hover-scrub
 * behaviour, keyboard navigation, and the live region.
 *
 * Note the naming trap this file has to respect: Playwright's `getByRole(name)`
 * substring-matches by default while RTL matches exactly, so an `aria-label`
 * that passes here can still break the e2e spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Project } from '@framepilot/timeline-schema';
import type {
  StockDownloadProgressWire,
  StockItemWire,
  StockQuotaSnapshot,
} from '@framepilot/shared-types';
import {
  StockPanel,
  formatBytes,
  formatClipLength,
  stockAssetId,
  stockErrorText,
  tileVariant,
} from './StockPanel.js';

const bridge = vi.hoisted(() => ({
  search: vi.fn(),
  thumbnail: vi.fn(),
  preview: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  quota: vi.fn(),
  desktop: vi.fn(() => true),
  progressListeners: [] as Array<(m: StockDownloadProgressWire) => void>,
  quotaListeners: [] as Array<(q: StockQuotaSnapshot) => void>,
}));

vi.mock('../editor/bridge.js', () => ({
  isDesktop: () => bridge.desktop(),
  stockSearch: (...args: unknown[]) => bridge.search(...args),
  stockThumbnail: (...args: unknown[]) => bridge.thumbnail(...args),
  stockPreview: (...args: unknown[]) => bridge.preview(...args),
  stockDownload: (...args: unknown[]) => bridge.download(...args),
  stockDownloadCancel: (...args: unknown[]) => bridge.cancel(...args),
  stockQuota: () => bridge.quota(),
  onStockDownloadProgress: (listener: (m: StockDownloadProgressWire) => void) => {
    bridge.progressListeners.push(listener);
    return () => {
      bridge.progressListeners = bridge.progressListeners.filter((l) => l !== listener);
    };
  },
  onStockQuotaChanged: (listener: (q: StockQuotaSnapshot) => void) => {
    bridge.quotaListeners.push(listener);
    return () => {
      bridge.quotaListeners = bridge.quotaListeners.filter((l) => l !== listener);
    };
  },
}));

function wireItem(overrides: Partial<StockItemWire> = {}): StockItemWire {
  return {
    remoteId: '3129671',
    provider: 'pexels',
    kind: 'video',
    title: 'City skyline at dusk',
    width: 3840,
    height: 2160,
    durationSeconds: 12,
    avgColor: '#6a8fbf',
    hasPreview: true,
    variants: [
      {
        id: 'hd',
        width: 1920,
        height: 1080,
        fps: 25,
        contentType: 'video/mp4',
        format: 'mp4',
        approxBytes: 24_000_000,
      },
      { id: 'uhd', width: 3840, height: 2160, fps: 25, contentType: 'video/mp4', format: 'mp4' },
    ],
    license: 'pexels',
    licenseUrl: 'https://www.pexels.com/license/',
    attributionRequired: false,
    attribution: 'Video by Ruvim on Pexels',
    creator: 'Ruvim',
    creatorUrl: 'https://www.pexels.com/@digitech',
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

function renderPanel(
  options: { project?: Project; blocked?: string | null; onOpenSettings?: () => void } = {},
): { onAddStock: ReturnType<typeof vi.fn> } {
  const onAddStock = vi.fn().mockReturnValue(null);
  render(
    <StockPanel
      project={options.project ?? emptyProject}
      placementBlockedReasonFor={() => options.blocked ?? null}
      onAddStock={onAddStock}
      {...(options.onOpenSettings ? { onOpenSettings: options.onOpenSettings } : {})}
    />,
  );
  return { onAddStock };
}

async function typeQuery(text: string): Promise<void> {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });
}

function okSearch(items: readonly StockItemWire[], hasMore = false) {
  return { ok: true, items, page: 1, totalResults: items.length, hasMore };
}

describe('StockPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridge.desktop.mockReturnValue(true);
    bridge.search.mockReset();
    bridge.thumbnail.mockReset().mockResolvedValue({ ok: false });
    bridge.preview.mockReset().mockResolvedValue({ ok: false });
    bridge.download.mockReset();
    bridge.cancel.mockReset();
    bridge.quota.mockReset().mockResolvedValue({ kind: 'unmeasured' });
    bridge.progressListeners = [];
    bridge.quotaListeners = [];
  });

  afterEach(() => vi.useRealTimers());

  // -------------------------------------------------------------------------
  // Shell states
  // -------------------------------------------------------------------------

  it('is absent-and-explained in the browser build, not present-and-broken', () => {
    bridge.desktop.mockReturnValue(false);
    renderPanel();
    expect(screen.getByRole('note').textContent).toMatch(/desktop app/i);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('explains the missing key as a first-run state, not an error', async () => {
    bridge.quota.mockResolvedValue({ kind: 'no_key' });
    const onOpenSettings = vi.fn();
    renderPanel({ onOpenSettings });
    await act(async () => {
      await Promise.resolve();
    });
    // Not an alert: having no key on first run is expected, not a failure.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/free Pexels API key/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('shows a prompt that says when NOT to reach for stock', () => {
    renderPanel();
    // The niche this product serves is screen recordings, where a punch-in is
    // usually the better cut. Saying so here costs nothing and saves edits.
    expect(screen.getByText(/punch-in on your own footage/i)).toBeDefined();
  });

  it('renders the Pexels credit in every state, including errors', async () => {
    renderPanel();
    expect(screen.getByRole('link', { name: 'Pexels' })).toBeDefined();

    bridge.search.mockResolvedValue({ ok: false, error: 'offline' });
    await typeQuery('skyline');
    // A compliance requirement, not a styling detail: the API guidelines ask for
    // a prominent link, and an error state is exactly where a lazier build drops it.
    expect(screen.getByRole('link', { name: 'Pexels' })).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  it('does not search on open — every request is one the user asked for', () => {
    renderPanel();
    expect(bridge.search).not.toHaveBeenCalled();
  });

  it('debounces so a typing user does not burn the hourly limit', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'c' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ci' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'city' } });
    expect(bridge.search).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(bridge.search).toHaveBeenCalledTimes(1);
  });

  it('shows skeleton tiles at real proportions while loading', async () => {
    bridge.search.mockImplementation(() => new Promise(() => undefined));
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'city' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const list = screen.getByRole('list');
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(list.querySelectorAll('.stock-tile--skeleton').length).toBeGreaterThan(0);
  });

  it('renders results with duration, rendition and photographer', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel();
    await typeQuery('city');
    expect(screen.getByText('City skyline at dusk')).toBeDefined();
    expect(screen.getByText('0:12')).toBeDefined();
    // Sized before the click, so a 24 MB download is a considered one.
    expect(screen.getByText(/1920×1080 · 24 MB/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Ruvim' })).toBeDefined();
  });

  it('dims previous results while re-searching instead of clearing them', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel();
    await typeQuery('city');

    bridge.search.mockImplementation(() => new Promise(() => undefined));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'city sky' } });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    // A grid that blanks on every keystroke makes the panel feel broken.
    expect(screen.getByText('City skyline at dusk')).toBeDefined();
    expect(screen.getByRole('list').className).toContain('is-stale');
  });

  it('announces the result count politely', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem(), wireItem({ remoteId: '2' })]));
    renderPanel();
    await typeQuery('city');
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('2 clips found');
  });

  it('suggests broadening when nothing matched', async () => {
    bridge.search.mockResolvedValue(okSearch([]));
    renderPanel();
    await typeQuery('zzzz');
    expect(screen.getByText(/Nothing matched/)).toBeDefined();
    expect(screen.getByText(/broader word/)).toBeDefined();
  });

  it('switches kind and re-searches without losing the query', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel();
    await typeQuery('city');
    expect(bridge.search).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'video' }));

    fireEvent.click(screen.getByRole('button', { name: 'Photos' }));
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(bridge.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'photo', text: 'city' }),
    );
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'city');
  });

  it('loads more only on an explicit press, never by scrolling', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()], true));
    renderPanel();
    await typeQuery('city');
    expect(bridge.search).toHaveBeenCalledTimes(1);

    bridge.search.mockResolvedValue({
      ok: true,
      items: [wireItem({ remoteId: '999', title: 'Second page' })],
      page: 2,
      totalResults: 2,
      hasMore: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    // Appended, not replaced — the user was still looking at page one.
    expect(screen.getByText('City skyline at dusk')).toBeDefined();
    expect(screen.getByText('Second page')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Errors and quota
  // -------------------------------------------------------------------------

  it('gives every failure its own sentence', () => {
    expect(stockErrorText('rate_limited')).toMatch(/hourly/i);
    expect(stockErrorText('quota_exhausted')).toMatch(/month/i);
    expect(stockErrorText('rate_limited')).not.toBe(stockErrorText('quota_exhausted'));
    expect(stockErrorText('cancelled')).toBe('');
    expect(stockErrorText('offline')).toBe('No network connection.');
  });

  it('surfaces a provider error as an alert', async () => {
    bridge.search.mockResolvedValue({ ok: false, error: 'provider_unavailable' });
    renderPanel();
    await typeQuery('city');
    expect(screen.getByRole('alert').textContent).toMatch(/Pexels is not responding/);
  });

  it('stays silent on a cancelled search', async () => {
    bridge.search.mockResolvedValue({ ok: false, error: 'cancelled' });
    renderPanel();
    await typeQuery('city');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the hourly limit without touching the monthly numbers', async () => {
    bridge.quota.mockResolvedValue({
      kind: 'hourly_limited',
      monthly: {
        limit: 20000,
        remaining: 19400,
        resetAt: '2026-09-01T00:00:00.000Z',
        observedAt: '2026-08-24T12:00:00.000Z',
      },
      since: '2026-08-24T12:00:00.000Z',
      retryAfterSeconds: 120,
    });
    renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    // A healthy monthly figure and an hourly 429 are both true at once, because
    // the provider only reports the monthly one.
    expect(screen.getByRole('status').textContent).toMatch(/Hourly limit reached/);
    expect(screen.getByRole('status').textContent).toMatch(/about 2 min/);
  });

  it('warns only when the monthly allowance is genuinely low', async () => {
    bridge.quota.mockResolvedValue({
      kind: 'measured',
      monthly: {
        limit: 20000,
        remaining: 19000,
        resetAt: '2026-09-01T00:00:00.000Z',
        observedAt: '2026-08-24T12:00:00.000Z',
      },
    });
    renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => {
      for (const listener of bridge.quotaListeners) {
        listener({
          kind: 'measured',
          monthly: {
            limit: 20000,
            remaining: 400,
            resetAt: '2026-09-01T00:00:00.000Z',
            observedAt: '2026-08-24T12:00:00.000Z',
          },
        });
      }
    });
    expect(screen.getByRole('status').textContent).toMatch(/400 of 20,000/);
  });

  // -------------------------------------------------------------------------
  // Placement refusal
  // -------------------------------------------------------------------------

  it('disables Add with the reason shown before the click', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel({ blocked: "There's already footage at the playhead — move the playhead." });
    await typeQuery('city');

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toHaveProperty('disabled', true);
    // Explained up front, not after a click that silently did nothing.
    expect(screen.getByRole('status').textContent).toMatch(/already footage at the playhead/);
    fireEvent.click(add);
    expect(bridge.download).not.toHaveBeenCalled();
  });

  it('enables Add when the playhead is clear', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel({ blocked: null });
    await typeQuery('city');
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', false);
  });

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  it('downloads at the project height and places the asset', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockResolvedValue({
      ok: true,
      asset: {
        relativePath: 'media/p1/city.mp4',
        kind: 'video',
        durationSeconds: 12,
        width: 1920,
        height: 1080,
        media: null,
        source: {
          provider: 'pexels',
          remoteId: '3129671',
          license: 'pexels',
          attributionRequired: false,
          attribution: 'Video by Ruvim on Pexels',
          fetchedAt: '2026-08-24T12:00:00.000Z',
        },
        deduped: false,
      },
    });
    const { onAddStock } = renderPanel();
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.download).toHaveBeenCalledWith(
      expect.objectContaining({ targetHeight: 1080, targetFps: 30, remoteId: '3129671' }),
    );
    expect(onAddStock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'video',
        path: 'media/p1/city.mp4',
        source: expect.objectContaining({ attributionRequired: false }),
      }),
    );
  });

  it('asks per tile, so a long clip is refused where a short one fits', async () => {
    // The panel used to probe ONE representative length for every tile: a 12s
    // clip passed a 5s probe, downloaded, and was then dropped on arrival with
    // no message. The predicate now receives each item's real duration.
    const asked: number[] = [];
    bridge.search.mockResolvedValue(
      okSearch([
        wireItem({ remoteId: 'short', durationSeconds: 4 }),
        wireItem({ remoteId: 'long', durationSeconds: 12 }),
      ]),
    );
    render(
      <StockPanel
        project={emptyProject}
        placementBlockedReasonFor={(seconds) => {
          asked.push(seconds);
          return seconds > 5 ? 'There is already picture on the timeline.' : null;
        }}
        onAddStock={() => null}
      />,
    );
    await typeQuery('city');

    expect(asked).toContain(4);
    expect(asked).toContain(12);
    // One tile can be added, the other cannot — the whole panel is not disabled.
    const addable = screen.getAllByRole('button', { name: 'Add' });
    expect(addable.filter((button) => !(button as HTMLButtonElement).disabled)).toHaveLength(1);
  });

  it('says so when the spot filled up during the download, instead of dropping the clip', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockResolvedValue({
      ok: true,
      asset: {
        relativePath: 'media/p1/city.mp4',
        kind: 'video',
        durationSeconds: 12,
        media: null,
        source: {
          provider: 'pexels',
          remoteId: '3129671',
          license: 'pexels',
          attributionRequired: false,
          fetchedAt: '2026-08-24T12:00:00.000Z',
        },
        deduped: false,
      },
    });
    render(
      <StockPanel
        project={emptyProject}
        placementBlockedReasonFor={() => null}
        // The playhead moved onto occupied ground while the bytes were in flight.
        onAddStock={() => 'That stretch filled up while this was downloading.'}
      />,
    );
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/filled up while this was downloading/)).toBeTruthy();
  });

  it('keeps the results already loaded when Load more fails', async () => {
    // Those pages cost provider requests the user already spent, and every clip
    // in them is still placeable. Replacing them with an error screen throws
    // that away to report a failure about the NEXT page.
    bridge.search.mockResolvedValueOnce(okSearch([wireItem()], true));
    renderPanel();
    await typeQuery('city');
    expect(document.querySelectorAll('.stock-tile')).toHaveLength(1);

    bridge.search.mockResolvedValueOnce({ ok: false, error: 'offline' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelectorAll('.stock-tile')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBeTruthy();
  });

  it('shows determinate progress and a cancel while downloading', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockImplementation(() => new Promise(() => undefined));
    renderPanel();
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });

    const bar = screen.getByRole('progressbar', { name: 'Downloading City skyline at dusk' });
    expect(bar).toBeDefined();
    await act(async () => {
      for (const listener of bridge.progressListeners) {
        listener({
          operationId: bridge.download.mock.calls[0]![0].operationId,
          remoteId: '3129671',
          phase: 'downloading',
          completedBytes: 12_000_000,
          totalBytes: 24_000_000,
        });
      }
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel downloading City skyline at dusk' }),
    );
    expect(bridge.cancel).toHaveBeenCalled();
  });

  it('returns to idle on cancel with no error text', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockResolvedValue({ ok: false, error: 'cancelled' });
    renderPanel();
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });
    // The user did it deliberately; telling them so is noise.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
  });

  it('offers Retry with the reason after a failure', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockResolvedValue({ ok: false, error: 'disk_full' });
    renderPanel();
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Not enough disk space/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('marks an item already in this project', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    const project = {
      ...emptyProject,
      assets: [
        {
          id: 'a1',
          path: 'media/p1/city.mp4',
          kind: 'video',
          source: {
            provider: 'pexels',
            remoteId: '3129671',
            license: 'pexels',
            attributionRequired: false,
            fetchedAt: '2026-08-24T12:00:00.000Z',
          },
        },
      ],
    } as unknown as Project;
    renderPanel({ project });
    await typeQuery('city');
    expect(screen.getByText('In this project')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Hover preview and cursor scrubbing
  // -------------------------------------------------------------------------

  describe('hover scrub', () => {
    beforeEach(() => {
      bridge.preview.mockResolvedValue({
        ok: true,
        contentType: 'video/mp4',
        data: new ArrayBuffer(8),
      });
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
      globalThis.URL.revokeObjectURL = vi.fn();
    });

    async function hoverTile(): Promise<HTMLElement> {
      bridge.search.mockResolvedValue(okSearch([wireItem()]));
      renderPanel();
      await typeQuery('city');
      const tile = document.querySelector('.stock-tile') as HTMLElement;
      await act(async () => {
        fireEvent.pointerEnter(tile);
        await Promise.resolve();
      });
      return tile;
    }

    it('fetches the preview only on hover, not on mount', async () => {
      bridge.search.mockResolvedValue(okSearch([wireItem()]));
      renderPanel();
      await typeQuery('city');
      // A grid of 24 clips would otherwise pull tens of megabytes nobody asked
      // to see.
      expect(bridge.preview).not.toHaveBeenCalled();

      const tile = document.querySelector('.stock-tile') as HTMLElement;
      await act(async () => {
        fireEvent.pointerEnter(tile);
        await Promise.resolve();
      });
      expect(bridge.preview).toHaveBeenCalledWith('3129671');
    });

    it('fetches the preview once per tile', async () => {
      const tile = await hoverTile();
      await act(async () => {
        fireEvent.pointerLeave(tile);
        fireEvent.pointerEnter(tile);
        await Promise.resolve();
      });
      expect(bridge.preview).toHaveBeenCalledTimes(1);
    });

    it('never asks for a preview a photo does not have', async () => {
      bridge.search.mockResolvedValue(okSearch([wireItem({ kind: 'photo', hasPreview: false })]));
      renderPanel();
      await typeQuery('rocks');
      const tile = document.querySelector('.stock-tile') as HTMLElement;
      await act(async () => {
        fireEvent.pointerEnter(tile);
        await Promise.resolve();
      });
      expect(bridge.preview).not.toHaveBeenCalled();
    });

    it('hands the playhead to the cursor once it travels', async () => {
      const tile = await hoverTile();
      const video = tile.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();

      tile.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 120 }) as DOMRect;
      Object.defineProperty(video, 'duration', { value: 12, configurable: true });
      const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);

      await act(async () => {
        fireEvent.pointerMove(tile, { clientX: 0 });
        fireEvent.pointerMove(tile, { clientX: 150 });
      });

      // Three-quarters across the tile is three-quarters through the clip.
      expect(pause).toHaveBeenCalled();
      const marker = tile.querySelector('.stock-scrub') as HTMLElement;
      expect(marker.style.left).toBe('75%');
    });

    it('ignores hand jitter below the scrub threshold', async () => {
      const tile = await hoverTile();
      const video = tile.querySelector('video') as HTMLVideoElement;
      tile.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 120 }) as DOMRect;
      const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);

      await act(async () => {
        fireEvent.pointerMove(tile, { clientX: 100 });
        fireEvent.pointerMove(tile, { clientX: 101 });
      });
      // One pixel of tremor is not an intent to scrub.
      expect(pause).not.toHaveBeenCalled();
      expect(tile.querySelector('.stock-scrub')).toBeNull();
    });

    it('clears the scrub marker on leave', async () => {
      const tile = await hoverTile();
      const video = tile.querySelector('video') as HTMLVideoElement;
      tile.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 120 }) as DOMRect;
      vi.spyOn(video, 'pause').mockImplementation(() => undefined);

      await act(async () => {
        fireEvent.pointerMove(tile, { clientX: 0 });
        fireEvent.pointerMove(tile, { clientX: 150 });
      });
      expect(tile.querySelector('.stock-scrub')).not.toBeNull();

      await act(async () => {
        fireEvent.pointerLeave(tile);
      });
      expect(tile.querySelector('.stock-scrub')).toBeNull();
    });

    it('does not autoplay under prefers-reduced-motion, but still scrubs', async () => {
      const matchMedia = vi.fn().mockReturnValue({ matches: true });
      vi.stubGlobal('matchMedia', matchMedia);
      const tile = await hoverTile();
      const video = tile.querySelector('video') as HTMLVideoElement;
      const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
      const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
      tile.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 120 }) as DOMRect;

      await act(async () => {
        await Promise.resolve();
      });
      expect(play).not.toHaveBeenCalled();

      // Scrubbing is motion the user drives, which is the distinction that
      // setting is actually about — so it stays.
      await act(async () => {
        fireEvent.pointerMove(tile, { clientX: 0 });
        fireEvent.pointerMove(tile, { clientX: 150 });
      });
      expect(pause).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  it('is one tab stop with arrow navigation between tiles', async () => {
    bridge.search.mockResolvedValue(
      okSearch([wireItem(), wireItem({ remoteId: '2', title: 'Second' })]),
    );
    renderPanel();
    await typeQuery('city');

    const tiles = document.querySelectorAll<HTMLElement>('.stock-tile');
    expect(tiles[0]!.getAttribute('tabindex')).toBe('0');
    expect(tiles[1]!.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(tiles[0]!, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.querySelectorAll('.stock-tile')[1]!.getAttribute('tabindex')).toBe('0');
    });
  });

  it('adds on Enter, and does nothing on Enter when blocked', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockImplementation(() => new Promise(() => undefined));
    renderPanel({ blocked: 'occupied' });
    await typeQuery('city');
    fireEvent.keyDown(document.querySelector('.stock-tile')!, { key: 'Enter' });
    expect(bridge.download).not.toHaveBeenCalled();
  });

  it('leaves Enter to the control that has focus inside the tile', async () => {
    // The tile's own Enter handler used to fire regardless of what was focused,
    // so Enter on Cancel started a SECOND download of the clip the user was
    // trying to stop, and Enter on the licence link was swallowed.
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockImplementation(() => new Promise(() => undefined));
    renderPanel();
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.download).toHaveBeenCalledTimes(1);

    const cancel = screen.getByRole('button', { name: /cancel/i });
    fireEvent.keyDown(cancel, { key: 'Enter', bubbles: true });
    expect(bridge.download).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('formats a clip length', () => {
    expect(formatClipLength(12)).toBe('0:12');
    expect(formatClipLength(92)).toBe('1:32');
    expect(formatClipLength(-1)).toBe('0:00');
  });

  it('formats bytes at a scale a person reads', () => {
    // Decimal, matching the OS file browser and the provider's own figures.
    expect(formatBytes(24_000_000)).toBe('24 MB');
    expect(formatBytes(3_000_000_000)).toBe('3.0 GB');
    expect(formatBytes(2000)).toBe('2 KB');
  });

  it('derives a stable, filesystem-safe asset id', () => {
    expect(stockAssetId(wireItem())).toBe('stock_pexels_3129671');
    expect(stockAssetId(wireItem({ remoteId: 'a/b c' }))).toBe('stock_pexels_a_b_c');
  });

  it('previews the rendition main would actually pick', () => {
    // The tile must not promise 4K and then download 1080p.
    expect(tileVariant(wireItem(), 1080)?.id).toBe('hd');
    expect(tileVariant(wireItem(), 2160)?.id).toBe('uhd');
    expect(tileVariant(wireItem(), 4320)?.id).toBe('uhd');
  });
});
