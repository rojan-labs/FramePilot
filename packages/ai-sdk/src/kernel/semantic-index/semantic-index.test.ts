/** Tests for the Semantic Timeline Index (kernel/semantic-index/semantic-index.ts, Phase K2.1). */
import { describe, expect, it } from 'vitest';
import type { Clip, Effect, Project, Track } from '@framepilot/timeline-schema';
import { buildSemanticIndex, semanticIndexFor } from './semantic-index.js';

const clip = (
  id: string,
  trackId: string,
  assetId: string,
  start = 0,
  end = 5,
  effects: Effect[] = [],
): Clip => ({
  id,
  assetId,
  trackId,
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects,
  keyframes: [],
});

const eff = (id: string, type: string, params: Record<string, unknown> = {}): Effect => ({
  id,
  type,
  params,
  keyframes: [],
});

const track = (id: string, type: Track['type'], clips: Clip[]): Track => ({ id, type, clips });

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Demo',
  version: 1,
  fps: 30,
  resolution: { width: 1080, height: 1920 },
  assets: [
    { id: 'a1', path: '/media/Intro.mp4', kind: 'video' },
    { id: 'a2', path: '/media/music.mp3', kind: 'audio' },
    { id: 'a3', path: '/media/logo.png', kind: 'image' },
  ] as Project['assets'],
  folders: [],
  timeline: {
    tracks: [
      track('v1', 'video', [clip('c1', 'v1', 'a1', 0, 5), clip('c2', 'v1', 'a1', 5, 9)]),
      track('au1', 'audio', [clip('c3', 'au1', 'a2', 0, 9)]),
      track('ov1', 'overlay', [
        clip('c4', 'ov1', '__text__', 1, 3, [eff('e1', 'text', { text: 'Introduction' })]),
        clip('c5', 'ov1', '__caption__', 3, 6, [eff('e2', 'caption', { text: 'hello world' })]),
      ]),
    ],
  },
  transcript: [],
  aiMemory: {},
  history: [],
  ...over,
});

describe('layers', () => {
  it('projects z-ordered, kind-labeled layers with spans', () => {
    const { layers } = buildSemanticIndex(project());
    expect(layers.map((l) => [l.trackId, l.z, l.position, l.kind, l.clipCount])).toEqual([
      ['v1', 0, 'front', 'video', 2],
      ['au1', 1, 'mid', 'audio', 1],
      ['ov1', 2, 'back', 'text', 2], // text (c4) then caption (c5) tie 1–1 → first encountered wins
    ]);
    expect(layers[0]!.span).toEqual({ start: 0, end: 9 });
  });

  it('labels an empty layer and gives it a null span', () => {
    const { layers } = buildSemanticIndex(
      project({ timeline: { tracks: [track('empty', 'video', [])] } }),
    );
    expect(layers).toEqual([
      { trackId: 'empty', z: 0, position: 'front', kind: 'empty', clipCount: 0, span: null },
    ]);
  });

  it('resolves a dominant-kind tie to the first kind encountered (stable)', () => {
    // One text clip then one caption clip → counts tie at 1; first (text) wins.
    const { layers } = buildSemanticIndex(
      project({
        timeline: {
          tracks: [
            track('ov', 'overlay', [
              clip('t', 'ov', '__text__', 0, 1),
              clip('c', 'ov', '__caption__', 1, 2),
            ]),
          ],
        },
      }),
    );
    expect(layers[0]!.kind).toBe('text');
  });

  it('positions the single track as front (count of 1)', () => {
    const { layers } = buildSemanticIndex(
      project({ timeline: { tracks: [track('v', 'video', [clip('c', 'v', 'a1')])] } }),
    );
    expect(layers[0]!.position).toBe('front');
  });
});

