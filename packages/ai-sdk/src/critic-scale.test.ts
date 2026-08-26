/**
 * The editorial checks stay affordable on a real project (context-management Phase 4).
 *
 * The Critic runs at the end of every agent run, so a check that is O(cuts × words) is a
 * check that makes a review of an hour of footage cost a visible pause. `word_severed`
 * compares every cut against every word and `audio_slam` compares every cut against every
 * audio edge; both are searched rather than scanned.
 *
 * There was also a cheaper mistake underneath: four of the six editorial checks read the
 * cut list, and each one called `listEditBoundaries` for itself — four full timeline-map
 * walks per review. It is built once now and shared.
 *
 * This is a budget, not a benchmark. See {@link BUDGET_MS} for the measured margin.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { critique } from './critic.js';

const FPS = 30;
/** An hour of footage: ~900 cuts and ~9,000 spoken words. */
const CLIPS = 900;
const WORDS = 9_000;
/**
 * Measured, with the margin stated rather than guessed.
 *
 * On this fixture: ~185ms uninstrumented, ~805ms under v8 coverage. CI runs
 * `turbo run test:coverage`, so the instrumented figure is the one that has to fit, and
 * it competes with every other package's suite for the machine. 4,000ms is roughly five
 * times the instrumented cost — loose enough not to flake under that load, and tight
 * enough to catch what it is for: before the checks shared one boundary list and searched
 * instead of scanned, this same fixture took **7,755ms** under coverage.
 */
const BUDGET_MS = 4_000;

function hourLongProject(): Project {
  const clips = Array.from({ length: CLIPS }, (_, i) => ({
    id: `clip_${i}`,
    trackId: 'video_1',
    assetId: 'asset_1',
    start: i * 4,
    end: i * 4 + 4,
    sourceStart: i * 9,
    sourceEnd: i * 9 + 4,
    effects: [],
    keyframes: [],
  }));
  const audio = clips.map((clip) => ({
    ...clip,
    id: `audio_${clip.id}`,
    trackId: 'audio_1',
    assetId: 'asset_music',
  }));
  return parseProject({
    id: 'proj_hour',
    name: 'An hour',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 9_000 },
      { id: 'asset_music', path: 'media/m.mp3', kind: 'audio', durationSeconds: 3_600 },
    ],
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips },
        { id: 'audio_1', type: 'audio', clips: audio },
      ],
      revision: 1,
    },
    transcript: Array.from({ length: WORDS }, (_, i) => ({
      word: `word${i}`,
      start: i * 0.4,
      end: i * 0.4 + 0.3,
    })),
    aiMemory: {},
    history: [],
  });
}

describe('critique on an hour of footage', () => {
  it(`finishes well inside ${String(BUDGET_MS)}ms`, () => {
    const project = hourLongProject();
    const started = performance.now();
    const report = critique(project, { producedChanges: true });
    const elapsed = performance.now() - started;
    // It actually ran the editorial checks, rather than skipping them and being fast for
    // the wrong reason.
    expect(report.checks.find((c) => c.id === 'word_severed')?.status).not.toBe('skipped');
    expect(report.checks.find((c) => c.id === 'audio_slam')?.status).not.toBe('skipped');
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
