/**
 * Tests for the per-track view layout (M2b-2): lane height clamping, collapse,
 * solo, the localStorage round-trip + corrupt tolerance, and the **derived**
 * solo-mute resolution. View/session state only — never the timeline (invariant
 * 5): solo produces a transient preview-mute set, not a `set_track_flags` patch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Asset, Track } from '@framepilot/timeline-schema';
import {
  COLLAPSED_TRACK_HEIGHT,
  DEFAULT_TRACK_VIEW,
  TRACK_HEIGHT_BOUNDS,
  clampTrackHeight,
  effectiveTrackHeight,
  loadTrackLayout,
  resolveSoloMutedTrackIds,
  useTrackLayout,
} from './useTrackLayout.js';

const STORAGE_KEY = 'framepilot.trackLayout';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('clampTrackHeight', () => {
  it('clamps to the bounds and rounds', () => {
    expect(clampTrackHeight(5)).toBe(TRACK_HEIGHT_BOUNDS.min);
    expect(clampTrackHeight(9999)).toBe(TRACK_HEIGHT_BOUNDS.max);
    expect(clampTrackHeight(60.4)).toBe(60);
  });
  it('falls back to the default for non-finite input', () => {
    expect(clampTrackHeight(Number.NaN)).toBe(TRACK_HEIGHT_BOUNDS.default);
  });
});

describe('effectiveTrackHeight', () => {
  it('reports the collapsed strip height when collapsed, else the set height', () => {
    expect(effectiveTrackHeight({ heightPx: 80, collapsed: false, soloed: false })).toBe(80);
    expect(effectiveTrackHeight({ heightPx: 80, collapsed: true, soloed: false })).toBe(
      COLLAPSED_TRACK_HEIGHT,
    );
  });
});

describe('useTrackLayout', () => {
  it('starts from defaults and persists a height resize (clamped, clears collapse)', () => {
    const { result } = renderHook(() => useTrackLayout());
    expect(result.current.get('v')).toEqual(DEFAULT_TRACK_VIEW);
    act(() => result.current.setHeight('v', 9999));
    expect(result.current.get('v').heightPx).toBe(TRACK_HEIGHT_BOUNDS.max);
    expect(result.current.get('v').collapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).v.heightPx).toBe(TRACK_HEIGHT_BOUNDS.max);
  });

  it('toggles collapse and solo independently, persisting each', () => {
    const { result } = renderHook(() => useTrackLayout());
    act(() => result.current.toggleCollapsed('v'));
    expect(result.current.get('v').collapsed).toBe(true);
    act(() => result.current.toggleSolo('v'));
    expect(result.current.get('v').soloed).toBe(true);
    expect(result.current.hasSolo).toBe(true);
    expect([...result.current.soloedIds]).toEqual(['v']);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.v).toMatchObject({ collapsed: true, soloed: true });
  });

  it('restores persisted state on mount and tolerates corrupt data', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    const { result: bad } = renderHook(() => useTrackLayout());
    expect(bad.current.get('v')).toEqual(DEFAULT_TRACK_VIEW); // fell back, no throw

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: { heightPx: 5000, soloed: true } }));
    const { result } = renderHook(() => useTrackLayout());
    // Out-of-range height clamps; missing `collapsed` defaults false; solo restored.
    expect(result.current.get('v')).toEqual({
      heightPx: TRACK_HEIGHT_BOUNDS.max,
      collapsed: false,
      soloed: true,
    });
  });
});

describe('loadTrackLayout', () => {
  it('returns an empty map when nothing is stored', () => {
    expect(loadTrackLayout()).toEqual({});
  });
  it('drops a non-object blob without throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    expect(loadTrackLayout()).toEqual({});
  });
});

describe('resolveSoloMutedTrackIds (derived preview mute, never a schema flag)', () => {
  const asset = (id: string, kind: Asset['kind']): [string, Asset] => [
    id,
    { id, path: `${id}.x`, kind },
  ];
  const assets = new Map<string, Asset>([
    asset('vid', 'video'),
    asset('snd', 'audio'),
    asset('txt', 'video'),
  ]);
  const track = (id: string, assetId: string): Track => ({
    id,
    type: 'video',
    clips: [
      {
        id: `${id}c`,
        assetId,
        trackId: id,
        start: 0,
        end: 1,
        sourceStart: 0,
        sourceEnd: 1,
        effects: [],
        keyframes: [],
      },
    ],
  });
  const tracks: readonly Track[] = [
    track('v1', 'vid'),
    track('a1', 'snd'),
    track('a2', 'snd'),
    { id: 'cap', type: 'caption', clips: [] }, // no audio-bearing clips
  ];

  it('is empty when nothing is soloed (the real mute flags stand alone)', () => {
    expect([...resolveSoloMutedTrackIds(tracks, new Set(), assets)]).toEqual([]);
  });

  it('mutes every OTHER audio-bearing lane when one is soloed', () => {
    const muted = resolveSoloMutedTrackIds(tracks, new Set(['a1']), assets);
    // a1 is soloed; v1 and a2 are audio-bearing and not soloed → muted; cap is empty.
    expect([...muted].sort()).toEqual(['a2', 'v1']);
    expect(muted.has('a1')).toBe(false);
    expect(muted.has('cap')).toBe(false);
  });

  it('exempts every soloed lane (soloing several monitors them together)', () => {
    const muted = resolveSoloMutedTrackIds(tracks, new Set(['v1', 'a1']), assets);
    expect([...muted]).toEqual(['a2']);
  });

  it('is empty when only a non-audio (caption) lane is soloed', () => {
    expect([...resolveSoloMutedTrackIds(tracks, new Set(['cap']), assets)]).toEqual([]);
  });
});
