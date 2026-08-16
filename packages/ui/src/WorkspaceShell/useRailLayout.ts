/**
 * The persistent layout for a workspace's resizable/collapsible side rails
 * (J1 extraction of apps/web-editor's `useRailLayout.ts` — plan
 * FRAMEPILOT-AI-PRODUCT-PLAN.md §6). Rail widths and collapsed flags are
 * **view state**, never project/timeline state: a host persists them
 * (by default to `localStorage`, via an injected {@link WorkspacePersistenceAdapter}).
 *
 * The width clamping is pure and unit-tested; the hook is the thin React +
 * storage shell around it. Behavior, key names (`framepilot.rail.<side>`), and
 * bounds are unchanged from the pre-extraction version — apps/web-editor keeps
 * using this via a thin re-export so its existing behavior/tests are untouched.
 */
import { useCallback, useState } from 'react';
import { type WorkspacePersistenceAdapter, localStorageAdapter } from './persistence.js';

/** Width bounds (px) for each rail — wide enough to be useful, capped to leave the stage room. */
export const RAIL_BOUNDS = {
  left: { min: 220, max: 480, default: 288 },
  right: { min: 260, max: 520, default: 360 },
} as const;

/** Width (px) a collapsed rail shows — a thin strip with just an expand button. */
export const COLLAPSED_WIDTH = 24;

export type RailSide = 'left' | 'right';

/** Clamp a proposed rail width to that rail's bounds. */
export function clampRailWidth(side: RailSide, width: number): number {
  const { min, max } = RAIL_BOUNDS[side];
  return Math.min(max, Math.max(min, width));
}

/** Minimum center-stage width (px) — the program monitor/timeline dock must stay
 * usable, so the rails give way first as the workspace narrows (e.g. a laptop
 * window down to ~1024px) rather than letting the stage shrink toward zero. */
export const MIN_STAGE_WIDTH = 320;

export interface EffectiveRailWidths {
  readonly left: number;
  readonly right: number;
}

/**
 * Shrink the two rails — proportionally, never below their own `RAIL_BOUNDS`
 * min — so together they never leave the center stage under
 * {@link MIN_STAGE_WIDTH}. Collapsed rails are already at their minimal strip
 * width and are left untouched. `containerWidth` of `Infinity` (unmeasured —
 * e.g. jsdom, which has no `ResizeObserver`) is a deliberate no-op: this only
 * ever shrinks the widths the caller already resolved, never grows them.
 */
export function clampRailWidthsToContainer(
  containerWidth: number,
  desired: {
    readonly left: number;
    readonly leftCollapsed: boolean;
    readonly right: number;
    readonly rightCollapsed: boolean;
  },
): EffectiveRailWidths {
  const { left, leftCollapsed, right, rightCollapsed } = desired;
  if (!Number.isFinite(containerWidth)) return { left, right };

  const budget = Math.max(0, containerWidth - MIN_STAGE_WIDTH);
  const total = left + right;
  if (total <= budget) return { left, right };

  const leftFloor = leftCollapsed ? left : RAIL_BOUNDS.left.min;
  const rightFloor = rightCollapsed ? right : RAIL_BOUNDS.right.min;
  const leftSlack = leftCollapsed ? 0 : Math.max(0, left - leftFloor);
  const rightSlack = rightCollapsed ? 0 : Math.max(0, right - rightFloor);
  const totalSlack = leftSlack + rightSlack;
  if (totalSlack <= 0) return { left: leftFloor, right: rightFloor };

  const shrink = Math.min(total - budget, totalSlack);
  return {
    left: Math.round(left - shrink * (leftSlack / totalSlack)),
    right: Math.round(right - shrink * (rightSlack / totalSlack)),
  };
}

interface RailState {
  readonly width: number;
  readonly collapsed: boolean;
}

const STORAGE_PREFIX = 'framepilot.rail.';

/** Read persisted rail state, falling back to defaults (and tolerating bad data). */
function loadRail(adapter: WorkspacePersistenceAdapter, side: RailSide): RailState {
  const fallback: RailState = { width: RAIL_BOUNDS[side].default, collapsed: false };
  const raw = adapter.getItem(`${STORAGE_PREFIX}${side}`);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<RailState>;
    return {
      width: typeof parsed.width === 'number' ? clampRailWidth(side, parsed.width) : fallback.width,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return fallback;
  }
}

function saveRail(adapter: WorkspacePersistenceAdapter, side: RailSide, state: RailState): void {
  adapter.setItem(`${STORAGE_PREFIX}${side}`, JSON.stringify(state));
}

export interface RailLayout {
  readonly left: RailState;
  readonly right: RailState;
  /** Effective grid widths in px (collapsed rails report {@link COLLAPSED_WIDTH}). */
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly setWidth: (side: RailSide, width: number) => void;
  readonly toggleCollapsed: (side: RailSide) => void;
}

/**
 * Manage both rails' widths + collapsed flags, persisted through `adapter`
 * (defaults to `localStorage`, matching this hook's pre-extraction behavior).
 */
export function useRailLayout(adapter: WorkspacePersistenceAdapter = localStorageAdapter): RailLayout {
  const [left, setLeft] = useState<RailState>(() => loadRail(adapter, 'left'));
  const [right, setRight] = useState<RailState>(() => loadRail(adapter, 'right'));

  const update = useCallback(
    (side: RailSide, next: RailState): void => {
      saveRail(adapter, side, next);
      (side === 'left' ? setLeft : setRight)(next);
    },
    [adapter],
  );

  const setWidth = useCallback(
    (side: RailSide, width: number): void => {
      const clamped = clampRailWidth(side, width);
      update(side, { width: clamped, collapsed: false });
    },
    [update],
  );

  const toggleCollapsed = useCallback(
    (side: RailSide): void => {
      const current = side === 'left' ? left : right;
      update(side, { ...current, collapsed: !current.collapsed });
    },
    [left, right, update],
  );

  return {
    left,
    right,
    leftWidth: left.collapsed ? COLLAPSED_WIDTH : left.width,
    rightWidth: right.collapsed ? COLLAPSED_WIDTH : right.width,
    setWidth,
    toggleCollapsed,
  };
}
