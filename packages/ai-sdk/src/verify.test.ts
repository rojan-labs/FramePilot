/**
 * Tests for enhancement verification (ADR 0076).
 *
 * The bar these set is specific: the exact captions the broken pipeline used to
 * produce — right text, plausible-looking times, source timestamps — must be
 * *detected*, with an issue that names the drift. A verification that passes
 * those is worse than none, because it converts an unverified claim into a
 * verified-looking one.
 */
import { describe, expect, it } from 'vitest';
import { buildTimelineMap, deriveCaptionCues, captionSegmentConfig } from '@framepilot/editor-core';
import type { Clip, Project, TranscriptWord } from '@framepilot/timeline-schema';
import { verifyCaptions, verifyTransitions } from './verify.js';

const ASSET = 'asset_talk';

/** Two retained ranges rippled together: source 10–20 then source 50–60. */
const RANGES: readonly (readonly [number, number])[] = [
  [10, 20],
  [50, 60],
];

const mediaClip = (id: string, start: number, end: number, s0: number, s1: number): Clip => ({
  id,
  assetId: ASSET,
  trackId: 'video_1',
  start,
  end,
  sourceStart: s0,
  sourceEnd: s1,
  effects: [],
  keyframes: [],
});

/** A word every 0.5s across the source, attributed to the asset. */
function transcript(): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (let t = 0; t < 70; t += 0.5) {
    words.push({ word: `w${t}`, start: t, end: t + 0.4, assetId: ASSET });
  }
  return words;
}

function projectDoc(captionClips: Clip[] = [], revision = 1): Project {
  return {
    id: 'p1',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: ASSET, path: '/a.mp4', kind: 'video', durationSeconds: 120 }],
    folders: [],
    timeline: {
      revision,
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            mediaClip('clip_0', 0, 10, RANGES[0]![0], RANGES[0]![1]),
            mediaClip('clip_1', 10, 20, RANGES[1]![0], RANGES[1]![1]),
          ],
        },
        { id: 'caption_1', type: 'caption', clips: captionClips },
      ],
    },
    transcript: transcript(),
    markers: [],
    aiMemory: {},
    history: [],
  };
}

/** Caption clips built the CORRECT way — through the mapping. */
function correctCaptions(revision = 1): Clip[] {
  const base = projectDoc([], revision);
  const map = buildTimelineMap(base.timeline);
  return deriveCaptionCues(map, base.transcript, captionSegmentConfig('subtitle')).map(
    (cue, i) => ({
      id: `cap_${i}`,
      assetId: '__caption__',
      trackId: 'caption_1',
      start: cue.start,
      end: cue.end,
      sourceStart: 0,
      sourceEnd: cue.end - cue.start,
      effects: [],
      keyframes: [],
      captionCue: {
        text: cue.text,
        words: [...cue.words],
        derivedFromRevision: cue.revision,
        source: {
          assetId: cue.assetId,
          clipId: cue.clipId,
          start: cue.sourceStart,
          end: cue.sourceEnd,
        },
      },
    }),
  );
}

const MUSIC = 'asset_song';
const BROLL = 'asset_broll';

/** Turn generator output into caption clips, the way the caption tools do. */
function cuesToClips(cues: readonly ReturnType<typeof deriveCaptionCues>[number][]): Clip[] {
  return cues.map((cue, i) => ({
    id: `mcap_${i}`,
    assetId: '__caption__',
    trackId: 'caption_1',
    start: cue.start,
    end: cue.end,
    sourceStart: 0,
    sourceEnd: cue.end - cue.start,
    effects: [],
    keyframes: [],
    captionCue: {
      text: cue.text,
      words: [...cue.words],
      derivedFromRevision: cue.revision,
      source: {
        assetId: cue.assetId,
        clipId: cue.clipId,
        start: cue.sourceStart,
        end: cue.sourceEnd,
      },
    },
  }));
}

/**
 * The shape that broke the old rule: ONE continuous 20s music/vocal bed carrying every
 * transcript word, under 40 half-second B-roll shots. Speech is continuous; the picture
 * is cut 40 times.
 */
