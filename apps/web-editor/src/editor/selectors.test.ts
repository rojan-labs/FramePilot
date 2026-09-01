import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import type { Asset } from '@framepilot/timeline-schema';
import {
  assetDisplayName,
  audibleAudioClipsAt,
  dbToGain,
  nextPool,
  EMPTY_POOL,
  PREVIEW_POOL_SIZE,
  prerollLead,
  prerollSeekTarget,
  shouldPreroll,
  type PoolState,
  adjacentClipId,
  adjacentMarker,
  clampTrimEnd,
  clampTrimStart,
  clipOnAdjacentTrack,
  clipFilmstripFrames,
  clipPeaks,
  waveformPoints,
  audioSettings,
  assetKind,
  canvasPreviewEligible,
  webCodecsPreviewEligible,
  clipCompositing,
  compactDuration,
  compactTimeLabel,
  magnetSnap,
  pxDeltaToSeconds,
  isIdentityCompositing,
  clipKind,
  pictureSegments,
  clipsActiveAt,
  upcomingVideoClips,
  activeClipsAt,
  audibleAudioAt,
  audioBearingTracks,
  createPlaybackIndex,
  effectiveMutedTrackIds,
  upcomingVideoFrom,
  layerKind,
  clipsIntersectingRect,
  effectLayersIntersectingRect,
  laneRenderWindow,
  spanInRenderWindow,
  shouldAutoFollow,
  wheelIntent,
  nextAutoScrollLeft,
  minimapGeometry,
  minimapScrollLeft,
  MINIMAP_MIN_BLOCK_PX,
  colorGradeCssFilter,
  colorGradeParams,
  downstreamClips,
  duckTrackOptions,
  findClip,
  selectionRange,
  isIdentityGrade,
  formatSeconds,
  formatTime,
  formatTimecode,
  orderedClips,
  pxToSeconds,
  rulerTicks,
  secondsToPx,
  snap,
  snapTargets,
  timelineDuration,
  timelineTransitions,
  transitionMaxDuration,
  trackJunctions,
  clipTransition,
  tracksCompatible,
  zoomToClip,
  zoomToFit,
} from './selectors.js';
import { demoTimeline } from './demo.js';

const emptyTimeline: Timeline = { tracks: [] };

/** A clip starting 2s into its source, 4s long on the timeline. */
const sampleClip: Clip = {
  id: 'c',
  assetId: 'a',
  trackId: 't',
  start: 6,
  end: 10,
  sourceStart: 2,
  sourceEnd: 6,
  effects: [],
  keyframes: [],
};

describe('assetDisplayName', () => {
  const asset = (path: string): Asset => ({
    id: 'a1',
    path,
    kind: 'video',
    durationSeconds: 1,
  });

  it('returns the basename of the asset path', () => {
    expect(assetDisplayName(asset('/media/intro.mp4'), 'clip_1')).toBe('intro.mp4');
    expect(assetDisplayName(asset('C:\\clips\\b roll.mov'), 'clip_1')).toBe('b roll.mov');
  });

  it('falls back when the asset is missing or the path is empty', () => {
    expect(assetDisplayName(undefined, 'clip_1')).toBe('clip_1');
    expect(assetDisplayName(asset(''), 'clip_1')).toBe('clip_1');
  });
});

describe('timelineDuration', () => {
  it('is the largest clip end across all tracks', () => {
    expect(timelineDuration(demoTimeline)).toBe(14);
  });

  it('is zero for an empty timeline', () => {
    expect(timelineDuration(emptyTimeline)).toBe(0);
  });
});

describe('findClip', () => {
  it('returns the clip and its track', () => {
    const found = findClip(demoTimeline, 'clip_body');
    expect(found?.clip.id).toBe('clip_body');
    expect(found?.track.id).toBe('video_1');
  });

  it('returns null for an unknown clip', () => {
    expect(findClip(demoTimeline, 'nope')).toBeNull();
  });
});

describe('selectionRange', () => {
  it('returns null for an empty selection', () => {
    expect(selectionRange(demoTimeline, [])).toBeNull();
  });

  it('is the single clip span for a one-clip selection', () => {
    expect(selectionRange(demoTimeline, ['clip_intro'])).toEqual({ start: 0, end: 6 });
  });

  it('is the bounding range across a multi-clip selection, order-independent', () => {
    expect(selectionRange(demoTimeline, ['clip_body', 'clip_intro'])).toEqual({
      start: 0,
      end: 14,
    });
    expect(selectionRange(demoTimeline, ['clip_intro', 'clip_body'])).toEqual({
      start: 0,
      end: 14,
    });
  });

  it('spans across tracks (the audio clip covers the whole timeline)', () => {
    expect(selectionRange(demoTimeline, ['clip_intro', 'clip_vo'])).toEqual({ start: 0, end: 14 });
  });

  it('skips ids that are not on the timeline (a stale selection)', () => {
    expect(selectionRange(demoTimeline, ['nope'])).toBeNull();
    expect(selectionRange(demoTimeline, ['clip_intro', 'nope'])).toEqual({ start: 0, end: 6 });
  });
});

describe('clipsActiveAt', () => {
  it('includes clips whose [start, end) span the time', () => {
    const active = clipsActiveAt(demoTimeline, 2).map((l) => l.clip.id);
    expect(active).toEqual(['clip_intro', 'clip_vo']);
  });

  it('is exclusive of the clip end (boundary belongs to the next clip)', () => {
    const active = clipsActiveAt(demoTimeline, 6).map((l) => l.clip.id);
    expect(active).toEqual(['clip_body', 'clip_vo']);
  });

  it('is empty past the end of the timeline', () => {
    expect(clipsActiveAt(demoTimeline, 100)).toEqual([]);
  });
});

describe('playback index (H3/H8 — O(log n) playhead queries)', () => {
  const demoAssets = new Map<string, Asset>();

  it('activeClipsAt matches clipsActiveAt across the whole demo timeline', () => {
    const index = createPlaybackIndex(demoTimeline, demoAssets);
    for (let t = -1; t <= 30; t += 0.25) {
      expect(activeClipsAt(index, t).map((l) => l.clip.id)).toEqual(
        clipsActiveAt(demoTimeline, t).map((l) => l.clip.id),
      );
    }
  });

  it('upcomingVideoFrom matches upcomingVideoClips for every cut point', () => {
    const index = createPlaybackIndex(demoTimeline, demoAssets);
    for (let t = -1; t <= 30; t += 0.5) {
      for (const count of [0, 1, 2, 3, 8]) {
        expect(upcomingVideoFrom(index, t, count).map((l) => l.clip.id)).toEqual(
          upcomingVideoClips(demoTimeline, demoAssets, t, count).map((l) => l.clip.id),
        );
      }
    }
  });

  it('audibleAudioAt matches audibleAudioClipsAt (volumes + source offsets)', () => {
    const index = createPlaybackIndex(demoTimeline, demoAssets);
    for (let t = 0; t <= 20; t += 0.5) {
      expect(audibleAudioAt(index, demoAssets, t)).toEqual(
        audibleAudioClipsAt(demoTimeline, demoAssets, t),
      );
    }
  });

  it('handles an empty timeline', () => {
    const index = createPlaybackIndex(emptyTimeline, demoAssets);
    expect(activeClipsAt(index, 0)).toEqual([]);
    expect(upcomingVideoFrom(index, 0, 3)).toEqual([]);
  });

  it('skips hidden tracks for upcoming video (mirrors the render)', () => {
    const hidden: Timeline = {
      tracks: demoTimeline.tracks.map((t) => ({ ...t, hidden: true })),
    };
    const index = createPlaybackIndex(hidden, demoAssets);
    expect(upcomingVideoFrom(index, 0, 5)).toEqual([]);
  });
});

describe('dbToGain', () => {
  it('maps decibels to a linear amplitude (0 dB = unity)', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 6);
    expect(dbToGain(20)).toBeCloseTo(10, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });
});

