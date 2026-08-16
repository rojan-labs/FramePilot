/** Tests for the local project index (project-index.ts). */
import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '@framepilot/timeline-schema';
import { buildProjectIndex, clipKindOf, indexFor, relevanceOf } from './project-index.js';

const clip = (id: string, trackId: string, assetId: string, start = 0, end = 5): Clip => ({
  id,
  assetId,
  trackId,
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const project = (): Project => ({
  id: 'p1',
  name: 'Demo',
  version: 1,
  fps: 30,
  resolution: { width: 1080, height: 1920 },
  assets: [
    { id: 'a1', path: '/media/Intro.mp4', kind: 'video', folderId: undefined },
    { id: 'a2', path: '/media/music.mp3', kind: 'audio', folderId: undefined },
  ] as Project['assets'],
  folders: [],
  timeline: {
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [clip('c1', 'v1', 'a1', 0, 5), clip('c2', 'v1', 'a1', 5, 9)],
      },
      { id: 'au1', type: 'audio', clips: [clip('c3', 'au1', 'a2', 0, 9)] },
      {
        id: 'ov1',
        type: 'overlay',
        clips: [
          {
            ...clip('c4', 'ov1', '__text__', 1, 3),
            effects: [{ id: 'e1', type: 'text', params: { text: 'Introduction' }, keyframes: [] }],
          },
          {
            ...clip('c5', 'ov1', 'a1', 3, 6),
            effects: [{ id: 'e2', type: 'transition', params: { style: 'fade' }, keyframes: [] }],
          },
        ],
      },
    ],
  },
  transcript: [],
  aiMemory: {},
  history: [],
});

describe('buildProjectIndex', () => {
  it('looks up clips, tracks, and assets by id with track context', () => {
    const index = buildProjectIndex(project());
    expect(index.clipById.get('c3')?.track.id).toBe('au1');
    expect(index.clipById.get('c1')?.trackIndex).toBe(0);
    expect(index.trackById.get('ov1')?.type).toBe('overlay');
    expect(index.trackIndexById.get('ov1')).toBe(2);
    expect(index.assetById.get('a2')?.kind).toBe('audio');
  });

  it('resolves relationship queries (clips of an asset, effects of a clip)', () => {
    const index = buildProjectIndex(project());
    expect(index.clipsOfAsset('a1').map((e) => e.clip.id)).toEqual(['c1', 'c2', 'c5']);
    expect(index.clipsOfAsset('missing')).toEqual([]);
    expect(index.effectsOf('c5').map((e) => e.effect.type)).toEqual(['transition']);
    expect(index.effectsOf('missing')).toEqual([]);
  });

  it('answers structural queries (track type, clip kind, range, effect type)', () => {
    const index = buildProjectIndex(project());
    expect(index.tracksOfType('audio').map((t) => t.id)).toEqual(['au1']);
    expect(index.clipsOfKind('text').map((e) => e.clip.id)).toEqual(['c4']);
    expect(index.clipsOfKind('audio').map((e) => e.clip.id)).toEqual(['c3']);
    expect(
      index
        .clipsInRange(4.5, 5.5)
        .map((e) => e.clip.id)
        .sort(),
    ).toEqual(['c1', 'c2', 'c3', 'c5']);
    expect(index.clipsWithEffectType('transition').map((e) => e.clip.id)).toEqual(['c5']);
  });

  it('searches overlay text and asset names case-insensitively', () => {
    const index = buildProjectIndex(project());
    const hit = index.search('introduction');
    expect(hit.clips.map((e) => e.clip.id)).toEqual(['c4']);
    const assets = index.search('MUSIC');
    expect(assets.assets.map((a) => a.id)).toEqual(['a2']);
    expect(index.search('   ')).toEqual({ clips: [], assets: [] });
  });

  it('derives clip kinds from content, never the layer', () => {
    const p = project();
    const index = buildProjectIndex(p);
    const byId = index.clipById;
    expect(clipKindOf(byId.get('c4')!.clip, index.assetById)).toBe('text');
    expect(clipKindOf(byId.get('c3')!.clip, index.assetById)).toBe('audio');
    expect(clipKindOf(byId.get('c1')!.clip, index.assetById)).toBe('video');
    expect(clipKindOf(clip('cc', 'x', '__caption__'), index.assetById)).toBe('caption');
    const withImage = new Map(index.assetById);
    withImage.set('img1', { id: 'img1', path: '/media/p.png', kind: 'image' } as never);
    expect(clipKindOf(clip('ci', 'x', 'img1'), withImage)).toBe('image');
  });
});