describe('dialogue', () => {
  it('groups contiguous transcript words into utterances and splits on a large gap', () => {
    const { dialogue } = buildSemanticIndex(
      project({
        transcript: [
          { word: 'hello', start: 0, end: 0.4 },
          { word: 'there', start: 0.5, end: 0.9 },
          // gap > 0.6s → new segment
          { word: 'again', start: 2.0, end: 2.4 },
        ],
      }),
    );
    expect(dialogue).toEqual([
      { start: 0, end: 0.9, text: 'hello there' },
      { start: 2.0, end: 2.4, text: 'again' },
    ]);
  });

  it('is empty when there is no transcript', () => {
    expect(buildSemanticIndex(project()).dialogue).toEqual([]);
  });

  it('keeps a segment together across a sub-threshold gap', () => {
    const { dialogue } = buildSemanticIndex(
      project({
        transcript: [
          { word: 'a', start: 0, end: 1 },
          { word: 'b', start: 1.3, end: 2 }, // gap 0.3 < 0.6 → same segment
        ],
      }),
    );
    expect(dialogue).toEqual([{ start: 0, end: 2, text: 'a b' }]);
  });

  it('extends segment end from an out-of-order/overlapping word', () => {
    const { dialogue } = buildSemanticIndex(
      project({
        transcript: [
          { word: 'long', start: 0, end: 3 },
          { word: 'short', start: 0.1, end: 0.5 }, // ends before current.end
        ],
      }),
    );
    expect(dialogue).toEqual([{ start: 0, end: 3, text: 'long short' }]);
  });
});

describe('captions', () => {
  it('collects caption clips with their rendered text', () => {
    const { captions } = buildSemanticIndex(project());
    expect(captions).toEqual([
      { clipId: 'c5', trackId: 'ov1', start: 3, end: 6, text: 'hello world' },
    ]);
  });

  it('yields empty text for a caption clip whose effect carries no text', () => {
    const { captions } = buildSemanticIndex(
      project({
        timeline: {
          tracks: [track('cap', 'caption', [clip('x', 'cap', '__caption__', 0, 1, [])])],
        },
      }),
    );
    expect(captions).toEqual([{ clipId: 'x', trackId: 'cap', start: 0, end: 1, text: '' }]);
  });
});

describe('transitions & effects', () => {
  it('separates transitions (with params) from categorized effects', () => {
    const p = project({
      timeline: {
        tracks: [
          track('v', 'video', [
            clip('c1', 'v', 'a1', 0, 5, [
              eff('tr', 'transition', { kind: 'fade', durationSeconds: 1, fromClipId: 'c0' }),
              eff('cg', 'color_grade', {}),
            ]),
            clip('c2', 'v', 'a1', 5, 9, [
              eff('gain', 'audio_gain', {}),
              eff('m', 'mask', {}),
              eff('t', 'text', { text: 'hi' }),
              eff('w', 'wormhole', {}),
            ]),
          ]),
        ],
      },
    });
    const { transitions, effects } = buildSemanticIndex(p);
    expect(transitions).toEqual([
      { clipId: 'c1', effectId: 'tr', kind: 'fade', durationSeconds: 1, fromClipId: 'c0' },
    ]);
    expect(effects).toEqual([
      { clipId: 'c1', effectId: 'cg', type: 'color_grade', category: 'color' },
      { clipId: 'c2', effectId: 'gain', type: 'audio_gain', category: 'audio' },
      { clipId: 'c2', effectId: 'm', type: 'mask', category: 'mask' },
      { clipId: 'c2', effectId: 't', type: 'text', category: 'text' },
      { clipId: 'c2', effectId: 'w', type: 'wormhole', category: 'other' },
    ]);
  });

  it('omits transition params that are absent or the wrong type', () => {
    const { transitions } = buildSemanticIndex(
      project({
        timeline: {
          tracks: [
            track('v', 'video', [
              clip('c', 'v', 'a1', 0, 5, [eff('tr', 'transition', { durationSeconds: 'long' })]),
            ]),
          ],
        },
      }),
    );
    expect(transitions).toEqual([{ clipId: 'c', effectId: 'tr' }]);
  });
});

describe('music', () => {
  it('collects audio-clip ranges per audio-bearing track only', () => {
    const { music } = buildSemanticIndex(project());
    expect(music).toEqual([{ trackId: 'au1', ranges: [{ start: 0, end: 9 }] }]);
  });
});

