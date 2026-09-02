import { describe, expect, it } from 'vitest';
import type { Clip, Project } from '@framepilot/timeline-schema';
import { makeProject } from '../__fixtures__/project.js';
import {
  checkCaptionStyleMatches,
  checkCaptionsWellFormed,
  checkFirstClipHeadTrimmed,
  checkFirstTwoSwapped,
  checkContentPreserved,
  checkCutawayInWindow,
  checkCutawayOnOccupiedTrack,
  checkDurationKept,
  checkNoPictureStacking,
  checkFirstClipEndsAt,
  checkLastClipMovedFirst,
  checkMusicCovers,
  checkMusicQuieter,
  checkNoGaps,
  checkNotDestructive,
  checkOnlyClipsTouched,
  checkOpensLaterInSource,
  checkUnchanged,
  checkCutsOnBeats,
  checkCutsOnFrameGrid,
  checkKeptClipsUntouched,
  checkNoMidWordCuts,
  checkNoOverlaps,
  checkValidRefs,
  scoreMissionScenario,
  projectDuration,
} from './mission-rubric.js';

function clip(id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    assetId: 'asset_1',
    trackId: 'video_1',
    start,
    end,
    sourceStart: start,
    sourceEnd: end,
    effects: [],
    keyframes: [],
    ...extra,
  } as Clip;
}

function withClips(clips: Clip[], audio: Clip[] = []): Project {
  const base = makeProject();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: [
        { id: 'video_1', type: 'video', clips },
        { id: 'audio_1', type: 'audio', clips: audio },
      ],
    },
  } as Project;
}

describe('mission rubric — primitive checks', () => {
  it('measures timeline duration as the furthest clip end on any track', () => {
    expect(projectDuration(withClips([clip('a', 0, 4), clip('b', 4, 9.5)]))).toBe(9.5);
  });

  it('flags off-grid edges at the project fps', () => {
    expect(checkCutsOnFrameGrid(withClips([clip('a', 0, 1), clip('b', 1, 2.5)])).ok).toBe(true);
    const off = checkCutsOnFrameGrid(withClips([clip('a', 0, 1.01)]));
    expect(off.ok).toBe(false);
    expect(off.detail).toContain('1 clip edge');
  });

  it('flags overlapping clips on one track', () => {
    expect(checkNoOverlaps(withClips([clip('a', 0, 5), clip('b', 4, 9)])).ok).toBe(false);
    expect(checkNoOverlaps(withClips([clip('a', 0, 5), clip('b', 5, 9)])).ok).toBe(true);
  });

  it('flags dangling asset refs and empty ranges', () => {
    expect(checkValidRefs(withClips([clip('a', 0, 5, { assetId: 'ghost' })])).ok).toBe(false);
    expect(checkValidRefs(withClips([clip('a', 3, 3)])).ok).toBe(false);
    expect(checkValidRefs(withClips([clip('a', 0, 3)])).ok).toBe(true);
  });

  it('flags a clip edge that lands inside a spoken word', () => {
    const p = withClips([clip('a', 0, 0.75)]);
    // makeProject transcript: hello 0–0.5, world 0.5–1 → edge at 0.75 is inside "world"
    expect(checkNoMidWordCuts(p).ok).toBe(false);
    expect(checkNoMidWordCuts(withClips([clip('a', 0, 0.5)])).ok).toBe(true);
  });

  it('scores cuts against a beat grid anchored on the placed music', () => {
    const music = clip('m', 1, 25, { assetId: 'music', trackId: 'audio_1', sourceStart: 0, sourceEnd: 24 });
    const base = withClips([clip('a', 0, 1.6), clip('b', 1.6, 2.2), clip('c', 2.2, 2.8)], [music]);
    const p = { ...base, assets: [...base.assets, { id: 'music', path: 'm.wav', kind: 'audio' as const }] } as Project;
    const on = checkCutsOnBeats(p, 0.6);
    expect(on.ok).toBe(true);
    expect(on.detail).toContain('2/2');
    const offBase = withClips([clip('a', 0, 1.9), clip('b', 1.9, 2.2)], [music]);
    const off = checkCutsOnBeats({ ...offBase, assets: p.assets } as Project, 0.6);
    expect(off.ok).toBe(false);
    expect(checkCutsOnBeats(withClips([clip('a', 0, 1), clip('b', 1, 2)]), 0.6).detail).toBe('no music placed');
  });

  it('detects a named "keep" clip whose source range changed', () => {
    const before = withClips([clip('a', 0, 5), clip('b', 5, 10)]);
    const after = withClips([clip('a', 0, 5), clip('b', 5, 8, { sourceEnd: 8 })]);
    expect(checkKeptClipsUntouched({ before, after, keepClipIds: ['a'] }).ok).toBe(true);
    expect(checkKeptClipsUntouched({ before, after, keepClipIds: ['b'] }).ok).toBe(false);
  });
});

