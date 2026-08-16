/** Tests for structured slice retrieval (kernel/semantic-index/semantic-index-slice.ts, P4.2). */
import { describe, expect, it } from 'vitest';
import type { SemanticTimelineIndex } from './semantic-index.js';
import { boundSemanticIndexSlice, getSlice } from './semantic-index-slice.js';

/** A fully-populated fixture index (every category non-empty) to slice in the tests below. */
function fixtureIndex(): SemanticTimelineIndex {
  return {
    layers: [
      {
        trackId: 'v1',
        z: 0,
        position: 'front',
        kind: 'video',
        clipCount: 2,
        span: { start: 0, end: 10 },
      },
      {
        trackId: 'au1',
        z: 1,
        position: 'back',
        kind: 'audio',
        clipCount: 1,
        span: { start: 0, end: 10 },
      },
      { trackId: 'empty', z: 2, position: 'back', kind: 'empty', clipCount: 0, span: null },
    ],
    dialogue: [
      { start: 0, end: 2, text: 'hello there' },
      { start: 12, end: 18, text: 'the important bit' },
      { start: 30, end: 32, text: 'goodbye' },
    ],
    captions: [
      { clipId: 'c1', trackId: 'ov1', start: 0, end: 2, text: 'hello there' },
      { clipId: 'c2', trackId: 'ov1', start: 12, end: 18, text: 'the important bit' },
    ],
    transitions: [{ clipId: 'c1', effectId: 'tr1', kind: 'fade' }],
    effects: [{ clipId: 'c1', effectId: 'e1', type: 'color_grade', category: 'color' }],
    music: [
      {
        trackId: 'au1',
        ranges: [
          { start: 0, end: 5 },
          { start: 20, end: 30 },
        ],
      },
    ],
    shots: [
      { start: 0, end: 3, sourceClipId: 'broll1' },
      { start: 12, end: 16, sourceClipId: 'broll1' },
    ],
    silences: [
      { start: 2, end: 3 },
      { start: 20, end: 22 },
    ],
    beats: { times: [0, 5, 13, 17, 40], bpm: 120 },
    speedRamps: [],
    markers: [],
    broll: [],
  };
}

describe('getSlice — no query (defaults)', () => {
  it('returns everything unfiltered when the query is omitted', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx);
    expect(slice.layers).toEqual(idx.layers);
    expect(slice.dialogue).toEqual(idx.dialogue);
    expect(slice.captions).toEqual(idx.captions);
    expect(slice.transitions).toEqual(idx.transitions);
    expect(slice.effects).toEqual(idx.effects);
    expect(slice.music).toEqual(idx.music);
    expect(slice.shots).toEqual(idx.shots);
    expect(slice.silences).toEqual(idx.silences);
    expect(slice.beats).toEqual(idx.beats);
  });

  it('returns everything unfiltered for an explicit empty-object query', () => {
    const idx = fixtureIndex();
    expect(getSlice(idx, {})).toEqual(getSlice(idx));
  });
});