describe('defensive shape handling (hand-built fixtures may omit schema defaults)', () => {
  it('treats a track with omitted clips as empty', () => {
    const bare = { id: 't', type: 'video' } as unknown as Track;
    const idx = buildSemanticIndex(project({ timeline: { tracks: [bare] } }));
    expect(idx.layers[0]).toMatchObject({ trackId: 't', kind: 'empty', clipCount: 0, span: null });
    expect(idx.music).toEqual([]);
  });

  it('treats a clip with omitted effects as having none', () => {
    const bareClip = {
      id: 'c',
      assetId: 'a1',
      trackId: 'v',
      start: 0,
      end: 5,
      sourceStart: 0,
      sourceEnd: 5,
    } as unknown as Clip;
    const idx = buildSemanticIndex(
      project({ timeline: { tracks: [track('v', 'video', [bareClip])] } }),
    );
    expect(idx.transitions).toEqual([]);
    expect(idx.effects).toEqual([]);
  });

  it('yields empty caption text when the caption clip omits effects entirely', () => {
    const bareCaption = {
      id: 'x',
      assetId: '__caption__',
      trackId: 'cap',
      start: 0,
      end: 2,
      sourceStart: 0,
      sourceEnd: 2,
    } as unknown as Clip;
    const { captions } = buildSemanticIndex(
      project({ timeline: { tracks: [track('cap', 'caption', [bareCaption])] } }),
    );
    expect(captions).toEqual([{ clipId: 'x', trackId: 'cap', start: 0, end: 2, text: '' }]);
  });

  it('reads caption text from a text effect when no caption effect carries it', () => {
    const { captions } = buildSemanticIndex(
      project({
        timeline: {
          tracks: [
            track('cap', 'caption', [
              clip('x', 'cap', '__caption__', 0, 2, [eff('t', 'text', { text: 'from text eff' })]),
            ]),
          ],
        },
      }),
    );
    expect(captions).toEqual([
      { clipId: 'x', trackId: 'cap', start: 0, end: 2, text: 'from text eff' },
    ]);
  });
});

describe('analysis-fed slices — absent analysisResults (honest empty, unchanged)', () => {
  it('are honestly empty when no analysisResults bag is supplied (no faked analysis)', () => {
    const idx = buildSemanticIndex(project());
    expect(idx.shots).toEqual([]);
    expect(idx.silences).toEqual([]);
    expect(idx.beats).toBeNull();
    expect(idx.loudness).toBeNull();
    expect(idx.black).toEqual([]);
    expect(idx.speedRamps).toEqual([]);
    expect(idx.markers).toEqual([]);
    expect(idx.broll).toEqual([]);
  });

  it('are honestly empty when an empty analysisResults bag is supplied', () => {
    const idx = buildSemanticIndex(project(), {});
    expect(idx.shots).toEqual([]);
    expect(idx.silences).toEqual([]);
    expect(idx.beats).toBeNull();
    expect(idx.loudness).toBeNull();
    expect(idx.black).toEqual([]);
  });
});

// A project with an asset placed on the timeline via exactly one clip, offset from 0 so a
// source-time -> timeline-time translation is actually exercised (not a no-op identity map).
function placedAssetProject(over: Partial<Project> = {}): Project {
  return project({
    assets: [
      { id: 'a1', path: '/media/Intro.mp4', kind: 'video' },
      { id: 'broll', path: '/media/broll.mp4', kind: 'video' },
      { id: 'music', path: '/media/music.mp3', kind: 'audio' },
    ] as Project['assets'],
    timeline: {
      tracks: [
        track('v1', 'video', [clip('c1', 'v1', 'a1', 0, 5)]),
        // broll is trimmed to source [1, 9) and placed starting at timeline 10s, so
        // timeline = source + 9.
        track('v2', 'video', [
          { ...clip('broll1', 'v2', 'broll', 10, 18), sourceStart: 1, sourceEnd: 9 },
        ]),
        // music placed 1:1 at timeline 0 (offset 0).
        track('au1', 'audio', [
          { ...clip('music1', 'au1', 'music', 0, 10), sourceStart: 0, sourceEnd: 10 },
        ]),
      ],
    },
    ...over,
  });
}

