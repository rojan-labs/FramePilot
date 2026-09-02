/**
 * The invariant this file exists to hold: **the canonical caption generator's own output
 * must verify clean.**
 *
 * It did not, and the cost is measurable. In a captured run `verify_captions` reported six
 * defects on a 34-cue track. The agent did exactly what the findings asked — "regenerate
 * the cue from the current mapped transcript" — and `caption_the_edit` produced cues with
 * byte-identical timings, because the timings were already right. The verifier then
 * reported the same six defects. 102 operations (34 deletions and 34 identical
 * re-insertions), a second wasted `verify_captions`, and the run's remaining turns spent
 * on a loop that could not converge.
 *
 * The cause was not in the generator and not in the model. Two of the verifier's three
 * caption checks derived their own answer to "which words is this cue answerable for" —
 * one by overlap, one by midpoint — and neither matched the segmenter's partition once the
 * cue boundaries had been frame-quantised at the patch boundary. Every disagreement was
 * exactly one word wide and exactly one frame away.
 *
 * The numbers below are the real ones from that run.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTimelineMap,
  captionSegmentConfig,
  deriveCaptionCues,
  frameToSeconds,
  secondsToFrame,
} from '@framepilot/editor-core';
import type { Clip, Project, TranscriptWord } from '@framepilot/timeline-schema';
import { verifyCaptions } from './verify.js';

const ASSET = 'asset_isom';
const FPS = 30;

/**
 * The captured run's speech, from 14.88s to 40.67s.
 *
 * Kept verbatim because the two failures are a property of these exact times: "school"
 * ends at 15.98 (the next cue's first word), and "The" runs 37.820–37.830, whose midpoint
 * lands on the wrong side of a boundary quantised from 37.820 up to 37.833.
 */
const WORDS: readonly (readonly [string, number, number])[] = [
  ['My', 14.2, 14.5],
  ['design', 14.88, 15.26],
  ['focus', 15.26, 15.57],
  ['school', 15.57, 15.98],
  ['with', 15.98, 16.34],
  ['one', 16.59, 16.9],
  ['mission.', 16.9, 17.5],
  ['A', 18.0, 18.2],
  ['generation', 18.2, 18.79],
  ['of', 18.79, 18.95],
  ['motion', 18.95, 19.4],
  ['designers.', 19.4, 20.6],
  ['I', 35.0, 35.14],
  ['built', 35.14, 35.46],
  ['last', 35.46, 35.76],
  ['year', 35.81, 36.1],
  ['by', 36.1, 36.26],
  ['AI', 36.26, 36.42],
  ['over', 36.42, 36.74],
  ['a', 36.74, 36.81],
  ['weekend.', 36.87, 37.64],
  ['The', 37.82, 37.83],
  ['product', 37.88, 38.17],
  ["isn't", 38.17, 38.43],
  ['the', 38.43, 38.59],
  ['problem', 38.59, 38.96],
  ['anymore,', 38.96, 39.46],
  ['getting', 39.46, 39.99],
  ['attention', 39.99, 40.67],
];

const transcript = (): TranscriptWord[] =>
  WORDS.map(([word, start, end]) => ({ word, start, end, assetId: ASSET }));

/** The talking head laid down whole, exactly as the run had it: one clip, no cuts. */
function projectDoc(captionClips: Clip[]): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: FPS,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: ASSET, path: '/talk.mp4', kind: 'video', durationSeconds: 49.78 }],
    folders: [],
    timeline: {
      revision: 28,
      tracks: [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            {
              id: 'clip_talk',
              assetId: ASSET,
              trackId: 'v_main',
              start: 0,
              end: 49.767,
              sourceStart: 0,
              sourceEnd: 49.767,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'captions_main', type: 'caption', clips: captionClips },
      ],
    },
    transcript: transcript(),
    markers: [],
    aiMemory: {},
    history: [],
  };
}

/** Snap to the frame grid, the way the patch boundary does before a cue is committed. */
const quantize = (seconds: number): number => frameToSeconds(secondsToFrame(seconds, FPS), FPS);

