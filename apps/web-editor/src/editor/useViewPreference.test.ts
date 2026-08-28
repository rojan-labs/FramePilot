/**
 * Tests for the view-preference hook. The behaviours that matter are the ones a person
 * notices: a setting survives a reload, an unset editor looks exactly as it shipped, and a
 * value that is no longer legal does not strand the UI in a state it cannot render.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oneOf, useViewPreference } from './useViewPreference.js';

type Tab = 'media' | 'effects';
const TABS = oneOf<Tab>(['media', 'effects']);

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useViewPreference', () => {
  it('returns the fallback when nothing is stored', () => {
    const { result } = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    expect(result.current[0]).toBe('media');
    // An un-configured editor must not write anything either — a default is not a choice.
    expect(localStorage.getItem('framepilot.view.t')).toBeNull();
  });

  it('persists a change and reads it back on the next mount', () => {
    const first = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    act(() => {
      first.result.current[1]('effects');
    });
    expect(first.result.current[0]).toBe('effects');

    // A fresh mount is what a reload is.
    const second = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    expect(second.result.current[0]).toBe('effects');
  });

  it('namespaces its keys so it cannot collide with the older stores', () => {
    const { result } = renderHook(() => useViewPreference<Tab>('leftTab', 'media', TABS));
    act(() => {
      result.current[1]('effects');
    });
    expect(localStorage.getItem('framepilot.view.leftTab')).toBe('"effects"');
  });

  it('accepts an updater, like useState', () => {
    const { result } = renderHook(() => useViewPreference<number>('n', 1, (r) =>
      typeof r === 'number' ? r : undefined,
    ));
    act(() => {
      result.current[1]((current) => current + 1);
    });
    expect(result.current[0]).toBe(2);
    expect(localStorage.getItem('framepilot.view.n')).toBe('2');
  });

  it('falls back rather than rendering a value this build no longer knows', () => {
    // The exact hazard: a tab id that was legal in a previous version. Restoring it would
    // select a panel that no longer exists.
    localStorage.setItem('framepilot.view.t', '"a-tab-that-was-removed"');
    const { result } = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    expect(result.current[0]).toBe('media');
  });

  it.each([
    ['corrupt JSON', 'not json at all'],
    ['a null', 'null'],
    ['an object where a string belongs', '{"nope":1}'],
  ])('falls back on %s', (_label, stored) => {
    localStorage.setItem('framepilot.view.t', stored);
    const { result } = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    expect(result.current[0]).toBe('media');
  });

  it('still works when storage is denied (private mode)', () => {
    // Reading and writing both throw; the preference must degrade to in-session state
    // rather than taking the editor down with it.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    expect(result.current[0]).toBe('media');
    act(() => {
      result.current[1]('effects');
    });
    expect(result.current[0]).toBe('effects');
  });

  it('does not write when the value did not actually change', () => {
    const { result } = renderHook(() => useViewPreference<Tab>('t', 'media', TABS));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      result.current[1]('media');
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('oneOf', () => {
  it('accepts only the listed values', () => {
    const coerce = oneOf(['a', 'b']);
    expect(coerce('a')).toBe('a');
    expect(coerce('c')).toBeUndefined();
    expect(coerce(1)).toBeUndefined();
    expect(coerce(null)).toBeUndefined();
  });
});
