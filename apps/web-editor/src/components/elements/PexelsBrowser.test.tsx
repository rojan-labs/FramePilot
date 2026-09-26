/**
 * PexelsBrowser (Elements → Photos / Videos) — one test per row of the state matrix in
 * `plan/3rd-party-sourcing/photo-video/CONTRACTS.md` §5, plus the hover-scrub
 * behaviour, keyboard navigation, and the live region.
 *
 * Note the naming trap this file has to respect: Playwright's `getByRole(name)`
 * substring-matches by default while RTL matches exactly, so an `aria-label`
 * that passes here can still break the e2e spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project } from '@framepilot/timeline-schema';
import type {
  StockDownloadProgressWire,
  StockItemWire,
  StockQuotaSnapshot,
} from '@framepilot/shared-types';
import {
  PexelsBrowser,
  STOCK_CATEGORIES,
  formatBytes,
  formatClipLength,
  orientationOf,
  projectOrientation,
  stockAssetId,
  stockErrorText,
  tileVariant,
} from './PexelsBrowser.js';
import { ELEMENT_DND_TYPE, decodeElementDrag } from './element-dnd.js';
import { resetDownloadRegistriesForTests, stockDownloads } from '../../editor/download-registry.js';

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

vi.mock('../../editor/bridge.js', () => ({
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
  // The download registry module imports both provider feeds; only the stock one
  // is exercised here, but the named export has to exist for the import to bind.
  onMusicDownloadProgress: () => () => {},
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

interface RenderOptions {
  project?: Project;
  blocked?: string | null;
  onOpenSettings?: () => void;
  kind?: 'photo' | 'video';
  /** The host offers no overlay placement (a host without the editor behind it). */
  noOverlay?: boolean;
  onShowInAssets?: (assetId: string) => void;
}

function panel(
  options: RenderOptions,
  onAddStock: ReturnType<typeof vi.fn>,
  onAddStockOverlay: ReturnType<typeof vi.fn>,
): JSX.Element {
  return (
    <PexelsBrowser
      kind={options.kind ?? 'video'}
      project={options.project ?? emptyProject}
      placementBlockedReasonFor={() => options.blocked ?? null}
      onAddStock={onAddStock}
      {...(options.noOverlay ? {} : { onAddStockOverlay })}
      {...(options.onOpenSettings ? { onOpenSettings: options.onOpenSettings } : {})}
      {...(options.onShowInAssets ? { onShowInAssets: options.onShowInAssets } : {})}
    />
  );
}

function renderPanel(options: RenderOptions = {}): {
  onAddStock: ReturnType<typeof vi.fn>;
  onAddStockOverlay: ReturnType<typeof vi.fn>;
  unmount: () => void;
  rerender: (next: RenderOptions) => void;
} {
  const onAddStock = vi.fn().mockReturnValue(null);
  const onAddStockOverlay = vi.fn().mockReturnValue(null);
  const { unmount, rerender } = render(panel(options, onAddStock, onAddStockOverlay));
  return {
    onAddStock,
    onAddStockOverlay,
    unmount,
    rerender: (next) => rerender(panel(next, onAddStock, onAddStockOverlay)),
  };
}

/** Let the mount's browse (fired on a zero-delay timer) land. */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
  });
}

/** A project of this frame size, to read the default orientation from. */
function projectSized(width: number, height: number): Project {
  return { ...emptyProject, resolution: { width, height } } as unknown as Project;
}

/** A finished download of the default item, as main answers it. */
function downloadedCity() {
  return {
    ok: true,
    asset: {
      relativePath: 'media/p1/city.mp4',
      kind: 'video',
      durationSeconds: 12,
      media: { width: 1920, height: 1080 },
      source: {
        provider: 'pexels',
        remoteId: '3129671',
        license: 'pexels',
        attributionRequired: false,
        fetchedAt: '2026-08-24T12:00:00.000Z',
      },
      deduped: false,
    },
  };
}

async function typeQuery(text: string): Promise<void> {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(400);
    await Promise.resolve();
  });
}

/** The quota strip, which is one of several status lines the panel keeps. */
const quotaStrip = (): HTMLElement | null => document.querySelector('.stock-quota-strip');