describe('analysis-fed slices — shots (detect_scenes ingestion, P4.1)', () => {
  it('translates scene cuts on a placed asset into timeline-space shots', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      shots: { assetId: 'broll', cuts: [{ time: 3 }, { time: 5 }, { time: 8 }] },
    });
    // cuts [3,5,8] (source time) -> 2 shots, translated by +9 (timeline = source + 9).
    expect(idx.shots).toEqual([
      { start: 12, end: 14, sourceClipId: 'broll1' },
      { start: 14, end: 17, sourceClipId: 'broll1' },
    ]);
  });

  it('dedupes and sorts out-of-order/duplicate cut times before pairing shots', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      shots: { assetId: 'broll', cuts: [{ time: 8 }, { time: 3 }, { time: 3 }, { time: 5 }] },
    });
    expect(idx.shots).toEqual([
      { start: 12, end: 14, sourceClipId: 'broll1' },
      { start: 14, end: 17, sourceClipId: 'broll1' },
    ]);
  });

  it("clips a shot to the clip's trimmed source window (partial overlap)", () => {
    // Cut range [0, 1) falls entirely before the clip's sourceStart (1) -> no shot for it;
    // [1, 12) partially overlaps [1, 9) -> clipped to the clip's own window.
    const idx = buildSemanticIndex(placedAssetProject(), {
      shots: { assetId: 'broll', cuts: [{ time: 0 }, { time: 1 }, { time: 12 }] },
    });
    expect(idx.shots).toEqual([
      { start: 10, end: 18, sourceClipId: 'broll1' }, // [1,9) source -> [10,18) timeline
    ]);
  });

  it('yields no shots for fewer than two cut times (nothing to bound a shot)', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      shots: { assetId: 'broll', cuts: [{ time: 3 }] },
    });
    expect(idx.shots).toEqual([]);
  });

  it('yields no shots when the analyzed asset is not placed on the timeline', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      shots: { assetId: 'not_on_timeline', cuts: [{ time: 1 }, { time: 2 }] },
    });
    expect(idx.shots).toEqual([]);
  });

  it('ignores a malformed detect_scenes payload (no assetId, non-array cuts, bad rows)', () => {
    expect(buildSemanticIndex(placedAssetProject(), { shots: {} }).shots).toEqual([]);
    expect(
      buildSemanticIndex(placedAssetProject(), { shots: { assetId: 'broll', cuts: 'nope' } }).shots,
    ).toEqual([]);
    expect(
      buildSemanticIndex(placedAssetProject(), {
        shots: { assetId: 'broll', cuts: [{ time: 'x' }, { time: -1 }, { time: 5 }] },
      }).shots,
    ).toEqual([]); // only one valid time survives -> still fewer than two
  });

  it('breaks a start-time tie on end time when two clips place the same asset identically', () => {
    // Two clips on different tracks both place `broll` at the same timeline offset (+9), so
    // every translated shot from one clip ties on `start` with its counterpart from the
    // other — the sort's secondary key (`end`) has to run, not just the primary one.
    const p = project({
      assets: [{ id: 'broll', path: '/media/broll.mp4', kind: 'video' }] as Project['assets'],
      timeline: {
        tracks: [
          track('v1', 'video', [
            { ...clip('broll1', 'v1', 'broll', 10, 18), sourceStart: 1, sourceEnd: 9 },
          ]),
          track('v2', 'video', [
            { ...clip('broll2', 'v2', 'broll', 10, 18), sourceStart: 1, sourceEnd: 9 },
          ]),
        ],
      },
    });
    const idx = buildSemanticIndex(p, {
      shots: { assetId: 'broll', cuts: [{ time: 3 }, { time: 5 }] },
    });
    expect(idx.shots).toEqual([
      { start: 12, end: 14, sourceClipId: 'broll1' },
      { start: 12, end: 14, sourceClipId: 'broll2' },
    ]);
  });
});

