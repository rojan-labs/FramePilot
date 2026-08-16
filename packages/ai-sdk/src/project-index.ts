/**
 * @framepilot/ai-sdk/project-index — the local project intelligence layer.
 *
 * A Cursor-style local index over the open {@link Project}: instead of every AI
 * turn re-walking (or re-serializing) the whole project, the orchestrator, the
 * context builder, and the name resolver query one precomputed structure —
 * entity lookup (clip/track/asset/effect by id), structural queries (by kind,
 * by track, by asset, by time range), text search (overlay/caption text, asset
 * file names), and relationship queries (clips of an asset, effects attached to
 * a clip).
 *
 * **Incremental by construction.** The editor's state is immutable: a patch
 * replaces only the objects along the modified path, so an untouched `Track`
 * keeps its identity across edits. The index exploits that two ways:
 * - {@link indexFor} memoizes the whole index per `Project` object (WeakMap), so
 *   repeated queries within one turn/render never rebuild anything;
 * - each track's sub-index is memoized per `Track` object (WeakMap), so when a
 *   patch produces a NEW project, only the tracks that actually changed are
 *   re-indexed — the rest are reused by reference.
 * Deleting an asset (or clip/track) yields a project without it; the fresh index
 * therefore cannot contain a stale entry, and the WeakMaps let the old entries
 * be garbage-collected with the old objects. There is no mutable cache to
 * invalidate and no path where the index drifts from the project.
 */
import type { Asset, Clip, Effect, Project, Timeline, Track } from '@framepilot/timeline-schema';

/** Where a clip lives: the clip plus its track context (z-order = track index). */
export interface ClipEntry {
  readonly clip: Clip;
  readonly track: Track;
  /** Z-order of the track (0 = visual front). */
  readonly trackIndex: number;
}

/** One effect and the clip/track it is attached to (relationship queries). */
export interface EffectEntry {
  readonly effect: Effect;
  readonly clip: Clip;
  readonly track: Track;
}

/** The queryable index over one immutable {@link Project} snapshot. */
export interface ProjectIndex {
  // --- entity lookup --------------------------------------------------------
  readonly clipById: ReadonlyMap<string, ClipEntry>;
  readonly trackById: ReadonlyMap<string, Track>;
  readonly assetById: ReadonlyMap<string, Asset>;
  /** Track index (z-order) by track id. */
  readonly trackIndexById: ReadonlyMap<string, number>;

  // --- relationships ---------------------------------------------------------
  /** All timeline clips referencing an asset (empty array when none). */
  clipsOfAsset(assetId: string): readonly ClipEntry[];
  /** All effects attached to a clip (e.g. the transition on Clip A). */
  effectsOf(clipId: string): readonly EffectEntry[];

  // --- structural queries ----------------------------------------------------
  /** Tracks of a given advisory type ("find all audio tracks"). */
  tracksOfType(type: Track['type']): readonly Track[];
  /** Clips whose derived kind matches (video/audio/image/text/caption). */
  clipsOfKind(kind: string): readonly ClipEntry[];
  /** Clips overlapping [start, end) in timeline time. */
  clipsInRange(start: number, end: number): readonly ClipEntry[];
  /** Clips carrying an effect of `type` ("every clip with a transition"). */
  clipsWithEffectType(type: string): readonly EffectEntry[];
  /** Clips animated by keyframes — on the clip itself or any of its effects. */
  keyframedClips(): readonly ClipEntry[];

  // --- text search -----------------------------------------------------------
  /**
   * Case-insensitive text search over overlay/caption text params and asset file
   * names ("locate the title containing 'Introduction'"). Results are
   * RELEVANCE-RANKED: whole-phrase-at-word-boundary > prefix > substring, so
   * "intro" surfaces the clip titled "Intro" before "reintroduction".
   */
  search(query: string): {
    readonly clips: readonly ClipEntry[];
    readonly assets: readonly Asset[];
  };
}

// Synthetic asset ids for clips with no media source (mirrors context-builder /
// the engine — a clip's kind derives from its content, never its layer).
const TEXT_OVERLAY_ASSET_ID = '__text__';
const CAPTION_ASSET_ID = '__caption__';

/** Derive a clip's kind from its asset (or synthetic id). Mirrors the engine. */
export function clipKindOf(clip: Clip, assetById: ReadonlyMap<string, Asset>): string {
  if (clip.assetId === TEXT_OVERLAY_ASSET_ID) return 'text';
  if (clip.assetId === CAPTION_ASSET_ID) return 'caption';
  const kind = assetById.get(clip.assetId)?.kind;
  if (kind === 'audio') return 'audio';
  if (kind === 'image') return 'image';
  return 'video';
}

/** The per-track slice of the index, reusable while the Track object is unchanged. */
interface TrackIndex {
  readonly clips: readonly Clip[];
  /** clipId → clip (identity within this track). */
  readonly clipById: ReadonlyMap<string, Clip>;
  /** assetId → clips on this track referencing it. */
  readonly clipsByAsset: ReadonlyMap<string, readonly Clip[]>;
  /** Lower-cased searchable text per clip (text/caption effect params). */
  readonly textByClip: ReadonlyMap<string, string>;
}

