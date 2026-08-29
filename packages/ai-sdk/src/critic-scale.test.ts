/**
 * The editorial checks scale with the edit, rather than with the square of it
 * (context-management Phase 4).
 *
 * The Critic runs at the end of every agent run, so a check that is O(cuts × words) is a
 * check that makes reviewing an hour of footage a visible pause. Two mistakes were live
 * here and both are what this guards:
 *
 * - `word_severed` compared every cut against every word (with a seconds-to-frame
 *   conversion inside the inner loop), and `audio_slam` compared every cut against every
 *   audio edge. Both are searched now, not scanned.
 * - Four of the six editorial checks read the cut list, and each called
 *   `listEditBoundaries` for itself — four full timeline-map walks per review. It is built
 *   once and shared.
 * - `mapTranscript` (`editor-core`, which `dead_air` reads and every caption derivation
 *   already paid) tested every word against every span: 167ms for an hour of footage,
 *   now 2ms. That one was not ours and predates this phase.
 *
 * ## Why this measures a RATIO and not a millisecond budget
 *
 * It measured milliseconds first, and that was the wrong instrument. CI runs
 * `turbo run test:coverage`: v8 instrumentation multiplies the cost about fourfold, and
 * every other package's suite is competing for the same machine. The same fixture measured
 * 185ms alone, 805ms under coverage, and 9,629ms under coverage plus full parallel load —
 * a 52x spread that no single threshold sits inside honestly. A budget wide enough to
 * survive the worst case is wide enough to pass the quadratic version it exists to catch.
 *
 * A ratio is invariant to all of it: the small and large runs pay the same instrumentation
 * and the same contention, so what is left is the shape. The version this was written
 * against measured **67x**.
 *
 * ## Why it keeps the FASTEST run and not the total
 *
 * A ratio is only as honest as its noisiest term, and summing repeats was collecting
 * every hiccup rather than averaging them out. That flaked: on a 10-core machine under
 * coverage plus 12-way CPU saturation, summing three repeats measured 9.8x, 10.5x, 21.5x
 * and **26.9x** across four consecutive runs — the last one over the ceiling, failing a
 * suite that had found nothing wrong. Keeping the fastest of five instead measured
 * **11.8x, 13.5x, 14.8x, 16.3x** under that same load. A GC pause or a descheduled core
 * can only ever ADD time to a sample, so the minimum is the one least contaminated by
 * whatever else the machine is doing.
 *
 * Measured with that estimator: **8.4-9.1x clean, 10.0-10.6x under coverage** for ten
 * times the project — sub-linear, because the fixed costs stop being the whole story as
 * the project grows.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { critique } from './critic.js';

const FPS = 30;

/** Ten times the material at each step: ~6 minutes, then ~an hour. */
const SMALL = { clips: 90, words: 900 };
const LARGE = { clips: 900, words: 9_000 };

/**
 * Ten times the work may cost at most this much more.
 *
 * Linear is 10 and the measured figure is 8.4-9.1x clean (sub-linear: at the small size
 * the fixed costs — schema parse, one map walk — are a real share of the total). The
 * ceiling is 25 rather than 10 because the small case is only a couple of milliseconds,
 * so its measurement is the noisy one, and because instrumentation and contention do not
 * load both sizes equally: the worst seen under coverage plus deliberate 12-way CPU
 * saturation is 16.3x. Quadratic is 100 and the version this was written against measured
 * 67x, so 25 still fails it decisively. It is deliberately NOT tightened to sit against
 * the observed spread — the guard exists to catch a change in shape, not to police
 * millisecond drift.
 */
const MAX_GROWTH = 25;

/** Timed runs per size. The fastest one is kept — see `costOf`. */
const REPEATS = 5;

