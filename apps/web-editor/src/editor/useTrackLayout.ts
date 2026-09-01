/**
 * Per-track view layout — lane height, collapsed flag, and audio **solo**
 * (plan/TIMELINE-REVAMP.md §4 "Track headers", §7 M2b-2). Like the side-rail
 * layout, edit-mode, and Settings prefs, these are **view/session state**, not
 * project state (invariant 5): they describe how this person likes to see each
 * lane, never anything about the timeline content. They live in `localStorage`,
 * keyed by track id, and are **not** part of the undo history or the saved
 * project file.
 *
 * Crucially, **solo is derived preview state, not a schema flag**: it produces a
 * transient "muted by solo" set (every *other* audio lane) layered over the
 * existing per-track `muted` flag — like a console's monitoring solo. It never
 * emits a `set_track_flags` patch and never touches `Track.muted`. See
 * {@link resolveSoloMutedTrackIds}.
 *
 * The pure load/normalise/clamp + solo-resolution helpers are unit-tested; the
 * hook is the thin React + storage shell around them (mirrors
 * {@link useRailLayout} / {@link useEditMode}).
 */
import { useCallback, useMemo, useState } from 'react';
import type { Asset, Track } from '@framepilot/timeline-schema';
import { audioBearingTracks } from './selectors.js';

/**
 * Lane-height bounds (px).
 *
 * 40px by default, down from 56. A lane carries a 17px name bar and, below it, a
 * filmstrip or waveform; 56px gave that strip more room than it can use — a
 * filmstrip frame is legible well under 24px — while costing a row of footage on
 * every screen. At 40 a working stack of six or seven lanes fits without
 * scrolling, which is the thing an editor actually needs from vertical space.
 * The floor drops with it so a deliberately squashed lane can still be squashed.
 */
export const TRACK_HEIGHT_BOUNDS = { min: 24, max: 200, default: 40 } as const;

/** Height (px) a collapsed lane shows — a thin strip with only its header chrome. */
export const COLLAPSED_TRACK_HEIGHT = 18;

/**
 * Height (px) of an `effect` adjustment lane (schema v13, ADR 0088).
 *
 * Deliberately shorter than a media lane: an effect layer carries no filmstrip,
 * no waveform and no thumbnail — only a name and two drag edges — so the 56px a
 * video lane needs would be empty space. Being visibly shorter is also what makes
 * an effect lane readable at a glance as "not footage", which is the requirement.
 *
 * 20px: the chip is a name and two drag edges, and at this height a lane of them
 * reads as an annotation strip rather than as another row of footage. The trim
 * handles narrow to 5px to match, which is still a comfortable pointer target.
 */
export const EFFECT_TRACK_HEIGHT = 20;

/** Persisted per-track view state. Absent fields fall back to the defaults below. */
export interface TrackViewState {
  /** Lane height in px (clamped to {@link TRACK_HEIGHT_BOUNDS}). */
  readonly heightPx: number;
  /** When true the lane collapses to {@link COLLAPSED_TRACK_HEIGHT} (bodies hidden). */
  readonly collapsed: boolean;
  /** When true this (audio) lane is soloed for preview monitoring (derived mute). */
  readonly soloed: boolean;
}

/** Factory defaults for a track with no persisted view state. */
export const DEFAULT_TRACK_VIEW: TrackViewState = {
  heightPx: TRACK_HEIGHT_BOUNDS.default,
  collapsed: false,
  soloed: false,
};

const STORAGE_KEY = 'framepilot.trackLayout';

/** Clamp a proposed lane height to {@link TRACK_HEIGHT_BOUNDS}. */
export function clampTrackHeight(height: number): number {
  if (!Number.isFinite(height)) return TRACK_HEIGHT_BOUNDS.default;
  return Math.min(TRACK_HEIGHT_BOUNDS.max, Math.max(TRACK_HEIGHT_BOUNDS.min, Math.round(height)));
}

/**
 * The effective rendered height for a lane: collapsed strips override the height.
 *
 * `trackType` is optional so every existing caller keeps working; passing
 * `'effect'` pins the lane to {@link EFFECT_TRACK_HEIGHT} rather than honouring a
 * persisted height, because an effect lane has nothing that benefits from being
 * taller and a stored 200px value from a resize drag would look like a bug.
 */
export function effectiveTrackHeight(view: TrackViewState, trackType?: Track['type']): number {
  if (view.collapsed) return COLLAPSED_TRACK_HEIGHT;
  if (trackType === 'effect') return EFFECT_TRACK_HEIGHT;
  return view.heightPx;
}

/** A map of track id → persisted {@link TrackViewState}. */
export type TrackLayoutMap = Readonly<Record<string, TrackViewState>>;

/** Coerce one untrusted parsed entry to a valid {@link TrackViewState}. */
function normalizeEntry(raw: unknown): TrackViewState {
  if (!raw || typeof raw !== 'object') return DEFAULT_TRACK_VIEW;
  const p = raw as Partial<TrackViewState>;
  return {
    heightPx:
      typeof p.heightPx === 'number' ? clampTrackHeight(p.heightPx) : DEFAULT_TRACK_VIEW.heightPx,
    collapsed: p.collapsed === true,
    soloed: p.soloed === true,
  };
}