describe('mission rubric — scenarios', () => {
  it('montage-30s: unchanged timeline scores the common checks only', () => {
    const before = makeProject();
    const s = scoreMissionScenario('montage-30s', { before, after: before });
    expect(s.checks.find((c) => c.id === 'timeline-changed')?.ok).toBe(false);
    expect(s.checks.find((c) => c.id === 'duration-within')?.ok).toBe(false);
    expect(s.score).toBeLessThan(0.6);
  });

  it('montage-30s: a 30-second, 6-clip, on-grid, non-overlapping timeline scores 1', () => {
    const before = makeProject();
    const clips = Array.from({ length: 6 }, (_, i) => clip(`c${i}`, i * 5, i * 5 + 5));
    const s = scoreMissionScenario('montage-30s', { before, after: withClips(clips) });
    expect(s.score).toBe(1);
  });

  it('remove-dead-air: shorter + changed + no mid-word cuts passes', () => {
    const before = withClips([clip('a', 0, 10)]);
    const after = withClips([clip('a', 0, 0.5), clip('b', 0.5, 4, { sourceStart: 1, sourceEnd: 4.5 })]);
    const s = scoreMissionScenario('remove-dead-air', { before, after });
    expect(s.checks.every((c) => c.ok)).toBe(true);
  });

  it('memory-captions: needs a caption track with clips', () => {
    const before = makeProject();
    const after = {
      ...before,
      timeline: {
        ...before.timeline,
        tracks: [...before.timeline.tracks, { id: 'cap_1', type: 'caption', clips: [clip('k', 0, 1)] }],
      },
    } as Project;
    expect(scoreMissionScenario('memory-captions', { before, after }).checks.find((c) => c.id === 'has-captions')?.ok).toBe(true);
    expect(scoreMissionScenario('memory-captions', { before, after: before }).checks.find((c) => c.id === 'has-captions')?.ok).toBe(false);
  });
});

// ── goal.md Phase 0 golden-set checks ────────────────────────────────────────────────

