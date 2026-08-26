/**
 * The editorial checks stay affordable on a real project (context-management Phase 4).
 *
 * The Critic runs at the end of every agent run, so a check that is O(cuts × words) is a
 * check that makes a review of an hour of footage cost a visible pause. `word_severed`
 * compares every cut against every word and `audio_slam` compares every cut against every
 * audio edge; both are searched rather than scanned.
 *
 * This is a budget, not a benchmark: the number is generous enough not to be flaky on a
 * loaded CI box, and small enough that reintroducing the nested scan (measured at
 * multiple seconds on this fixture) fails it.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { critique } from './critic.js';

const FPS = 30;
/** An hour of footage: ~900 cuts and ~9,000 spoken words. */
const CLIPS = 900;
const WORDS = 9_000;
const BUDGET_MS = 1_500;

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
