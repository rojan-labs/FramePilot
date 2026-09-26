import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LIVE_ANNOUNCEMENT_GAP_MS, useLiveAnnouncement } from './useLiveAnnouncement.js';

describe('useLiveAnnouncement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('empties the region, then sets the message, so it is read as a change', () => {
    const { result } = renderHook(() => useLiveAnnouncement());
    expect(result.current[0]).toBe('');
    act(() => result.current[1]('Added Fire at 0:12'));
    // Empty first: a screen reader only speaks a live region whose text changed.
    expect(result.current[0]).toBe('');
    act(() => vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_GAP_MS));
    expect(result.current[0]).toBe('Added Fire at 0:12');
  });

  it('reads the same message again when it is repeated', () => {
    const { result } = renderHook(() => useLiveAnnouncement());
    act(() => result.current[1]('Added Fire at 0:12'));
    act(() => vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_GAP_MS));
    act(() => result.current[1]('Added Fire at 0:12'));
    // Setting the same text twice would not re-render, and nothing would be spoken.
    expect(result.current[0]).toBe('');
    act(() => vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_GAP_MS));
    expect(result.current[0]).toBe('Added Fire at 0:12');
  });

  it('keeps only the newest of two quick messages', () => {
    const { result } = renderHook(() => useLiveAnnouncement());
    act(() => {
      result.current[1]('first');
      result.current[1]('second');
    });
    act(() => vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_GAP_MS));
    expect(result.current[0]).toBe('second');
  });

  it('says nothing after it unmounts', () => {
    const { result, unmount } = renderHook(() => useLiveAnnouncement());
    act(() => result.current[1]('late'));
    unmount();
    expect(() => vi.advanceTimersByTime(LIVE_ANNOUNCEMENT_GAP_MS)).not.toThrow();
  });
});