describe('audibleAudioClipsAt', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
  ]);
  const audioClip = (
    id: string,
    start: number,
    end: number,
    effects: Clip['effects'] = [],
  ): Clip => ({
    ...sampleClip,
    id,
    assetId: 'aud',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects,
  });
  const gain = (gainDb: number, muted = false): Clip['effects'] => [
    { id: 'g', type: 'audio_gain', params: { gainDb, muted }, keyframes: [] },
  ];

  it('returns audio-only clips under the playhead with their source offset', () => {
    const timeline: Timeline = {
      tracks: [{ id: 'a', type: 'audio', clips: [audioClip('music', 4, 12)] }],
    };
    const audible = audibleAudioClipsAt(timeline, assets, 6);
    expect(audible.map((a) => a.clip.id)).toEqual(['music']);
    expect(audible[0]?.sourceTime).toBe(2); // sourceStart 0 + (6 - 4)
    expect(audible[0]?.volume).toBe(1); // unity gain
  });

  it('scales volume by the clip gain and zeroes a muted clip', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'a', type: 'audio', clips: [audioClip('soft', 0, 8, gain(-20))] },
        { id: 'b', type: 'audio', clips: [audioClip('off', 0, 8, gain(0, true))] },
      ],
    };
    const audible = audibleAudioClipsAt(timeline, assets, 4);
    const byId = new Map(audible.map((a) => [a.clip.id, a.volume]));
    expect(byId.get('soft')).toBeCloseTo(0.1, 6);
    expect(byId.get('off')).toBe(0);
  });

  it('ducks the bed under the sidechain track, matching the engine envelope', () => {
    // The captured-run bug: a bed authored WITH a duck played flat in the
    // monitor, so it was loudest exactly where the render is quietest. The
    // editor heard the music drowning their voice and the agent then cut the
    // bed's clip gain — damaging a mix the render already had right.
    const ducked = (gainDb: number): Clip['effects'] => [
      {
        id: 'g',
        type: 'audio_gain',
        params: { gainDb, duckUnderTrackId: 'dialogue', duckAmountDb: -12 },
        keyframes: [],
      },
    ];
    const timeline: Timeline = {
      tracks: [
        { id: 'music', type: 'audio', clips: [audioClip('bed', 0, 20, ducked(0))] },
        { id: 'dialogue', type: 'audio', clips: [audioClip('vo', 5, 10)] },
      ],
    };
    const bedVolume = (t: number): number =>
      audibleAudioClipsAt(timeline, assets, t).find((a) => a.clip.id === 'bed')!.volume;

    // Well before the dialogue: unducked.
    expect(bedVolume(2)).toBeCloseTo(1, 6);
    // Fully inside it: down by the full -12 dB.
    expect(bedVolume(7)).toBeCloseTo(dbToGain(-12), 6);
    // Well after it: back up.
    expect(bedVolume(15)).toBeCloseTo(1, 6);
    // Mid-ramp. These are the engine's own numbers, read off
    // `duck_gain_at(t, [(5, 10)], -12.0)` in framepilot_engine.audio.mixing —
    // the point of the port is that the monitor agrees with the render, so the
    // test compares against the render rather than against itself.
    expect(bedVolume(4.925)).toBeCloseTo(0.6255943215754781, 9);
    expect(bedVolume(7)).toBeCloseTo(0.251188643150958, 9);
  });

  it('applies fade in/out to the monitor volume', () => {
    const faded: Clip['effects'] = [
      {
        id: 'g',
        type: 'audio_gain',
        params: { gainDb: 0, fadeInSeconds: 2, fadeOutSeconds: 2 },
        keyframes: [],
      },
    ];
    const timeline: Timeline = {
      tracks: [{ id: 'a', type: 'audio', clips: [audioClip('bed', 0, 10, faded)] }],
    };
    const volume = (t: number): number => audibleAudioClipsAt(timeline, assets, t)[0]!.volume;
    expect(volume(1)).toBeCloseTo(0.5, 6); // halfway up the fade in
    expect(volume(5)).toBeCloseTo(1, 6); // full level between the fades
    expect(volume(9)).toBeCloseTo(0.5, 6); // halfway down the fade out
  });

  it('excludes muted tracks and video-clip (footage) audio', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'a', type: 'audio', clips: [audioClip('music', 0, 8)], muted: true },
        { id: 'v', type: 'video', clips: [{ ...audioClip('shot', 0, 8), assetId: 'vid' }] },
      ],
    };
    expect(audibleAudioClipsAt(timeline, assets, 4)).toEqual([]);
  });

  it('excludes clips outside the playhead (end-exclusive)', () => {
    const timeline: Timeline = {
      tracks: [{ id: 'a', type: 'audio', clips: [audioClip('music', 4, 8)] }],
    };
    expect(audibleAudioClipsAt(timeline, assets, 8)).toEqual([]);
    expect(audibleAudioClipsAt(timeline, assets, 3.9)).toEqual([]);
  });

  it('a solo overrides persisted mute for playback: soloed plays, everyone else is silenced', () => {
    // 'a' is persisted muted but soloed — must still sound. 'b' is not persisted
    // muted but is NOT soloed — must be silenced while any solo is active.
    const timeline: Timeline = {
      tracks: [
        { id: 'a', type: 'audio', clips: [audioClip('music', 0, 8)], muted: true },
        { id: 'b', type: 'audio', clips: [audioClip('vo', 0, 8)] },
      ],
    };
    const audible = audibleAudioClipsAt(timeline, assets, 4, new Set(['a']));
    expect(audible.map((c) => c.clip.id)).toEqual(['music']);
    // The underlying `Timeline`/`Track` objects passed in are never mutated —
    // solo is preview-only monitoring state, never a schema/patch edit.
    expect(timeline.tracks[0]?.muted).toBe(true);
    expect(timeline.tracks[1]?.muted).toBeUndefined();
  });

  it('audibleAudioAt honors the same solo override as audibleAudioClipsAt', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'a', type: 'audio', clips: [audioClip('music', 0, 8)], muted: true },
        { id: 'b', type: 'audio', clips: [audioClip('vo', 0, 8)] },
      ],
    };
    const index = createPlaybackIndex(timeline, assets);
    const soloed = new Set(['a']);
    expect(audibleAudioAt(index, assets, 4, soloed)).toEqual(
      audibleAudioClipsAt(timeline, assets, 4, soloed),
    );
  });
});

describe('audioBearingTracks', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
  ]);
  const clip = (id: string, assetId: string): Clip => ({
    ...sampleClip,
    id,
    assetId,
    trackId: id,
  });

  it('keeps only tracks with an audio- or video-kind clip', () => {
    const tracks: Timeline['tracks'] = [
      { id: 'v', type: 'video', clips: [clip('shot', 'vid')] },
      { id: 'a', type: 'audio', clips: [clip('music', 'aud')] },
      { id: 'cap', type: 'caption', clips: [] },
    ];
    expect(audioBearingTracks(tracks, assets).map((t) => t.id)).toEqual(['v', 'a']);
  });
});

describe('effectiveMutedTrackIds (solo override, H0.4 J2 — preview only, never the render)', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
  ]);
  const clip = (id: string, assetId: string): Clip => ({
    ...sampleClip,
    id,
    assetId,
    trackId: id,
  });
  const tracks: Timeline['tracks'] = [
    { id: 'v', type: 'video', clips: [clip('shot', 'vid')] },
    { id: 'a1', type: 'audio', clips: [clip('music', 'aud')] },
    { id: 'a2', type: 'audio', clips: [clip('vo', 'aud')], muted: true },
    { id: 'cap', type: 'caption', clips: [] },
  ];

  it('with no solo active, mirrors each track’s persisted `muted` flag exactly', () => {
    const muted = effectiveMutedTrackIds(tracks, new Set(), assets);
    expect([...muted]).toEqual(['a2']);
  });

  it('soloing a track un-mutes it for playback even though its persisted `muted` is true', () => {
    const muted = effectiveMutedTrackIds(tracks, new Set(['a2']), assets);
    expect(muted.has('a2')).toBe(false);
  });

  it('soloing one audio-bearing track mutes every other audio-bearing track, persisted flag or not', () => {
    const muted = effectiveMutedTrackIds(tracks, new Set(['a2']), assets);
    expect(muted.has('v')).toBe(true); // was not persisted-muted
    expect(muted.has('a1')).toBe(true); // was not persisted-muted
    expect(muted.has('a2')).toBe(false); // soloed
  });

  it('leaves non-audio-bearing tracks unaffected by solo (nothing to monitor there)', () => {
    const muted = effectiveMutedTrackIds(tracks, new Set(['a2']), assets);
    expect(muted.has('cap')).toBe(false);
  });

  it('soloing only a non-audio-bearing track is a no-op (no audio track to solo onto)', () => {
    const muted = effectiveMutedTrackIds(tracks, new Set(['cap']), assets);
    expect([...muted]).toEqual(['a2']); // same as no solo — only the real flag stands
  });

  it('never mutates the tracks passed in', () => {
    const before = JSON.parse(JSON.stringify(tracks)) as unknown;
    effectiveMutedTrackIds(tracks, new Set(['a2']), assets);
    expect(JSON.parse(JSON.stringify(tracks))).toEqual(before);
  });
});

describe('nextPool (preview element pool)', () => {
  it('cold-loads the active clip into a slot and pre-warms the upcoming ones', () => {
    const next = nextPool(EMPTY_POOL, 'clipA', ['clipB', 'clipC']);
    expect(next.front).toBe(0);
    // Active + the given upcoming fill the leading slots; the rest of the pool
    // (PREVIEW_POOL_SIZE slots) stays empty until more upcoming clips are known.
    expect(next.loaded.slice(0, 3)).toEqual(['clipA', 'clipB', 'clipC']);
    expect(next.loaded).toHaveLength(PREVIEW_POOL_SIZE);
    expect(next.loaded.slice(3).every((id) => id === null)).toBe(true);
  });

  it('swaps front to the pre-warmed slot at a cut (no reload) and warms the freed slot', () => {
    // Slot 0 shows clipA; slots 1-2 pre-warm clipB/clipC. Playhead crosses to clipB.
    const prev: PoolState = { front: 0, loaded: ['clipA', 'clipB', 'clipC'] };
    const next = nextPool(prev, 'clipB', ['clipC', 'clipD']);
    expect(next.front).toBe(1); // front IS the slot that already holds clipB — no load
    expect(next.loaded).toEqual(['clipD', 'clipB', 'clipC']); // freed slot 0 warms clipD
  });

  it('keeps every slot that still holds a wanted clip (elements stay decoded)', () => {
    const prev: PoolState = { front: 1, loaded: ['clipC', 'clipB', null] };
    const next = nextPool(prev, 'clipB', ['clipC']);
    expect(next).toEqual({ front: 1, loaded: ['clipC', 'clipB', null] });
  });

  it('is a fixed point once stable (the component relies on this to stop re-rendering)', () => {
    const stable = nextPool(EMPTY_POOL, 'clipA', ['clipB']);
    expect(nextPool(stable, 'clipA', ['clipB'])).toEqual(stable);
  });

  it('holds the front slot for a gap/image active clip but still pre-warms upcoming', () => {
    const prev: PoolState = { front: 0, loaded: ['clipA', null, null] };
    const next = nextPool(prev, null, ['clipB', 'clipC']);
    expect(next.front).toBe(0);
    // The stale front element is never evicted while there is no active clip.
    expect(next.loaded).toEqual(['clipA', 'clipB', 'clipC']);
  });

  it('never evicts the previous front while in a gap, even under pool pressure', () => {
    const prev: PoolState = { front: 0, loaded: ['old', 'x', 'y'] };
    const next = nextPool(prev, null, ['clipB', 'clipC', 'clipD']);
    expect(next.front).toBe(0);
    expect(next.loaded[0]).toBe('old');
    expect(next.loaded).toEqual(['old', 'clipB', 'clipC']);
  });

  it('does not recycle the protected (visible) slot for a warm clip mid-bridge', () => {
    // Cut A→B: slot 1 (pre-warmed B) becomes front, but the monitor still shows
    // slot 0 (A's last frame) until B has a decoded frame — reloading slot 0
    // with the next warm clip during that bridge would flash black.
    const prev: PoolState = { front: 0, loaded: ['clipA', 'clipB', 'clipC'] };
    const next = nextPool(prev, 'clipB', ['clipC', 'clipD'], 0);
    expect(next.front).toBe(1);
    expect(next.loaded).toEqual(['clipA', 'clipB', 'clipC']); // clipD deferred
    // Once the monitor advances to the new front, the old slot is recycled.
    const settled = nextPool(next, 'clipB', ['clipC', 'clipD'], 1);
    expect(settled.loaded).toEqual(['clipD', 'clipB', 'clipC']);
  });

  it('loads the ACTIVE clip over the protection (a bridge must never deadlock)', () => {
    // Scrub to a cold clip while every other slot holds a wanted clip: the
    // active clip must still get an element, or the front never becomes ready
    // and the visible slot never advances.
    const prev: PoolState = { front: 0, loaded: ['old', 'up1', 'up2'] };
    const next = nextPool(prev, 'cold', ['up1', 'up2'], 0);
    expect(next.loaded).toEqual(['cold', 'up1', 'up2']);
    expect(next.front).toBe(0);
  });

  it('dedupes and caps the wanted list to the pool size', () => {
    // More distinct wanted clips than the pool can hold: the active clip plus the
    // first (PREVIEW_POOL_SIZE − 1) upcoming fill every slot; the duplicate active
    // id is deduped and any overflow beyond the pool is dropped.
    const next = nextPool(EMPTY_POOL, 'clipA', [
      'clipA',
      'clipB',
      'clipC',
      'clipD',
      'clipE',
      'clipF',
    ]);
    expect(next.loaded).toHaveLength(PREVIEW_POOL_SIZE);
    expect(next.loaded).toEqual(['clipA', 'clipB', 'clipC', 'clipD', 'clipE']);
    expect(next.loaded).not.toContain('clipF'); // capped
  });
});