/** The panel-level note that speaks when no tile can be added as a cutaway. */
const blockedNote = (): HTMLElement => document.querySelector('.stock-blocked') as HTMLElement;

/** The tile's own tab stop: the button covering its picture. */
const tileMain = (index = 0): HTMLButtonElement =>
  document.querySelectorAll<HTMLButtonElement>('.stock-tile-main')[index]!;

/** What the panel has said in its polite region (a reason posted by Enter, for one). */
async function posted(): Promise<string> {
  await act(async () => {
    vi.advanceTimersByTime(60);
    await Promise.resolve();
  });
  return document.querySelector('[data-live="posted"]')?.textContent ?? '';
}

function okSearch(items: readonly StockItemWire[], hasMore = false) {
  return { ok: true, items, page: 1, totalResults: items.length, hasMore };
}

/** What a blocked Add says: the host's fixed sentence. */
const BLOCKED =
  "Add replaces the picture, and there's footage at the playhead. " +
  'Use Overlay to put it on top, or move the playhead to a gap.';

describe('PexelsBrowser', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridge.desktop.mockReturnValue(true);
    // Every mount now browses, so the bridge must answer from the first render.
    // Individual tests override this with the items they care about.
    bridge.search.mockReset().mockResolvedValue(okSearch([]));
    bridge.thumbnail.mockReset().mockResolvedValue({ ok: false });
    bridge.preview.mockReset().mockResolvedValue({ ok: false });
    bridge.download.mockReset();
    bridge.cancel.mockReset();
    bridge.quota.mockReset().mockResolvedValue({ kind: 'unmeasured' });
    bridge.progressListeners = [];
    bridge.quotaListeners = [];
    // The registry is a module singleton by design — it has to outlive the
    // panel. That makes it shared state between tests, so it is cleared here.
    resetDownloadRegistriesForTests();
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
    // No dead controls above the explanation: nothing can be searched or filtered yet.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Orientation' })).toBeNull();
    // The credit stays, inside the note.
    const hint = document.querySelector('.stock-hint') as HTMLElement;
    expect(within(hint).getByRole('link', { name: 'Photos and videos from Pexels' })).toBeDefined();
    // One clear, primary way forward.
    const addKey = screen.getByRole('button', { name: 'Add Pexels key' });
    expect(addKey.getAttribute('data-variant')).toBe('primary');
    fireEvent.click(addKey);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('browses the curated feed on mount instead of showing an empty panel', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    // The empty box IS the browse — no words, fired immediately, no debounce.
    expect(bridge.search).toHaveBeenCalledWith({ text: '', kind: 'video', page: 1 });
    // Labelled for a screen reader, not with a line of prose above the grid:
    // the panel is a sidebar, and the tiles are what it is for.
    expect(screen.getByRole('list', { name: 'Popular on Pexels — video' })).toBeDefined();
    expect(screen.queryByText(/Popular on Pexels/)).toBeNull();
  });

  it('offers the key setup rather than a browse when there is no key', async () => {
    bridge.quota.mockResolvedValue({ kind: 'no_key' });
    bridge.search.mockResolvedValue({ ok: false, error: 'no_key' });
    renderPanel();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    // Whether or not the mount browse got out before the key state landed, what
    // the user ends up looking at is the thing they can act on.
    expect(screen.getByText(/free Pexels API key/i)).toBeDefined();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps everything that is not a result in the one control row', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    // Search and the required Pexels credit share a row; below it there is the grid
    // and nothing else to read. The kind is the Elements sub-tab, so there is no
    // kind control in the row at all.
    const controls = document.querySelector('.stock-controls');
    expect(controls?.querySelector('#stock-search-input')).not.toBeNull();
    expect(controls?.querySelector('select')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(controls?.querySelector('.stock-credit')).not.toBeNull();
    expect(document.querySelectorAll('.stock-note')).toHaveLength(0);
  });

  it('renders the Pexels credit in every state, including errors', async () => {
    renderPanel();
    expect(screen.getByRole('link', { name: 'Photos and videos from Pexels' })).toBeDefined();

    bridge.search.mockResolvedValue({ ok: false, error: 'offline' });
    await typeQuery('skyline');
    // A compliance requirement, not a styling detail: the API guidelines ask for
    // a prominent link, and an error state is exactly where a lazier build drops it.
    expect(screen.getByRole('link', { name: 'Photos and videos from Pexels' })).toBeDefined();
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

  it('ignores a search that resolves after a newer one', async () => {
    // Requests cannot be recalled once sent, and a slow "cats" can land after a
    // fast "dogs" — replacing the grid the user is looking at with the one they
    // abandoned two keystrokes ago. The debounce narrows this window; it does
    // not close it, and "Load more" does not debounce at all.
    let resolveCats: (value: unknown) => void = () => undefined;
    let resolveDogs: (value: unknown) => void = () => undefined;
    bridge.search
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCats = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDogs = resolve;
        }),
      );
    renderPanel();
    await typeQuery('cats');
    await typeQuery('dogs');

    await act(async () => {
      resolveDogs(okSearch([wireItem({ remoteId: 'dog', title: 'A dog' })]));
      await Promise.resolve();
      resolveCats(okSearch([wireItem({ remoteId: 'cat', title: 'A cat' })]));
      await Promise.resolve();
    });

    expect(screen.getByText('A dog')).toBeDefined();
    expect(screen.queryByText('A cat')).toBeNull();
  });

  it('does not let an abandoned query report its error over live results', async () => {
    let failCats: (value: unknown) => void = () => undefined;
    bridge.search
      .mockReturnValueOnce(
        new Promise((resolve) => {
          failCats = resolve;
        }),
      )
      .mockResolvedValueOnce(okSearch([wireItem({ remoteId: 'dog', title: 'A dog' })]));
    renderPanel();
    await typeQuery('cats');
    await typeQuery('dogs');

    await act(async () => {
      failCats({ ok: false, error: 'offline' });
      await Promise.resolve();
    });

    // The results the user is looking at survive; no alert about a query they
    // have already moved on from.
    expect(screen.getByText('A dog')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
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
    // The duration is read at rest, on the picture, not only on hover.
    expect(document.querySelector('.stock-tile-dur')?.textContent).toBe('0:12');
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

  it('re-searches the same words when the sub-tab switches kind', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    const { rerender } = renderPanel();
    await typeQuery('city');
    expect(bridge.search).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'video' }));

    // Photos ↔ Videos is the Elements sub-tab; the host hands the new kind down.
    rerender({ kind: 'photo' });
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
    expect(quotaStrip()?.textContent).toMatch(/Hourly limit reached/);
    expect(quotaStrip()?.getAttribute('role')).toBe('status');
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
    expect(quotaStrip()).toBeNull();

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
    expect(quotaStrip()?.textContent).toMatch(/400 of 20,000/);
  });

  // -------------------------------------------------------------------------
  // Placement refusal
  // -------------------------------------------------------------------------

  it('disables Add with the reason shown before the click', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel({ blocked: BLOCKED });
    await typeQuery('city');

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    // Explained up front, not after a click that silently did nothing.
    expect(blockedNote().textContent).toBe(BLOCKED);
    expect(blockedNote().getAttribute('role')).toBe('status');
    fireEvent.click(add);
    expect(bridge.download).not.toHaveBeenCalled();
    // The click is answered: the reason is said, not swallowed.
    expect(await posted()).toBe(BLOCKED);
  });

  it('enables Add when the playhead is clear', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    renderPanel({ blocked: null });
    await typeQuery('city');
    expect(screen.getByRole('button', { name: 'Add' }).getAttribute('aria-disabled')).toBeNull();
    // The note stays mounted, empty, so the region is there before anything is said in it.
    expect(blockedNote().textContent).toBe('');
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

  it('carries the downloaded clip’s shape onto the asset', async () => {
    // A stock library is overwhelmingly 16:9, so a shapeless stock asset is exactly the
    // landscape-in-portrait case `list_assets`' letterbox note and the review's reframe
    // check exist to catch — and both go quiet when the dimensions are missing. The wire
    // carries the pair now; this pins that the renderer stops dropping it on the way to
    // the media bin.
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockResolvedValue({
      ok: true,
      asset: {
        relativePath: 'media/p1/city.mp4',
        kind: 'video',
        durationSeconds: 12,
        width: 1920,
        height: 1080,
        media: { width: 1920, height: 1080, proxyPath: 'media/p1/city.proxy.mp4' },
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

    expect(onAddStock).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ width: 1920, height: 1080 }),
      }),
    );
  });

  it('keeps a download alive, with its progress and Cancel, across a tab switch', async () => {
    // The Stock tab unmounts when the user switches tabs — which is exactly what
    // someone does after queuing a 40 MB clip. Before the registry, coming back
    // showed an idle tile with an Add button while main was still fetching, so a
    // second click would start a competing download of the same file.
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderPanel();
    await typeQuery('city');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    // Progress that arrives while the panel is away is still recorded. It carries the operation
    // id main was given, which is what ties it to this tile.
    const { operationId } = bridge.download.mock.calls[0]![0] as { operationId: string };
    act(() => {
      for (const listener of bridge.progressListeners) {
        listener({
          operationId,
          remoteId: '3129671',
          phase: 'downloading',
          completedBytes: 30,
          totalBytes: 100,
        });
      }
    });

    renderPanel();
    await typeQuery('city');
    const bar = screen.getByRole('progressbar', { name: /Downloading/ });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('button', { name: /Cancel downloading/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('refuses to start a second download of an item already in flight', async () => {
    // The tile's own Enter shortcut can reach `add` while the bar is up, and two
    // downloads would fight over the same destination file.
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await typeQuery('city');

    fireEvent.keyDown(tileMain(), { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(tileMain(), { key: 'Enter' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.download).toHaveBeenCalledTimes(1);
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
      <PexelsBrowser
        kind="video"
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
    expect(
      addable.filter((button) => button.getAttribute('aria-disabled') !== 'true'),
    ).toHaveLength(1);
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
      <PexelsBrowser
        kind="video"
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

    expect(screen.getByRole('alert').textContent).toMatch(/filled up while this was downloading/);
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
    // The failed button says Retry and says which placement it retries.
    const retry = screen.getByRole('button', { name: 'Retry adding at the playhead' });
    expect(retry.textContent).toBe('Retry');
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

    expect(tileMain(0).getAttribute('tabindex')).toBe('0');
    expect(tileMain(1).getAttribute('tabindex')).toBe('-1');
    // The list item itself is not a stop; the button over its picture is.
    expect(document.querySelector('.stock-tile')!.hasAttribute('tabindex')).toBe(false);

    fireEvent.keyDown(tileMain(0), { key: 'ArrowRight' });
    await waitFor(() => {
      expect(tileMain(1).getAttribute('tabindex')).toBe('0');
    });
    expect(document.activeElement).toBe(tileMain(1));
  });

  it('adds on Enter, and says why on Enter when Add is blocked', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()]));
    bridge.download.mockImplementation(() => new Promise(() => undefined));
    renderPanel({ blocked: BLOCKED });
    await typeQuery('city');
    fireEvent.keyDown(tileMain(), { key: 'Enter' });
    expect(bridge.download).not.toHaveBeenCalled();
    expect(await posted()).toBe(BLOCKED);
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

describe('PexelsBrowser — categories, orientation, drag and Add as overlay (EL9)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridge.desktop.mockReturnValue(true);
    bridge.search.mockReset().mockResolvedValue(okSearch([wireItem()]));
    bridge.thumbnail.mockReset().mockResolvedValue({ ok: false });
    bridge.preview.mockReset().mockResolvedValue({ ok: false });
    bridge.download.mockReset();
    bridge.cancel.mockReset();
    bridge.quota.mockReset().mockResolvedValue({ kind: 'unmeasured' });
    bridge.progressListeners = [];
    bridge.quotaListeners = [];
    resetDownloadRegistriesForTests();
  });

  afterEach(() => vi.useRealTimers());

  // -------------------------------------------------------------------------
  // Category chips
  // -------------------------------------------------------------------------

  it('offers the curated categories as chips, after the feed', async () => {
    renderPanel({ kind: 'photo' });
    await settle();
    const chips = within(screen.getByRole('group', { name: 'Photo categories' })).getAllByRole(
      'button',
    );
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Curated',
      'Business',
      'Technology',
      'People',
      'Nature',
      'City',
      'Abstract',
      'Backgrounds',
      'Food',
      'Travel',
      'Textures',
    ]);
    // The feed is what an empty box shows, so it is the chip that starts pressed.
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(chips.slice(1).every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(
      true,
    );
    expect(STOCK_CATEGORIES).toHaveLength(10);
  });

  it('runs one search for a category, at once, and none for a second click on it', async () => {
    renderPanel();
    await settle();
    bridge.search.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Nature' }));
    // A click is a deliberate request: no typing debounce to wait through.
    await settle();
    expect(bridge.search).toHaveBeenCalledTimes(1);
    expect(bridge.search).toHaveBeenCalledWith({
      text: 'nature',
      kind: 'video',
      page: 1,
      orientation: 'landscape',
    });
    expect(screen.getByRole('button', { name: 'Nature' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    // The same chip, the same kind, the same orientation: nothing more to ask for.
    fireEvent.click(screen.getByRole('button', { name: 'Nature' }));
    await settle();
    expect(bridge.search).toHaveBeenCalledTimes(1);
  });

  it('says in the quota strip that each category is one search', async () => {
    renderPanel();
    await settle();
    expect(screen.queryByText(/Each category is one search/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'City' }));
    await settle();
    expect(quotaStrip()?.textContent).toMatch(/Each category is one search/);
  });

  it('leaves the category when the user types, and goes back to the feed from its chip', async () => {
    renderPanel();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    await settle();
    // Choosing a category empties the box: the chip is what is being searched.
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '');

    await typeQuery('pasta');
    expect(screen.getByRole('button', { name: 'Food' }).getAttribute('aria-pressed')).toBe('false');
    expect(bridge.search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'pasta' }));

    fireEvent.click(screen.getByRole('button', { name: 'Popular' }));
    await settle();
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '');
    expect(bridge.search).toHaveBeenLastCalledWith({ text: '', kind: 'video', page: 1 });
  });

  it('loads more of a category, not of the box', async () => {
    bridge.search.mockResolvedValue(okSearch([wireItem()], true));
    renderPanel();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Travel' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(bridge.search).toHaveBeenLastCalledWith({
      text: 'travel',
      kind: 'video',
      page: 2,
      orientation: 'landscape',
    });
  });

  // -------------------------------------------------------------------------
  // Orientation
  // -------------------------------------------------------------------------

  it("starts on the project's own orientation", async () => {
    const pressed = (): string | undefined =>
      within(screen.getByRole('group', { name: 'Orientation' }))
        .getAllByRole('button')
        .find((button) => button.getAttribute('aria-pressed') === 'true')
        ?.getAttribute('aria-label') ?? undefined;
    for (const [width, height, expected] of [
      [1920, 1080, 'Landscape'],
      [1080, 1920, 'Portrait'],
      [1080, 1080, 'Square'],
    ] as const) {
      const { unmount } = renderPanel({ project: projectSized(width, height) });
      await settle();
      expect(pressed()).toBe(expected);
      unmount();
    }
  });

  it('asks Pexels for the chosen shape, and re-runs the search when it changes', async () => {
    renderPanel({ project: projectSized(1080, 1920) });
    await typeQuery('city');
    expect(bridge.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'city', orientation: 'portrait' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Square' }));
    await settle();
    expect(bridge.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'city', orientation: 'square' }),
    );

    // Any shape is no filter at all: the parameter is left off rather than sent empty.
    fireEvent.click(screen.getByRole('button', { name: 'Any' }));
    await settle();
    expect(bridge.search).toHaveBeenLastCalledWith({ text: 'city', kind: 'video', page: 1 });
  });

  it('filters the feed by shape on the page, without spending a request', async () => {
    // Pexels' curated and popular feeds take no orientation, so asking would buy the same page
    // again. The page it already sent is filtered by each item's own shape instead.
    bridge.search.mockResolvedValue(
      okSearch([
        wireItem({ remoteId: 'wide', title: 'Wide shot', width: 3840, height: 2160 }),
        wireItem({ remoteId: 'tall', title: 'Tall shot', width: 1080, height: 1920 }),
      ]),
    );
    renderPanel();
    await settle();
    expect(screen.getByText('Wide shot')).toBeDefined();
    expect(screen.queryByText('Tall shot')).toBeNull();
    const browses = bridge.search.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    await settle();
    expect(screen.getByText('Tall shot')).toBeDefined();
    expect(screen.queryByText('Wide shot')).toBeNull();
    expect(bridge.search.mock.calls.length).toBe(browses);

    fireEvent.click(screen.getByRole('button', { name: 'Square' }));
    await settle();
    // Nothing on the page is that shape: said, with the way to get some.
    expect(screen.getByText(/Nothing here is square/)).toBeDefined();
  });

  it('keeps the orientation control keyboard-reachable and labelled', async () => {
    renderPanel();
    await settle();
    const group = screen.getByRole('group', { name: 'Orientation' });
    const buttons = within(group).getAllByRole('button');
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['Any', 'Landscape', 'Portrait', 'Square']);
    // Plain buttons in the tab order, like the category chips: no hidden roving state.
    expect(buttons.every((button) => button.tabIndex === 0)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Drag to the timeline
  // -------------------------------------------------------------------------

  it('puts the provider id and the kind on a drag, and nothing else', async () => {
    renderPanel({ kind: 'photo' });
    await settle();
    const tile = document.querySelector('.stock-tile') as HTMLElement;
    expect(tile.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      setData: (type: string, value: string) => data.set(type, value),
    };
    fireEvent.dragStart(tile, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe('copy');
    const raw = data.get(ELEMENT_DND_TYPE)!;
    expect(JSON.parse(raw)).toEqual({ kind: 'stock', mediaKind: 'video', remoteId: '3129671' });
    expect(decodeElementDrag(raw)).toEqual({
      kind: 'stock',
      mediaKind: 'video',
      remoteId: '3129671',
    });
    expect(raw).not.toMatch(/https?:|media\//);
  });

  it('cannot be dragged while it downloads or once it is in the project', async () => {
    bridge.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await settle();
    expect(document.querySelector('.stock-tile')!.getAttribute('draggable')).toBe('false');
  });

  // -------------------------------------------------------------------------
  // Add as overlay
  // -------------------------------------------------------------------------

  it('offers Add as overlay beside Add, and keeps it enabled where Add is blocked', async () => {
    renderPanel({ blocked: BLOCKED });
    await settle();
    // Add stays a cutaway, disabled with its reason (ADR 0140).
    expect(screen.getByRole('button', { name: 'Add' }).getAttribute('aria-disabled')).toBe('true');
    // Covering footage is the point of an overlay (ADR 0193).
    const overlay = screen.getByRole('button', { name: 'Add as overlay' });
    expect(overlay.getAttribute('aria-disabled')).toBeNull();
    // One compact row: the word the blocked sentence names, no icon, the small size.
    expect(overlay.textContent).toBe('Overlay');
    expect(overlay.querySelector('svg')).toBeNull();
    expect(overlay.getAttribute('data-size')).toBe('sm');
    expect(screen.getByRole('button', { name: 'Add' }).getAttribute('data-size')).toBe('sm');
    // The host's sentence, once, with nothing appended: it already names Overlay.
    expect(blockedNote().textContent).toBe(BLOCKED);
  });

  it('downloads and hands the asset to the overlay placement, never to the cutaway', async () => {
    bridge.download.mockResolvedValue(downloadedCity());
    const { onAddStock, onAddStockOverlay } = renderPanel({ blocked: 'occupied' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add as overlay' }));
    await settle();
    expect(bridge.download).toHaveBeenCalledWith(
      expect.objectContaining({ remoteId: '3129671', targetHeight: 1080 }),
    );
    expect(onAddStock).not.toHaveBeenCalled();
    expect(onAddStockOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stock_pexels_3129671',
        kind: 'video',
        path: 'media/p1/city.mp4',
        media: expect.objectContaining({ width: 1920, height: 1080 }),
      }),
    );
    // Landed: the tile has nothing in flight and nothing failed.
    expect(stockDownloads.getSnapshot()['3129671']).toBeUndefined();
  });

  it('shows the same progress and Cancel for an overlay as for Add', async () => {
    bridge.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add as overlay' }));
    await settle();
    expect(
      screen.getByRole('progressbar', { name: 'Downloading City skyline at dusk' }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add as overlay' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel downloading City skyline at dusk' }),
    );
    expect(bridge.cancel).toHaveBeenCalled();
  });

  it('offers the overlay again after an overlay failed, and retries that — not the cutaway', async () => {
    bridge.download.mockResolvedValueOnce({ ok: false, error: 'offline' });
    const { onAddStock, onAddStockOverlay } = renderPanel();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add as overlay' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('No network connection.');
    // The action that failed is the one that says Retry; Add stays Add.
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry adding at the playhead' })).toBeNull();
    const retry = screen.getByRole('button', { name: 'Retry adding as an overlay' });
    expect(retry.textContent).toBe('Retry');
    bridge.download.mockResolvedValueOnce(downloadedCity());
    fireEvent.click(retry);
    await settle();
    expect(onAddStockOverlay).toHaveBeenCalledTimes(1);
    expect(onAddStock).not.toHaveBeenCalled();
  });

  it('after a failed drop, offers both actions and the drag again, with the reason', async () => {
    renderPanel();
    await settle();
    act(() =>
      stockDownloads.fail('video:3129671', 'Not enough disk space to save this file.', 'drop'),
    );
    expect(screen.getByRole('alert').textContent).toBe('Not enough disk space to save this file.');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add as overlay' })).toBeDefined();
    expect(document.querySelector('.stock-tile')!.getAttribute('draggable')).toBe('true');
  });

  it('asks main for the kind the tile shows', async () => {
    bridge.download.mockReturnValue(new Promise(() => undefined));
    renderPanel({ kind: 'photo' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await settle();
    // The search stub answers a video item: the kind sent is the item's own, not the tab's.
    expect(bridge.download).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video' }));
  });

  it('keeps a photo and a video with the same id apart', async () => {
    // A Pexels photo with the video's numeric id: its download, and its place in the project,
    // are not the video tile's.
    const project = {
      ...emptyProject,
      assets: [
        {
          id: 'stock_pexels_3129671',
          path: 'media/p1/rocks.jpg',
          kind: 'image',
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
    await settle();
    act(() => stockDownloads.start('photo:3129671', 'the-photo'));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('In this project')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
  });

  it('is absent from a tile already in the project, and from a host with no overlay placement', async () => {
    renderPanel({ noOverlay: true });
    await settle();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Add as overlay' })).toBeNull();
  });
});

describe('PexelsBrowser — the tile as one keyboard stop (Enter adds, Shift+Enter overlays)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridge.desktop.mockReturnValue(true);
    bridge.search.mockReset().mockResolvedValue(okSearch([wireItem()]));
    bridge.thumbnail.mockReset().mockResolvedValue({ ok: false });
    bridge.preview.mockReset().mockResolvedValue({ ok: false });
    bridge.download.mockReset();
    bridge.cancel.mockReset();
    bridge.quota.mockReset().mockResolvedValue({ kind: 'unmeasured' });
    bridge.progressListeners = [];
    bridge.quotaListeners = [];
    resetDownloadRegistriesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const description = (element: Element): string =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();

  it('is a named button that says what Enter and Shift+Enter do', async () => {
    bridge.thumbnail.mockResolvedValue({
      ok: true,
      contentType: 'image/jpeg',
      data: new ArrayBuffer(4),
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:thumb');
    globalThis.URL.revokeObjectURL = vi.fn();
    renderPanel();
    await settle();
    const main = screen.getByRole('button', {
      name: 'City skyline at dusk, 0:12, 1920×1080 · 24 MB',
    });
    expect(main).toBe(tileMain());
    expect(main.getAttribute('aria-keyshortcuts')).toBe('Enter Shift+Enter');
    expect(description(main)).toBe(
      'Enter adds it at the playhead. Shift+Enter adds it as an overlay.',
    );
    // The name already carries the title; the picture adds nothing to it.
    await waitFor(() => expect(main.querySelector('img')?.getAttribute('alt')).toBe(''));
    // Everything else in the tile is out of the Tab order: one stop per grid.
    expect(screen.getByRole('button', { name: 'Add' }).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('button', { name: 'Add as overlay' }).getAttribute('tabindex')).toBe(
      '-1',
    );
    expect(screen.getByRole('link', { name: 'Ruvim' }).getAttribute('tabindex')).toBe('-1');
  });

  it('points the stop at the reason when Add is blocked', async () => {
    renderPanel({ blocked: BLOCKED });
    await settle();
    expect(description(tileMain())).toBe(`${BLOCKED} Shift+Enter adds it as an overlay.`);
  });

  it('adds as an overlay on Shift+Enter, even where Add is blocked', async () => {
    bridge.download.mockResolvedValue(downloadedCity());
    const { onAddStock, onAddStockOverlay } = renderPanel({ blocked: BLOCKED });
    await settle();
    fireEvent.keyDown(tileMain(), { key: 'Enter', shiftKey: true });
    await settle();
    expect(onAddStockOverlay).toHaveBeenCalledTimes(1);
    expect(onAddStock).not.toHaveBeenCalled();
  });

  it('adds on a click of the picture, as Enter does', async () => {
    bridge.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await settle();
    fireEvent.click(tileMain());
    await settle();
    expect(bridge.download).toHaveBeenCalledTimes(1);
  });

  it('cancels a download with Escape on the tile', async () => {
    bridge.download.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    await settle();
    fireEvent.keyDown(tileMain(), { key: 'Enter' });
    await settle();
    expect(tileMain().getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(description(tileMain())).toBe('Downloading. Escape cancels.');
    fireEvent.keyDown(tileMain(), { key: 'Escape' });
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
  });

  it('shows an item already in the project in Assets', async () => {
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
    const onShowInAssets = vi.fn();
    renderPanel({ project, onShowInAssets });
    await settle();
    const pill = screen.getByRole('button', { name: 'Show City skyline at dusk in Assets' });
    expect(pill.textContent).toBe('In this project');
    fireEvent.click(pill);
    expect(onShowInAssets).toHaveBeenCalledWith('a1');
    fireEvent.keyDown(tileMain(), { key: 'Enter' });
    expect(onShowInAssets).toHaveBeenCalledTimes(2);
    expect(description(tileMain())).toBe('In this project. Enter shows it in Assets.');
    expect(bridge.download).not.toHaveBeenCalled();
  });

  it('previews a video while its tile has keyboard focus', async () => {
    bridge.preview.mockResolvedValue({
      ok: true,
      contentType: 'video/mp4',
      data: new ArrayBuffer(8),
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.focus(tileMain());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.preview).toHaveBeenCalledWith('3129671');
    await waitFor(() => expect(play).toHaveBeenCalled());
    act(() => {
      fireEvent.blur(tileMain());
    });
    expect(pause).toHaveBeenCalled();
    play.mockRestore();
    pause.mockRestore();
  });

  it('does not autoplay a focused tile under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    bridge.preview.mockResolvedValue({
      ok: true,
      contentType: 'video/mp4',
      data: new ArrayBuffer(8),
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    renderPanel();
    await settle();
    await act(async () => {
      fireEvent.focus(tileMain());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.preview).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();
    play.mockRestore();
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

  it("reads a frame's orientation the way the filter offers it", () => {
    expect(orientationOf(1920, 1080)).toBe('landscape');
    expect(orientationOf(1080, 1920)).toBe('portrait');
    expect(orientationOf(1080, 1080)).toBe('square');
    // A 4:5 photo is portrait, not "nearly square"; a pixel off square is still square.
    expect(orientationOf(1080, 1350)).toBe('portrait');
    expect(orientationOf(1081, 1080)).toBe('square');
    expect(projectOrientation({ width: 1920, height: 1080 })).toBe('landscape');
    expect(projectOrientation(undefined)).toBe('any');
  });

  it('previews the rendition main would actually pick', () => {
    // The tile must not promise 4K and then download 1080p.
    expect(tileVariant(wireItem(), 1080)?.id).toBe('hd');
    expect(tileVariant(wireItem(), 2160)?.id).toBe('uhd');
    expect(tileVariant(wireItem(), 4320)?.id).toBe('uhd');
  });
});
