/**
 * Tests for transcript → edited-timeline caption derivation (ADR 0076).
 *
 * The centrepiece is the observed failure scenario: six non-contiguous source
 * ranges rippled into a continuous timeline. Before this module, captions
 * generated for that edit carried source timestamps and were wrong from the
 * first cut onward — while every operation reported success. So these assert the
 * properties that failure violated, not the mechanics of the mapper:
 *
 *   - only retained speech is captioned;
 *   - every cue sits at its real sequence position;
 *   - no cue spans a cut, even where the ripple made two ranges adjacent;
 *   - later edits (reorder, trim, speed) move the captions with the footage.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectSchema,
  type Project,
  type Timeline,
  type TranscriptWord,
} from '@framepilot/timeline-schema';
import {
  buildTimelineMap,
  mapSourceTime,
  mapSequenceTime,
  retainedSourceRanges,
} from '../timeline-map.js';
import * as segmentModule from './segment.js';
import { captionSegmentConfig, type CaptionSegmentConfig } from './segment.js';
import { deriveCaptionCues, mapTranscript } from './derive.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSET = 'asset_talk';

/** The six retained source ranges from the observed run, in order. */
const RETAINED: readonly (readonly [number, number])[] = [
  [6.86, 19.5],
  [28.5, 53.45],
  [110.0, 119.5],
  [132.0, 142.0],
  [155.0, 170.0],
  [197.0, 208.0],
];

/**
 * Ripple the retained ranges into one continuous track — a clip per range, each
 * butted against the previous, which is exactly what the editor produces and the
 * shape that made the old bug invisible (the timeline looks perfectly clean).
 */
function rippledTimeline(
  ranges: readonly (readonly [number, number])[] = RETAINED,
  options: { readonly speed?: number; readonly revision?: number } = {},
): Timeline {
  const speed = options.speed ?? 1;
  let cursor = 0;
  const clips = ranges.map(([sourceStart, sourceEnd], index) => {
    const start = cursor;
    const end = start + (sourceEnd - sourceStart) / speed;
    cursor = end;
    return {
      id: `clip_${index}`,
      assetId: ASSET,
      trackId: 'track_v1',
      start,
      end,
      sourceStart,
      sourceEnd,
      effects: [],
      keyframes: [],
      ...(speed === 1 ? {} : { speed }),
    };
  });
  return {
    revision: options.revision ?? 1,
    tracks: [{ id: 'track_v1', type: 'video' as const, clips }],
  };
}

/**
 * A word every 0.5s across the whole source, so any mis-mapping shows up as a
 * word landing where a different word should be. `w<n>` names the source second
 * it starts at, which makes failures readable.
 */
function sourceTranscript(assetId: string | undefined = ASSET): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (let t = 0; t < 220; t += 0.5) {
    words.push({
      word: `w${t.toFixed(1)}`,
      start: +t.toFixed(4),
      end: +(t + 0.4).toFixed(4),
      ...(assetId === undefined ? {} : { assetId }),
    });
  }
  return words;
}

/**
 * Would a word be kept? The majority rule: at least half of it must fall inside
 * one retained range. Mirrored here deliberately rather than imported, so the
 * tests pin the *policy* and would catch the implementation quietly changing it.
 */
const survives = (word: TranscriptWord): boolean =>
  RETAINED.some(
    ([lo, hi]) =>
      Math.min(hi, word.end) - Math.max(lo, word.start) >= (word.end - word.start) / 2 - 1e-6,
  );

/** Segmentation that groups aggressively, so cue-boundary behavior is visible. */
const config = (overrides: Partial<CaptionSegmentConfig> = {}): CaptionSegmentConfig =>
  captionSegmentConfig('subtitle', overrides);

// ---------------------------------------------------------------------------
// The canonical mapping
// ---------------------------------------------------------------------------