describe('boundSemanticIndexSlice — long-project model boundary', () => {
  it('keeps deterministic beginning/middle/end coverage while bounding every large category', () => {
    const dialogue = Array.from({ length: 1_001 }, (_, index) => ({
      start: index,
      end: index + 0.5,
      text: `line ${String(index)}`,
    }));
    const source = getSlice({
      ...fixtureIndex(),
      dialogue,
      beats: { times: Array.from({ length: 2_001 }, (_, index) => index * 0.5), bpm: 120 },
    });

    const bounded = boundSemanticIndexSlice(source, {
      entriesPerKind: 5,
      beatTimes: 5,
      musicRangesPerTrack: 2,
    });

    expect(bounded.dialogue).toHaveLength(5);
    expect(bounded.dialogue.map((entry) => entry.text)).toEqual([
      'line 0',
      'line 250',
      'line 500',
      'line 750',
      'line 1000',
    ]);
    expect(bounded.beats).toEqual({ times: [0, 250, 500, 750, 1_000], bpm: 120 });
  });

  it('omits bpm when bounding a beat grid whose source never carried one', () => {
    // The bpm field is optional on the source grid; the bounded copy must not fabricate
    // one just because the shape has a slot for it.
    const source = getSlice({
      ...fixtureIndex(),
      beats: { times: [0, 5, 13, 17, 40] },
    });

    const bounded = boundSemanticIndexSlice(source, {
      entriesPerKind: 5,
      beatTimes: 3,
      musicRangesPerTrack: 2,
    });

    expect(bounded.beats).toEqual({ times: [0, 13, 40] });
  });

  it('keeps only the first entry when the bound is exactly 1 (no midpoint to distribute across)', () => {
    // The general "evenly distribute across limit-1 gaps" math divides by `limit - 1`,
    // which is undefined at limit 1 — this must short-circuit to "just the first entry"
    // rather than dividing by zero.
    const source = getSlice({ ...fixtureIndex(), beats: { times: [0, 5, 13, 17, 40] } });
    const bounded = boundSemanticIndexSlice(source, {
      entriesPerKind: 5,
      beatTimes: 1,
      musicRangesPerTrack: 2,
    });
    expect(bounded.beats).toEqual({ times: [0] });
  });

  it('passes a null beat grid through unbounded', () => {
    const source = getSlice({ ...fixtureIndex(), beats: null });
    const bounded = boundSemanticIndexSlice(source, {
      entriesPerKind: 5,
      beatTimes: 5,
      musicRangesPerTrack: 2,
    });
    expect(bounded.beats).toBeNull();
  });
});

describe('getSlice — empty index / no matches', () => {
  const empty: SemanticTimelineIndex = {
    layers: [],
    dialogue: [],
    captions: [],
    transitions: [],
    effects: [],
    music: [],
    shots: [],
    silences: [],
    beats: null,
    speedRamps: [],
    markers: [],
    broll: [],
  };

  it('slices an empty index to an all-empty slice, never throwing', () => {
    const slice = getSlice(empty, { timeRange: { start: 0, end: 100 }, layerId: 'v1' });
    expect(slice).toEqual({
      layers: [],
      dialogue: [],
      captions: [],
      transitions: [],
      effects: [],
      music: [],
      shots: [],
      silences: [],
      beats: null,
    });
  });

  it('yields empty arrays / null beats for a time range that matches nothing', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { timeRange: { start: 100, end: 200 } });
    expect(slice.dialogue).toEqual([]);
    expect(slice.captions).toEqual([]);
    expect(slice.shots).toEqual([]);
    expect(slice.silences).toEqual([]);
    expect(slice.beats).toBeNull();
    expect(slice.music).toEqual([]);
    expect(slice.layers).toEqual([]); // no layer's span overlaps [100,200)
  });
});

