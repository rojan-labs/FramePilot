import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import {
  DEFAULT_SILENCE_CUT,
  noCutsNote,
  silenceCutOps,
  silenceCuts,
  suggestedThreshold,
  wordSafeRange,
} from './silence-cut.js';

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
    const cuts = silenceCuts(
      project,
      {
        assetId: 'asset_1',
        ranges: [
          { start: 6, end: 8 }, // 2 s silence → 1.7 s cut at timeline 11.15–12.85
          { start: 12, end: 12.7 }, // 0.7 s measured: under the 0.8 s threshold asked for
          { start: 24, end: 30 }, // runs past the clip's source end → clipped at 25
          { start: 0, end: 3 }, // before the clip's source window → nothing
        ],
      },
      { minSilenceSeconds: 0.8, keepSeconds: 0.15 },
    );
    expect(cuts).toEqual([
      { trackId: 'video_1', clipId: 'c1', start: snap(11.15), end: snap(12.85) },
      { trackId: 'video_1', clipId: 'c1', start: snap(29.15), end: snap(30) },
    ]);
  });

  it('qualifies a silence on its MEASURED length, not what keepSeconds leaves behind', () => {
    // The double-threshold bug: ffmpeg had already enforced `>= minSilenceSeconds`, and
    // re-checking the trimmed span made the real floor 0.55 + 2 × 0.12 = 0.79 s. A 0.6 s
    // gap the caller asked to cut was therefore silently kept.
    const project = projectWithClip(0, 0, 30);
    const cuts = silenceCuts(
      project,
      { assetId: 'asset_1', ranges: [{ start: 5, end: 5.6 }] },
      { minSilenceSeconds: 0.55, keepSeconds: 0.12 },
    );
    expect(cuts).toEqual([
      { trackId: 'video_1', clipId: 'c1', start: snap(5.12), end: snap(5.48) },
    ]);
  });

  it('still drops a silence measured shorter than the threshold', () => {
    const project = projectWithClip(0, 0, 30);
    expect(
      silenceCuts(
        project,
        { assetId: 'asset_1', ranges: [{ start: 5, end: 5.4 }] },
        { minSilenceSeconds: 0.55, keepSeconds: 0.12 },
      ),
    ).toEqual([]);
  });

  it('drops a qualifying silence whose surviving cut is only a sliver of the clip', () => {
    // Source 10–40 plays; the silence is 2 s but only its last 30 ms is inside the clip.
    const project = projectWithClip(0, 10, 30);
    expect(
      silenceCuts(
        project,
        { assetId: 'asset_1', ranges: [{ start: 8, end: 10 }] },
        { minSilenceSeconds: 0.5, keepSeconds: 0 },
      ),
    ).toEqual([]);
  });

  it('defaults to the same threshold the engine measures at', () => {
    // TS 0.8 vs Python 0.5 meant an omitted argument threw away measured dead air.
    expect(DEFAULT_SILENCE_CUT.minSilenceSeconds).toBe(0.5);
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

describe('noCutsNote — an empty cut list never becomes "there is no dead air"', () => {
  const measuredRun = {
    assetId: 'asset_1',
    ranges: [],
    measuredCount: 56,
    longestSeconds: 0.449,
    belowThresholdSeconds: 10.65,
    probeFloorSeconds: 0.1,
  };

  it('states the measurement and steers DOWN, not up', () => {
    // The run this fixes: 49.77s talking head, 56 gaps, 10.65s of dead air, longest
    // 0.449s. The old note said "0 silence(s) measured", the model raised 0.55 → 0.65
    // and gave up on dead-air removal entirely.
    const note = noCutsNote(measuredRun, { minSilenceSeconds: 0.55, keepSeconds: 0.15 });
    expect(note).toContain('56 silence(s) were measured');
    expect(note).toContain('longest is 0.449s');
    expect(note).toContain('10.7s of dead air sits in shorter gaps');
    expect(note).toContain('minSilenceSeconds: 0.25');
    expect(note).not.toContain('No dead air');
  });

  it('states the threshold it was actually judged at, with keepSeconds out of it', () => {
    // The effective floor used to be minSilenceSeconds + 2 × keepSeconds; the note
    // quoted the request and was wrong by 0.24 s. Now they are the same number.
    expect(noCutsNote(measuredRun, { minSilenceSeconds: 0.55, keepSeconds: 0.12 })).toContain(
      'Nothing to cut at 0.55s',
    );
  });

  it('does not suggest a threshold the tool schema would reject', () => {
    const note = noCutsNote(
      { ...measuredRun, longestSeconds: 0.2, belowThresholdSeconds: 3 },
      { minSilenceSeconds: 0.5, keepSeconds: 0.15 },
    );
    expect(note).not.toContain('minSilenceSeconds:');
    expect(note).toContain('under the 0.2s minimum');
    expect(note).toContain('speed ramps');
  });

  it('says the recording really is continuous when the probe floor found nothing', () => {
    const note = noCutsNote(
      { assetId: 'asset_1', ranges: [], measuredCount: 0, probeFloorSeconds: 0.1 },
      DEFAULT_SILENCE_CUT,
    );
    expect(note).toContain('measured down to 0.1s gaps');
    expect(note).toContain('continuous speech');
    expect(note).toContain('Lowering minSilenceSeconds will not find anything');
  });

  it('returns the engine reason verbatim instead of any inference of its own', () => {
    // `analyze_silence` and `detect_beats` already guarded this; `remove_silences` did
    // not, so a video-only asset was reported as a recording with no dead air.
    const note = noCutsNote(
      {
        assetId: 'asset_1',
        ranges: [],
        reason: 'b.mp4 has no audio track, so there is no silence.',
      },
      DEFAULT_SILENCE_CUT,
    );
    expect(note).toBe('b.mp4 has no audio track, so there is no silence.');
  });

  it('ignores a blank reason and falls through to the measurement', () => {
    const note = noCutsNote({ ...measuredRun, reason: '   ' }, DEFAULT_SILENCE_CUT);
    expect(note).toContain('56 silence(s) were measured');
  });

  it('blames placement, not the threshold, when qualifying silences were found', () => {
    const note = noCutsNote(
      { assetId: 'asset_1', ranges: [{ start: 1, end: 3 }], measuredCount: 4, longestSeconds: 2 },
      DEFAULT_SILENCE_CUT,
    );
    expect(note).toContain('1 silence(s) that long were measured');
    expect(note).toContain('where that asset plays');
    expect(note).not.toContain('minSilenceSeconds:');
  });

  it('admits what it does not know when the engine sent no measurement', () => {
    // Older sidecar build, or a cached pre-v2 analysis row.
    const note = noCutsNote({ assetId: 'asset_1', ranges: [] }, DEFAULT_SILENCE_CUT);
    expect(note).toContain('NOT a finding that the recording has no dead air');
    expect(note).toContain('0.25');
  });
});

describe('suggestedThreshold', () => {
  it('aims under the longest measured gap, on a clean 0.05 step', () => {
    expect(suggestedThreshold(0.449)).toBe(0.25);
    expect(suggestedThreshold(1.2)).toBe(0.7);
  });

  it('returns null when no legal threshold could reach the gaps', () => {
    expect(suggestedThreshold(0.3)).toBeNull();
    expect(suggestedThreshold(0)).toBeNull();
  });
});
