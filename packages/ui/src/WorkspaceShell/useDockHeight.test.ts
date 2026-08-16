/**
 * Tests for the persisted timeline-dock height (J1 extraction of logic that
 * used to be inlined in apps/web-editor's `Editor.tsx` — plan
 * FRAMEPILOT-AI-PRODUCT-PLAN.md §6): default/clamped height and
 * persistence-adapter round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEFAULT_TIMELINE_HEIGHT,
  TIMELINE_DOCK_KEY,
  TIMELINE_MIN,
  useDockHeight,
} from './useDockHeight.js';
import type { WorkspacePersistenceAdapter } from './persistence.js';

function memoryAdapter(): WorkspacePersistenceAdapter & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('useDockHeight (default adapter — localStorage)', () => {
  it('defaults to DEFAULT_TIMELINE_HEIGHT and persists a resize under TIMELINE_DOCK_KEY', () => {
    const { result } = renderHook(() => useDockHeight());
    expect(result.current.height).toBe(DEFAULT_TIMELINE_HEIGHT);

    act(() => result.current.setHeight(300));
    expect(result.current.height).toBe(300);
    expect(localStorage.getItem(TIMELINE_DOCK_KEY)).toBe('300');
  });

  it('clamps a persisted height below the minimum on load', () => {
    localStorage.setItem(TIMELINE_DOCK_KEY, '10');
    const { result } = renderHook(() => useDockHeight());
    expect(result.current.height).toBe(TIMELINE_MIN);
  });

  it('falls back to the default on corrupt persisted data', () => {
    localStorage.setItem(TIMELINE_DOCK_KEY, 'not a number');
    const { result } = renderHook(() => useDockHeight());
    expect(result.current.height).toBe(DEFAULT_TIMELINE_HEIGHT);
  });
});

describe('useDockHeight (injected adapter — J1 pluggable persistence)', () => {
  it('reads and writes exclusively through the injected adapter', () => {
    const adapter = memoryAdapter();
    adapter.store.set(TIMELINE_DOCK_KEY, '400');
    const setItem = vi.spyOn(adapter, 'setItem');

    const { result } = renderHook(() => useDockHeight({ adapter }));
    expect(result.current.height).toBe(400);

    act(() => result.current.setHeight(320.6));
    expect(setItem).toHaveBeenCalledWith(TIMELINE_DOCK_KEY, '321'); // rounded
    expect(localStorage.getItem(TIMELINE_DOCK_KEY)).toBeNull(); // never touched
  });

  it('honors a custom storageKey/min/defaultHeight, clamping only on load (the caller — e.g. StageSplitter — clamps before calling setHeight)', () => {
    const adapter = memoryAdapter();
    const { result } = renderHook(() =>
      useDockHeight({ adapter, storageKey: 'custom.key', min: 80, defaultHeight: 120 }),
    );
    expect(result.current.height).toBe(120);

    // setHeight itself does not clamp (matches the pre-extraction `setDockHeight`) —
    // it stores whatever the caller passes, rounded.
    act(() => result.current.setHeight(10));
    expect(adapter.store.get('custom.key')).toBe('10');

    // But loading a too-small persisted value back DOES clamp to `min`.
    const { result: reloaded } = renderHook(() =>
      useDockHeight({ adapter, storageKey: 'custom.key', min: 80, defaultHeight: 120 }),
    );
    expect(reloaded.current.height).toBe(80);
  });
});