function project({ clips, words }: { clips: number; words: number }): Project {
  const picture = Array.from({ length: clips }, (_, i) => ({
    id: `clip_${i}`,
    trackId: 'video_1',
    assetId: 'asset_1',
    start: i * 4,
    end: i * 4 + 4,
    sourceStart: i * 9,
    sourceEnd: i * 9 + 4,
    // One transition, so `transition_fit` has something to check rather than skipping —
    // a check that skips is fast for the wrong reason and would prove nothing here.
    effects:
      i === 1
        ? [
            {
              id: 'fx_1',
              type: 'transition',
              params: { kind: 'fade', durationSeconds: 0.5 },
              keyframes: [],
            },
          ]
        : [],
    keyframes: [],
  }));
  return parseProject({
    id: 'proj_scale',
    name: 'Scale',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: clips * 9 },
      { id: 'asset_music', path: 'media/m.mp3', kind: 'audio', durationSeconds: clips * 4 },
    ],
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips: picture },
        {
          id: 'audio_1',
          type: 'audio',
          clips: picture.map((clip) => ({
            ...clip,
            id: `audio_${clip.id}`,
            trackId: 'audio_1',
            assetId: 'asset_music',
          })),
        },
      ],
      revision: 1,
    },
    transcript: Array.from({ length: words }, (_, i) => ({
      word: `word${i}`,
      start: i * 0.4,
      end: i * 0.4 + 0.3,
    })),
    aiMemory: {},
    history: [],
  });
}

/** A timed span shorter than this is mostly clock resolution, not work. */
const MIN_SAMPLE_MS = 5;

/**
 * The cost of ONE critique at this size, in milliseconds.
 *
 * Two defences against measuring the machine instead of the code:
 *
 * 1. **Each sample times a BATCH, not a single call.** A small-project critique runs well
 *    under the timer's resolution, so a one-call sample used to come back as ~0 and get
 *    floored by the caller — which made the ratio's denominator a constant and let any
 *    slow large-size sample explode it. (Observed: a 62.7x reading under a loaded,
 *    coverage-instrumented suite, from a test that passes comfortably on its own.) The
 *    batch grows until the span is worth reading, so both terms of the ratio are real.
 * 2. **The fastest sample wins.** A GC pause or a descheduled core can only ever ADD time,
 *    never subtract it, so the minimum is the sample least contaminated by whatever else
 *    the machine was doing. Summing does the opposite: it collects every hiccup.
 */
function costOf(size: { clips: number; words: number }): number {
  const built = project(size);
  // One warm-up, so JIT compilation is not billed to whichever size runs first.
  critique(built, { producedChanges: true });

  // Calibrate the batch: enough calls that one sample clears MIN_SAMPLE_MS.
  let batch = 1;
  for (;;) {
    const started = performance.now();
    for (let i = 0; i < batch; i += 1) critique(built, { producedChanges: true });
    const elapsed = performance.now() - started;
    if (elapsed >= MIN_SAMPLE_MS || batch >= 4096) break;
    batch *= 2;
  }

  let fastest = Infinity;
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const started = performance.now();
    for (let i = 0; i < batch; i += 1) critique(built, { producedChanges: true });
    fastest = Math.min(fastest, (performance.now() - started) / batch);
  }
  return fastest;
}

describe('critique scales with the edit', () => {
  it(`costs under ${String(MAX_GROWTH)}x for ten times the project`, () => {
    // Asserted first: the editorial checks actually RAN at this size. A version that
    // skipped them would be beautifully fast and prove nothing.
    const report = critique(project(LARGE), { producedChanges: true });
    for (const id of ['jump_cut', 'word_severed', 'audio_slam', 'transition_fit'] as const) {
      expect(report.checks.find((c) => c.id === id)?.status, id).not.toBe('skipped');
    }

    const small = costOf(SMALL);
    const large = costOf(LARGE);
    // No floor on the denominator: `costOf` guarantees both terms are real measurements
    // (see MIN_SAMPLE_MS), so flooring here would only hide a genuine result.
    const growth = large / small;
    expect(growth, `10x the project cost ${growth.toFixed(1)}x the time`).toBeLessThan(MAX_GROWTH);
  });
});
