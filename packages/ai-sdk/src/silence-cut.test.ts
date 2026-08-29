import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { silenceCutOps, silenceCuts, wordSafeRange } from './silence-cut.js';

const snap = (seconds: number): number => Math.round(seconds * 30) / 30;

function projectWithClip(
  start: number,
  sourceStart: number,
  length: number,
  speed?: number,
): Project {
  const base = makeProject();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'asset_1',
              trackId: 'video_1',
              start,
              end: start + length,
              sourceStart,
              sourceEnd: sourceStart + length,
              effects: [],
              keyframes: [],
              ...(speed ? { speed } : {}),
            },
          ],
        },
      ],
    },
  } as Project;
}

describe('silenceCuts', () => {
  it('maps source silences onto the clip, keeps breath, drops short ones, snaps to frames', () => {
    const project = projectWithClip(10, 5, 20); // source 5–25 plays at timeline 10–30
    const cuts = silenceCuts(project, {
      assetId: 'asset_1',
      ranges: [
        { start: 6, end: 8 }, // 2 s silence → 1.7 s cut at timeline 11.15–12.85
        { start: 12, end: 12.9 }, // 0.9 s → 0.6 s after keep: below the 0.8 s floor
        { start: 24, end: 30 }, // runs past the clip's source end → clipped at 25
        { start: 0, end: 3 }, // before the clip's source window → nothing
      ],
    });
    expect(cuts).toEqual([
      { trackId: 'video_1', clipId: 'c1', start: snap(11.15), end: snap(12.85) },
      { trackId: 'video_1', clipId: 'c1', start: snap(29.15), end: snap(30) },
    ]);
  });

  it('ignores clips of other assets and speed-changed clips', () => {
    const other = projectWithClip(0, 0, 10);
    expect(silenceCuts(other, { assetId: 'asset_9', ranges: [{ start: 1, end: 4 }] })).toEqual([]);
    const ramped = projectWithClip(0, 0, 10, 2);
    expect(silenceCuts(ramped, { assetId: 'asset_1', ranges: [{ start: 1, end: 4 }] })).toEqual([]);
  });
});

describe('silenceCutOps', () => {
  it('emits ripple deletes last-to-first and reports the seconds removed', () => {
    const project = projectWithClip(0, 0, 60);
    const { ops, removedSeconds } = silenceCutOps(project, {
      assetId: 'asset_1',
      ranges: [
        { start: 5, end: 7 },
        { start: 20, end: 23 },
      ],
    });
    expect(ops.map((o) => (o as { start: number }).start)).toEqual([snap(20.15), snap(5.15)]);
    expect(ops[0]).toEqual({
      type: 'ripple_delete',
      trackId: 'video_1',
      start: snap(20.15),
      end: snap(22.85),
    });
    expect(removedSeconds).toBeCloseTo(snap(22.85) - snap(20.15) + (snap(6.85) - snap(5.15)), 5);
  });
});

describe('wordSafeRange — a cut never opens inside a word (P4.1)', () => {
  const words = [
    { start: 1.0, end: 1.4 },
    { start: 2.0, end: 2.5 },
    { start: 5.0, end: 5.6 },
  ];

  it('leaves a cut that already sits in a gap exactly where it is', () => {
    expect(wordSafeRange(2.6, 4.9, words)).toEqual({ start: 2.6, end: 4.9 });
  });

  it("moves a start inside a word to that word's end", () => {
    // silencedetect heard the trailing sibilant of "…ss" as silence.
    expect(wordSafeRange(2.2, 4.0, words)).toEqual({ start: 2.5, end: 4.0 });
  });

  it("moves an end inside a word to that word's start", () => {
    expect(wordSafeRange(3.0, 5.3, words)).toEqual({ start: 3.0, end: 5.0 });
  });

  it('only ever shrinks the cut — it never eats into speech', () => {
    const corrected = wordSafeRange(1.2, 5.2, words)!;
    expect(corrected.start).toBeGreaterThanOrEqual(1.2);
    expect(corrected.end).toBeLessThanOrEqual(5.2);
    expect(corrected).toEqual({ start: 1.4, end: 5.0 });
  });

  it('drops a range that a word swallows entirely', () => {
    // Wholly inside one word: start → 2.5, end → 2.0, nothing left.
    expect(wordSafeRange(2.1, 2.4, words)).toBeNull();
  });

  it('treats a boundary-exact edge as already clean', () => {
    expect(wordSafeRange(1.4, 2.0, words)).toEqual({ start: 1.4, end: 2.0 });
  });

  it('is the identity with no transcript', () => {
    expect(wordSafeRange(1.2, 5.2, [])).toEqual({ start: 1.2, end: 5.2 });
  });
});
