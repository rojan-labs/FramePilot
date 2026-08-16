/**
 * @framepilot/ai-sdk/style-presets — named editing styles (PRD MVP 4, Phase 7).
 *
 * A style preset is a reusable bundle of intent: a target platform, a set of
 * project-memory preferences (brand/caption/pacing), and a goal sentence the
 * agent can run. Picking "Clean SaaS demo" should make the agent behave the same
 * way every time — so presets are plain, deterministic data, applied to a project
 * by writing the existing {@link ProjectMemory} (no schema change, no migration).
 */
import type { Project } from '@framepilot/timeline-schema';
import type { TargetPlatform } from './context-builder.js';
import { type MemoryPreferenceKey, setExportPlatforms, setPreference } from './memory-store.js';

/** The free-text preferences a preset seeds into project memory. */
export type PresetPreferences = Partial<Record<MemoryPreferenceKey, string>>;

/** A named editing style the agent can adopt. */
export interface StylePreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Target platform this style is tuned for. */
  readonly targetPlatform: TargetPlatform;
  /** Preferences written into project memory when the preset is applied. */
  readonly preferences: PresetPreferences;
  /** A goal sentence pre-filled into the agent prompt. */
  readonly goal: string;
}

/** Built-in style presets (PRD §8.7 examples: clean SaaS demo, no aggressive zooms). */
export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: 'clean_saas_demo',
    name: 'Clean SaaS demo',
    description:
      'Calm, professional product walkthrough with restrained motion and clear captions.',
    targetPlatform: 'linkedin',
    preferences: {
      brandStyle: 'Clean, professional SaaS demo. Minimal, restrained motion; no aggressive zooms.',
      captionStyle: 'Clear sans-serif captions, sentence case, no heavy effects.',
      preferredPacing: 'Steady and deliberate; let key moments breathe.',
    },
    goal: 'Make this a clean, professional SaaS product demo with clear captions and steady pacing.',
  },
  {
    id: 'high_energy_reel',
    name: 'High-energy Reel',
    description: 'Punchy vertical short with tight cuts, bold captions, and dynamic zooms.',
    targetPlatform: 'reels',
    preferences: {
      brandStyle: 'High-energy, punchy short-form. Tight cuts and dynamic punch-ins.',
      captionStyle: 'Bold captions with keyword highlights.',
      preferredPacing: 'Fast; remove dead air and keep momentum.',
    },
    goal: 'Turn this into a high-energy 45-second vertical Reel: cut dead air, add bold captions, and punch in on key moments.',
  },
  {
    id: 'talking_head_explainer',
    name: 'Talking-head explainer',
    description: 'Clear spoken explainer with readable captions and gentle emphasis.',
    targetPlatform: 'shorts',
    preferences: {
      brandStyle: 'Talking-head explainer; keep the speaker centered and legible.',
      captionStyle: 'High-contrast captions kept inside the safe area.',
      preferredPacing: 'Conversational; trim long silences but keep natural rhythm.',
    },
    goal: 'Make this a clear talking-head explainer: trim long silences, add readable captions, and keep a conversational pace.',
  },
];

/** Look up a style preset by id. */
export const getStylePreset = (id: string): StylePreset | undefined =>
  STYLE_PRESETS.find((preset) => preset.id === id);

/**
 * Apply a style preset to a project: seed its memory preferences and export
 * platform. Pure — returns a new {@link Project}; the caller persists it.
 *
 * @param project - The project to seed.
 * @param presetId - Id of a preset in {@link STYLE_PRESETS}.
 * @returns A new project with memory updated, or the project unchanged if the id is unknown.
 */
export function applyStylePreset(project: Project, presetId: string): Project {
  const preset = getStylePreset(presetId);
  if (!preset) return project;
  let next = project;
  for (const [key, value] of Object.entries(preset.preferences)) {
    next = setPreference(next, key as MemoryPreferenceKey, value);
  }
  return setExportPlatforms(next, [preset.targetPlatform]);
}