describe('getSlice — timeRange filtering', () => {
  it('keeps only dialogue/captions/shots/silences overlapping the range', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { timeRange: { start: 10, end: 20 } });
    expect(slice.dialogue).toEqual([{ start: 12, end: 18, text: 'the important bit' }]);
    expect(slice.captions).toEqual([
      { clipId: 'c2', trackId: 'ov1', start: 12, end: 18, text: 'the important bit' },
    ]);
    expect(slice.shots).toEqual([{ start: 12, end: 16, sourceClipId: 'broll1' }]);
  });

  it('keeps an entry that only PARTIALLY overlaps the query range (edge case)', () => {
    const idx = fixtureIndex();
    // Query [1, 13) only partially overlaps dialogue [0,2) and [12,18) — both still count.
    const slice = getSlice(idx, { timeRange: { start: 1, end: 13 } });
    expect(slice.dialogue.map((d) => d.text)).toEqual(['hello there', 'the important bit']);
  });

  it('excludes an entry that ends exactly at the range start (half-open, no overlap)', () => {
    const idx = fixtureIndex();
    // silence [2,3) vs range starting at 3: [3, 10) — end(3) is not > start(3) -> excluded.
    const slice = getSlice(idx, { timeRange: { start: 3, end: 10 } });
    expect(slice.silences).toEqual([]);
  });

  it('filters music ranges within the query, dropping the entry if none survive', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { timeRange: { start: 0, end: 10 } });
    expect(slice.music).toEqual([{ trackId: 'au1', ranges: [{ start: 0, end: 5 }] }]);

    const outOfRange = getSlice(idx, { timeRange: { start: 100, end: 200 } });
    expect(outOfRange.music).toEqual([]);
  });

  it('filters a layer by span overlap, dropping an empty-span (null) layer entirely', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { timeRange: { start: 0, end: 1 } });
    expect(slice.layers.map((l) => l.trackId)).toEqual(['v1', 'au1']); // 'empty' has span: null
  });

  it('filters the beat grid to times within the range, nulling out when none survive', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { timeRange: { start: 10, end: 20 } });
    expect(slice.beats).toEqual({ times: [13, 17], bpm: 120 });

    const none = getSlice(idx, { timeRange: { start: 1000, end: 2000 } });
    expect(none.beats).toBeNull();
  });

  it('omits bpm from a filtered beat grid whose source grid never carried one', () => {
    const idx = { ...fixtureIndex(), beats: { times: [0, 5, 13, 17, 40] } }; // no bpm field
    const slice = getSlice(idx, { timeRange: { start: 10, end: 20 } });
    expect(slice.beats).toEqual({ times: [13, 17] });
  });

  it('leaves transitions/effects unfiltered by timeRange (no timeline position on those entries)', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { timeRange: { start: 1000, end: 2000 } });
    expect(slice.transitions).toEqual(idx.transitions);
    expect(slice.effects).toEqual(idx.effects);
  });
});

describe('getSlice — layerId filtering', () => {
  it('narrows layers/music/captions to the requested track id', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { layerId: 'au1' });
    expect(slice.layers.map((l) => l.trackId)).toEqual(['au1']);
    expect(slice.music.map((m) => m.trackId)).toEqual(['au1']);
    expect(slice.captions).toEqual([]); // no caption entries live on 'au1'
  });

  it('combines with timeRange (both filters apply)', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { layerId: 'au1', timeRange: { start: 0, end: 10 } });
    expect(slice.music).toEqual([{ trackId: 'au1', ranges: [{ start: 0, end: 5 }] }]);
  });

  it('yields no layers for an id that does not exist', () => {
    const idx = fixtureIndex();
    expect(getSlice(idx, { layerId: 'no_such_track' }).layers).toEqual([]);
  });
});

describe('getSlice — kinds filtering', () => {
  it('restricts the slice to only the requested categories; the rest come back empty', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { kinds: ['dialogue', 'beats'] });
    expect(slice.dialogue).toEqual(idx.dialogue);
    expect(slice.beats).toEqual(idx.beats);
    expect(slice.captions).toEqual([]);
    expect(slice.shots).toEqual([]);
    expect(slice.silences).toEqual([]);
    expect(slice.transitions).toEqual([]);
    expect(slice.effects).toEqual([]);
    expect(slice.music).toEqual([]);
    expect(slice.layers).toEqual([]);
  });

  it('combines kinds with timeRange — an excluded kind ignores the range entirely', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { kinds: ['dialogue'], timeRange: { start: 10, end: 20 } });
    expect(slice.dialogue).toEqual([{ start: 12, end: 18, text: 'the important bit' }]);
    expect(slice.shots).toEqual([]); // excluded by kinds, regardless of overlap
  });

  it('an empty kinds list yields an all-empty slice', () => {
    const idx = fixtureIndex();
    const slice = getSlice(idx, { kinds: [] });
    expect(slice).toEqual({
      layers: [],
      dialogue: [],
      captions: [],
      transitions: [],
      effects: [],
      music: [],
      shots: [],
      silences: [],
      beats: null,
    });
  });
});