describe('golden-set checks', () => {
  const five = () =>
    withClips([clip('c1', 0, 40), clip('c2', 40, 62), clip('c3', 62, 71), clip('c4', 71, 86), clip('c5', 86, 136)]);

  it('checkFirstClipEndsAt is frame-exact', () => {
    expect(checkFirstClipEndsAt(withClips([clip('c1', 0, 10)]), 10).ok).toBe(true);
    // One frame off at 30 fps is a miss, not "close enough".
    const off = checkFirstClipEndsAt(withClips([clip('c1', 0, 10 + 1 / 30)]), 10);
    expect(off.ok).toBe(false);
    expect(off.detail).toMatch(/1\.00 frame/);
    expect(off.facet).toBe('boundary');
    expect(checkFirstClipEndsAt(withClips([]), 10).ok).toBe(false);
  });

  it('checkOnlyClipsTouched allows the target and a ripple, not a stray edit', () => {
    const before = five();
    // Trim c1 to 10 s with ripple: everyone else moves but keeps content.
    const rippled = withClips([
      clip('c1', 0, 10, { sourceStart: 0, sourceEnd: 10 }),
      clip('c2', 10, 32, { sourceStart: 40, sourceEnd: 62 }),
      clip('c3', 32, 41, { sourceStart: 62, sourceEnd: 71 }),
      clip('c4', 41, 56, { sourceStart: 71, sourceEnd: 86 }),
      clip('c5', 56, 106, { sourceStart: 86, sourceEnd: 136 }),
    ]);
    expect(checkOnlyClipsTouched({ before, after: rippled }, ['c1']).ok).toBe(true);
    const stray = withClips([clip('c1', 0, 10, { sourceEnd: 10 }), clip('c2', 10, 20, { sourceStart: 40, sourceEnd: 50 })]);
    const r = checkOnlyClipsTouched({ before, after: stray }, ['c1']);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('c2');
    expect(r.detail).toContain('c3');
  });

  it('checkLastClipMovedFirst + checkContentPreserved + checkNoGaps describe a reorder', () => {
    const before = five();
    const rotated = withClips([
      clip('c5', 0, 50, { sourceStart: 86, sourceEnd: 136 }),
      clip('c1', 50, 90, { sourceStart: 0, sourceEnd: 40 }),
      clip('c2', 90, 112, { sourceStart: 40, sourceEnd: 62 }),
      clip('c3', 112, 121, { sourceStart: 62, sourceEnd: 71 }),
      clip('c4', 121, 136, { sourceStart: 71, sourceEnd: 86 }),
    ]);
    expect(checkLastClipMovedFirst({ before, after: rotated }).ok).toBe(true);
    expect(checkContentPreserved({ before, after: rotated }).ok).toBe(true);
    expect(checkNoGaps(rotated).ok).toBe(true);
    expect(checkLastClipMovedFirst({ before, after: before }).ok).toBe(false);
    expect(checkLastClipMovedFirst({ before: withClips([clip('c1', 0, 1)]), after: before }).ok).toBe(false);
    const cut = withClips([clip('c5', 0, 40, { sourceStart: 86, sourceEnd: 126 }), clip('c1', 45, 85)]);
    expect(checkContentPreserved({ before, after: cut }).ok).toBe(false);
    expect(checkNoGaps(cut).detail).toBe('1 gap(s)');
  });

  it('checkOpensLaterInSource sees a hook pulled forward', () => {
    const before = withClips([clip('c1', 0, 100)]);
    const hooked = withClips([clip('h', 0, 5, { sourceStart: 40, sourceEnd: 45 }), clip('c1', 5, 105)]);
    expect(checkOpensLaterInSource({ before, after: hooked }).ok).toBe(true);
    expect(checkOpensLaterInSource({ before, after: before }).ok).toBe(false);
    expect(checkOpensLaterInSource({ before: withClips([]), after: before }).ok).toBe(false);
  });

  it('checkCutawayInWindow + checkDurationKept describe a b-roll cutaway', () => {
    const before = withClips([clip('talk', 0, 100)]);
    const cutaway = withClips([
      clip('talk', 0, 5),
      clip('b', 5, 12, { assetId: 'asset_broll', sourceStart: 0, sourceEnd: 7 }),
      clip('talk2', 12, 100, { sourceStart: 12, sourceEnd: 100 }),
    ]);
    expect(checkCutawayInWindow(cutaway, ['asset_broll'], [0, 20]).ok).toBe(true);
    expect(checkCutawayInWindow(cutaway, ['asset_broll'], [30, 50]).ok).toBe(false);
    expect(checkCutawayInWindow(cutaway, ['other'], [0, 20]).ok).toBe(false);
    expect(checkDurationKept({ before, after: cutaway }).ok).toBe(true);
    expect(checkDurationKept({ before, after: withClips([clip('talk', 0, 90)]) }).ok).toBe(false);
  });

  it('checkMusicCovers + checkMusicQuieter describe a music bed', () => {
    const base = makeProject();
    const withMusicAsset: Project = {
      ...base,
      assets: [...base.assets, { id: 'asset_music', path: 'media/beat.wav', kind: 'audio', durationSeconds: 120 }],
    };
    const music = (gainDb: number | undefined, end = 100) =>
      ({
        ...withMusicAsset,
        timeline: {
          ...withMusicAsset.timeline,
          tracks: [
            { id: 'video_1', type: 'video', clips: [clip('talk', 0, 100)] },
            {
              id: 'audio_1',
              type: 'audio',
              clips: [
                clip('m', 0, end, {
                  assetId: 'asset_music',
                  effects: gainDb === undefined ? [] : [{ id: 'g', type: 'audio_gain', params: { gainDb }, keyframes: [] }],
                }),
              ],
            },
          ],
        },
      }) as Project;
    expect(checkMusicCovers(music(-12), 'asset_music').ok).toBe(true);
    expect(checkMusicCovers(music(-12, 30), 'asset_music').ok).toBe(false);
    expect(checkMusicCovers(music(-12), undefined).ok).toBe(true);
    expect(checkMusicQuieter(music(-12), 'asset_music').ok).toBe(true);
    expect(checkMusicQuieter(music(0), 'asset_music').ok).toBe(false);
    expect(checkMusicQuieter(music(undefined), 'asset_music').ok).toBe(false);
    expect(checkMusicQuieter(withMusicAsset, 'asset_music').ok).toBe(false);
  });

  it('checkCaptionsWellFormed wants text inside the programme', () => {
    const base = withClips([clip('talk', 0, 30)]);
    const captions = (cues: Clip[]) =>
      ({
        ...base,
        timeline: { ...base.timeline, tracks: [...base.timeline.tracks, { id: 'caption_1', type: 'caption', clips: cues }] },
      }) as Project;
    const cue = (id: string, start: number, end: number, text: string) =>
      clip(id, start, end, { assetId: '__caption__', captionCue: { text, words: [] } } as Partial<Clip>);
    expect(checkCaptionsWellFormed(captions([cue('k1', 0, 2, 'hello'), cue('k2', 2, 4, 'world')])).ok).toBe(true);
    expect(checkCaptionsWellFormed(captions([])).ok).toBe(false);
    expect(checkCaptionsWellFormed(captions([cue('k1', 0, 2, '  ')])).ok).toBe(false);
    expect(checkCaptionsWellFormed(captions([cue('k1', 40, 42, 'late')])).ok).toBe(false);
  });

  it('checkUnchanged and checkNotDestructive guard the ask/decline/vague cases', () => {
    const before = five();
    expect(checkUnchanged({ before, after: before }).ok).toBe(true);
    expect(checkUnchanged({ before, after: withClips([]) }).ok).toBe(false);
    expect(checkNotDestructive({ before, after: withClips([clip('c1', 0, 70)]) }).ok).toBe(true);
    expect(checkNotDestructive({ before, after: withClips([clip('c1', 0, 30)]) }).ok).toBe(false);
    expect(checkNotDestructive({ before: withClips([]), after: withClips([]) }).ok).toBe(true);
  });

  it('every golden rubric scores and the intent-only rubrics are 1 on an untouched timeline', () => {
    const before = five();
    expect(scoreMissionScenario('unchanged', { before, after: before }).score).toBe(1);
    expect(scoreMissionScenario('vague-not-destructive', { before, after: before }).score).toBe(1);
    for (const id of [
      'trim-first-clip',
      'reorder-last-first',
      'captions',
      'hook-first',
      'broll-cutaway',
      'music-bed',
      'compound-silence-captions',
    ] as const) {
      const s = scoreMissionScenario(id, { before, after: before, expectedFirstClipEndSeconds: 10 });
      expect(s.score, id).toBeLessThan(1);
      expect(s.checks.some((c) => c.facet === 'target' || c.facet === 'boundary'), `${id} has a faceted check`).toBe(true);
    }
  });
});