describe('preview pre-roll (play-start freeze removal)', () => {
  const clip = (sourceStart: number): Clip => ({
    id: 'c',
    assetId: 'a',
    trackId: 'v',
    start: 10,
    end: 12,
    sourceStart,
    sourceEnd: sourceStart + 2,
    effects: [],
    keyframes: [],
  });

  it('clamps the lead so the back-seek never precedes the source start', () => {
    // A trimmed clip (source starts at 3s) has room for the full lead...
    expect(prerollLead(clip(3), 0.15)).toBeCloseTo(0.15);
    // ...but a clip trimmed only 0.05s in can only lead by 0.05s.
    expect(prerollLead(clip(0.05), 0.15)).toBeCloseTo(0.05);
    // An untrimmed clip (source starts at 0) has nothing to seek back into.
    expect(prerollLead(clip(0), 0.15)).toBe(0);
  });

  it('seeks back from the in-point by the usable lead', () => {
    expect(prerollSeekTarget(clip(3), 0.15)).toBeCloseTo(2.85);
    // Untrimmed: no lead, so the target is the in-point itself (a no-op seek).
    expect(prerollSeekTarget(clip(0), 0.15)).toBe(0);
  });

  it('fires only inside the lead window ahead of the cut', () => {
    expect(shouldPreroll(0.1, 0.15)).toBe(true); // cut is 100ms away, within lead
    expect(shouldPreroll(0.5, 0.15)).toBe(false); // still too far to pre-roll
    expect(shouldPreroll(0, 0.15)).toBe(false); // already at the cut
    expect(shouldPreroll(-0.1, 0.15)).toBe(false); // cut already passed
    expect(shouldPreroll(0.1, 0)).toBe(false); // untrimmed clip: never pre-rolls
  });
});

describe('upcomingVideoClips', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['img', { id: 'img', path: 'p.png', kind: 'image' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
  ]);
  const clip = (id: string, assetId: string, start: number, end: number): Clip => ({
    ...sampleClip,
    id,
    assetId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
  });

  it('returns the video clips starting strictly after the time, in playback order', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 't1',
          type: 'video',
          clips: [clip('a', 'vid', 0, 4), clip('b', 'vid', 4, 8), clip('c', 'vid', 8, 12)],
        },
      ],
    };
    expect(upcomingVideoClips(timeline, assets, 1, 2).map((l) => l.clip.id)).toEqual(['b', 'c']);
    expect(upcomingVideoClips(timeline, assets, 5, 2).map((l) => l.clip.id)).toEqual(['c']);
    expect(upcomingVideoClips(timeline, assets, 9, 2)).toEqual([]);
  });

  it('skips images (cheap to paint) so the videos behind them still get warmed', () => {
    const timeline: Timeline = {
      tracks: [
        {
          id: 't1',
          type: 'video',
          clips: [clip('a', 'vid', 0, 4), clip('still', 'img', 4, 8), clip('c', 'vid', 8, 12)],
        },
      ],
    };
    expect(upcomingVideoClips(timeline, assets, 1, 2).map((l) => l.clip.id)).toEqual(['c']);
  });

  it('skips audio clips and hidden tracks', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'a', type: 'audio', clips: [clip('music', 'aud', 4, 8)] },
        { id: 'hidden', type: 'video', clips: [clip('h', 'vid', 4, 8)], hidden: true },
        { id: 'v', type: 'video', clips: [clip('shown', 'vid', 6, 10)] },
      ],
    };
    expect(upcomingVideoClips(timeline, assets, 1, 3).map((l) => l.clip.id)).toEqual(['shown']);
  });

  it('collects across tracks and resolves ties to the topmost track', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'top', type: 'video', clips: [clip('t1', 'vid', 4, 8)] },
        { id: 'bottom', type: 'video', clips: [clip('b1', 'vid', 4, 8), clip('b2', 'vid', 8, 12)] },
      ],
    };
    expect(upcomingVideoClips(timeline, assets, 0, 3).map((l) => l.clip.id)).toEqual([
      't1',
      'b1',
      'b2',
    ]);
  });
});

describe('clipKind', () => {
  const mk = (id: string, assetId: string): Clip => ({ ...sampleClip, id, assetId });
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
    ['img', { id: 'img', path: 'p.png', kind: 'image' }],
  ]);

  it('derives kind from the asset, defaulting unknown assets to video', () => {
    expect(clipKind(mk('c1', 'vid'), assets)).toBe('video');
    expect(clipKind(mk('c2', 'aud'), assets)).toBe('audio');
    expect(clipKind(mk('c3', 'img'), assets)).toBe('image');
    expect(clipKind(mk('c4', 'missing'), assets)).toBe('video');
  });

  it('recognises text/caption clips by their synthetic asset id', () => {
    expect(clipKind(mk('c5', '__text__'), assets)).toBe('text');
    expect(clipKind(mk('c6', '__caption__'), assets)).toBe('caption');
  });
});

describe('canvasPreviewEligible', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['img', { id: 'img', path: 'p.png', kind: 'image' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
  ]);
  const vid = (id: string, start: number, end: number, overrides: Partial<Clip> = {}): Clip => ({
    ...sampleClip,
    id,
    assetId: 'vid',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    ...overrides,
  });
  const timelineOf = (...clips: Clip[]): Timeline => ({
    tracks: [{ id: 'v', type: 'video', clips }],
  });

  it('is false for an empty timeline', () => {
    expect(canvasPreviewEligible(timelineOf(), assets)).toBe(false);
  });

  it('is true for plain, non-overlapping video cuts (with a gap between them)', () => {
    const timeline = timelineOf(vid('c1', 0, 3), vid('c2', 5, 8));
    expect(canvasPreviewEligible(timeline, assets)).toBe(true);
  });

  it('is true for a lone image clip', () => {
    const image = {
      ...sampleClip,
      id: 'i1',
      assetId: 'img',
      start: 0,
      end: 3,
      sourceStart: 0,
      sourceEnd: 3,
    };
    expect(canvasPreviewEligible(timelineOf(image), assets)).toBe(true);
  });

  it('is true with a text/caption overlay alongside a picture clip (P3b composites it)', () => {
    const textClip = { ...sampleClip, id: 't1', assetId: '__text__', start: 0, end: 3 };
    expect(canvasPreviewEligible(timelineOf(vid('c1', 0, 3), textClip), assets)).toBe(true);
  });

  it('is false for an overlay-only timeline (no picture to composite over)', () => {
    const textClip = { ...sampleClip, id: 't1', assetId: '__text__', start: 0, end: 3 };
    expect(canvasPreviewEligible(timelineOf(textClip), assets)).toBe(false);
  });

  it('is false when two picture clips overlap', () => {
    const timeline = timelineOf(vid('c1', 0, 5), vid('c2', 3, 8));
    expect(canvasPreviewEligible(timeline, assets)).toBe(false);
  });

  it('is true for a clip with transform keyframes (P3a composites them on canvas)', () => {
    const timeline = timelineOf(
      vid('c1', 0, 3, {
        keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 2, easing: 'linear' }],
      }),
    );
    expect(canvasPreviewEligible(timeline, assets)).toBe(true);
  });

  it('is true for a clip with a non-full-frame crop (P3a composites it on canvas)', () => {
    const timeline = timelineOf(vid('c1', 0, 3, { crop: { x: 0.1, y: 0, width: 0.8, height: 1 } }));
    expect(canvasPreviewEligible(timeline, assets)).toBe(true);
  });

  it('is true for a clip with a non-normal blend mode (P3a composites it on canvas)', () => {
    const timeline = timelineOf(vid('c1', 0, 3, { blendMode: 'multiply' }));
    expect(canvasPreviewEligible(timeline, assets)).toBe(true);
  });

  it('is true for a clip with an authored (non-identity) color grade (P3a composites it on canvas)', () => {
    const timeline = timelineOf(
      vid('c1', 0, 3, {
        effects: [{ id: 'e1', type: 'color_grade', params: { exposure: 1 }, keyframes: [] }],
      }),
    );
    expect(canvasPreviewEligible(timeline, assets)).toBe(true);
  });

  it('is false for a clip with a non-1x speed (P4, not P2/P3)', () => {
    const timeline = timelineOf(vid('c1', 0, 3, { speed: 2 }));
    expect(canvasPreviewEligible(timeline, assets)).toBe(false);
  });

  it('ignores clips on hidden tracks', () => {
    const timeline: Timeline = {
      tracks: [
        { id: 'v1', type: 'video', clips: [vid('c1', 0, 3)] },
        { id: 'v2', type: 'video', clips: [vid('c2', 0, 3)], hidden: true },
      ],
    };
    // Without the hidden-track exclusion this would be an overlap (false);
    // with it, only c1 is considered.
    expect(canvasPreviewEligible(timeline, assets)).toBe(true);
  });

  it('audio-only clips impose no constraint', () => {
    const audioClip = { ...sampleClip, id: 'a1', assetId: 'aud', start: 0, end: 3 };
    expect(canvasPreviewEligible(timelineOf(vid('c1', 0, 3), audioClip), assets)).toBe(true);
  });
});

