/**
 * A mounted waveform repaints when the theme changes (ADR 0198).
 *
 * The canvas resolves its colours from the theme at paint time, and a theme switch
 * does not resize it — so without the shared theme signal it kept the old theme's
 * colours until the next resize. The paint is observed through `getComputedStyle`
 * on the canvas, which is exactly where the colours are read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ClipWaveform, clearWaveformBitmapCache } from './ClipWaveform.js';

vi.mock('../editor/useWaveformPeaks.js', () => ({
  useWaveformPeaks: () => ({ peaks: [0.2, 0.6, 0.9, 0.4] }),
}));

/** Let the MutationObserver's microtask deliver. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  // Run frames immediately: the repaint is rAF-coalesced.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  clearWaveformBitmapCache();
});

/** How many times the theme colours were read from a waveform canvas. */
function colourReads(spy: { readonly mock: { readonly calls: readonly unknown[][] } }): number {
  return spy.mock.calls.filter(([element]) => element instanceof HTMLCanvasElement).length;
}

describe('ClipWaveform theme repaint', () => {
  it('re-reads its colours when data-theme flips, and stops after unmount', async () => {
    const getStyle = vi.spyOn(window, 'getComputedStyle');
    const { unmount } = render(
      <ClipWaveform
        assetId="vo"
        media={undefined}
        assetPath={undefined}
        sourceStart={0}
        sourceEnd={4}
        variant="band"
      />,
    );
    const afterMount = colourReads(getStyle);
    expect(afterMount).toBeGreaterThan(0);

    document.documentElement.dataset.theme = 'light';
    await flush();
    const afterSwitch = colourReads(getStyle);
    expect(afterSwitch).toBe(afterMount + 1);

    unmount();
    document.documentElement.dataset.theme = 'dark';
    await flush();
    expect(colourReads(getStyle)).toBe(afterSwitch);
  });
});