/**
 * Cues exactly as `caption_the_edit` commits them: derived by the canonical generator,
 * with the CLIP bounds on the frame grid and the cue's own word times left in real time.
 *
 * That asymmetry is deliberate and is the whole point — it is what the run produced, and
 * it is what made two of the verifier's checks disagree with the generator by one word.
 */
function committedCues(): Clip[] {
  const base = projectDoc([]);
  const map = buildTimelineMap(base.timeline);
  return deriveCaptionCues(map, base.transcript, captionSegmentConfig('short-form'), FPS).map(
    (cue, index) => ({
      id: `caption_captions_main_${index}`,
      assetId: '__caption__',
      trackId: 'captions_main',
      start: quantize(cue.start),
      end: quantize(cue.end),
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

describe('verifyCaptions converges with the generator that produced the cues', () => {
  it('reports nothing on freshly generated, frame-quantised cues', () => {
    // The regression in one line. When this fails, the agent is being handed a finding it
    // cannot act on: regenerating reproduces the cue byte for byte and the finding returns.
    const report = verifyCaptions(projectDoc(committedCues()));
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not measure a cue against its predecessor’s last word', () => {
    // The captured finding, reproduced from its own numbers: `Caption "with one mission."
    // starts 0.41s away from the word it captions (cue says 15.98s, the audio is at
    // 15.57s)`. 15.57s is "school" — the PREVIOUS cue's last word. It ends at 15.98s, and
    // 15.98s quantises DOWN to 15.967s (479.4 frames → frame 479), so "school" ends 13ms
    // inside the cue that follows it and overlapped it. The cue was never out of sync; the
    // check was reading its neighbour's word.
    const cueWords = (words: readonly (readonly [string, number, number])[]) =>
      words.map(([word, start, end]) => ({ word, start, end }));
    const boundary = quantize(15.98);
    expect(boundary).toBeLessThan(15.98);

    const cue = (
      id: string,
      start: number,
      end: number,
      words: typeof cueWords extends never ? never : ReturnType<typeof cueWords>,
    ): Clip => ({
      id,
      assetId: '__caption__',
      trackId: 'captions_main',
      start,
      end,
      sourceStart: 0,
      sourceEnd: end - start,
      effects: [],
      keyframes: [],
      captionCue: {
        text: words.map((word) => word.word).join(' '),
        words,
        derivedFromRevision: 28,
        source: { assetId: ASSET, clipId: 'clip_talk', start, end },
      },
    });

    const report = verifyCaptions(
      projectDoc([
        cue(
          'cap_a',
          quantize(14.2),
          boundary,
          cueWords([
            ['My', 14.2, 14.5],
            ['design', 14.88, 15.26],
            ['focus', 15.26, 15.57],
            ['school', 15.57, 15.98],
          ]),
        ),
        cue(
          'cap_b',
          boundary,
          quantize(17.5),
          cueWords([
            ['with', 15.98, 16.34],
            ['one', 16.59, 16.9],
            ['mission.', 16.9, 17.5],
          ]),
        ),
        cue(
          'cap_c',
          quantize(18.0),
          quantize(20.6),
          cueWords([
            ['A', 18.0, 18.2],
            ['generation', 18.2, 18.79],
            ['of', 18.79, 18.95],
            ['motion', 18.95, 19.4],
            ['designers.', 19.4, 20.6],
          ]),
        ),
        ...committedCues().filter((clip) => clip.start > 30),
      ]),
    );
    expect(report.issues.filter((issue) => issue.code === 'caption_out_of_sync')).toEqual([]);
  });

  it('does not count the next cue’s first word against this one', () => {
    // Captured finding: `Caption at 35.8s shows 6 words but 7 now play across it (year by
    // AI over a weekend. The)`. "The" runs 37.820–37.830; the next cue's start quantised
    // from 37.820 up to 37.833, putting the word's midpoint on the wrong side of it.
    const report = verifyCaptions(projectDoc(committedCues()));
    expect(report.issues.filter((issue) => issue.code === 'caption_stale')).toEqual([]);
  });

  it('still reports a cue that really is built on source time', () => {
    // The slack is one frame; it must not swallow a genuine defect. This cue is a second
    // early, which is what a source-timestamped caption looks like.
    const cues = committedCues();
    const first = cues[0]!;
    const shifted: Clip = {
      ...first,
      captionCue: {
        ...first.captionCue!,
        words: first.captionCue!.words.map((word) => ({
          ...word,
          start: word.start - 1,
          end: word.end - 1,
        })),
      },
    };
    const report = verifyCaptions(projectDoc([shifted, ...cues.slice(1)]));
    expect(report.issues.some((issue) => issue.code === 'caption_out_of_sync')).toBe(true);
  });

  it('still reports speech no cue covers', () => {
    const cues = committedCues();
    const report = verifyCaptions(projectDoc(cues.slice(0, -1)));
    expect(report.issues.some((issue) => issue.code === 'speech_uncaptioned')).toBe(true);
    expect(report.speechCoverage).toBeLessThan(1);
  });
});

describe('ownership on a track the segmenter did not build', () => {
  const cue = (
    id: string,
    start: number,
    end: number,
    words: readonly [string, number, number][],
  ): Clip => ({
    id,
    assetId: '__caption__',
    trackId: 'captions_main',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes: [],
    captionCue: {
      text: words.map(([word]) => word).join(' '),
      words: words.map(([word, wordStart, wordEnd]) => ({ word, start: wordStart, end: wordEnd })),
      derivedFromRevision: 28,
      source: { assetId: ASSET, clipId: 'clip_talk', start, end },
    },
  });

  it('gives a word inside two overlapping cues to the later one — what a viewer reads', () => {
    // Hand-authored tracks can overlap; the generator's never do. The later cue is the one
    // on top, so it is the one answerable for the word.
    const long = cue('cap_long', quantize(14.2), quantize(17.5), [
      ['My', 14.2, 14.5],
      ['design', 14.88, 15.26],
      ['focus', 15.26, 15.57],
      ['school', 15.57, 15.98],
    ]);
    const over = cue('cap_over', quantize(15.26), quantize(17.5), [
      ['focus', 15.26, 15.57],
      ['school', 15.57, 15.98],
    ]);
    const report = verifyCaptions(projectDoc([long, over]));
    // The claim under test is which cue a shared word is MEASURED against. "focus" and
    // "school" fall inside both; the later cue is the one on top, so its own first word is
    // compared to "focus" and it is in sync. (A hand-authored track like this may still
    // report staleness for words it does not account for — that finding is honest, and is
    // not what this test is about.)
    expect(
      report.issues.filter(
        (issue) => issue.clipId === 'cap_over' && issue.code === 'caption_out_of_sync',
      ),
    ).toEqual([]);
    // And the earlier cue is no longer credited with them: it is measured from "My".
    expect(
      report.issues.filter(
        (issue) => issue.clipId === 'cap_long' && issue.code === 'caption_out_of_sync',
      ),
    ).toEqual([]);
  });

  it('scales to a word-level track without walking every cue per word', () => {
    // A ten-minute talk captioned word by word. The check is that it completes promptly:
    // the previous implementation copied and reversed the whole cue list once per word.
    const words: [string, number, number][] = [];
    for (let index = 0; index < 1800; index += 1) {
      words.push([`w${index}`, index * 0.3, index * 0.3 + 0.25]);
    }
    const cues = words.map(([word, start, end], index) =>
      cue(`cap_${index}`, quantize(start), quantize(end), [[word, start, end]]),
    );
    const doc = {
      ...projectDoc(cues),
      transcript: words.map(([word, start, end]) => ({ word, start, end, assetId: ASSET })),
      timeline: {
        ...projectDoc(cues).timeline,
        tracks: projectDoc(cues).timeline.tracks.map((track) =>
          track.id === 'v_main'
            ? {
                ...track,
                clips: [{ ...(track.clips[0] as Clip), end: 545, sourceEnd: 545 }],
              }
            : track,
        ),
      },
    } as unknown as Project;
    const started = Date.now();
    const report = verifyCaptions(doc);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.cueCount).toBe(1800);
  });
});