function montageDoc(captionClips: Clip[] = []): Project {
  const shots: Clip[] = Array.from({ length: 40 }, (_, i) => ({
    id: `shot_${i}`,
    assetId: BROLL,
    trackId: 'video_1',
    start: i * 0.5,
    end: (i + 1) * 0.5,
    sourceStart: i * 0.5,
    sourceEnd: (i + 1) * 0.5,
    effects: [],
    keyframes: [],
  }));
  return {
    id: 'p2',
    name: 'montage',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [
      { id: BROLL, path: '/b.mp4', kind: 'video', durationSeconds: 60 },
      { id: MUSIC, path: '/s.wav', kind: 'audio', durationSeconds: 60 },
    ],
    folders: [],
    timeline: {
      revision: 7,
      tracks: [
        { id: 'video_1', type: 'video', clips: shots },
        {
          id: 'audio_1',
          type: 'audio',
          clips: [
            {
              id: 'song',
              assetId: MUSIC,
              trackId: 'audio_1',
              start: 0,
              end: 20,
              sourceStart: 0,
              sourceEnd: 20,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'caption_1', type: 'caption', clips: captionClips },
      ],
    },
    // A word every 0.5s for the whole bed, attributed to the SONG, so every word maps
    // through the one audio span and the mapping yields exactly one run.
    transcript: Array.from({ length: 40 }, (_, i) => ({
      word: `lyric${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      assetId: MUSIC,
    })),
    markers: [],
    aiMemory: {},
    history: [],
  };
}

describe('verifyCaptions', () => {
  it('passes captions derived through the timeline mapping', () => {
    const report = verifyCaptions(projectDoc(correctCaptions()));
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.cueCount).toBeGreaterThan(0);
  });

  it('catches the original bug: cues carrying SOURCE timestamps', () => {
    // Exactly what the broken pipeline produced — segmented straight from the
    // transcript, so a word spoken at source 50s becomes a cue at 50s on a
    // 20s timeline. Every operation applied cleanly; nothing said it was wrong.
    const sourceTimed: Clip[] = [
      {
        id: 'cap_bad',
        assetId: '__caption__',
        trackId: 'caption_1',
        start: 50,
        end: 52,
        sourceStart: 0,
        sourceEnd: 2,
        effects: [],
        keyframes: [],
        captionCue: {
          text: 'w50 w50.5',
          words: [
            { word: 'w50', start: 50, end: 50.4 },
            { word: 'w50.5', start: 50.5, end: 50.9 },
          ],
          derivedFromRevision: 1,
        },
      },
    ];
    const report = verifyCaptions(projectDoc(sourceTimed));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('caption_past_end');
  });

  it('catches a cue placed over footage that was cut', () => {
    const overDeleted: Clip[] = [
      {
        ...correctCaptions()[0]!,
        id: 'cap_x',
        start: 3,
        end: 5,
        captionCue: {
          // Words from source 30–32, a range that was deleted entirely.
          text: 'w30 w30.5',
          words: [
            { word: 'w30', start: 30, end: 30.4 },
            { word: 'w30.5', start: 30.5, end: 30.9 },
          ],
          derivedFromRevision: 1,
        },
      },
    ];
    const report = verifyCaptions(projectDoc(overDeleted));
    expect(report.issues.map((i) => i.code)).toContain('caption_text_mismatch');
  });

  it('catches a cue bridging a speech break', () => {
    // Spans 9–11, straddling the 10s boundary between two source ranges whose
    // words really were never spoken together — source 10–20 then source 50–60.
    const straddling: Clip[] = [
      {
        ...correctCaptions()[0]!,
        id: 'cap_straddle',
        start: 9,
        end: 11,
      },
    ];
    const report = verifyCaptions(projectDoc(straddling));
    expect(report.issues.map((i) => i.code)).toContain('caption_spans_speech_break');
  });

  it('passes cues over a montage whose picture is cut finer than its audio', () => {
    // The live failure this rule was rewritten for: continuous narration under many
    // short shots. Every cue the canonical generator produces crosses several picture
    // cuts, and every one of them is correct — the words WERE spoken together. The old
    // rule filtered every video and audio span, so it reported one defect per cue and
    // left the run no placement that could satisfy it.
    const project = montageDoc();
    const cues = deriveCaptionCues(
      buildTimelineMap(project.timeline),
      project.transcript,
      captionSegmentConfig('subtitle'),
    );
    expect(cues.length).toBeGreaterThan(3);
    // The test only means something if the cues really do cross picture cuts: that is
    // the input the old rule rejected. Shot boundaries are every 0.5s.
    const shotStarts = Array.from({ length: 39 }, (_, i) => (i + 1) * 0.5);
    const crossing = cues.filter((cue) =>
      shotStarts.some((t) => t > cue.start + 1e-6 && t < cue.end - 1e-6),
    );
    expect(crossing.length).toBeGreaterThan(0);
    const report = verifyCaptions(montageDoc(cuesToClips(cues)));
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not call a correct cue stale just because the project revision moved on', () => {
    // Cues derived at revision 1, project now at revision 4, arrangement UNCHANGED.
    // A colour grade or an effect layer bumps the revision without moving a word, and
    // reporting forty perfectly-timed cues as stale is how a run learns to ignore its
    // own verifier.
    const report = verifyCaptions(projectDoc(correctCaptions(1), 4));
    expect(report.issues.filter((i) => i.code === 'caption_stale')).toEqual([]);
  });

  it('catches a cue whose words a later edit actually replaced', () => {
    // The real staleness case: cues derived against source 50–60 on the second clip,
    // then that clip re-reads source 30–40. The cue text is now describing speech that
    // no longer plays there, and the revision is not what proves it — the words are.
    const derived = correctCaptions(1);
    const moved = projectDoc(derived, 4);
    const videoTrack = moved.timeline.tracks[0]!;
    const relinked: Project = {
      ...moved,
      timeline: {
        ...moved.timeline,
        tracks: [
          {
            ...videoTrack,
            clips: [
              videoTrack.clips[0]!,
              { ...videoTrack.clips[1]!, sourceStart: 30, sourceEnd: 40 },
            ],
          },
          ...moved.timeline.tracks.slice(1),
        ],
      },
    };
    const stale = verifyCaptions(relinked).issues.filter((i) => i.code === 'caption_stale');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0]!.detail).toMatch(/regenerate the cue from the current mapped transcript/i);
  });

  it('catches a cue whose words drifted off their timings, same text and count', () => {
    // The subtle staleness: nothing was added or removed, so the count and the text still
    // match — the cue just no longer sits on the words. A revision compare cannot see
    // this at all (the revision need not have changed), which is why it was replaced by a
    // measurement.
    const drifted = correctCaptions(1).map((clip, i) =>
      i !== 0
        ? clip
        : {
            ...clip,
            captionCue: {
              ...clip.captionCue!,
              words: clip.captionCue!.words.map((w) => ({
                ...w,
                start: w.start + 0.5,
                end: w.end + 0.5,
              })),
            },
          },
    );
    const stale = verifyCaptions(projectDoc(drifted)).issues.filter(
      (i) => i.code === 'caption_stale',
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toMatch(/0\.5s away, past the 0\.084s tolerance/);
  });

  it('counts words in the singular when a one-word cue is the stale one', () => {
    // Cosmetic but asserted: the report is read by a person as often as by the model, and
    // "shows 1 words" is the kind of detail that makes a verifier look untrustworthy.
    const first = correctCaptions(1)[0]!;
    const oneWord: Clip[] = [
      {
        ...first,
        captionCue: { ...first.captionCue!, words: [first.captionCue!.words[0]!] },
      },
    ];
    const stale = verifyCaptions(projectDoc(oneWord)).issues.filter(
      (i) => i.code === 'caption_stale',
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain('shows 1 word but');
  });

  it('refuses to call a cue of unknown provenance verified', () => {
    const noProvenance = correctCaptions().map((c) => ({
      ...c,
      captionCue: { text: c.captionCue!.text, words: c.captionCue!.words },
    }));
    const report = verifyCaptions(projectDoc(noProvenance));
    expect(report.issues.map((i) => i.code)).toContain('caption_provenance_unknown');
  });

  it('rejects the live lyric-video failure: one full-duration transcript fallback block', () => {
    const project = projectDoc([
      {
        id: 'cap_whole_song',
        assetId: '__caption__',
        trackId: 'caption_1',
        start: 0,
        end: 20,
        sourceStart: 0,
        sourceEnd: 20,
        effects: [{ id: 'caption_fx', type: 'caption', params: {}, keyframes: [] }],
        keyframes: [],
      },
    ]);
    const report = verifyCaptions(project);

    // Time-range coverage alone is not caption quality: all retained words fit inside
    // the rectangle, but the viewer would see one paragraph and there is no revision
    // provenance proving the fallback text is current.
    expect(report.speechCoverage).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.cueCount).toBe(1);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['caption_too_dense', 'caption_provenance_unknown']),
    );
  });

  it('does not count a title on an overlay track as a caption cue', () => {
    const project = projectDoc(correctCaptions());
    project.timeline.tracks.push({
      id: 'titles',
      type: 'overlay',
      clips: [
        {
          id: 'title',
          assetId: '__text__',
          trackId: 'titles',
          start: 0,
          end: 4.5,
          sourceStart: 0,
          sourceEnd: 4.5,
          effects: [
            { id: 'title_fx', type: 'text', params: { text: 'THE SEARCH' }, keyframes: [] },
          ],
          keyframes: [],
        },
      ],
    });

    expect(verifyCaptions(project).cueCount).toBe(correctCaptions().length);
  });

  it('reports retained speech that nothing captions', () => {
    const onlyFirst = correctCaptions().slice(0, 1);
    const report = verifyCaptions(projectDoc(onlyFirst));
    expect(report.issues.map((i) => i.code)).toContain('speech_uncaptioned');
    expect(report.speechCoverage).toBeLessThan(1);
  });

  it('names the drift in seconds, so the caller can act on it', () => {
    const drifted = correctCaptions().map((c, i) =>
      i === 0 ? { ...c, start: c.start + 1.5, end: c.end + 1.5 } : c,
    );
    const report = verifyCaptions(projectDoc(drifted));
    // Asserted by code, not by a disjunction: this used to accept either
    // `caption_out_of_sync` or `caption_spans_cut`, which meant it could not tell a
    // drift measurement from a boundary complaint and passed while the boundary rule
    // was firing on every cue in the project.
    const sync = report.issues.find((i) => i.code === 'caption_out_of_sync');
    expect(sync?.detail).toMatch(/1\.5/);
  });

  it('skips sync checks for a cue whose captionCue carries no words (nothing to compare)', () => {
    // A captionCue can exist (so provenance/stale checks still run) while `words` is
    // empty — e.g. a placeholder cue. There is nothing to compare timing against, so
    // sync checking must bail out rather than indexing into an empty array.
    const wordless: Clip[] = [
      {
        ...correctCaptions()[0]!,
        id: 'cap_wordless',
        captionCue: { ...correctCaptions()[0]!.captionCue!, text: '', words: [] },
      },
    ];
    const report = verifyCaptions(projectDoc(wordless));
    expect(report.issues.map((i) => i.code)).not.toContain('caption_out_of_sync');
    expect(report.issues.map((i) => i.code)).not.toContain('caption_text_mismatch');
  });

  it('reports full speech coverage (not NaN/Infinity) when the project carries no transcript at all', () => {
    // With zero transcript words, the "fraction covered" division would be 0/0. There is
    // no retained speech to fail to caption, so coverage must read as complete (1), not
    // a NaN that would corrupt a caller's "coverage < threshold" check.
    const project = projectDoc(correctCaptions());
    const report = verifyCaptions({ ...project, transcript: [] });
    expect(report.speechCoverage).toBe(1);
    expect(report.issues.map((i) => i.code)).not.toContain('speech_uncaptioned');
  });

  it('is honest about an empty caption track rather than passing it', () => {
    const report = verifyCaptions(projectDoc([]));
    expect(report.cueCount).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('speech_uncaptioned');
    expect(report.speechCoverage).toBeLessThan(1);
  });
});

describe('verifyTransitions', () => {
  const withTransition = (
    toClipId: string,
    fromClipId: string,
    durationSeconds: number,
  ): Project => {
    const p = projectDoc();
    const track = p.timeline.tracks[0]!;
    return {
      ...p,
      timeline: {
        ...p.timeline,
        tracks: [
          {
            ...track,
            clips: track.clips.map((c) =>
              c.id === toClipId
                ? {
                    ...c,
                    effects: [
                      {
                        id: `${toClipId}__transition`,
                        type: 'transition',
                        params: { kind: 'cross-dissolve', durationSeconds, fromClipId },
                        keyframes: [],
                      },
                    ],
                  }
                : c,
            ),
          },
          ...p.timeline.tracks.slice(1),
        ],
      },
    };
  };

  it('passes a transition at a real cut with the right neighbours', () => {
    const report = verifyTransitions(withTransition('clip_1', 'clip_0', 1));
    expect(report.issues).toEqual([]);
    expect(report.transitionCount).toBe(1);
    expect(report.boundaryCount).toBe(1);
  });

  it('reports no transitions when none were applied — not silent success', () => {
    const report = verifyTransitions(projectDoc());
    expect(report.transitionCount).toBe(0);
    expect(report.boundaryCount).toBe(1);
  });

  it('catches a transition on a clip with nothing before it', () => {
    // The failure mode: an effect stamped where there is no cut to cross.
    const report = verifyTransitions(withTransition('clip_0', 'ghost', 1));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('transition_without_cut');
  });

  it('catches a transition naming the wrong outgoing clip', () => {
    const report = verifyTransitions(withTransition('clip_1', 'not_the_previous_clip', 1));
    expect(report.issues.map((i) => i.code)).toContain('transition_wrong_clips');
  });

  it('catches a transition longer than the cut can carry', () => {
    // Both clips are 10s, so the ceiling is 5s; 9s overruns the shot.
    const report = verifyTransitions(withTransition('clip_1', 'clip_0', 9));
    expect(report.issues.map((i) => i.code)).toContain('transition_too_long');
  });
});
