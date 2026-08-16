/**
 * Persisted height for the full-width timeline dock (J1 extraction of logic
 * that used to be inlined in apps/web-editor's `Editor.tsx` — plan
 * FRAMEPILOT-AI-PRODUCT-PLAN.md §6). View state only (invariant 5), persisted
 * through an injected {@link WorkspacePersistenceAdapter} (defaults to
 * `localStorage`, matching the pre-extraction behavior exactly, including the
 * `framepilot.timelineDock.height` storage key).
 */
import { useCallback, useState } from 'react';
import { type WorkspacePersistenceAdapter, localStorageAdapter } from './persistence.js';

/** Min timeline-dock height + min top-region height (px) when dragging. */
export const TIMELINE_MIN = 160;
export const TOP_REGION_MIN = 240;
export const DEFAULT_TIMELINE_HEIGHT = 260;
/** Persisted dock height — mirrors the rail-layout localStorage convention. */
export const TIMELINE_DOCK_KEY = 'framepilot.timelineDock.height';

/**
 * Largest dock height that still leaves the top region at least `topRegionMin`,
 * so the timeline never crushes the preview + sidebars on a short window.
 */
export function maxDockHeight(topRegionMin: number = TOP_REGION_MIN, min: number = TIMELINE_MIN): number {
  if (typeof window === 'undefined') return Number.POSITIVE_INFINITY;
  // ~44px topbar + ~28px status bar frame the workspace; be generous, then clamp.
  return Math.max(min, window.innerHeight - 72 - topRegionMin);
}

function loadDockHeight(
  adapter: WorkspacePersistenceAdapter,
  storageKey: string,
  min: number,
  topRegionMin: number,
  defaultHeight: number,
): number {
  const max = maxDockHeight(topRegionMin, min);
  const raw = adapter.getItem(storageKey);
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const wanted = Number.isFinite(value) ? value : defaultHeight;
  return Math.min(max, Math.max(min, wanted));
}

export interface DockHeightOptions {
  readonly adapter?: WorkspacePersistenceAdapter;
  readonly storageKey?: string;
  readonly min?: number;
  readonly topRegionMin?: number;
  readonly defaultHeight?: number;
}

export interface DockLayout {
  readonly height: number;
  readonly setHeight: (height: number) => void;
}

/** Manage the timeline dock's height, persisted through `adapter`. */
export function useDockHeight(options: DockHeightOptions = {}): DockLayout {
  const {
    adapter = localStorageAdapter,
    storageKey = TIMELINE_DOCK_KEY,
    min = TIMELINE_MIN,
    topRegionMin = TOP_REGION_MIN,
    defaultHeight = DEFAULT_TIMELINE_HEIGHT,
  } = options;

  const [height, setHeightState] = useState<number>(() =>
    loadDockHeight(adapter, storageKey, min, topRegionMin, defaultHeight),
  );

  const setHeight = useCallback(
    (next: number): void => {
      setHeightState(next);
      adapter.setItem(storageKey, String(Math.round(next)));
    },
    [adapter, storageKey],
  );

  return { height, setHeight };
}
