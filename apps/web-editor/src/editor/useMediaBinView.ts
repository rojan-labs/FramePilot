/**
 * Media-bin view state — density, kind filter, and sort (redesign brief, Media
 * sidebar pass 1). Like {@link useTrackLayout}, this is **view/session state,
 * not project state** (invariant 5): it describes how this person likes to
 * browse the bin, never anything about its contents. Persisted to
 * `localStorage` so it survives a reload, same load-tolerant-parse + save shape
 * as `useTrackLayout.ts`.
 */
import { useCallback, useState } from 'react';

/** Grid density: how many columns the footage grid renders (S=4, M=3, L=2). */
export type BinDensity = 'S' | 'M' | 'L';
/** Kind filter over the flattened bin (mirrors {@link Asset.kind}, plus "all"). */
export type BinFilter = 'all' | 'video' | 'audio' | 'image';
/** Sort key applied once the bin is off its default (folder-tree) view. */
export type BinSort = 'recent' | 'name' | 'duration' | 'type' | 'unused';

export interface MediaBinViewState {
  readonly density: BinDensity;
  readonly filter: BinFilter;
  readonly sort: BinSort;
}

/**
 * Default density is 'L' (2 columns, 96px thumbnails) — the bin's shipped
 * layout today. Density is additive/opt-in; the un-configured default must
 * reproduce the existing look exactly, not silently re-lay-out every project.
 */
export const DEFAULT_BIN_VIEW: MediaBinViewState = {
  density: 'L',
  filter: 'all',
  sort: 'recent',
};

const STORAGE_KEY = 'framepilot.mediaBinView.v1';

const DENSITIES: ReadonlySet<string> = new Set<BinDensity>(['S', 'M', 'L']);
const FILTERS: ReadonlySet<string> = new Set<BinFilter>(['all', 'video', 'audio', 'image']);
const SORTS: ReadonlySet<string> = new Set<BinSort>([
  'recent',
  'name',
  'duration',
  'type',
  'unused',
]);

/** Coerce untrusted parsed JSON to a valid {@link MediaBinViewState}. */
function normalize(raw: unknown): MediaBinViewState {
  if (!raw || typeof raw !== 'object') return DEFAULT_BIN_VIEW;
  const p = raw as Partial<Record<keyof MediaBinViewState, unknown>>;
  return {
    density:
      typeof p.density === 'string' && DENSITIES.has(p.density)
        ? (p.density as BinDensity)
        : DEFAULT_BIN_VIEW.density,
    filter:
      typeof p.filter === 'string' && FILTERS.has(p.filter)
        ? (p.filter as BinFilter)
        : DEFAULT_BIN_VIEW.filter,
    sort:
      typeof p.sort === 'string' && SORTS.has(p.sort) ? (p.sort as BinSort) : DEFAULT_BIN_VIEW.sort,
  };
}

/** Read the persisted view state, tolerating missing/corrupt data. */
export function loadMediaBinView(): MediaBinViewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BIN_VIEW;
    return normalize(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_BIN_VIEW;
  }
}

function saveMediaBinView(view: MediaBinViewState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    /* storage may be unavailable (private mode); the view still works in-session. */
  }
}

/** The media-bin view API: current state plus setters, persisted as they change. */
export interface UseMediaBinView extends MediaBinViewState {
  readonly setDensity: (density: BinDensity) => void;
  readonly setFilter: (filter: BinFilter) => void;
  readonly setSort: (sort: BinSort) => void;
}

/** Manage the bin's density/filter/sort, persisted to `localStorage`. */
export function useMediaBinView(): UseMediaBinView {
  const [view, setView] = useState<MediaBinViewState>(() => loadMediaBinView());

  const update = useCallback((patch: Partial<MediaBinViewState>): void => {
    setView((current) => {
      const next = { ...current, ...patch };
      saveMediaBinView(next);
      return next;
    });
  }, []);

  return {
    ...view,
    setDensity: useCallback((density: BinDensity) => update({ density }), [update]),
    setFilter: useCallback((filter: BinFilter) => update({ filter }), [update]),
    setSort: useCallback((sort: BinSort) => update({ sort }), [update]),
  };
}