describe('webCodecsPreviewEligible', () => {
  const clip: Clip = {
    ...sampleClip,
    id: 'movie-clip',
    assetId: 'movie',
    start: 0,
    end: 7_200,
    sourceStart: 0,
    sourceEnd: 7_200,
  };
  const timeline: Timeline = { tracks: [{ id: 'v1', type: 'video', clips: [clip] }] };

  it('routes an unproxied feature-length source to the streaming DOM preview', () => {
    const assets = new Map<string, Asset>([
      ['movie', { id: 'movie', path: 'media/movie.mov', kind: 'video', durationSeconds: 7_200 }],
    ]);
    expect(webCodecsPreviewEligible(timeline, assets)).toBe(false);
  });

  it('keeps bounded proxy media on the WebCodecs compositor', () => {
    // Within the decoded-PCM budget (MAX_WEBCODECS_DECODED_AUDIO_BYTES) — unlike the
    // feature-length source above, this source is short enough to stay eligible.
    const assets = new Map<string, Asset>([
      [
        'movie',
        {
          id: 'movie',
          path: 'media/movie.mov',
          kind: 'video',
          durationSeconds: 300,
          media: { proxyPath: '.framepilot-derived/movie/proxy.mp4' },
        },
      ],
    ]);
    expect(webCodecsPreviewEligible(timeline, assets)).toBe(true);
  });

  it('still rejects a canvas-incompatible timeline even when sources have proxies', () => {
    const assets = new Map<string, Asset>([
      [
        'movie',
        { id: 'movie', path: 'movie.mov', kind: 'video', media: { proxyPath: 'proxy.mp4' } },
      ],
    ]);
    const spedUp: Timeline = {
      tracks: [{ id: 'v1', type: 'video', clips: [{ ...clip, speed: 2 }] }],
    };
    expect(webCodecsPreviewEligible(spedUp, assets)).toBe(false);
  });
});

describe('clipCompositing / isIdentityCompositing', () => {
  const base = (overrides: Partial<Clip> = {}): Clip => ({
    ...sampleClip,
    id: 'c1',
    assetId: 'vid',
    start: 0,
    end: 3,
    sourceStart: 0,
    sourceEnd: 3,
    ...overrides,
  });

  it('projects an identity compositing for a plain clip', () => {
    const c = clipCompositing(base());
    expect(c.keyframes).toEqual([]);
    expect(c.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(c.blendMode).toBe('normal');
    expect(isIdentityCompositing(c)).toBe(true);
  });

  it('is non-identity when the clip has transform keyframes', () => {
    const c = clipCompositing(
      base({ keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 2, easing: 'linear' }] }),
    );
    expect(c.keyframes).toHaveLength(1);
    expect(isIdentityCompositing(c)).toBe(false);
  });

  it('is non-identity when the clip has a crop', () => {
    const c = clipCompositing(base({ crop: { x: 0.1, y: 0, width: 0.8, height: 1 } }));
    expect(c.crop).toEqual({ x: 0.1, y: 0, width: 0.8, height: 1 });
    expect(isIdentityCompositing(c)).toBe(false);
  });

  it('is non-identity when the clip has a blend mode', () => {
    const c = clipCompositing(base({ blendMode: 'multiply' }));
    expect(c.blendMode).toBe('multiply');
    expect(isIdentityCompositing(c)).toBe(false);
  });

  it('is non-identity when the clip has an authored color grade', () => {
    const c = clipCompositing(
      base({
        effects: [{ id: 'e1', type: 'color_grade', params: { exposure: 1 }, keyframes: [] }],
      }),
    );
    expect(c.grade.exposure).toBe(1);
    expect(isIdentityCompositing(c)).toBe(false);
  });
});

describe('pictureSegments', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
  ]);
  const vid = (id: string, start: number, end: number): Clip => ({
    ...sampleClip,
    id,
    assetId: 'vid',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
  });
  const timelineOf = (...clips: Clip[]): Timeline => ({
    tracks: [{ id: 'v', type: 'video', clips }],
  });

  it('returns nothing for an empty timeline', () => {
    expect(pictureSegments(timelineOf(), assets)).toEqual([]);
  });

  it('is contiguous (no gap segment) for back-to-back clips', () => {
    const segments = pictureSegments(timelineOf(vid('c1', 0, 3), vid('c2', 3, 6)), assets);
    expect(segments).toEqual([
      { start: 0, end: 3, clip: expect.objectContaining({ id: 'c1' }) },
      { start: 3, end: 6, clip: expect.objectContaining({ id: 'c2' }) },
    ]);
  });

  it('fills a gap between clips with a null-clip segment', () => {
    const segments = pictureSegments(timelineOf(vid('c1', 0, 3), vid('c2', 5, 8)), assets);
    expect(segments).toEqual([
      { start: 0, end: 3, clip: expect.objectContaining({ id: 'c1' }) },
      { start: 3, end: 5, clip: null },
      { start: 5, end: 8, clip: expect.objectContaining({ id: 'c2' }) },
    ]);
  });

  it('fills a leading gap when the first clip does not start at 0', () => {
    const segments = pictureSegments(timelineOf(vid('c1', 2, 5)), assets);
    expect(segments).toEqual([
      { start: 0, end: 2, clip: null },
      { start: 2, end: 5, clip: expect.objectContaining({ id: 'c1' }) },
    ]);
  });

  it('ignores audio-only clips entirely', () => {
    const audioClip = { ...sampleClip, id: 'a1', assetId: 'aud', start: 0, end: 8 };
    const segments = pictureSegments(timelineOf(vid('c1', 0, 3), audioClip), assets);
    expect(segments).toEqual([{ start: 0, end: 3, clip: expect.objectContaining({ id: 'c1' }) }]);
  });
});

describe('assetKind', () => {
  it('maps an asset to its placed clip kind', () => {
    expect(assetKind({ id: 'a', path: 'v.mp4', kind: 'video' })).toBe('video');
    expect(assetKind({ id: 'a', path: 'a.mp3', kind: 'audio' })).toBe('audio');
    expect(assetKind({ id: 'a', path: 'p.png', kind: 'image' })).toBe('image');
  });
});

describe('layerKind', () => {
  const assets = new Map<string, Asset>([
    ['vid', { id: 'vid', path: 'v.mp4', kind: 'video' }],
    ['aud', { id: 'aud', path: 'a.mp3', kind: 'audio' }],
    ['img', { id: 'img', path: 'p.png', kind: 'image' }],
  ]);
  const clipOf = (id: string, assetId: string): Clip => ({ ...sampleClip, id, assetId });

  it('returns null for an empty layer', () => {
    expect(layerKind({ id: 'L', type: 'video', clips: [] }, assets)).toBeNull();
  });

  it('returns the dominant clip kind of a mixed layer', () => {
    const track = {
      id: 'L',
      type: 'video' as const,
      clips: [clipOf('c1', 'aud'), clipOf('c2', 'aud'), clipOf('c3', 'vid')],
    };
    expect(layerKind(track, assets)).toBe('audio');
  });
});

describe('snapTargets', () => {
  it('collects clip boundaries, the origin, and any extras, sorted+unique', () => {
    expect(snapTargets(demoTimeline, [6, 10])).toEqual([0, 6, 10, 14]);
  });
});

describe('snap', () => {
  const targets = [0, 6, 14];

  it('snaps to the nearest target within the threshold', () => {
    expect(snap(6.2, targets, 0.5)).toBe(6);
  });

  it('leaves the time unchanged when nothing is close enough', () => {
    expect(snap(3, targets, 0.5)).toBe(3);
  });

  it('clamps negative input to zero before snapping', () => {
    expect(snap(-5, targets, 0.5)).toBe(0);
  });
});

describe('formatTimecode', () => {
  it('formats whole seconds and frames as HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(1, 30)).toBe('00:00:01:00');
    expect(formatTimecode(0.5, 30)).toBe('00:00:00:15');
  });

  it('rolls hours, minutes, and seconds over correctly', () => {
    expect(formatTimecode(61, 30)).toBe('00:01:01:00');
    expect(formatTimecode(3661, 30)).toBe('01:01:01:00');
  });

  it('quantises to the nearest frame so it never shows a jittering boundary', () => {
    // 5.9999s at 30fps rounds up to frame 180 → exactly 00:00:06:00.
    expect(formatTimecode(5.9999, 30)).toBe('00:00:06:00');
  });

  it('counts frames within the second up to fps-1', () => {
    expect(formatTimecode(1 + 29 / 30, 30)).toBe('00:00:01:29');
  });

  it('clamps negative and non-finite input to zero', () => {
    expect(formatTimecode(-5, 30)).toBe('00:00:00:00');
    expect(formatTimecode(Number.NaN, 30)).toBe('00:00:00:00');
  });

  it('falls back to 30fps when fps is unusable', () => {
    expect(formatTimecode(0.5, 0)).toBe('00:00:00:15');
    expect(formatTimecode(0.5, Number.NaN)).toBe('00:00:00:15');
  });

  it('respects a non-30 frame rate', () => {
    expect(formatTimecode(0.5, 24)).toBe('00:00:00:12');
    expect(formatTimecode(1 + 23 / 24, 24)).toBe('00:00:01:23');
  });
});

