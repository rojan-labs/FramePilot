/**
 * The home screen's project list: what to show, and how to page through it.
 *
 * On desktop this pages through every project in the projects folder, recently opened
 * first, {@link HOME_PROJECT_PAGE_SIZE} at a time. Two cases keep the older recents-only
 * list instead:
 * - the browser build, which lists its locally stored projects as before;
 * - a desktop whose preload predates `listProjects` (a dev app not yet restarted) or whose
 *   listing fails. The home screen must never come up blank because of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger, type ProjectListEntry } from '@framepilot/shared-types';
import type { RecentProject, RendererBridge } from '../editor/bridge.js';
import { getBridge } from '../editor/bridge.js';
import { BROWSER_PATH_PREFIX, listBrowserProjectSummaries } from '../editor/persistence.js';

const log = createLogger('web-editor:home-projects');

/** Projects per page; "Load more" appends the next page. */
export const HOME_PROJECT_PAGE_SIZE = 10;

/**
 * Cap for the recents-only list. That list arrives whole, and its own scroll area keeps a
 * long one from growing the page.
 */
const MAX_RECENTS = 100;

/** One row of the list. */
export interface HomeProjectEntry {
  readonly path: string;
  readonly name: string;
  /** Epoch ms shown beside the name: last opened (recents), else last changed. */
  readonly date: number;
  /** True when it came from the recently-opened list. */
  readonly recent: boolean;
}

/**
 * `all`: every project in the folder, paged (desktop).
 * `recents`: the recently-opened list only (browser, or a desktop without `listProjects`).
 */
export type HomeProjectSource = 'all' | 'recents';

export interface HomeProjects {
  readonly entries: readonly HomeProjectEntry[];
  readonly source: HomeProjectSource;
  /** How many projects the whole list holds; `null` for the recents-only list. */
  readonly total: number | null;
  /** True while there are projects not yet loaded. */
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** Append the next page. Ignored while a page is loading or when nothing is left. */
  readonly loadMore: () => void;
}

interface ListState {
  readonly entries: readonly HomeProjectEntry[];
  readonly source: HomeProjectSource;
  readonly total: number | null;
  /** Offset of the next page to request. */
  readonly nextOffset: number;
}

interface ProjectPage {
  readonly entries: readonly ProjectListEntry[];
  readonly total: number;
}

const EMPTY: ListState = { entries: [], source: 'recents', total: null, nextOffset: 0 };

const fromListEntry = (entry: ProjectListEntry): HomeProjectEntry => ({
  path: entry.path,
  name: entry.name,
  date: entry.lastActiveAt,
  recent: entry.recent,
});

const fromRecent = (entry: RecentProject): HomeProjectEntry => ({
  path: entry.path,
  name: entry.name,
  date: entry.openedAt,
  recent: true,
});

/** One page from main, or `null` when this desktop cannot list projects (or it failed). */
async function fetchPage(bridge: RendererBridge, offset: number): Promise<ProjectPage | null> {
  if (typeof bridge.listProjects !== 'function') return null;
  try {
    const result = await bridge.listProjects({ offset, limit: HOME_PROJECT_PAGE_SIZE });
    if (result.ok) return result;
    log.warn('project list refused', { offset, error: result.error });
  } catch (error) {
    log.warn('project list failed', { offset, error: String(error) });
  }
  return null;
}

/** The desktop recents list, newest first. A failure lists nothing; project actions still work. */
async function loadRecents(bridge: RendererBridge): Promise<ListState> {
  try {
    const items = await bridge.recentProjects();
    const entries = [...items]
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, MAX_RECENTS)
      .map(fromRecent);
    return { ...EMPTY, entries };
  } catch (error) {
    log.warn('recent projects failed to load', { error: String(error) });
    return EMPTY;
  }
}

/** Projects saved in this browser. Summaries only: no project blob is parsed to draw the list. */
function browserProjects(): ListState {
  const entries = listBrowserProjectSummaries()
    .map(({ id, name, openedAt }) => ({
      path: `${BROWSER_PATH_PREFIX}${id}`,
      name,
      date: openedAt,
      recent: true,
    }))
    .slice(0, MAX_RECENTS);
  return { ...EMPTY, entries };
}

/**
 * Add a page to the list. A path already shown is skipped: the folder can change between
 * requests (a save moves a project up), and one project must not appear twice.
 */
function appendPage(current: ListState, page: ProjectPage): ListState {
  const shown = new Set(current.entries.map((entry) => entry.path));
  const added = page.entries.filter((entry) => !shown.has(entry.path)).map(fromListEntry);
  return {
    entries: [...current.entries, ...added],
    source: 'all',
    // An empty page means the list ended early (projects were removed); stop offering more.
    total: page.entries.length === 0 ? current.nextOffset : page.total,
    nextOffset: current.nextOffset + page.entries.length,
  };
}

/**
 * Before anything loads: a desktop that can list the folder starts as the full list, so the
 * heading does not flip from "Recent projects" to "Projects" when the first page arrives.
 */
function initialList(desktop: boolean): ListState {
  const canList = desktop && typeof getBridge()?.listProjects === 'function';
  return canList ? { ...EMPTY, source: 'all' } : EMPTY;
}

/**
 * Load the home screen's project list.
 *
 * @param desktop - Whether the desktop bridge is present (see `isDesktop`).
 */
export function useHomeProjects(desktop: boolean): HomeProjects {
  const [list, setList] = useState<ListState>(() => initialList(desktop));
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!desktop) {
      setList(browserProjects());
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      const firstPage = await fetchPage(bridge, 0);
      const next = firstPage
        ? appendPage({ ...EMPTY, source: 'all' }, firstPage)
        : await loadRecents(bridge);
      if (!cancelled) setList(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const hasMore = list.source === 'all' && list.total !== null && list.nextOffset < list.total;

  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    const bridge = getBridge();
    if (!bridge) return;
    loadingRef.current = true;
    setLoadingMore(true);
    void fetchPage(bridge, list.nextOffset).then((page) => {
      loadingRef.current = false;
      if (!mountedRef.current) return;
      setLoadingMore(false);
      // A failed page keeps what is shown and leaves "Load more" in place to try again.
      if (page) setList((current) => appendPage(current, page));
    });
  }, [hasMore, list.nextOffset]);

  return {
    entries: list.entries,
    source: list.source,
    total: list.total,
    hasMore,
    loadingMore,
    loadMore,
  };
}