describe('second phrasings of the core verbs', () => {
  const five = () =>
    withClips([clip('c1', 0, 40), clip('c2', 40, 62), clip('c3', 62, 71), clip('c4', 71, 86), clip('c5', 86, 136)]);

  it('checkFirstClipHeadTrimmed wants the source start moved by exactly N seconds', () => {
    const before = five();
    const headTrimmed = withClips([clip('c1', 0, 30, { sourceStart: 10, sourceEnd: 40 }), clip('c2', 30, 52, { sourceStart: 40, sourceEnd: 62 })]);
    expect(checkFirstClipHeadTrimmed({ before, after: headTrimmed }, 10).ok).toBe(true);
    // Trimming the END by ten seconds is the other verb, and it does not pass.
    const tailTrimmed = withClips([clip('c1', 0, 30, { sourceStart: 0, sourceEnd: 30 })]);
    expect(checkFirstClipHeadTrimmed({ before, after: tailTrimmed }, 10).ok).toBe(false);
    const oneFrameOff = withClips([clip('c1', 0, 30, { sourceStart: 10 + 1 / 30, sourceEnd: 40 + 1 / 30 })]);
    expect(checkFirstClipHeadTrimmed({ before, after: oneFrameOff }, 10).ok).toBe(false);
    expect(checkFirstClipHeadTrimmed({ before: withClips([]), after: before }, 10).ok).toBe(false);
  });

  it('checkFirstTwoSwapped accepts only the swap', () => {
    const before = five();
    const swapped = withClips([
      clip('c2', 0, 22, { sourceStart: 40, sourceEnd: 62 }),
      clip('c1', 22, 62, { sourceStart: 0, sourceEnd: 40 }),
      clip('c3', 62, 71, { sourceStart: 62, sourceEnd: 71 }),
      clip('c4', 71, 86, { sourceStart: 71, sourceEnd: 86 }),
      clip('c5', 86, 136, { sourceStart: 86, sourceEnd: 136 }),
    ]);
    expect(checkFirstTwoSwapped({ before, after: swapped }).ok).toBe(true);
    expect(checkFirstTwoSwapped({ before, after: before }).ok).toBe(false);
    expect(checkFirstTwoSwapped({ before: withClips([clip('c1', 0, 1)]), after: before }).ok).toBe(false);
    expect(scoreMissionScenario('reorder-swap-first-two', { before, after: swapped }).score).toBe(1);
  });

  it('checkCaptionStyleMatches reads the cue style, else the track default', () => {
    const base = withClips([clip('talk', 0, 30)]);
    const captions = (trackStyle: object | undefined, cues: Clip[]) =>
      ({
        ...base,
        timeline: {
          ...base.timeline,
          tracks: [
            ...base.timeline.tracks,
            { id: 'caption_1', type: 'caption', clips: cues, ...(trackStyle ? { captionStyle: trackStyle } : {}) },
          ],
        },
      }) as Project;
    const cue = (id: string, style?: object) =>
      clip(id, 0, 2, { assetId: '__caption__', captionCue: { text: 'hi', words: [] }, ...(style ? { captionStyle: style } : {}) } as Partial<Clip>);
    const want = { textTransform: 'uppercase', position: 'bottom' };
    expect(checkCaptionStyleMatches(captions({ textTransform: 'uppercase' }, [cue('k1'), cue('k2')]), want).ok).toBe(true);
    expect(checkCaptionStyleMatches(captions(undefined, [cue('k1', { textTransform: 'uppercase' }), cue('k2')]), want).ok).toBe(false);
    expect(checkCaptionStyleMatches(captions({ textTransform: 'uppercase', position: 'top' }, [cue('k1')]), want).ok).toBe(false);
    expect(checkCaptionStyleMatches(captions({ textTransform: 'uppercase' }, []), want).ok).toBe(false);
    expect(checkCaptionStyleMatches(captions(undefined, [cue('k1')]), {}).ok).toBe(true);
  });
});