describe('sparse (pre-parse) projects', () => {
  it('tolerates missing assets/clips/effects arrays (schema defaults not applied)', () => {
    const sparse = {
      id: 'p2',
      name: 'Sparse',
      version: 1,
      fps: 30,
      resolution: { width: 1, height: 1 },
      folders: [],
      timeline: {
        tracks: [
          { id: 't1', type: 'video' }, // no clips array
          {
            id: 't2',
            type: 'overlay',
            clips: [
              {
                id: 'c1',
                assetId: '__text__',
                trackId: 't2',
                start: 0,
                end: 1,
                sourceStart: 0,
                sourceEnd: 1,
                // no effects / keyframes arrays
              },
            ],
          },
        ],
      },
      transcript: [],
      aiMemory: {},
      history: [],
    } as unknown as Project;
    const index = buildProjectIndex(sparse);
    expect(index.clipById.get('c1')?.track.id).toBe('t2');
    expect(index.effectsOf('c1')).toEqual([]);
    expect(index.clipsWithEffectType('transition')).toEqual([]);
    expect(index.search('anything')).toEqual({ clips: [], assets: [] });
    expect(index.assetById.size).toBe(0);
  });
});

describe('indexFor (memoized, incremental)', () => {
  it('returns the same index for the same project snapshot', () => {
    const p = project();
    expect(indexFor(p)).toBe(indexFor(p));
  });

  it('rebuilds for a new snapshot and reflects deletions with no stale entries', () => {
    const p1 = project();
    const first = indexFor(p1);
    expect(first.clipsOfAsset('a2')).toHaveLength(1);

    // Delete asset a2 and its clip (an immutable edit produces a NEW project).
    const p2: Project = {
      ...p1,
      assets: p1.assets.filter((a) => a.id !== 'a2'),
      timeline: {
        tracks: p1.timeline.tracks.map((t): Track => (t.id === 'au1' ? { ...t, clips: [] } : t)),
      },
    };
    const second = indexFor(p2);
    expect(second).not.toBe(first);
    expect(second.assetById.has('a2')).toBe(false);
    expect(second.clipsOfAsset('a2')).toEqual([]);
    expect(second.clipById.has('c3')).toBe(false);
    // The untouched video track's clips are still fully indexed.
    expect(second.clipById.get('c1')?.track.id).toBe('v1');
  });

  it('reuses unchanged tracks across edits (per-track incremental reuse)', () => {
    const p1 = project();
    const before = indexFor(p1);
    // Edit ONLY the audio track; the video/overlay Track objects keep identity.
    const p2: Project = {
      ...p1,
      timeline: {
        tracks: p1.timeline.tracks.map(
          (t): Track => (t.id === 'au1' ? { ...t, clips: [clip('c3b', 'au1', 'a2', 1, 8)] } : t),
        ),
      },
    };
    const after = indexFor(p2);
    // Same underlying Clip objects for the untouched track — proof the per-track
    // sub-index was reused rather than rebuilt.
    expect(after.clipById.get('c1')?.clip).toBe(before.clipById.get('c1')?.clip);
    expect(after.clipById.get('c3b')).toBeDefined();
    expect(after.clipById.has('c3')).toBe(false);
  });
});

describe('relevance-ranked search + keyframed clips (H10)', () => {
  it('ranks prefix > word-boundary > substring matches', () => {
    expect(relevanceOf('intro title', 'intro')).toBe(3);
    expect(relevanceOf('the intro title', 'intro')).toBe(2);
    expect(relevanceOf('reintroduction', 'intro')).toBe(1);
    expect(relevanceOf('outro', 'intro')).toBe(0);
    expect(relevanceOf('99 intro', 'intro')).toBe(2);
    expect(relevanceOf('v9intro', 'intro')).toBe(1);
    expect(relevanceOf('Zintro', 'intro')).toBe(1); // uppercase word char before
  });

  it('orders search results by relevance', () => {
    const fixture = project();
    const index = buildProjectIndex(fixture);
    const { clips } = index.search('re');
    // Every returned clip actually matches; scores are non-increasing.
    const scores = clips.map((e) => {
      const text = (e.clip.effects ?? [])
        .filter((f) => f.type === 'text' || f.type === 'caption')
        .map((f) => String((f.params as { text?: unknown }).text ?? ''))
        .join(' ')
        .toLowerCase();
      return relevanceOf(text, 're');
    });
    expect(scores.every((s) => s > 0)).toBe(true);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('finds clips animated by clip-level or effect-level keyframes', () => {
    const kf = { time: 0, property: 'scale', value: 1, easing: 'linear' };
    const base = project();
    const animated: Project = {
      ...base,
      timeline: {
        tracks: [
          {
            id: 'v1',
            type: 'video',
            clips: [
              { ...clip('k1', 'v1', 'a1', 0, 2), keyframes: [kf] } as Clip,
              {
                ...clip('k2', 'v1', 'a1', 2, 4),
                effects: [{ id: 'fx', type: 'transform', params: {}, keyframes: [kf] }],
              } as Clip,
              {
                // Static, with an effect whose keyframes field is absent (pre-parse).
                ...clip('k3', 'v1', 'a1', 4, 6),
                effects: [{ id: 'fx3', type: 'text', params: { text: 'hi' } }],
              } as unknown as Clip,
              // Pre-parse shapes may omit the arrays entirely — must not throw.
              {
                ...clip('k4', 'v1', 'a1', 6, 8),
                keyframes: undefined,
                effects: undefined,
              } as unknown as Clip,
            ],
          },
        ],
      },
    };
    const index = buildProjectIndex(animated);
    expect(index.keyframedClips().map((e) => e.clip.id)).toEqual(['k1', 'k2']);
  });
});