describe('analysis-fed slices — silences (analyze_silence ingestion, P4.1)', () => {
  it('translates silent ranges on a placed asset into timeline-space silences', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      silences: { assetId: 'broll', ranges: [{ start: 2, end: 4, duration: 2 }] },
    });
    expect(idx.silences).toEqual([{ start: 11, end: 13 }]);
  });

  it('drops a malformed row (non-positive length) but keeps well-formed ones', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      silences: {
        assetId: 'broll',
        ranges: [
          { start: 5, end: 5 }, // zero-length, dropped
          { start: 6, end: 3 }, // inverted, dropped
          { start: 2, end: 4 },
        ],
      },
    });
    expect(idx.silences).toEqual([{ start: 11, end: 13 }]);
  });

  it('yields no silences when the analyzed asset is not placed on the timeline', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      silences: { assetId: 'ghost', ranges: [{ start: 0, end: 1 }] },
    });
    expect(idx.silences).toEqual([]);
  });

  it('ignores a malformed analyze_silence payload (no assetId, non-array ranges)', () => {
    expect(buildSemanticIndex(placedAssetProject(), { silences: {} }).silences).toEqual([]);
    expect(
      buildSemanticIndex(placedAssetProject(), { silences: { assetId: 'broll', ranges: 'nope' } })
        .silences,
    ).toEqual([]);
  });
});

describe('analysis-fed slices — black frames (brain black rows, B2.4)', () => {
  it('translates black ranges on a placed asset into timeline time', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      black: { assetId: 'broll', ranges: [{ start: 2, end: 4, duration: 2 }] },
    });
    expect(idx.black).toEqual([{ start: 11, end: 13 }]);
  });

  it('yields no black ranges for an unplaced asset or a malformed payload', () => {
    expect(
      buildSemanticIndex(placedAssetProject(), {
        black: { assetId: 'ghost', ranges: [{ start: 0, end: 1 }] },
      }).black,
    ).toEqual([]);
    expect(buildSemanticIndex(placedAssetProject(), { black: {} }).black).toEqual([]);
    expect(
      buildSemanticIndex(placedAssetProject(), { black: { assetId: 'broll', ranges: 'nope' } })
        .black,
    ).toEqual([]);
  });
});

describe('analysis-fed slices — loudness (brain loudness rows, B2.4)', () => {
  it('reports loudness for a placed asset, keeping only real optional fields', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      loudness: {
        assetId: 'music',
        integratedLufs: -17.2,
        loudnessRangeLu: 6.1,
        truePeakDbfs: -1.3,
      },
    });
    expect(idx.loudness).toEqual({
      assetId: 'music',
      integratedLufs: -17.2,
      loudnessRangeLu: 6.1,
      truePeakDbfs: -1.3,
    });
  });

  it('omits absent/malformed optional ebur128 fields', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      loudness: { assetId: 'music', integratedLufs: -20, loudnessRangeLu: 'x', truePeakDbfs: null },
    });
    expect(idx.loudness).toEqual({ assetId: 'music', integratedLufs: -20 });
  });

  it('is null for an unplaced asset — unplaced media never populates the projection', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      loudness: { assetId: 'ghost', integratedLufs: -20 },
    });
    expect(idx.loudness).toBeNull();
  });

  it('is null for a malformed payload (no assetId or non-finite integratedLufs)', () => {
    expect(buildSemanticIndex(placedAssetProject(), { loudness: {} }).loudness).toBeNull();
    expect(
      buildSemanticIndex(placedAssetProject(), {
        loudness: { assetId: 'music', integratedLufs: 'loud' },
      }).loudness,
    ).toBeNull();
    expect(
      buildSemanticIndex(placedAssetProject(), {
        loudness: { assetId: 'music', integratedLufs: Number.NaN },
      }).loudness,
    ).toBeNull();
  });

  it('caches per (project, bag) so a loudness-only bag is a distinct entry', () => {
    const p = placedAssetProject();
    const withLoudness = { loudness: { assetId: 'music', integratedLufs: -18 } };
    expect(semanticIndexFor(p, withLoudness)).toBe(semanticIndexFor(p, { ...withLoudness }));
    expect(semanticIndexFor(p, withLoudness)).not.toBe(semanticIndexFor(p, {}));
  });
});