/**
 * Run `369e8c82`'s shape, and what a correct answer to it looks like. `mission-overlay` is
 * the only fixture that has it: a gapless picture track plus an EMPTY second video track,
 * where ADR 0140 refuses every placement on the empty one.
 */
describe('b-roll over an empty overlay track', () => {
  /** Narration gapless on `video_1`, `b_roll` above it holding whatever is passed. */
  const overlay = (main: Clip[], broll: Clip[] = []): Project => {
    const base = makeProject();
    return {
      ...base,
      assets: [...base.assets, { id: 'asset_broll', path: 'media/broll/b2.mov', kind: 'video', durationSeconds: 9 }],
      timeline: {
        ...base.timeline,
        // `tracks[0]` is the visual front, so the overlay track comes first.
        tracks: [
          { id: 'b_roll', type: 'video', clips: broll },
          { id: 'video_1', type: 'video', clips: main },
          { id: 'audio_1', type: 'audio', clips: [] },
        ],
      },
    } as Project;
  };
  const b = (id: string, start: number, end: number, trackId: string) =>
    clip(id, start, end, { assetId: 'asset_broll', trackId, sourceStart: 0, sourceEnd: end - start });
  const before = () => overlay([clip('talk', 0, 100)]);
  /** The right answer: split the narration and drop the cutaway into the gap it opened. */
  const cutIn = () =>
    overlay([
      clip('talk', 0, 5),
      b('bro', 5, 12, 'video_1'),
      clip('talk2', 12, 100, { sourceStart: 12, sourceEnd: 100 }),
    ]);
  /** The trap: the same b-roll dropped on the empty layer, on top of the narration. */
  const stacked = () => overlay([clip('talk', 0, 100)], [b('bro', 5, 12, 'b_roll')]);

  it('checkNoPictureStacking sees the overlap `checkNoOverlaps` cannot', () => {
    expect(checkNoPictureStacking(cutIn()).ok).toBe(true);
    const bad = checkNoPictureStacking(stacked());
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('bro on b_roll');
    // The per-track check is blind to it — which is exactly why the new one exists.
    expect(checkNoOverlaps(stacked()).ok).toBe(true);
  });

  it('checkCutawayOnOccupiedTrack wants the b-roll cut into the programme', () => {
    expect(checkCutawayOnOccupiedTrack({ before: before(), after: cutIn() }, ['asset_broll']).ok).toBe(true);
    expect(checkCutawayOnOccupiedTrack({ before: before(), after: stacked() }, ['asset_broll']).ok).toBe(false);
    // Refused everywhere and nothing placed is a miss too, and says so in its own words.
    const none = checkCutawayOnOccupiedTrack({ before: before(), after: before() }, ['asset_broll']);
    expect(none.ok).toBe(false);
    expect(none.detail).toBe('no b-roll placed at all');
  });

  it('scores the cut-in 1 and every wrong answer below it', () => {
    const ctx = (after: Project) => ({
      before: before(),
      after,
      brollAssetIds: ['asset_broll'],
      cutawayWindowSeconds: [0, 20] as const,
    });
    expect(scoreMissionScenario('broll-cutaway-empty-overlay', ctx(cutIn())).score).toBe(1);
    expect(scoreMissionScenario('broll-cutaway-empty-overlay', ctx(stacked())).score).toBeLessThan(1);
    expect(scoreMissionScenario('broll-cutaway-empty-overlay', ctx(before())).score).toBeLessThan(1);
    // A cutaway that lengthened the programme instead of covering part of it.
    const appended = overlay([clip('talk', 0, 100), b('bro', 100, 107, 'video_1')]);
    expect(scoreMissionScenario('broll-cutaway-empty-overlay', ctx(appended)).score).toBeLessThan(1);
  });
});
