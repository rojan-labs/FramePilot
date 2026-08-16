/**
 * Project orientation / canvas presets (Phase 15 H5).
 *
 * The canvas is PROJECT CONFIGURATION — `project.resolution` — not an export-time
 * choice: the preview letterbox, overlay positioning, composition grid, and the
 * engine's render all derive from it, so changing the preset here propagates
 * everywhere by construction. Pure data + matchers; the UI writes the new
 * resolution through the shell's normal project-change path (autosaved like any
 * other project metadata; media is never touched).
 */
import type { Project } from '@framepilot/timeline-schema';

/** A project resolution ({@link Project.resolution}'s shape). */
export type Resolution = Project['resolution'];

export interface OrientationPreset {
  /** Stable id used by the Select. */
  readonly id: string;
  /** e.g. "16:9". */
  readonly label: string;
  /** Human hint, e.g. "Landscape · YouTube". */
  readonly hint: string;
  readonly resolution: Resolution;
}

/** The canvas presets offered by the orientation selector, in display order. */
export const ORIENTATION_PRESETS: readonly OrientationPreset[] = [
  {
    id: '16:9',
    label: '16:9',
    hint: 'Landscape · YouTube',
    resolution: { width: 1920, height: 1080 },
  },
  {
    id: '9:16',
    label: '9:16',
    hint: 'Portrait · Reels / TikTok / Shorts',
    resolution: { width: 1080, height: 1920 },
  },
  { id: '1:1', label: '1:1', hint: 'Square · Feed', resolution: { width: 1080, height: 1080 } },
  {
    id: '4:5',
    label: '4:5',
    hint: 'Portrait · Instagram feed',
    resolution: { width: 1080, height: 1350 },
  },
  { id: '21:9', label: '21:9', hint: 'Cinematic wide', resolution: { width: 2560, height: 1080 } },
];

/** The preset id for custom (non-preset) dimensions. */
export const CUSTOM_ORIENTATION_ID = 'custom';

/**
 * Match a resolution to a preset by ASPECT (not exact pixels), so a 4K 16:9
 * project still reads "16:9"; returns {@link CUSTOM_ORIENTATION_ID} otherwise.
 */
export function orientationIdFor(resolution: Resolution): string {
  if (resolution.width <= 0 || resolution.height <= 0) return CUSTOM_ORIENTATION_ID;
  const aspect = resolution.width / resolution.height;
  const match = ORIENTATION_PRESETS.find(
    (preset) => Math.abs(preset.resolution.width / preset.resolution.height - aspect) < 1e-6,
  );
  return match?.id ?? CUSTOM_ORIENTATION_ID;
}

/**
 * The project with its canvas set to `preset`'s resolution (no-op for an unknown
 * id or when the resolution is already identical — callers can dispatch blindly).
 */
export function withOrientation(project: Project, presetId: string): Project {
  const preset = ORIENTATION_PRESETS.find((p) => p.id === presetId);
  if (!preset) return project;
  const { width, height } = preset.resolution;
  if (project.resolution.width === width && project.resolution.height === height) return project;
  return { ...project, resolution: { width, height } };
}
