/**
 * Tests for the media-bin view state (density/filter/sort): defaults, the
 * localStorage round-trip, and corrupt-data tolerance. View/session state only
 * (invariant 5) — never touches the project or timeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_BIN_VIEW, loadMediaBinView, useMediaBinView } from './useMediaBinView.js';

const STORAGE_KEY = 'framepilot.mediaBinView.v1';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('loadMediaBinView', () => {
  it('returns defaults when nothing is persisted', () => {
    expect(loadMediaBinView()).toEqual(DEFAULT_BIN_VIEW);
  });

  it('tolerates corrupt/partial persisted data', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadMediaBinView()).toEqual(DEFAULT_BIN_VIEW);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ density: 'huge', filter: 'video' }));
    expect(loadMediaBinView()).toEqual({ ...DEFAULT_BIN_VIEW, filter: 'video' });
  });
});

describe('useMediaBinView', () => {
  it('starts from defaults and persists each setter', () => {
    const { result } = renderHook(() => useMediaBinView());
    expect(result.current.density).toBe('L');
    expect(result.current.filter).toBe('all');
    expect(result.current.sort).toBe('recent');

    act(() => result.current.setDensity('S'));
    act(() => result.current.setFilter('audio'));
    act(() => result.current.setSort('name'));

    expect(result.current.density).toBe('S');
    expect(result.current.filter).toBe('audio');
    expect(result.current.sort).toBe('name');
    expect(loadMediaBinView()).toEqual({ density: 'S', filter: 'audio', sort: 'name' });
  });
});