describe('buildTimelineMap', () => {
  it('lays the six retained ranges end to end with no gaps or overlaps', () => {
    const map = buildTimelineMap(rippledTimeline());
    expect(map.spans).toHaveLength(6);
    expect(map.revision).toBe(1);

    const totalSource = RETAINED.reduce((sum, [lo, hi]) => sum + (hi - lo), 0);
    expect(map.duration).toBeCloseTo(totalSource, 6);

    for (let i = 1; i < map.spans.length; i += 1) {
      // Butted, not overlapping: the ripple's defining property.
      expect(map.spans[i]!.start).toBeCloseTo(map.spans[i - 1]!.end, 9);
    }
  });

  it('excludes caption tracks, which have no real source range', () => {
    const timeline = rippledTimeline();
    const withCaptions: Timeline = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: 'track_cap',
          type: 'caption' as const,
          clips: [
            {
              id: 'cap_0',
              assetId: ASSET,
              trackId: 'track_cap',
              start: 0,
              end: 2,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    // Six, not seven — otherwise the caption we are deriving would feed back
    // into the map we derive it from.
    expect(buildTimelineMap(withCaptions).spans).toHaveLength(6);
  });

  it('breaks a start/track tie by clip id, so span order is total', () => {
    // Two clips on the same track starting at the same instant only happens in
    // hand-edited or corrupted project JSON, but the sort must still produce a
    // deterministic order rather than depending on array insertion order.
    const timeline: Timeline = {
      revision: 1,
      tracks: [
        {
          id: 'track_v1',
          type: 'video' as const,
          clips: [
            {
              id: 'clip_z',
              assetId: ASSET,
              trackId: 'track_v1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_a',
              assetId: ASSET,
              trackId: 'track_v1',
              start: 0,
              end: 5,
              sourceStart: 5,
              sourceEnd: 10,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    const map = buildTimelineMap(timeline);
    expect(map.spans.map((s) => s.clipId)).toEqual(['clip_a', 'clip_z']);
  });
});

describe('source ↔ sequence conversion', () => {
  const map = buildTimelineMap(rippledTimeline());

  it('maps a retained source instant to its real sequence position', () => {
    // 28.5 is the start of the second range; the first contributed 12.64s.
    expect(mapSourceTime(map, ASSET, 28.5)[0]?.sequenceTime).toBeCloseTo(12.64, 6);
    // A moment 5s into the third range: 12.64 + 24.95 preceding, plus 5.
    expect(mapSourceTime(map, ASSET, 115.0)[0]?.sequenceTime).toBeCloseTo(42.59, 6);
  });

  it('reports no sequence position at all for deleted source time', () => {
    expect(mapSourceTime(map, ASSET, 25.0)).toHaveLength(0);
    expect(mapSourceTime(map, ASSET, 100.0)).toHaveLength(0);
    expect(mapSourceTime(map, ASSET, 209.0)).toHaveLength(0);
  });

  it('round-trips every retained instant back to itself', () => {
    for (const [lo, hi] of RETAINED) {
      for (let t = lo; t < hi; t += 1.37) {
        const hit = mapSourceTime(map, ASSET, t)[0];
        expect(hit).toBeDefined();
        expect(mapSequenceTime(map, hit!.sequenceTime)?.sourceTime).toBeCloseTo(t, 6);
      }
    }
  });

  it('reports nothing playing past the end of the sequence', () => {
    // The honest-absence contract: a clamped guess at a neighbouring clip would
    // hide the very discontinuity (running off the edit) this checks for.
    expect(mapSequenceTime(map, map.duration + 10)).toBeNull();
  });

  it('reports nothing playing in a sequence gap', () => {
    const gapped = buildTimelineMap({
      revision: 1,
      tracks: [
        {
          id: 'track_v1',
          type: 'video' as const,
          clips: [
            {
              id: 'clip_0',
              assetId: ASSET,
              trackId: 'track_v1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_1',
              assetId: ASSET,
              trackId: 'track_v1',
              start: 8,
              end: 12,
              sourceStart: 5,
              sourceEnd: 9,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    });
    expect(mapSequenceTime(gapped, 6.5)).toBeNull();
  });

  it('returns every appearance when a source range is used twice', () => {
    const reused = rippledTimeline([
      [10, 20],
      [10, 20],
    ]);
    const hits = mapSourceTime(buildTimelineMap(reused), ASSET, 15);
    expect(hits.map((h) => h.sequenceTime)).toEqual([5, 15]);
  });
});

describe('retainedSourceRanges', () => {
  it('reads back every span when no asset is given, and only one asset’s when filtered', () => {
    const map = buildTimelineMap(rippledTimeline());
    expect(retainedSourceRanges(map)).toEqual(map.spans);
    expect(retainedSourceRanges(map, ASSET)).toEqual(map.spans);
    expect(retainedSourceRanges(map, 'some_other_asset')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Transcript mapping
// ---------------------------------------------------------------------------

describe('mapTranscript', () => {
  const map = buildTimelineMap(rippledTimeline());
  const mapped = mapTranscript(map, sourceTranscript());

  it('keeps exactly the words majority-retained by the edit, and no others', () => {
    const kept = new Set(mapped.words.map((w) => w.sourceStart));
    for (const word of sourceTranscript()) {
      expect(kept.has(word.start)).toBe(survives(word));
    }
  });

  it('drops the deleted majority of the transcript', () => {
    expect(mapped.droppedCount).toBeGreaterThan(200);
    expect(mapped.words.length).toBeLessThan(sourceTranscript().length);
  });

  it('produces one run per retained range, in sequence order', () => {
    expect(mapped.runs).toHaveLength(6);
    expect(mapped.runs.map((r) => r.clipId)).toEqual([
      'clip_0',
      'clip_1',
      'clip_2',
      'clip_3',
      'clip_4',
      'clip_5',
    ]);
  });

  it('never lets a mapped word escape its clip', () => {
    const byId = new Map(map.spans.map((s) => [s.clipId, s]));
    for (const word of mapped.words) {
      const span = byId.get(word.clipId)!;
      expect(word.start).toBeGreaterThanOrEqual(span.start - 1e-9);
      expect(word.end).toBeLessThanOrEqual(span.end + 1e-9);
    }
  });

  it('keeps sequence time monotonic across the whole edit', () => {
    for (let i = 1; i < mapped.words.length; i += 1) {
      expect(mapped.words[i]!.start).toBeGreaterThanOrEqual(mapped.words[i - 1]!.start);
    }
  });

  it('preserves each word’s source timing alongside the mapped timing', () => {
    for (const word of mapped.words) {
      // The two are equal only for the first clip, which starts at t=0 with
      // sourceStart 6.86 — everywhere else they must genuinely differ.
      expect(word.sourceStart).toBeGreaterThan(0);
      expect(word.sourceEnd).toBeGreaterThan(word.sourceStart);
    }
    const later = mapped.words.filter((w) => w.clipId !== 'clip_0');
    expect(later.every((w) => w.start !== w.sourceStart)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Sub-word clips: the majority rule scaled by clip length
  // -------------------------------------------------------------------------

  /** One 20-clip track of `seconds`-long slivers cut straight out of the source. */
  const sliverTimeline = (seconds: number): Timeline => ({
    revision: 1,
    tracks: [
      {
        id: 'track_v1',
        type: 'video' as const,
        clips: Array.from({ length: 20 }, (_, i) => ({
          id: `sliver_${i}`,
          assetId: ASSET,
          trackId: 'track_v1',
          start: i * seconds,
          end: (i + 1) * seconds,
          sourceStart: i * seconds,
          sourceEnd: (i + 1) * seconds,
          effects: [],
          keyframes: [],
        })),
      },
    ],
  });

  it('captions clips shorter than the words spoken over them', () => {
    // 0.1s clips under 0.4s words: no clip can retain half of any word, so the
    // word-relative rule dropped the entire transcript and short clips came out
    // silent. Judged against the clip, each sliver is fully covered by the word
    // playing over it and is captioned.
    const slivers = mapTranscript(buildTimelineMap(sliverTimeline(0.1)), sourceTranscript());
    expect(slivers.words.length).toBeGreaterThan(0);
  });

  it('still captions a word only once when several slivers are covered by it', () => {
    const slivers = mapTranscript(buildTimelineMap(sliverTimeline(0.1)), sourceTranscript());
    const sources = slivers.words.map((w) => w.sourceStart);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('still drops a barely-retained word at a normal cut', () => {
    // The clip is far longer than the word, so the threshold is the word's own
    // half — unchanged. 0.05s of a 0.4s word is not "heard here".
    const timeline = rippledTimeline([[10, 40]]);
    const barely = mapTranscript(buildTimelineMap(timeline), [
      { word: 'clipped', start: 9.65, end: 10.05, assetId: ASSET },
    ]);
    expect(barely.words).toHaveLength(0);
    expect(barely.droppedCount).toBe(1);
  });

  it('confines an attributed word to its own asset', () => {
    const other = mapTranscript(map, [
      { word: 'elsewhere', start: 7, end: 7.4, assetId: 'asset_broll' },
    ]);
    expect(other.words).toHaveLength(0);
    expect(other.droppedCount).toBe(1);
  });

  it('matches an unattributed pre-v12 word against any asset', () => {
    const legacy = mapTranscript(map, [{ word: 'legacy', start: 7, end: 7.4 }]);
    expect(legacy.words).toHaveLength(1);
    expect(legacy.words[0]!.assetId).toBe(ASSET);
  });

  it('breaks a start-time tie in mapped-word order by source start', () => {
    // Two runs starting at the exact same sequence instant only happens with a
    // reused source range played on two tracks; the tiebreak keeps ordering
    // deterministic instead of depending on transcript array order.
    const multiTrack: Timeline = {
      revision: 1,
      tracks: [
        {
          id: 'track_v1',
          type: 'video' as const,
          clips: [
            {
              id: 'clip_v1',
              assetId: ASSET,
              trackId: 'track_v1',
              start: 0,
              end: 5,
              sourceStart: 100,
              sourceEnd: 105,
              effects: [],
              keyframes: [],
            },
          ],
        },
        {
          id: 'track_v2',
          type: 'video' as const,
          clips: [
            {
              id: 'clip_v2',
              assetId: ASSET,
              trackId: 'track_v2',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    const map = buildTimelineMap(multiTrack);
    // Later source word first in the input array — if the sort didn't tiebreak on
    // sourceStart, this order would leak through unchanged.
    const mapped = mapTranscript(map, [
      { word: 'late', start: 101, end: 101.4, assetId: ASSET },
      { word: 'early', start: 1, end: 1.4, assetId: ASSET },
    ]);
    // Both map to sequence start 1 (1s into their own 5s clip), so only the
    // sourceStart tiebreak (1 < 101) can put "early" first.
    expect(mapped.words.map((w) => w.word)).toEqual(['early', 'late']);
  });

  it('falls back to the word’s own timing when a run opens for a clip its span map has no entry for', () => {
    // Defensive: every mapped word's clipId comes from a span in the very map
    // `spanById` is built from, so this ought to be unreachable — but the run's
    // start/end must still degrade to the word's own timing rather than throw if
    // that invariant were ever violated (e.g. by a future refactor of `spanById`
    // construction). Forcing the very first `Map.get` to miss exercises exactly
    // that guard without weakening the invariant itself.
    const oneClip = buildTimelineMap(rippledTimeline([[0, 5]]));
    // Scoped to a CLIP-id lookup rather than "the first Map.get anywhere": `mapTranscript`
    // now indexes spans by asset before it maps a word, so a blanket first-call mock would
    // break that lookup instead of the one this test is about, and the word would simply
    // be dropped.
    const realGet = Map.prototype.get;
    let missed = false;
    const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
    ) {
      if (!missed && key !== ASSET) {
        missed = true;
        return undefined;
      }
      return realGet.call(this, key) as unknown;
    });
    try {
      const result = mapTranscript(oneClip, [{ word: 'hi', start: 1, end: 1.4, assetId: ASSET }]);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.start).toBe(result.words[0]!.start);
      expect(result.runs[0]!.end).toBe(result.words[0]!.end);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('falls back to zeroed source timing when the segmenter mis-partitions a run', () => {
    // Defensive: `deriveCaptionCues` counts forward through `segmentCaptions`'
    // output assuming it exactly partitions its input (documented on the
    // function). If a future change to the segmenter broke that invariant and
    // returned more cue-words than the run actually has, the source range must
    // degrade to 0 rather than read past the end of the run's words.
    const map = buildTimelineMap(rippledTimeline([[0, 5]]));
    const runWords = [
      { word: 'a', start: 0, end: 0.4 },
      { word: 'b', start: 0.5, end: 0.9 },
    ];
    const spy = vi.spyOn(segmentModule, 'segmentCaptions').mockReturnValue([
      { text: 'a b', words: runWords, start: 0, end: 0.9 },
      // A second, bogus cue: nothing is left of the run to back it.
      {
        text: 'overflow',
        words: [{ word: 'overflow', start: 0.9, end: 1.2 }],
        start: 0.9,
        end: 1.2,
      },
    ]);
    try {
      const cues = deriveCaptionCues(map, runWords, config());
      const overflow = cues[cues.length - 1]!;
      expect(overflow.sourceStart).toBe(0);
      expect(overflow.sourceEnd).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('carries confidence and speaker through untouched', () => {
    const rich = mapTranscript(map, [
      { word: 'hi', start: 7, end: 7.4, assetId: ASSET, confidence: 0.82, speaker: 'S1' },
    ]);
    expect(rich.words[0]).toMatchObject({ confidence: 0.82, speaker: 'S1' });
  });
});

// ---------------------------------------------------------------------------
// Cue derivation — the observed scenario
// ---------------------------------------------------------------------------

describe('deriveCaptionCues over the six rippled ranges', () => {
  const map = buildTimelineMap(rippledTimeline());
  const cues = deriveCaptionCues(map, sourceTranscript(), config());

  it('produces cues at all', () => {
    expect(cues.length).toBeGreaterThan(10);
  });

  it('places every cue inside the edited sequence', () => {
    for (const cue of cues) {
      expect(cue.start).toBeGreaterThanOrEqual(0);
      expect(cue.end).toBeLessThanOrEqual(map.duration + 1e-9);
      expect(cue.end).toBeGreaterThan(cue.start);
    }
  });

  it('never spans a cut, including where the ripple made ranges adjacent', () => {
    const boundaries = map.spans.map((s) => s.end).slice(0, -1);
    for (const cue of cues) {
      for (const boundary of boundaries) {
        const spans = cue.start < boundary - 1e-9 && cue.end > boundary + 1e-9;
        expect(spans).toBe(false);
      }
    }
  });

  it('attributes every cue to exactly one clip, with a retained source range', () => {
    for (const cue of cues) {
      expect(map.spans.some((s) => s.clipId === cue.clipId)).toBe(true);
      expect(survives({ word: '', start: cue.sourceStart, end: cue.sourceEnd })).toBe(true);
      expect(cue.assetId).toBe(ASSET);
    }
  });

  it('captions no deleted speech', () => {
    for (const cue of cues) {
      for (const word of cue.words) {
        // Every displayed word maps back to a moment that survived the edit.
        expect(mapSequenceTime(map, word.start)).not.toBeNull();
      }
    }
  });

  it('restarts at each source discontinuity rather than running through it', () => {
    // Six ranges ⇒ six independently captioned regions.
    expect(new Set(cues.map((c) => c.clipId)).size).toBe(6);
    for (const span of map.spans) {
      const own = cues.filter((c) => c.clipId === span.clipId);
      expect(own.length).toBeGreaterThan(0);
      expect(own[0]!.start).toBeGreaterThanOrEqual(span.start - 1e-9);
      expect(own[own.length - 1]!.end).toBeLessThanOrEqual(span.end + 1e-9);
    }
  });

  it('never overlaps two cues', () => {
    const ordered = [...cues].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!.start).toBeGreaterThanOrEqual(ordered[i - 1]!.end - 1e-9);
    }
  });

  it('stamps the revision it was derived from', () => {
    expect(cues.every((c) => c.revision === 1)).toBe(true);
  });

  it('does not place cues at source timestamps — the original bug', () => {
    // The last range starts at source 197s but plays at ~72s. A cue anywhere
    // near 197s on a 92s timeline is the old behavior reappearing.
    const last = cues[cues.length - 1]!;
    expect(last.start).toBeLessThan(map.duration);
    expect(last.start).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Edits applied after captions exist
// ---------------------------------------------------------------------------

describe('derivation follows later timeline changes', () => {
  const transcript = sourceTranscript();

  it('moves cues with the footage when clips are reordered', () => {
    const reordered = rippledTimeline([RETAINED[5]!, ...RETAINED.slice(0, 5)]);
    const cues = deriveCaptionCues(buildTimelineMap(reordered), transcript, config());
    // The formerly-last range now plays first, so its speech captions first.
    expect(cues[0]!.sourceStart).toBeGreaterThanOrEqual(197.0);
    expect(cues[0]!.start).toBeLessThan(2);
  });

  it('compresses cue timing under a speed change without inventing words', () => {
    const fast = buildTimelineMap(rippledTimeline(RETAINED, { speed: 2 }));
    const slow = buildTimelineMap(rippledTimeline(RETAINED, { speed: 1 }));
    const fastCues = deriveCaptionCues(fast, transcript, config());
    const slowCues = deriveCaptionCues(slow, transcript, config());

    expect(fast.duration).toBeCloseTo(slow.duration / 2, 6);
    for (const cue of fastCues) {
      expect(cue.end).toBeLessThanOrEqual(fast.duration + 1e-9);
    }
    // Same speech either way — only the pacing differs.
    const words = (cs: readonly { readonly text: string }[]) => cs.map((c) => c.text).join(' ');
    expect(words(fastCues).split(/\s+/).length).toBe(words(slowCues).split(/\s+/).length);
  });

  it('drops the cues for footage removed by a later trim', () => {
    const trimmed = rippledTimeline([[6.86, 12.0], ...RETAINED.slice(1)]);
    const cues = deriveCaptionCues(buildTimelineMap(trimmed), transcript, config());
    const firstClip = cues.filter((c) => c.clipId === 'clip_0');
    for (const cue of firstClip) {
      expect(cue.sourceEnd).toBeLessThanOrEqual(12.0 + 0.4);
    }
  });

  it('keeps two assets’ transcripts apart', () => {
    const multi: Timeline = {
      revision: 3,
      tracks: [
        {
          id: 'track_v1',
          type: 'video' as const,
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_a',
              trackId: 'track_v1',
              start: 0,
              end: 5,
              sourceStart: 10,
              sourceEnd: 15,
              effects: [],
              keyframes: [],
            },
            {
              id: 'clip_b',
              assetId: 'asset_b',
              trackId: 'track_v1',
              start: 5,
              end: 10,
              sourceStart: 10,
              sourceEnd: 15,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    const cues = deriveCaptionCues(
      buildTimelineMap(multi),
      [
        { word: 'alpha', start: 11, end: 11.5, assetId: 'asset_a' },
        { word: 'beta', start: 11, end: 11.5, assetId: 'asset_b' },
      ],
      config(),
    );
    // Identical source times, different assets: they must land 5s apart, not
    // both on whichever clip happened to be checked first.
    const alpha = cues.find((c) => c.text.includes('alpha'))!;
    const beta = cues.find((c) => c.text.includes('beta'))!;
    expect(alpha.start).toBeCloseTo(1, 6);
    expect(beta.start).toBeCloseTo(6, 6);
  });
});

// ---------------------------------------------------------------------------
// Boundary and rounding behavior
// ---------------------------------------------------------------------------

describe('edit-boundary handling', () => {
  it('clamps a word straddling a cut instead of letting it overhang', () => {
    const map = buildTimelineMap(rippledTimeline([[0, 10]]));
    const mapped = mapTranscript(map, [
      // Mostly inside, ending 0.3s past the out-point.
      { word: 'straddle', start: 9.5, end: 10.3, assetId: ASSET },
    ]);
    expect(mapped.words).toHaveLength(1);
    expect(mapped.words[0]!.end).toBeCloseTo(10, 9);
  });

  it('drops a word that is mostly in deleted footage', () => {
    const map = buildTimelineMap(rippledTimeline([[0, 10]]));
    const mapped = mapTranscript(map, [{ word: 'gone', start: 9.95, end: 10.9, assetId: ASSET }]);
    expect(mapped.words).toHaveLength(0);
  });

  it('does not attribute a word to the next clip on sub-frame float error', () => {
    // 19.5 - 6.86 = 12.639999999999999 in IEEE754; a word ending exactly at the
    // cut must not be judged to overlap the following clip.
    const map = buildTimelineMap(rippledTimeline());
    const mapped = mapTranscript(map, [{ word: 'edge', start: 19.1, end: 19.5, assetId: ASSET }]);
    expect(mapped.words).toHaveLength(1);
    expect(mapped.words[0]!.clipId).toBe('clip_0');
  });

  it('handles a timeline with no clips without throwing', () => {
    const empty = buildTimelineMap({ revision: 0, tracks: [] });
    expect(empty.duration).toBe(0);
    expect(deriveCaptionCues(empty, sourceTranscript(), config())).toEqual([]);
    expect(mapTranscript(empty, sourceTranscript()).droppedCount).toBeGreaterThan(0);
  });

  it('handles an empty transcript without producing cues', () => {
    const map = buildTimelineMap(rippledTimeline());
    expect(deriveCaptionCues(map, [], config())).toEqual([]);
  });

  it('ignores zero-duration transcript entries', () => {
    const map = buildTimelineMap(rippledTimeline());
    const mapped = mapTranscript(map, [{ word: 'blip', start: 7, end: 7, assetId: ASSET }]);
    expect(mapped.words).toHaveLength(0);
    expect(mapped.droppedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Surviving a save/reload cycle
// ---------------------------------------------------------------------------

describe('persistence', () => {
  /** A project carrying the derived cues, round-tripped through JSON + parse. */
  function reloaded(): Project {
    const timeline = rippledTimeline();
    const cues = deriveCaptionCues(buildTimelineMap(timeline), sourceTranscript(), config());
    const project = {
      id: 'p1',
      name: 'p',
      version: 1,
      fps: 30,
      resolution: { width: 1080, height: 1920 },
      assets: [{ id: ASSET, path: '/a.mp4', kind: 'video' as const, durationSeconds: 220 }],
      folders: [],
      timeline: {
        ...timeline,
        tracks: [
          ...timeline.tracks,
          {
            id: 'caption_1',
            type: 'caption' as const,
            clips: cues.map((cue, i) => ({
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
            })),
          },
        ],
      },
      transcript: sourceTranscript(),
      markers: [],
      aiMemory: {},
      history: [],
    };
    // Exactly what saving and reopening does.
    return ProjectSchema.parse(JSON.parse(JSON.stringify(project)));
  }

  it('keeps caption timing, provenance, and the revision across a reload', () => {
    const project = reloaded();
    const captions = project.timeline.tracks.find((t) => t.type === 'caption')!.clips;
    expect(captions.length).toBeGreaterThan(0);
    expect(project.timeline.revision).toBe(1);
    for (const clip of captions) {
      // Provenance is what makes a reloaded caption checkable rather than merely
      // present — without it, a reopened project can only assume it is current.
      expect(clip.captionCue?.derivedFromRevision).toBe(1);
      expect(clip.captionCue?.source?.assetId).toBe(ASSET);
      expect(clip.captionCue?.source?.end).toBeGreaterThan(clip.captionCue!.source!.start);
    }
  });

  it('re-derives byte-identically from the reloaded project', () => {
    // The mapping is a pure function of persisted state, so reopening a project
    // and regenerating must reproduce what was there — no hidden in-memory
    // context that a reload would lose.
    const project = reloaded();
    const again = deriveCaptionCues(
      buildTimelineMap(project.timeline),
      project.transcript,
      config(),
    );
    const stored = project.timeline.tracks
      .find((t) => t.type === 'caption')!
      .clips.map((c) => [c.captionCue!.text, +c.start.toFixed(6), +c.end.toFixed(6)]);
    expect(again.map((c) => [c.text, +c.start.toFixed(6), +c.end.toFixed(6)])).toEqual(stored);
  });

  it('keeps the transcript source-relative on disk', () => {
    // The transcript must NOT be rewritten into sequence time when captions are
    // generated: it belongs to the asset and has to stay reusable across edits.
    const project = reloaded();
    expect(project.transcript[0]!.start).toBe(0);
    expect(project.transcript.at(-1)!.start).toBeGreaterThan(
      buildTimelineMap(project.timeline).duration,
    );
  });
});
