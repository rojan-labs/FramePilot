/**
 * Tests for the persistent rail layout (J1 extraction of apps/web-editor's
 * `useRailLayout.test.ts` — plan FRAMEPILOT-AI-PRODUCT-PLAN.md §6): width
 * clamping, collapse, and persistence-adapter round-trip. View state only —
 * never the timeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  COLLAPSED_WIDTH,
  RAIL_BOUNDS,
  clampRailWidth,
  clampRailWidthsToContainer,
  useRailLayout,
} from './useRailLayout.js';
import type { WorkspacePersistenceAdapter } from './persistence.js';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** A minimal in-memory adapter, so tests can assert exactly what the hook wrote. */
function memoryAdapter(): WorkspacePersistenceAdapter & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
}

describe('clampRailWidth', () => {
  it('clamps each rail to its bounds', () => {
    expect(clampRailWidth('left', 10)).toBe(RAIL_BOUNDS.left.min);
    expect(clampRailWidth('left', 9999)).toBe(RAIL_BOUNDS.left.max);
    expect(clampRailWidth('right', 300)).toBe(300);
  });
});

describe('clampRailWidthsToContainer', () => {
  const desired = (overrides: Partial<Parameters<typeof clampRailWidthsToContainer>[1]> = {}) => ({
    left: RAIL_BOUNDS.left.default,
    leftCollapsed: false,
    right: RAIL_BOUNDS.right.default,
    rightCollapsed: false,
    ...overrides,
  });

  it('is a no-op when unmeasured (Infinity — e.g. jsdom with no ResizeObserver)', () => {
    expect(clampRailWidthsToContainer(Number.POSITIVE_INFINITY, desired())).toEqual({
      left: RAIL_BOUNDS.left.default,
      right: RAIL_BOUNDS.right.default,
    });
  });

  it('is a no-op when both rails already fit within the stage minimum', () => {
    expect(clampRailWidthsToContainer(2000, desired())).toEqual({
      left: RAIL_BOUNDS.left.default,
      right: RAIL_BOUNDS.right.default,
    });
  });

  it('shrinks both rails proportionally, never below their own min, on a narrow window', () => {
    // 1024px window, both rails persisted at max (480 + 520 = 1000px) would leave
    // only 24px for the stage — must give way to preserve MIN_STAGE_WIDTH (320px).
    const result = clampRailWidthsToContainer(1024, desired({ left: 480, right: 520 }));
    expect(result.left).toBeGreaterThanOrEqual(RAIL_BOUNDS.left.min);
    expect(result.right).toBeGreaterThanOrEqual(RAIL_BOUNDS.right.min);
    expect(result.left + result.right).toBeLessThanOrEqual(1024 - 320);
  });

  it('leaves a collapsed rail untouched and shrinks only the expanded one', () => {
    const result = clampRailWidthsToContainer(
      700,
      desired({ left: COLLAPSED_WIDTH, leftCollapsed: true, right: 520 }),
    );
    expect(result.left).toBe(COLLAPSED_WIDTH);
    expect(result.right).toBeLessThan(520);
    expect(result.right).toBeGreaterThanOrEqual(RAIL_BOUNDS.right.min);
  });

  it('floors both rails at their bounds min when there is no slack left to give', () => {
    // Even at their bounds minimum (220 + 260 = 480px), a 400px container can't
    // fit both rails plus MIN_STAGE_WIDTH — best effort is the bounds minimum.
    const result = clampRailWidthsToContainer(400, desired({ left: 220, right: 260 }));
    expect(result).toEqual({ left: RAIL_BOUNDS.left.min, right: RAIL_BOUNDS.right.min });
  });
});

describe('useRailLayout (default adapter — localStorage)', () => {
  it('starts from defaults and persists a resize', () => {
    const { result } = renderHook(() => useRailLayout());
    expect(result.current.leftWidth).toBe(RAIL_BOUNDS.left.default);

    act(() => result.current.setWidth('left', 9999));
    expect(result.current.left.width).toBe(RAIL_BOUNDS.left.max);
    expect(JSON.parse(localStorage.getItem('framepilot.rail.left')!).width).toBe(
      RAIL_BOUNDS.left.max,
    );
  });

  it('collapses a rail to the strip width and back', () => {
    const { result } = renderHook(() => useRailLayout());
    act(() => result.current.toggleCollapsed('right'));
    expect(result.current.right.collapsed).toBe(true);
    expect(result.current.rightWidth).toBe(COLLAPSED_WIDTH);
    act(() => result.current.toggleCollapsed('right'));
    expect(result.current.rightWidth).toBe(RAIL_BOUNDS.right.default);
  });

  it('restores persisted state on mount and tolerates corrupt data', () => {
    localStorage.setItem('framepilot.rail.left', JSON.stringify({ width: 320, collapsed: true }));
    localStorage.setItem('framepilot.rail.right', 'not json');
    const { result } = renderHook(() => useRailLayout());
    expect(result.current.left.collapsed).toBe(true);
    expect(result.current.left.width).toBe(320);
    expect(result.current.right.width).toBe(RAIL_BOUNDS.right.default); // fell back
  });
});

describe('useRailLayout (injected adapter — J1 pluggable persistence)', () => {
  it('reads initial state through the injected adapter, not localStorage', () => {
    const adapter = memoryAdapter();
    adapter.store.set('framepilot.rail.left', JSON.stringify({ width: 260, collapsed: false }));
    localStorage.setItem('framepilot.rail.left', JSON.stringify({ width: 480, collapsed: true }));

    const { result } = renderHook(() => useRailLayout(adapter));
    // The adapter's value wins — the hook never touched localStorage directly.
    expect(result.current.left.width).toBe(260);
    expect(result.current.left.collapsed).toBe(false);
  });

  it('writes resizes and collapse toggles through the injected adapter with the right key/value shape', () => {
    const adapter = memoryAdapter();
    const setItem = vi.spyOn(adapter, 'setItem');
    const { result } = renderHook(() => useRailLayout(adapter));

    act(() => result.current.setWidth('right', 300));
    expect(setItem).toHaveBeenCalledWith(
      'framepilot.rail.right',
      JSON.stringify({ width: 300, collapsed: false }),
    );
    expect(localStorage.getItem('framepilot.rail.right')).toBeNull(); // never touched

    act(() => result.current.toggleCollapsed('left'));
    expect(setItem).toHaveBeenCalledWith(
      'framepilot.rail.left',
      JSON.stringify({ width: RAIL_BOUNDS.left.default, collapsed: true }),
    );
  });
});
