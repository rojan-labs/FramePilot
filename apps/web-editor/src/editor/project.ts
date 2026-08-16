/**
 * Project creation + import helpers (plan/PLAN.md Phase 3.2 — "Project create /
 * import video").
 *
 * Creating a project produces a brand-new, schema-valid `project.fp.json` in
 * memory; importing a video produces the same with a single video asset and a
 * clip spanning it. This is *construction*, not an edit to an existing timeline,
 * so it does not go through the patch engine — but the result is validated
 * against the Zod schema before it is handed back (AGENTS.md invariant 3: no
 * un-validated project ever enters the editor).
 *
 * Ids are derived deterministically from the project/asset names (no clock, no
 * RNG) so creation is replayable and unit-testable.
 */
import {
  type Asset,
  type Project,
  type Resolution,
  type Track,
  parseProject,
} from '@framepilot/timeline-schema';

/** 1080p portrait is the short-form default; callers may override. */
export const DEFAULT_RESOLUTION: Resolution = { width: 1080, height: 1920 };
/** Default project frame rate. */
export const DEFAULT_FPS = 30;

/**
 * Named track definitions kept for reference and tests; no longer used to
 * pre-seed new projects (CapCut-style: projects start empty and tracks are
 * created on demand by `placeAssetPatch`).
 */
export const BASE_TRACKS: readonly { readonly id: string; readonly type: Track['type'] }[] = [
  { id: 'video_1', type: 'video' },
  { id: 'overlay_1', type: 'overlay' },
  { id: 'caption_1', type: 'caption' },
  { id: 'audio_1', type: 'audio' },
];

/** Options for {@link newProject}. */
export interface NewProjectOptions {
  readonly fps?: number;
  readonly resolution?: Resolution;
}

/** A video file being imported into a fresh project. */
export interface ImportedVideo {
  /** Absolute path to the source media. */
  readonly path: string;
  /** Source duration in seconds (from the engine's media probe). */
  readonly durationSeconds: number;
}

/** Lowercase slug safe for use inside a deterministic id. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'untitled';

/**
 * Build an empty, schema-valid project.
 *
 * @param name - Display name; also seeds the deterministic project id.
 * @throws ZodError if the constructed object somehow fails validation (a guard
 *   against future schema drift — the literal below is expected to be valid).
 */
export function newProject(name: string, options: NewProjectOptions = {}): Project {
  return parseProject({
    id: `project_${slug(name)}`,
    name,
    version: 1,
    fps: options.fps ?? DEFAULT_FPS,
    resolution: options.resolution ?? DEFAULT_RESOLUTION,
    assets: [],
    // Start empty — tracks are created on demand when assets are placed
    // (CapCut-style auto-layering via placeAssetPatch).
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/**
 * No-op kept for API compatibility with older project-open paths. Now that
 * projects start with zero tracks (CapCut-style), there is nothing to backfill;
 * `placeAssetPatch` creates tracks on demand. Returns the project unchanged.
 */
export function ensureBaseTracks(project: Project): Project {
  return project;
}

/**
 * Append an asset to a project's media bin, returning a new validated project.
 * Used by media import; the timeline is untouched (placing a clip is a separate,
 * undoable patch).
 */
export function addAsset(project: Project, asset: Asset): Project {
  return parseProject({ ...project, assets: [...project.assets, asset] });
}

/**
 * Build a project seeded with one imported video: a single video asset plus a
 * video track containing one clip that spans the whole source.
 */
export function newProjectFromVideo(
  name: string,
  video: ImportedVideo,
  options: NewProjectOptions = {},
): Project {
  const assetId = `asset_${slug(name)}`;
  const trackId = 'video_1';
  return parseProject({
    id: `project_${slug(name)}`,
    name,
    version: 1,
    fps: options.fps ?? DEFAULT_FPS,
    resolution: options.resolution ?? DEFAULT_RESOLUTION,
    assets: [
      { id: assetId, path: video.path, kind: 'video', durationSeconds: video.durationSeconds },
    ],
    timeline: {
      tracks: [
        {
          id: trackId,
          type: 'video' as const,
          clips: [
            {
              id: 'clip_1',
              assetId,
              trackId,
              start: 0,
              end: video.durationSeconds,
              sourceStart: 0,
              sourceEnd: video.durationSeconds,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/**
 * Remove an asset from a project's media bin, returning a new validated project.
 * The timeline is untouched here — clips referencing the asset are removed
 * separately as an undoable patch (see `removeAssetClipsPatch`) so deleting media
 * never leaves a dangling clip reference but stays reversible.
 */
export function removeAsset(project: Project, assetId: string): Project {
  return parseProject({
    ...project,
    assets: project.assets.filter((asset) => asset.id !== assetId),
  });
}

/** The asset ids referenced by a project (used to validate `add_clip` edits). */
export const assetIdsOf = (project: Project): readonly string[] =>
  project.assets.map((asset) => asset.id);
