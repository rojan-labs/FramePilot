/**
 * Tests for the persistent rail layout (plan 3.4 Part 4): width clamping,
 * collapse, and localStorage round-trip. View state only — never the timeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { COLLAPSED_WIDTH, RAIL_BOUNDS, clampRailWidth, useRailLayout } from './useRailLayout.js';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('clampRailWidth', () => {
  it('clamps each rail to its bounds', () => {
    expect(clampRailWidth('left', 10)).toBe(RAIL_BOUNDS.left.min);
    expect(clampRailWidth('left', 9999)).toBe(RAIL_BOUNDS.left.max);
    expect(clampRailWidth('right', 300)).toBe(300);
  });
});

describe('useRailLayout', () => {
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