describe('formatSeconds', () => {
  it('formats with two fixed decimals and a trailing s', () => {
    expect(formatSeconds(0)).toBe('0.00s');
    expect(formatSeconds(2)).toBe('2.00s');
    expect(formatSeconds(12.345)).toBe('12.35s');
  });

  it('clamps negative / non-finite values to zero', () => {
    expect(formatSeconds(-5)).toBe('0.00s');
    expect(formatSeconds(Number.NaN)).toBe('0.00s');
  });
});

describe('formatTime', () => {
  it('defaults to frame-accurate timecode', () => {
    expect(formatTime(0.5, 30)).toBe('00:00:00:15');
    expect(formatTime(0.5, 30, 'timecode')).toBe('00:00:00:15');
  });

  it('renders plain seconds when asked', () => {
    expect(formatTime(2.5, 30, 'seconds')).toBe('2.50s');
  });
});

describe('magnetSnap', () => {
  const edges = [0, 4, 10];

  it('captures an edge that comes within the capture radius', () => {
    expect(magnetSnap(4.05, edges, 0.2, 0.5, null)).toEqual({ value: 4, held: 4 });
  });

  it('leaves a value alone when nothing is near', () => {
    expect(magnetSnap(6, edges, 0.2, 0.5, null)).toEqual({ value: 6, held: null });
  });

  it('keeps holding past the capture radius, which is the resistance', () => {
    // 0.35s away: too far to be captured fresh, close enough that a hold survives.
    // This gap is what makes a join something the user feels themselves break,
    // instead of an alignment that blinks off at an invisible line.
    expect(magnetSnap(4.35, edges, 0.2, 0.5, 4)).toEqual({ value: 4, held: 4 });
    expect(magnetSnap(4.35, edges, 0.2, 0.5, null)).toEqual({ value: 4.35, held: null });
  });

  it('lets go once the pointer pulls beyond the release radius', () => {
    expect(magnetSnap(4.6, edges, 0.2, 0.5, 4)).toEqual({ value: 4.6, held: null });
  });

  it('does not let a nearer edge steal an unbroken hold', () => {
    // Dragging along a run of butt-joined clips would otherwise hop from cut to
    // cut without the user ever releasing one.
    expect(magnetSnap(4.4, [4, 4.5], 0.2, 0.5, 4)).toEqual({ value: 4, held: 4 });
  });

  it('behaves like plain snap when the release radius adds nothing', () => {
    expect(magnetSnap(4.3, edges, 0.2, 0, 4)).toEqual({ value: 4.3, held: null });
  });

  it('clamps below zero and tolerates an empty target set', () => {
    expect(magnetSnap(-3, edges, 0.2, 0.5, null)).toEqual({ value: 0, held: 0 });
    expect(magnetSnap(5, [], 0.2, 0.5, null)).toEqual({ value: 5, held: null });
  });
});

describe('pxDeltaToSeconds', () => {
  it('keeps the sign, so a leftward drag is a negative duration', () => {
    expect(pxDeltaToSeconds(40, 40)).toBe(1);
    expect(pxDeltaToSeconds(-40, 40)).toBe(-1);
    expect(pxDeltaToSeconds(0, 40)).toBe(0);
  });

  it('does NOT clamp the way the position helper does', () => {
    // The whole reason this function is separate. `pxToSeconds` clamps to >= 0
    // because an x before the start of the lane is not a time; a drag delta of
    // -40px is a perfectly real "shorten by one second", and clamping it made the
    // audio fade handles growable but never shrinkable.
    expect(pxToSeconds(-40, 40)).toBe(0);
    expect(pxDeltaToSeconds(-40, 40)).toBe(-1);
  });

  it('returns 0 rather than Infinity or NaN for a degenerate zoom or delta', () => {
    expect(pxDeltaToSeconds(40, 0)).toBe(0);
    expect(pxDeltaToSeconds(40, -10)).toBe(0);
    expect(pxDeltaToSeconds(Number.NaN, 40)).toBe(0);
    expect(pxDeltaToSeconds(Number.POSITIVE_INFINITY, 40)).toBe(0);
  });
});

describe('compactTimeLabel', () => {
  it('drops the fields the current scale cannot distinguish', () => {
    // A 14s sequence stepped every 2s: hours and frames are constant, so both go.
    expect(compactTimeLabel(0, 30, 2, 14)).toBe('0:00');
    expect(compactTimeLabel(2, 30, 2, 14)).toBe('0:02');
    expect(compactTimeLabel(74, 30, 2, 140)).toBe('1:14');
  });

  it('keeps the minute field so a label can never be misread as frames', () => {
    expect(compactTimeLabel(2, 30, 2, 14).startsWith('0:')).toBe(true);
  });

  it('adds frames only once the step resolves finer than a second', () => {
    expect(compactTimeLabel(1.5, 30, 0.5, 14)).toBe('0:01:15');
    // Seconds truncate, exactly as the full timecode does — a label never
    // rounds up into a second the playhead has not reached.
    expect(compactTimeLabel(1.5, 30, 1, 14)).toBe('0:01');
  });

  it('adds hours only once the span reaches one', () => {
    expect(compactTimeLabel(3700, 30, 60, 7200)).toBe('1:01:40');
    expect(compactTimeLabel(600, 30, 60, 1200)).toBe('10:00');
  });

  it('honours the seconds display mode with step-sized precision', () => {
    expect(compactTimeLabel(2.5, 30, 5, 60, 'seconds')).toBe('3');
    expect(compactTimeLabel(2.5, 30, 0.5, 60, 'seconds')).toBe('2.5');
    expect(compactTimeLabel(2.25, 30, 1 / 30, 60, 'seconds')).toBe('2.25');
  });

  it('clamps hostile input instead of rendering NaN', () => {
    expect(compactTimeLabel(Number.NaN, 30, 2, 14)).toBe('0:00');
    expect(compactTimeLabel(-5, 30, 2, 14)).toBe('0:00');
    expect(compactTimeLabel(2, 0, 0, 14)).toBe('0:02');
  });
});

describe('compactDuration', () => {
  it('reads as a length, not a position', () => {
    expect(compactDuration(6, 30)).toBe('0:06');
    expect(compactDuration(74, 30)).toBe('1:14');
    expect(compactDuration(3725, 30)).toBe('1:02:05');
  });

  it('falls back to frames for sub-second clips, where 0:00 says nothing', () => {
    expect(compactDuration(0.5, 30)).toBe('15f');
    expect(compactDuration(0.2, 25)).toBe('5f');
  });

  it('honours the seconds display mode', () => {
    expect(compactDuration(6, 30, 'seconds')).toBe('6.0s');
    expect(compactDuration(74, 30, 'seconds')).toBe('74s');
  });

  it('clamps hostile input', () => {
    expect(compactDuration(Number.NaN, 30)).toBe('0f');
    expect(compactDuration(-3, 30)).toBe('0f');
  });
});

