/**
 * Perf regression guard for the filmstrip zoom path (plan AGENT-NATIVE-UX P5).
 *
 * A zoom gesture re-renders every clip with a new width each tick. The filmstrip
 * must do work ONLY when the quantized slot count changes (a bucket crossing),
 * never per tick: `filmstripSlots` quantizes width → slots, and `ClipFilmstrip`
 * is memoized on its props. This test counts frame-derivation calls (a proxy for
 * "the strip recomputed/redrew") across a simulated zoom sweep and asserts they
 * stay bounded by bucket crossings — the regression that made thumbnails-on zoom
 * lag was exactly this work running on every tick, per clip.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Asset } from '@framepilot/timeline-schema';
import { ClipFilmstrip, filmstripSlots } from './ClipFilmstrip.js';

const counters = vi.hoisted(() => ({ frameDerivations: 0 }));

vi.mock('../editor/selectors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../editor/selectors.js')>();
  return {
    ...actual,
    clipFilmstripFrames: (...args: Parameters<typeof actual.clipFilmstripFrames>) => {
      counters.frameDerivations += 1;
      return actual.clipFilmstripFrames(...args);
    },
  };
});

const asset: Asset = {
  id: 'v1',
  path: '/media/clip.mp4',
  kind: 'video',
  durationSeconds: 10,
  media: { thumbnailPaths: Array.from({ length: 16 }, (_, i) => `t${i}.jpg`) },
};

describe('ClipFilmstrip perf — zoom ticks do bounded work', () => {
  it('recomputes only on slot-bucket crossings, not per zoom tick', () => {
    // Simulate a continuous zoom: clip width sweeps 300→560px in 20px ticks.
    const widths = Array.from({ length: 14 }, (_, i) => 300 + i * 20);
    const distinctBuckets = new Set(widths.map((w) => filmstripSlots(w))).size;

    const { rerender } = render(
      <ClipFilmstrip
        asset={asset}
        sourceStart={0}
        sourceEnd={10}
        slots={filmstripSlots(widths[0]!)}
      />,
    );
    for (const width of widths.slice(1)) {
      rerender(
        <ClipFilmstrip
          asset={asset}
          sourceStart={0}
          sourceEnd={10}
          slots={filmstripSlots(width)}
        />,
      );
    }

    // One derivation per DISTINCT bucket (memo skips same-props re-renders), plus
    // at most one from the thumbnail hook's initial state settle — 14 ticks must
    // never mean 14 recomputes.
    expect(distinctBuckets).toBeLessThan(widths.length);
    expect(counters.frameDerivations).toBeLessThanOrEqual(distinctBuckets + 1);
  });
});
