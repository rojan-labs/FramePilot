/**
 * @framepilot/ai-sdk/names — human-readable names for timeline ids
 * (Phase 11 progress-clarity pass, ADR 0033 amendment).
 *
 * The event stream reads as machine noise when clips/tracks/assets are shown by id
 * (`clip_7`, `video_1`). {@link projectNames} builds a pure, deterministic resolver
 * from the current {@link Project} so reasoning summaries, plan steps, tool cards, and
 * reference chips can say "Intro.mp4" / "Video 1" instead. It never mutates the project
 * and falls back to the raw id when nothing better exists (so it is always safe).
 */
import type { Asset, Project } from '@framepilot/timeline-schema';
import { indexFor } from './project-index.js';

/** Resolves editor ids → friendly labels. Every method is total (falls back to the id). */
export interface ProjectNames {
  /** A clip's label — its source asset's file name, else the clip id. */
  clip(id: string): string;
  /** A track's label — a type-indexed name like "Video 1", else the track id. */
  track(id: string): string;
  /** An asset's label — its file name (basename of the path), else the asset id. */
  asset(id: string): string;
}

/** Basename of a media path (mirrors web-editor's `assetDisplayName`). */
function baseName(asset: Asset | undefined, fallback: string): string {
  if (!asset) return fallback;
  // split() always yields ≥1 element, so pop() is a string; the ?? '' is defensive.
  /* v8 ignore next */
  const base = asset.path.split(/[/\\]/).pop() ?? '';
  return base.length > 0 ? base : fallback;
}

/** Title-case a track type for a friendly prefix ("video" → "Video"). */
function typeLabel(type: string): string {
  return type.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Build a name resolver for `project`. Precomputes id→name maps once so repeated
 * lookups during a streaming run are O(1) and allocation-free.
 *
 * @param project - The project whose ids are being described.
 * @returns A {@link ProjectNames} whose methods always return a non-empty label.
 */
/** Resolver cache per project snapshot — an agent run calls projectNames every
 *  step and every event description; the project is immutable between edits, so
 *  the resolver (like the {@link indexFor} it reads) is built at most once. */
const namesCache = new WeakMap<Project, ProjectNames>();

export function projectNames(project: Project): ProjectNames {
  const cached = namesCache.get(project);
  if (cached) return cached;
  // Entity lookup comes from the shared project index (built once per snapshot).
  const { assetById } = indexFor(project);

  // Clip → its source asset's file name.
  const clipName = new Map<string, string>();
  // Track → a "Type N" label, numbered per type in track order (Video 1, Video 2…).
  const trackName = new Map<string, string>();
  const perTypeCount = new Map<string, number>();
  for (const track of project.timeline.tracks) {
    const next = (perTypeCount.get(track.type) ?? 0) + 1;
    perTypeCount.set(track.type, next);
    trackName.set(track.id, `${typeLabel(track.type)} ${next}`);
    for (const clip of track.clips) {
      clipName.set(clip.id, baseName(assetById.get(clip.assetId), clip.id));
    }
  }

  const names: ProjectNames = {
    clip: (id) => clipName.get(id) ?? id,
    track: (id) => trackName.get(id) ?? id,
    asset: (id) => baseName(assetById.get(id), id),
  };
  namesCache.set(project, names);
  return names;
}