/** Two video tracks (stacked) + an audio track, for navigation tests. */
const navTimeline: Timeline = {
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'a1',
          assetId: 'x',
          trackId: 'v1',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
        {
          id: 'a2',
          assetId: 'x',
          trackId: 'v1',
          start: 4,
          end: 8,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
    {
      id: 'v2',
      type: 'video',
      clips: [
        {
          id: 'b1',
          assetId: 'x',
          trackId: 'v2',
          start: 1,
          end: 6,
          sourceStart: 0,
          sourceEnd: 5,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

describe('orderedClips', () => {
  it('returns every clip sorted by start time', () => {
    expect(orderedClips(navTimeline).map((l) => l.clip.id)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('adjacentClipId', () => {
  it('wraps forward and backward through the ordered clips', () => {
    expect(adjacentClipId(navTimeline, 'a1', 1)).toBe('b1');
    expect(adjacentClipId(navTimeline, 'a2', 1)).toBe('a1'); // wraps to first
    expect(adjacentClipId(navTimeline, 'a1', -1)).toBe('a2'); // wraps to last
  });

  it('starts a selection from the first/last clip when nothing is selected', () => {
    expect(adjacentClipId(navTimeline, null, 1)).toBe('a1');
    expect(adjacentClipId(navTimeline, null, -1)).toBe('a2');
    expect(adjacentClipId(emptyTimeline, null, 1)).toBeNull();
  });
});

describe('clipOnAdjacentTrack', () => {
  it('finds the clip spanning the selection start on the track below', () => {
    // a1 starts at 0; the track below (v2) has b1 spanning 1–6 — nearest by start.
    expect(clipOnAdjacentTrack(navTimeline, 'a1', 1)).toBe('b1');
  });

  it('finds the clip whose span contains the selection start', () => {
    // b1 starts at 1; the track above (v1) has a1 spanning 0–4 which contains 1.
    expect(clipOnAdjacentTrack(navTimeline, 'b1', -1)).toBe('a1');
  });

  it('returns null past the edge tracks or with no selection', () => {
    expect(clipOnAdjacentTrack(navTimeline, 'a1', -1)).toBeNull(); // no track above v1
    expect(clipOnAdjacentTrack(navTimeline, 'b1', 1)).toBeNull(); // no track below v2
    expect(clipOnAdjacentTrack(navTimeline, null, 1)).toBeNull();
    expect(clipOnAdjacentTrack(navTimeline, 'nope', 1)).toBeNull();
  });
});

describe('adjacentMarker', () => {
  const markers = [2, 5, 9];
  it('finds the next marker after a time', () => {
    expect(adjacentMarker(markers, 3, 1)).toBe(5);
    expect(adjacentMarker(markers, 9, 1)).toBeNull();
  });
  it('finds the previous marker before a time', () => {
    expect(adjacentMarker(markers, 6, -1)).toBe(5);
    expect(adjacentMarker(markers, 2, -1)).toBeNull();
  });
});

describe('tracksCompatible', () => {
  it('is true only for the same track type', () => {
    expect(tracksCompatible('video', 'video')).toBe(true);
    expect(tracksCompatible('video', 'audio')).toBe(false);
    expect(tracksCompatible('caption', 'overlay')).toBe(false);
  });
});

describe('clampTrimStart', () => {
  it('cannot move the start past the source in-point (sourceStart → 0)', () => {
    // earliest start = clip.start - clip.sourceStart = 6 - 2 = 4
    expect(clampTrimStart(sampleClip, 0)).toBe(4);
    expect(clampTrimStart(sampleClip, 5)).toBe(5);
  });

  it('cannot cross the right edge (keeps a minimum length)', () => {
    expect(clampTrimStart(sampleClip, 100)).toBeCloseTo(10 - 0.05);
  });

  it('falls back to the earliest start when the clip is shorter than the minimum', () => {
    // span (0.02s) < MIN_CLIP_SECONDS, so the allowed range inverts → earliest wins.
    const tiny: Clip = { ...sampleClip, start: 3, end: 3.02, sourceStart: 0 };
    expect(clampTrimStart(tiny, 0)).toBe(3); // earliest = start - sourceStart
  });
});

describe('clampTrimEnd', () => {
  it('cannot cross the left edge (keeps a minimum length)', () => {
    expect(clampTrimEnd(sampleClip, 0)).toBeCloseTo(6 + 0.05);
    expect(clampTrimEnd(sampleClip, 9)).toBe(9);
  });

  it('allows extending the right edge (render-time validates source bounds)', () => {
    expect(clampTrimEnd(sampleClip, 20)).toBe(20);
  });
});

describe('rulerTicks', () => {
  it('uses a frame-scale major step when zoomed in', () => {
    const { stepSeconds, major } = rulerTicks(2, 240, 30);
    expect(stepSeconds).toBeLessThan(1); // sub-second / frame granularity
    expect(major[0]).toBe(0);
  });

  it('uses a coarse (minute+) major step when zoomed far out', () => {
    const { stepSeconds, minor } = rulerTicks(600, 4, 30);
    expect(stepSeconds).toBeGreaterThanOrEqual(15);
    expect(minor.length).toBeGreaterThan(0); // still legible minors between majors
  });

  it('drops minor ticks at frame-level zoom (a major is a single frame)', () => {
    // Only an extreme zoom selects a 1-frame major step → nothing to subdivide.
    const { stepSeconds, minor } = rulerTicks(0.2, 3000, 30);
    expect(stepSeconds).toBeCloseTo(1 / 30);
    expect(minor).toEqual([]);
  });

  it('caps at the coarsest candidate when zoomed absurdly far out (or zero zoom)', () => {
    expect(rulerTicks(1e6, 0.0001, 30).stepSeconds).toBe(3600);
    expect(rulerTicks(10, 0, 30).stepSeconds).toBe(3600); // zoom 0 → infinite desired
  });

  it('starts majors at the origin and stays within the lane', () => {
    const { major } = rulerTicks(10, 40, 30);
    expect(major[0]).toBe(0);
    expect(major[major.length - 1]).toBeLessThanOrEqual(10 + major[1]!);
  });
});

describe('zoomToFit', () => {
  it('fits the whole lane into the viewport with padding, centred', () => {
    const { pxPerSecond, centerSeconds } = zoomToFit(10, 1000);
    expect(pxPerSecond).toBeCloseTo((1000 * 0.92) / 10);
    expect(centerSeconds).toBe(5);
  });

  it('handles a zero-width viewport without dividing by zero', () => {
    expect(zoomToFit(10, 0).pxPerSecond).toBe(0);
  });
});

describe('zoomToClip', () => {
  it('fills the viewport with the clip and centres on it', () => {
    const target = zoomToClip(sampleClip, 800);
    expect(target?.pxPerSecond).toBeCloseTo((800 * 0.92) / 4);
    expect(target?.centerSeconds).toBe(8);
  });

  it('returns null for a zero-length clip', () => {
    expect(zoomToClip({ ...sampleClip, end: sampleClip.start }, 800)).toBeNull();
  });

  it('handles a zero-width viewport without dividing by zero', () => {
    expect(zoomToClip(sampleClip, 0)?.pxPerSecond).toBe(0);
  });
});

describe('px <-> seconds', () => {
  it('converts seconds to pixels at the given zoom', () => {
    expect(secondsToPx(3, 40)).toBe(120);
  });

  it('converts pixels to seconds and clamps to zero', () => {
    expect(pxToSeconds(120, 40)).toBe(3);
    expect(pxToSeconds(-10, 40)).toBe(0);
  });

  it('treats a non-positive zoom as zero seconds (avoids divide-by-zero)', () => {
    expect(pxToSeconds(100, 0)).toBe(0);
  });
});

describe('color grade', () => {
  const graded = (params: Record<string, number>): Clip => ({
    ...sampleClip,
    effects: [{ id: 'c__grade', type: 'color_grade', params, keyframes: [] }],
  });

  it('reads identity when there is no grade effect', () => {
    expect(isIdentityGrade(colorGradeParams(sampleClip))).toBe(true);
  });

  it('reads grade params, defaulting missing/invalid axes to 0', () => {
    const grade = colorGradeParams(graded({ exposure: 0.5, contrast: 'x' as unknown as number }));
    expect(grade.exposure).toBe(0.5);
    expect(grade.contrast).toBe(0);
    expect(grade.saturation).toBe(0);
  });

  it('returns "none" for an identity grade', () => {
    expect(colorGradeCssFilter(colorGradeParams(sampleClip))).toBe('none');
  });

  it('maps exposure/contrast/saturation into a CSS filter', () => {
    const filter = colorGradeCssFilter(colorGradeParams(graded({ saturation: -1 })));
    expect(filter).toContain('saturate(0.000)');
    expect(filter).toContain('brightness(');
  });

  it('warm temperature rotates hue negative (toward red)', () => {
    const filter = colorGradeCssFilter(colorGradeParams(graded({ temperature: 1 })));
    expect(filter).toContain('hue-rotate(-18.0deg)');
  });
});

describe('audio settings', () => {
  const withAudio = (params: Record<string, unknown>): Clip => ({
    ...sampleClip,
    effects: [{ id: 'c__gain', type: 'audio_gain', params, keyframes: [] }],
  });

  it('defaults when there is no audio_gain effect', () => {
    const a = audioSettings(sampleClip);
    expect(a.gainDb).toBe(0);
    expect(a.muted).toBe(false);
    expect(a.duckUnderTrackId).toBeNull();
  });

  it('reads stored gain/fade/mute/normalize/duck', () => {
    const a = audioSettings(
      withAudio({
        gainDb: -6,
        fadeInSeconds: 1,
        muted: true,
        normalize: true,
        duckUnderTrackId: 'v1',
      }),
    );
    expect(a.gainDb).toBe(-6);
    expect(a.fadeInSeconds).toBe(1);
    expect(a.muted).toBe(true);
    expect(a.normalize).toBe(true);
    expect(a.duckUnderTrackId).toBe('v1');
  });

  it('lists other audio/video tracks as duck sidechain options', () => {
    expect(duckTrackOptions(navTimeline, 'v1').map((t) => t.id)).toEqual(['v2']);
    expect(duckTrackOptions(navTimeline, 'v2').map((t) => t.id)).toEqual(['v1']);
  });
});

describe('waveform helpers', () => {
  it('clipPeaks returns [] when the asset has no peaks', () => {
    expect(clipPeaks(undefined, 0, 5)).toEqual([]);
    expect(clipPeaks({ peaks: [], peaksPerSecond: 10 }, 0, 5)).toEqual([]);
    expect(clipPeaks({ peaks: [0.5, 0.5] }, 0, 5)).toEqual([]); // no peaksPerSecond
  });

  it('clipPeaks slices peaks to the clip source window by peaksPerSecond', () => {
    const peaks = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    // 10 peaks at 2/sec → 5s of audio; window [1s,3s) → indices [2,6)
    expect(clipPeaks({ peaks, peaksPerSecond: 2 }, 1, 3)).toEqual([0.2, 0.3, 0.4, 0.5]);
  });

  it('clipPeaks clamps the window to the available peaks', () => {
    const peaks = [0.1, 0.2, 0.3];
    expect(clipPeaks({ peaks, peaksPerSecond: 1 }, -5, 999)).toEqual([0.1, 0.2, 0.3]);
  });

  it('waveformPoints returns "" for empty peaks or a zero box', () => {
    expect(waveformPoints([], 100, 32)).toBe('');
    expect(waveformPoints([0.5], 0, 32)).toBe('');
  });

  it('waveformPoints draws a mirrored polyline across the box', () => {
    const pts = waveformPoints([0, 1], 100, 32).split(' ');
    // 2 peaks → 2 top points + 2 bottom points (reversed).
    expect(pts).toHaveLength(4);
    // First top point: x=0, peak 0 → midline (16).
    expect(pts[0]).toBe('0.0,16.0');
    // Second top point: x=100, peak 1 → top edge (0).
    expect(pts[1]).toBe('100.0,0.0');
    // Amplitudes are clamped to [0,1] and mirrored about the 16px midline.
    expect(waveformPoints([2], 100, 32)).toContain('0.0,0.0'); // clamped to 1 → top
  });
});

describe('clipFilmstripFrames', () => {
  const withThumbs = (thumbnailPaths: string[] | undefined, durationSeconds?: number): Asset => ({
    id: 'v1',
    path: '/media/clip.mp4',
    kind: 'video',
    durationSeconds,
    media: thumbnailPaths ? { thumbnailPaths } : undefined,
  });

  it('returns [] when the asset, media, or duration is missing/zero', () => {
    expect(clipFilmstripFrames(undefined, 0, 5, 8)).toEqual([]);
    expect(clipFilmstripFrames(withThumbs(undefined, 10), 0, 5, 8)).toEqual([]); // no media
    expect(clipFilmstripFrames(withThumbs([], 10), 0, 5, 8)).toEqual([]); // empty paths
    expect(clipFilmstripFrames(withThumbs(['a.jpg'], undefined), 0, 5, 8)).toEqual([]); // no duration
    expect(clipFilmstripFrames(withThumbs(['a.jpg'], 0), 0, 5, 8)).toEqual([]); // zero duration
  });

  it('returns [] when maxFrames is non-positive', () => {
    expect(clipFilmstripFrames(withThumbs(['a.jpg', 'b.jpg'], 10), 0, 10, 0)).toEqual([]);
  });

  it('returns [] for an image asset — it is one still frame, tiled by the caller', () => {
    // Even with stale derived thumb paths (an older import mislabelling a photo
    // as video), an image yields no per-frame strip so the caller tiles its source.
    const image: Asset = {
      id: 'img',
      path: 'media/p/photo.jpeg',
      kind: 'image',
      durationSeconds: 5,
      media: { thumbnailPaths: ['.framepilot-derived/x/thumbs/thumb_000.png'] },
    };
    expect(clipFilmstripFrames(image, 0, 5, 8)).toEqual([]);
  });

  it('returns the whole strip when fewer frames than maxFrames cover the full range', () => {
    const thumbs = ['a.jpg', 'b.jpg', 'c.jpg'];
    expect(clipFilmstripFrames(withThumbs(thumbs, 3), 0, 3, 8)).toEqual(thumbs);
  });

  it('maps a sub-range to a contiguous slice of the strip', () => {
    // 10 thumbs across 10s → 1 thumb/sec; window [2s,5s) → indices [2,5)
    const thumbs = Array.from({ length: 10 }, (_, i) => `t${i}.jpg`);
    expect(clipFilmstripFrames(withThumbs(thumbs, 10), 2, 5, 8)).toEqual([
      't2.jpg',
      't3.jpg',
      't4.jpg',
    ]);
  });

  it('picks maxFrames evenly (first..last) when the window has more frames', () => {
    const thumbs = Array.from({ length: 9 }, (_, i) => `t${i}.jpg`);
    // Full range, maxFrames=3 → indices 0, 4, 8 (even across 0..8).
    expect(clipFilmstripFrames(withThumbs(thumbs, 9), 0, 9, 3)).toEqual([
      't0.jpg',
      't4.jpg',
      't8.jpg',
    ]);
  });

  it('clamps a window that overruns the strip and never returns an empty slice', () => {
    const thumbs = ['a.jpg', 'b.jpg'];
    // sourceStart beyond the strip would slice empty → falls back to the first frame.
    expect(clipFilmstripFrames(withThumbs(thumbs, 2), 5, 9, 8)).toEqual(['a.jpg']);
  });
});

describe('clipsIntersectingRect (marquee selection, M2a)', () => {
  // Two tracks, each with two clips. At 40px/s: 1s = 40px. The rows are given as
  // explicit bands, exactly as the view lays them out — and deliberately NOT the
  // same height, which is the case a uniform "container height / row count" got
  // wrong (an effect lane is 20px where a video lane is 56).
  const c = (id: string, trackId: string, start: number, end: number): Clip => ({
    ...sampleClip,
    id,
    trackId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
  });
  const tl: Timeline = {
    tracks: [
      { id: 't0', type: 'video', clips: [c('a', 't0', 0, 2), c('b', 't0', 5, 7)] },
      { id: 't1', type: 'video', clips: [c('d', 't1', 1, 3), c('e', 't1', 8, 10)] },
    ],
  };
  const rows = [
    { trackId: 't0', top: 0, height: 50 },
    { trackId: 't1', top: 50, height: 50 },
  ];
  const PPS = 40;

  it('selects clips whose time-span and row both overlap the rect', () => {
    // x [0,120px] = [0,3s], row 0 only → covers a (0–2s); d is on row 1 (excluded).
    const ids = clipsIntersectingRect(tl, { x: 0, y: 0, width: 120, height: 40 }, rows, PPS);
    expect(ids).toEqual(['a']);
  });

  it('spans multiple rows when the rect is tall enough', () => {
    // x [0,120px] = [0,3s] over both rows → a (t0) and d (t1, 1–3s) intersect.
    const ids = clipsIntersectingRect(tl, { x: 0, y: 0, width: 120, height: 100 }, rows, PPS);
    expect(ids).toEqual(['a', 'd']);
  });

  it('uses half-open span overlap (touching edges do not count)', () => {
    // x [80,80] → 0 width returns []; and a rect ending exactly at a clip start
    // (x=[0,80px]=[0,2s]) overlaps a (ends at 2) since a.end(2) > from(0).
    expect(clipsIntersectingRect(tl, { x: 80, y: 0, width: 0, height: 40 }, rows, PPS)).toEqual([]);
    expect(clipsIntersectingRect(tl, { x: 0, y: 0, width: 80, height: 40 }, rows, PPS)).toEqual([
      'a',
    ]);
  });

  it('selects multiple clips on one row when the rect spans them', () => {
    // x [0,320px] = [0,8s], row 0 → a (0–2) and b (5–7); e starts at 8 (excluded).
    const ids = clipsIntersectingRect(tl, { x: 0, y: 0, width: 320, height: 40 }, rows, PPS);
    expect(ids).toEqual(['a', 'b']);
  });

  it('returns [] for a degenerate rect', () => {
    expect(clipsIntersectingRect(tl, { x: 0, y: 0, width: 0, height: 0 }, rows, PPS)).toEqual([]);
    expect(clipsIntersectingRect(tl, { x: 0, y: 0, width: 50, height: 50 }, [], PPS)).toEqual([]);
  });

  it('ignores rows whose track is not in the timeline', () => {
    const ids = clipsIntersectingRect(
      tl,
      { x: 0, y: 0, width: 120, height: 200 },
      [
        { trackId: 'ghost', top: 0, height: 50 },
        { trackId: 't0', top: 50, height: 50 },
      ],
      PPS,
    );
    expect(ids).toEqual(['a']);
  });

  it('hit-tests each row at its OWN height, not an average of them', () => {
    // A short effect lane on top of two tall lanes — the real shape of a project
    // with effects. Averaging the three (26+62+62)/3 ≈ 50 would map a band drawn
    // over the AUDIO lane (y 88–150) onto rows 1–2 and drag the video clips in.
    const mixed = [
      { trackId: 'fx', top: 0, height: 26 },
      { trackId: 't0', top: 26, height: 62 },
      { trackId: 't1', top: 88, height: 62 },
    ];
    const ids = clipsIntersectingRect(tl, { x: 0, y: 90, width: 480, height: 56 }, mixed, PPS);
    expect(ids).toEqual(['d', 'e']); // t1 only — no video clips swept in
  });
});

describe('effectLayersIntersectingRect (marquee over an effect lane)', () => {
  const layer = (id: string, start: number, end: number) => ({
    id,
    effectId: 'halo-bloom',
    kind: 'bloom' as const,
    start,
    end,
    params: {},
  });
  const tl = {
    tracks: [
      {
        id: 'fx',
        type: 'effect',
        clips: [],
        effectLayers: [layer('fx_a', 0, 2), layer('fx_b', 6, 8)],
      },
      { id: 't0', type: 'video', clips: [] },
    ],
  } as unknown as Timeline;
  const rows = [
    { trackId: 'fx', top: 0, height: 26 },
    { trackId: 't0', top: 26, height: 62 },
  ];
  const PPS = 40;

  it('selects the layers a band covers on the effect lane', () => {
    // x [0,120px] = [0,3s] over the fx row → fx_a only.
    expect(
      effectLayersIntersectingRect(tl, { x: 0, y: 0, width: 120, height: 20 }, rows, PPS),
    ).toEqual(['fx_a']);
  });

  it('skips lanes the band does not reach, and degenerate rects', () => {
    expect(
      effectLayersIntersectingRect(tl, { x: 0, y: 30, width: 400, height: 40 }, rows, PPS),
    ).toEqual([]);
    expect(
      effectLayersIntersectingRect(tl, { x: 0, y: 0, width: 0, height: 20 }, rows, PPS),
    ).toEqual([]);
  });
});

describe('downstreamClips (Insert edit mode)', () => {
  const clip = (id: string, start: number, end: number): Clip => ({
    ...sampleClip,
    id,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
  });
  const timeline: Timeline = {
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [clip('a', 0, 4), clip('b', 4, 8), clip('c', 8, 12)],
      },
      { id: 'v2', type: 'video', clips: [clip('x', 2, 6)] },
    ],
  };

  it('returns clips at/after the insertion point, back-to-front', () => {
    expect(downstreamClips(timeline, 'v1', 4).map((c) => c.id)).toEqual(['c', 'b']);
  });

  it('includes a clip whose start sits exactly at the insertion point', () => {
    expect(downstreamClips(timeline, 'v1', 0).map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('ignores clips on other lanes', () => {
    expect(downstreamClips(timeline, 'v1', 4).some((c) => c.id === 'x')).toBe(false);
  });

  it('is empty when nothing is downstream or the track is missing', () => {
    expect(downstreamClips(timeline, 'v1', 99)).toEqual([]);
    expect(downstreamClips(timeline, 'nope', 0)).toEqual([]);
  });
});

describe('shouldAutoFollow (auto-scroll decision, M2b-2)', () => {
  const base = { enabled: true, playing: true, scrubbing: false, userScrolling: false };
  it('follows only while enabled and playing', () => {
    expect(shouldAutoFollow(base)).toBe(true);
    expect(shouldAutoFollow({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoFollow({ ...base, playing: false })).toBe(false);
  });
  it('suspends while the user scrubs or manually scrolls (never fights manual control)', () => {
    expect(shouldAutoFollow({ ...base, scrubbing: true })).toBe(false);
    expect(shouldAutoFollow({ ...base, userScrolling: true })).toBe(false);
  });
});

describe('nextAutoScrollLeft (auto-scroll geometry, M2b-2)', () => {
  // 1000px viewport over 5000px of content; 15% dead-band → [150, 850] of the view.
  it('returns null while the playhead sits in the comfortable band', () => {
    expect(nextAutoScrollLeft(500, 0, 1000, 5000)).toBeNull();
  });
  it('scrolls to bring an off-right playhead back to the band edge', () => {
    // playhead at 1200px is past the right edge (0 + 850); target = 1200 - 850 = 350.
    expect(nextAutoScrollLeft(1200, 0, 1000, 5000)).toBe(350);
  });
  it('scrolls to bring an off-left playhead back, clamping at zero', () => {
    // From scrollLeft 800, playhead at 700 is left of (800 + 150); target clamps ≥ 0.
    const next = nextAutoScrollLeft(700, 800, 1000, 5000);
    expect(next).not.toBeNull();
    expect(next!).toBeLessThan(800);
  });
  it('clamps to the scrollable range and returns null for a zero-width viewport', () => {
    expect(nextAutoScrollLeft(99999, 0, 1000, 5000)).toBe(4000); // maxScroll = 5000 - 1000
    expect(nextAutoScrollLeft(500, 0, 0, 5000)).toBeNull();
  });
});

describe('minimapGeometry / minimapScrollLeft (overview strip, M2b-2)', () => {
  // One track, clip [0,2]s; at 40px/s content = 400px; minimap = 100px → scale 0.25.
  const mc = (id: string, trackId: string, start: number, end: number): Clip => ({
    ...sampleClip,
    id,
    trackId,
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
  });
  const tl: Timeline = {
    tracks: [
      { id: 'a', type: 'video', clips: [mc('c0', 'a', 0, 2), mc('c1', 'a', 8, 10)] },
      { id: 'b', type: 'video', clips: [mc('c2', 'b', 4, 6)] },
    ],
  };
  const order = ['a', 'b'];
  const PPS = 40;
  const CONTENT = 400; // 10s × 40px/s
  const MINI = 100;

  it('compresses each clip to a minimap block on its row', () => {
    const geo = minimapGeometry(tl, order, PPS, CONTENT, 0, 200, MINI);
    expect(geo.rows).toBe(2);
    expect(geo.blocks).toHaveLength(3);
    // c0 [0,2]s → minimap px [0, 2×40×(100/400)=20].
    const c0 = geo.blocks.find((b) => b.clipId === 'c0')!;
    expect(c0.x).toBe(0);
    expect(c0.width).toBeCloseTo(20, 5);
    expect(c0.row).toBe(0);
    expect(geo.blocks.find((b) => b.clipId === 'c2')!.row).toBe(1);
  });
  it('maps the viewport scroll/width onto the window rect', () => {
    // scrollLeft 100px → window x = 100 × 0.25 = 25; clientWidth 200 → width = 50.
    const geo = minimapGeometry(tl, order, PPS, CONTENT, 100, 200, MINI);
    expect(geo.viewport.x).toBe(25);
    expect(geo.viewport.width).toBeCloseTo(50, 5);
  });
  it('keeps a tiny clip at least the minimum block width', () => {
    const tiny: Timeline = { tracks: [{ id: 'a', type: 'video', clips: [mc('t', 'a', 0, 0.01)] }] };
    const geo = minimapGeometry(tiny, ['a'], PPS, CONTENT, 0, 200, MINI);
    expect(geo.blocks[0]!.width).toBeGreaterThanOrEqual(MINIMAP_MIN_BLOCK_PX);
  });
  it('is empty for a zero content or minimap width', () => {
    expect(minimapGeometry(tl, order, PPS, 0, 0, 200, MINI).blocks).toEqual([]);
    expect(minimapGeometry(tl, order, PPS, CONTENT, 0, 200, 0).blocks).toEqual([]);
  });
  it('maps a minimap click back to a centred, clamped scrollLeft', () => {
    // Click at minimap x=50 → content px = 50 × (400/100) = 200; centre on it for a
    // 200px viewport → 200 - 100 = 100, clamped to [0, 400-200=200].
    expect(minimapScrollLeft(50, CONTENT, 200, MINI)).toBe(100);
    expect(minimapScrollLeft(100, CONTENT, 200, MINI)).toBe(200); // clamps at maxScroll
    expect(minimapScrollLeft(0, CONTENT, 200, MINI)).toBe(0);
    expect(minimapScrollLeft(50, CONTENT, 200, 0)).toBe(0); // degenerate minimap width
  });
});

describe('on-cut transition selectors (M3b)', () => {
  const mkClip = (id: string, start: number, end: number, effects: Clip['effects'] = []): Clip => ({
    id,
    assetId: 'asset_x',
    trackId: 'v',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    keyframes: [],
    effects,
  });
  const transitionEffect = (
    toId: string,
    fromId: string,
    durationSeconds: number,
    kind = 'fade',
  ) => ({
    id: `${toId}__transition`,
    type: 'transition' as const,
    params: { kind, durationSeconds, fromClipId: fromId },
    keyframes: [],
  });
  // a [0,4], b [4,10] adjacent with a transition entering b from a; c [12,14] gapped.
  const timeline: Timeline = {
    tracks: [
      {
        id: 'v',
        type: 'video',
        clips: [
          mkClip('a', 0, 4),
          mkClip('b', 4, 10, [transitionEffect('b', 'a', 1)]),
          mkClip('c', 12, 14),
        ],
      },
    ],
  };

  it('clipTransition returns the transition effect on the incoming clip only', () => {
    expect(clipTransition(timeline.tracks[0]!.clips[1]!)?.id).toBe('b__transition');
    expect(clipTransition(timeline.tracks[0]!.clips[0]!)).toBeUndefined();
  });

  it('timelineTransitions resolves pill geometry for a valid adjacency', () => {
    const placements = timelineTransitions(timeline);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      trackId: 'v',
      fromClipId: 'a',
      toClipId: 'b',
      effectId: 'b__transition',
      kind: 'fade',
      durationSeconds: 1,
      cutTime: 4, // b.start
      maxDurationSeconds: 4, // min(b=6, a=4)
    });
  });

  it('timelineTransitions skips a transition whose fromClipId is not the adjacent earlier clip', () => {
    const dangling: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [mkClip('a', 0, 4), mkClip('b', 4, 10, [transitionEffect('b', 'ghost', 1)])],
        },
      ],
    };
    expect(timelineTransitions(dangling)).toHaveLength(0);
  });

  it('transitionMaxDuration is min(incoming, outgoing) and null with no earlier neighbour', () => {
    expect(transitionMaxDuration(timeline, 'b')).toBe(4);
    expect(transitionMaxDuration(timeline, 'a')).toBeNull(); // first clip on the lane
    expect(transitionMaxDuration(timeline, 'nope')).toBeNull();
  });

  it('trackJunctions yields a cut per consecutive pair, marking touching ones', () => {
    const junctions = trackJunctions(timeline.tracks[0]!);
    expect(junctions).toHaveLength(2);
    expect(junctions[0]).toMatchObject({
      fromClipId: 'a',
      toClipId: 'b',
      cutTime: 4,
      touching: true,
    });
    // c starts at 12 but b ends at 10 → gapped, not a butt-joined cut.
    expect(junctions[1]).toMatchObject({ fromClipId: 'b', toClipId: 'c', touching: false });
  });
});

describe('laneRenderWindow / spanInRenderWindow (horizontal windowing)', () => {
  it('returns null (render everything) when the viewport is unmeasured', () => {
    expect(laneRenderWindow(0, 0)).toBeNull();
    expect(laneRenderWindow(500, -1)).toBeNull();
    expect(laneRenderWindow(500, Number.NaN)).toBeNull();
  });

  it('covers the viewport plus at least one viewport of overscan each side', () => {
    // Worst cases within a bucket: the leading edge just after a crossing and
    // the trailing edge just before the next one both keep >= one bucket mounted.
    for (const scrollLeft of [2_000, 2_400, 2_999]) {
      const win = laneRenderWindow(scrollLeft, 1_000)!;
      expect(win.startPx).toBeLessThanOrEqual(scrollLeft - 1_000);
      expect(win.endPx).toBeGreaterThanOrEqual(scrollLeft + 1_000 + 1_000);
    }
  });

  it('is quantized: identical within a bucket, changes only across bucket boundaries', () => {
    // clientWidth 1000 → bucket 1000; every scrollLeft in [1000, 2000) shares a window.
    expect(laneRenderWindow(1_000, 1_000)).toEqual(laneRenderWindow(1_999, 1_000));
    expect(laneRenderWindow(1_999, 1_000)).not.toEqual(laneRenderWindow(2_000, 1_000));
  });

  it('clamps the window start at 0 and enforces the minimum bucket', () => {
    expect(laneRenderWindow(0, 100)!.startPx).toBe(0);
    // Tiny viewport (below the 256px minimum bucket) still windows coarsely.
    expect(laneRenderWindow(0, 100)!.endPx).toBe(768);
  });

  it('spanInRenderWindow keeps everything with a null window and intersects otherwise', () => {
    expect(spanInRenderWindow(9_999, 10_000, null, 40)).toBe(true);
    const win = { startPx: 400, endPx: 800 };
    // At 40 px/s: a clip [5s,8s] spans [200px,320px] → outside; [12s,25s] → inside.
    expect(spanInRenderWindow(5, 8, win, 40)).toBe(false);
    expect(spanInRenderWindow(12, 25, win, 40)).toBe(true);
    // Edge-touching spans stay mounted (inclusive bounds).
    expect(spanInRenderWindow(0, 10, win, 40)).toBe(true);
  });
});

describe('wheelIntent (UX-06)', () => {
  const base = {
    deltaX: 0,
    deltaY: 100,
    zoomModifier: false,
    shiftKey: false,
    canScrollVertically: false,
  };

  it('zooms on Cmd/Ctrl (and on a trackpad pinch, which reports ctrl)', () => {
    expect(wheelIntent({ ...base, zoomModifier: true })).toBe('zoom');
    // The zoom modifier wins over every other consideration.
    expect(wheelIntent({ ...base, zoomModifier: true, canScrollVertically: true })).toBe('zoom');
  });

  it('scrolls the timeline horizontally for a bare vertical wheel', () => {
    expect(wheelIntent(base)).toBe('scroll-horizontal');
    expect(wheelIntent({ ...base, deltaY: -100 })).toBe('scroll-horizontal');
  });

  it('leaves the browser alone when it already does the right thing', () => {
    // Shift is the browser's own horizontal mapping.
    expect(wheelIntent({ ...base, shiftKey: true })).toBe('browser');
    // A two-finger horizontal swipe is already on the right axis.
    expect(wheelIntent({ ...base, deltaX: -120, deltaY: 4 })).toBe('browser');
    // No movement at all is not an intent.
    expect(wheelIntent({ ...base, deltaY: 0 })).toBe('browser');
  });

  it('never steals a vertical wheel from a track stack tall enough to scroll', () => {
    expect(wheelIntent({ ...base, canScrollVertically: true })).toBe('browser');
  });
});