/** Extract a clip's searchable overlay/caption text (lower-cased), or ''. */
function clipText(clip: Clip): string {
  const parts: string[] = [];
  // Defensive `?? []`: schema defaults `effects`, but hand-built test fixtures
  // (and pre-parse callers) may omit it.
  for (const effect of clip.effects ?? []) {
    if (effect.type === 'text' || effect.type === 'caption') {
      const text = (effect.params as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Per-track sub-index cache. Keyed on the immutable Track object: a patch that
 * does not touch this track keeps its reference, so its sub-index is reused —
 * this is what makes {@link indexFor} incremental across edits.
 */
const trackIndexCache = new WeakMap<Track, TrackIndex>();

function indexTrack(track: Track): TrackIndex {
  const cached = trackIndexCache.get(track);
  if (cached) return cached;

  const clipById = new Map<string, Clip>();
  const clipsByAsset = new Map<string, Clip[]>();
  const textByClip = new Map<string, string>();
  for (const clip of track.clips ?? []) {
    clipById.set(clip.id, clip);
    const byAsset = clipsByAsset.get(clip.assetId);
    if (byAsset) byAsset.push(clip);
    else clipsByAsset.set(clip.assetId, [clip]);
    const text = clipText(clip);
    if (text) textByClip.set(clip.id, text);
  }

  const built: TrackIndex = { clips: track.clips ?? [], clipById, clipsByAsset, textByClip };
  trackIndexCache.set(track, built);
  return built;
}

/** Build the full index for a project snapshot (prefer {@link indexFor}). */
export function buildProjectIndex(project: Project): ProjectIndex {
  const timeline: Timeline = project.timeline;

  const assetById = new Map<string, Asset>();
  for (const asset of project.assets ?? []) assetById.set(asset.id, asset);

  const trackById = new Map<string, Track>();
  const trackIndexById = new Map<string, number>();
  const clipById = new Map<string, ClipEntry>();
  const trackIndexes: { track: Track; index: number; sub: TrackIndex }[] = [];

  timeline.tracks.forEach((track, trackIndex) => {
    trackById.set(track.id, track);
    trackIndexById.set(track.id, trackIndex);
    const sub = indexTrack(track);
    trackIndexes.push({ track, index: trackIndex, sub });
    for (const clip of sub.clips) {
      clipById.set(clip.id, { clip, track, trackIndex });
    }
  });

  const entry = (clip: Clip, track: Track, trackIndex: number): ClipEntry => ({
    clip,
    track,
    trackIndex,
  });

  return {
    clipById,
    trackById,
    assetById,
    trackIndexById,

    clipsOfAsset: (assetId) =>
      trackIndexes.flatMap(({ track, index, sub }) =>
        (sub.clipsByAsset.get(assetId) ?? []).map((clip) => entry(clip, track, index)),
      ),

    effectsOf: (clipId) => {
      const found = clipById.get(clipId);
      if (!found) return [];
      return (found.clip.effects ?? []).map((effect) => ({
        effect,
        clip: found.clip,
        track: found.track,
      }));
    },

    tracksOfType: (type) => timeline.tracks.filter((t) => t.type === type),

    clipsOfKind: (kind) =>
      [...clipById.values()].filter((e) => clipKindOf(e.clip, assetById) === kind),

    clipsInRange: (start, end) =>
      [...clipById.values()].filter((e) => e.clip.start < end && e.clip.end > start),

    clipsWithEffectType: (type) =>
      [...clipById.values()].flatMap((e) =>
        (e.clip.effects ?? [])
          .filter((effect) => effect.type === type)
          .map((effect) => ({ effect, clip: e.clip, track: e.track })),
      ),

    keyframedClips: () =>
      [...clipById.values()].filter(
        (e) =>
          (e.clip.keyframes ?? []).length > 0 ||
          (e.clip.effects ?? []).some((effect) => (effect.keyframes ?? []).length > 0),
      ),

    search: (query) => {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return { clips: [], assets: [] };
      const scoredClips = trackIndexes.flatMap(({ track, index, sub }) =>
        [...sub.textByClip.entries()]
          .map(([clipId, text]) => ({ clipId, score: relevanceOf(text, q) }))
          .filter(({ score }) => score > 0)
          .map(({ clipId, score }) => ({
            entry: entry(sub.clipById.get(clipId)!, track, index),
            score,
          })),
      );
      scoredClips.sort((a, b) => b.score - a.score); // stable: ties keep track/time order
      const scoredAssets = [...assetById.values()]
        .map((asset) => ({ asset, score: relevanceOf(asset.path.toLowerCase(), q) }))
        .filter(({ score }) => score > 0);
      scoredAssets.sort((a, b) => b.score - a.score);
      return {
        clips: scoredClips.map(({ entry: e }) => e),
        assets: scoredAssets.map(({ asset }) => asset),
      };
    },
  };
}

/**
 * Relevance score for a case-insensitive match of `q` inside `text`:
 * 3 = starts with the query, 2 = query begins at a word boundary,
 * 1 = substring anywhere, 0 = no match. Ties keep original (track/time) order
 * via a stable sort, so ranking never scrambles equally-relevant results.
 */
export function relevanceOf(text: string, q: string): number {
  const at = text.indexOf(q);
  if (at < 0) return 0;
  if (at === 0) return 3;
  const before = text.charCodeAt(at - 1);
  // Word boundary: preceding char is not a letter/digit.
  const isWordChar =
    (before >= 48 && before <= 57) ||
    (before >= 97 && before <= 122) ||
    (before >= 65 && before <= 90);
  return isWordChar ? 1 : 2;
}

/** Whole-index cache, keyed on the immutable Project snapshot. */
const projectIndexCache = new WeakMap<Project, ProjectIndex>();

/**
 * The index for `project`, built at most once per project snapshot. Every AI
 * turn, event description, and context assembly against the same snapshot
 * shares this one structure; after an edit, only the changed tracks are
 * re-indexed (see the module doc).
 */
export function indexFor(project: Project): ProjectIndex {
  const cached = projectIndexCache.get(project);
  if (cached) return cached;
  const built = buildProjectIndex(project);
  projectIndexCache.set(project, built);
  return built;
}