/** Read the persisted layout map, tolerating missing/corrupt data. */
export function loadTrackLayout(): TrackLayoutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, TrackViewState> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[id] = normalizeEntry(value);
    }
    return out;
  } catch {
    return {};
  }
}

function saveTrackLayout(map: TrackLayoutMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage may be unavailable (private mode); layout still works in-session. */
  }
}

/**
 * The set of track ids that are **muted by solo** — a derived, transient preview
 * state, never a schema change. When at least one audio-bearing lane is soloed,
 * every *other* audio-bearing lane is monitored as muted; the soloed lanes (and
 * all non-audio lanes, which carry no sound) are unaffected. With no solo active
 * the set is empty (so the normal per-track `muted` flags stand alone).
 *
 * "Audio-bearing" means the lane holds at least one video or audio clip — those
 * are the only kinds that contribute to the audio mix; pure caption/text overlay
 * lanes never solo-mute. Pure (no DOM/React) so it is unit-tested in isolation.
 *
 * This is the timeline header's *display* projection (which lane's mute button
 * shows the "muted by solo" cue). The preview mixer/monitor drives actual
 * playback from {@link effectiveMutedTrackIds} in `selectors.ts`, which folds
 * the same solo rule over the persisted `muted` flags (and also un-mutes a
 * soloed track whose own `muted` flag is true — solo overrides it either way).
 *
 * @param tracks - The visible tracks, in order.
 * @param soloed - Set of track ids the user has soloed.
 * @param assetById - Asset lookup, to derive each clip's kind.
 * @returns Track ids to treat as muted for preview monitoring (may be empty).
 */
export function resolveSoloMutedTrackIds(
  tracks: readonly Track[],
  soloed: ReadonlySet<string>,
  assetById: ReadonlyMap<string, Asset>,
): ReadonlySet<string> {
  const audioTracks = audioBearingTracks(tracks, assetById);
  const soloedAudio = audioTracks.filter((t) => soloed.has(t.id));
  if (soloedAudio.length === 0) return new Set();
  const soloedIds = new Set(soloedAudio.map((t) => t.id));
  return new Set(audioTracks.filter((t) => !soloedIds.has(t.id)).map((t) => t.id));
}

/** The track-layout API exposed to the timeline. */
export interface UseTrackLayout {
  /** Read a track's view state (defaults when none is persisted). */
  readonly get: (trackId: string) => TrackViewState;
  /** Set a track's lane height (clamped, persisted, clears collapse). */
  readonly setHeight: (trackId: string, heightPx: number) => void;
  /** Toggle a track's collapsed flag. */
  readonly toggleCollapsed: (trackId: string) => void;
  /** Toggle a track's solo flag (preview-only; see {@link resolveSoloMutedTrackIds}). */
  readonly toggleSolo: (trackId: string) => void;
  /** True when any track is currently soloed (drives the derived-mute styling). */
  readonly hasSolo: boolean;
  /** The ids of tracks currently soloed — input to {@link resolveSoloMutedTrackIds}. */
  readonly soloedIds: ReadonlySet<string>;
}

/** Manage per-track lane height / collapse / solo, persisted to `localStorage`. */
export function useTrackLayout(): UseTrackLayout {
  const [map, setMap] = useState<TrackLayoutMap>(() => loadTrackLayout());

  const update = useCallback((trackId: string, patch: Partial<TrackViewState>): void => {
    setMap((current) => {
      const prev = current[trackId] ?? DEFAULT_TRACK_VIEW;
      const next: TrackLayoutMap = { ...current, [trackId]: { ...prev, ...patch } };
      saveTrackLayout(next);
      return next;
    });
  }, []);

  const get = useCallback(
    (trackId: string): TrackViewState => map[trackId] ?? DEFAULT_TRACK_VIEW,
    [map],
  );

  const setHeight = useCallback(
    (trackId: string, heightPx: number): void =>
      update(trackId, { heightPx: clampTrackHeight(heightPx), collapsed: false }),
    [update],
  );

  const toggleCollapsed = useCallback(
    (trackId: string): void =>
      update(trackId, { collapsed: !(map[trackId] ?? DEFAULT_TRACK_VIEW).collapsed }),
    [update, map],
  );

  const toggleSolo = useCallback(
    (trackId: string): void =>
      update(trackId, { soloed: !(map[trackId] ?? DEFAULT_TRACK_VIEW).soloed }),
    [update, map],
  );

  // Memoised on `map` (not recomputed every render): callers now include this
  // hook's whole return value in their own memo deps (Editor.tsx lifts it so
  // solo can also drive the preview mixer, not just the timeline header), so an
  // unstable identity here would defeat that outer memoization on every
  // playhead tick — the exact perf regression H0.4 J2 guards against.
  const soloedIds = useMemo(
    () =>
      new Set(
        Object.entries(map)
          .filter(([, view]) => view.soloed)
          .map(([id]) => id),
      ),
    [map],
  );

  return useMemo<UseTrackLayout>(
    () => ({
      get,
      setHeight,
      toggleCollapsed,
      toggleSolo,
      hasSolo: soloedIds.size > 0,
      soloedIds,
    }),
    [get, setHeight, toggleCollapsed, toggleSolo, soloedIds],
  );
}
