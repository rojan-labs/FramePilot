/**
 * Performance complexity guard (plan/PLAN.md Phase 8 — "Performance budgets";
 * see docs/guides/performance-budgets.md).
 *
 * This is NOT a precise benchmark — wall-clock on CI is noisy. It is a coarse
 * guard against a *catastrophic* algorithmic regression (e.g. an accidental
 * O(n²) in the apply path) using a deliberately generous ceiling that never
 * flakes on a healthy implementation but trips loudly on a quadratic blow-up.
 *
 * The interaction-latency budget (< 16 ms per edit) rests on each operation being
 * ~O(clips). Applying many trims over a many-clip timeline must stay roughly
 * linear: 10k applies over a 1k-clip timeline complete in well under a second on
 * the reference machine; the 5 s ceiling is ~CI×slack.
 */
import { describe, expect, it } from 'vitest';
import { applyOperation } from './operations.js';
import type { Clip, Timeline } from '@framepilot/timeline-schema';

const CLIP_COUNT = 1000;
const APPLY_COUNT = 10_000;
const CEILING_MS = 5000;

function manyClipTimeline(n: number): Timeline {
  const clips: Clip[] = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    assetId: 'asset_1',
    trackId: 'video_1',
    start: i * 10,
    end: i * 10 + 10,
    sourceStart: 0,
    sourceEnd: 10,
    effects: [],
    keyframes: [],
  }));
  return { tracks: [{ id: 'video_1', type: 'video', clips }] };
}

describe('apply-path complexity guard', () => {
  it('stays roughly linear over many sequential trims', () => {
    let timeline = manyClipTimeline(CLIP_COUNT);
    const start = performance.now();
    for (let i = 0; i < APPLY_COUNT; i++) {
      const id = `c${i % CLIP_COUNT}`;
      const base = (i % CLIP_COUNT) * 10;
      // Alternate the trim so the timeline keeps changing but stays valid.
      const end = base + (i % 2 === 0 ? 9 : 10);
      timeline = applyOperation(timeline, { type: 'trim_clip', clipId: id, start: base, end });
    }
    const elapsed = performance.now() - start;
    expect(timeline.tracks[0]!.clips).toHaveLength(CLIP_COUNT);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });
});
