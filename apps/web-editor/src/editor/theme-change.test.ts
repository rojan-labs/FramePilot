/**
 * The shared theme-change signal behind the waveform repaint (ADR 0198).
 *
 * What matters: a `data-theme` flip and an OS scheme flip both reach every
 * subscriber, and however many clips subscribe there is ONE observer and ONE
 * media-query listener — not one per waveform — released after the last leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeThemeChange } from './theme-change.js';

/** Let the MutationObserver's microtask deliver. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let schemeListeners: Set<() => void>;
let observersCreated: number;
const RealMutationObserver = globalThis.MutationObserver;

beforeEach(() => {
  schemeListeners = new Set();
  observersCreated = 0;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: (_: string, listener: () => void) => schemeListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => schemeListeners.delete(listener),
    })),
  );
  class CountingObserver extends RealMutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observersCreated += 1;
    }
  }
  vi.stubGlobal('MutationObserver', CountingObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('subscribeThemeChange', () => {
  it('tells every subscriber when data-theme changes, through one shared observer', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeThemeChange(first);
    const stopSecond = subscribeThemeChange(second);
    expect(observersCreated).toBe(1);
    expect(schemeListeners.size).toBe(1);

    document.documentElement.dataset.theme = 'light';
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    stopSecond();
  });

  it('tells subscribers when the OS colour scheme flips', () => {
    const listener = vi.fn();
    const stop = subscribeThemeChange(listener);
    for (const fire of schemeListeners) fire();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops watching after the last subscriber leaves', async () => {
    const listener = vi.fn();
    const stop = subscribeThemeChange(listener);
    stop();
    expect(schemeListeners.size).toBe(0);

    document.documentElement.dataset.theme = 'dark';
    await flush();
    expect(listener).not.toHaveBeenCalled();

    // A later subscriber starts a fresh watcher rather than reusing a dead one.
    const again = vi.fn();
    const stopAgain = subscribeThemeChange(again);
    expect(observersCreated).toBe(2);
    document.documentElement.dataset.theme = 'light';
    await flush();
    expect(again).toHaveBeenCalledTimes(1);
    stopAgain();
  });
});