describe('analysis-fed slices — beats (detect_beats ingestion, P4.1)', () => {
  it('translates beat times on a placed asset into a timeline-space beat grid + bpm', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: {
        assetId: 'music',
        beats: [{ time: 0, strength: 1 }, { time: 1 }, { time: 2 }],
        bpm: 120,
      },
    });
    // music is placed 1:1 at timeline 0 -> beat times pass through unchanged.
    expect(idx.beats).toEqual({ times: [0, 1, 2], bpm: 120 });
  });

  it('dedupes/sorts translated beat times via the shared beat-grid normalization', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: { assetId: 'music', beats: [{ time: 2 }, { time: 0 }, { time: 0 }, { time: 1 }] },
    });
    expect(idx.beats).toEqual({ times: [0, 1, 2] });
  });

  it("drops a beat outside the clip's trimmed source window", () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: { assetId: 'music', beats: [{ time: 5 }, { time: 15 }] }, // clip source window is [0,10)
    });
    expect(idx.beats).toEqual({ times: [5] });
  });

  it('omits bpm when the payload does not carry a finite number', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: { assetId: 'music', beats: [{ time: 1 }], bpm: null },
    });
    expect(idx.beats).toEqual({ times: [1] });
  });

  it('yields null when the analyzed asset is not placed on the timeline', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: { assetId: 'ghost', beats: [{ time: 1 }] },
    });
    expect(idx.beats).toBeNull();
  });

  it('yields null when every beat falls outside every clip (nothing survives translation)', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: { assetId: 'music', beats: [{ time: 50 }] },
    });
    expect(idx.beats).toBeNull();
  });

  it('drops one malformed row (non-numeric time) but keeps the well-formed rows beside it', () => {
    const idx = buildSemanticIndex(placedAssetProject(), {
      beats: { assetId: 'music', beats: [{ time: 'nope' }, { time: 1 }, { time: 2 }] },
    });
    expect(idx.beats).toEqual({ times: [1, 2] });
  });

  it('ignores a malformed detect_beats payload (no assetId, non-array beats)', () => {
    expect(buildSemanticIndex(placedAssetProject(), { beats: {} }).beats).toBeNull();
    expect(
      buildSemanticIndex(placedAssetProject(), { beats: { assetId: 'music', beats: 'nope' } })
        .beats,
    ).toBeNull();
  });
});

describe('semanticIndexFor memoization', () => {
  it('returns the same instance for the same project snapshot', () => {
    const p = project();
    expect(semanticIndexFor(p)).toBe(semanticIndexFor(p));
  });

  it('derives a fresh index for a different project snapshot', () => {
    expect(semanticIndexFor(project())).not.toBe(semanticIndexFor(project()));
  });

  it('treats a bag-less call and an empty-bag call as the same cache entry (P4.1)', () => {
    const p = project();
    expect(semanticIndexFor(p)).toBe(semanticIndexFor(p, {}));
  });

  it(
    'caches per (project, analysis-bag) pair — same bag CONTENT reuses the same instance, ' +
      'even from two independently-built bag objects (content-hash keyed, not reference-keyed)',
    () => {
      const p = placedAssetProject();
      const bagA = { shots: { assetId: 'broll', cuts: [{ time: 3 }, { time: 5 }] } };
      const bagB = { shots: { assetId: 'broll', cuts: [{ time: 3 }, { time: 5 }] } };
      expect(bagA).not.toBe(bagB); // genuinely distinct objects, equal content
      expect(semanticIndexFor(p, bagA)).toBe(semanticIndexFor(p, bagB));
    },
  );

  it('derives a fresh index when the analysis bag actually differs', () => {
    const p = placedAssetProject();
    const withBeats = semanticIndexFor(p, { beats: { assetId: 'music', beats: [{ time: 1 }] } });
    const withoutBeats = semanticIndexFor(p);
    expect(withBeats).not.toBe(withoutBeats);
    expect(withBeats.beats).toEqual({ times: [1] });
    expect(withoutBeats.beats).toBeNull();
  });
});
