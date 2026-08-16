/**
 * Tests for style presets (Phase 7): presets are deterministic data, and applying
 * one seeds the project's memory preferences + export platform without a schema change.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_PRESETS, applyStylePreset, getStylePreset } from './style-presets.js';
import { readMemory } from './memory-store.js';
import { makeProject } from './__fixtures__/project.js';

describe('style presets', () => {
  it('every preset is well-formed with a unique id', () => {
    expect(STYLE_PRESETS.length).toBeGreaterThan(0);
    const ids = STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of STYLE_PRESETS) {
      expect(preset.name).not.toBe('');
      expect(preset.goal).not.toBe('');
      expect(Object.keys(preset.preferences).length).toBeGreaterThan(0);
    }
  });

  it('getStylePreset looks up by id and returns undefined for unknown ids', () => {
    expect(getStylePreset('clean_saas_demo')?.name).toBe('Clean SaaS demo');
    expect(getStylePreset('nope')).toBeUndefined();
  });

  it('applyStylePreset seeds memory preferences and export platform', () => {
    const project = applyStylePreset(makeProject(), 'high_energy_reel');
    const memory = readMemory(project);
    expect(memory.brandStyle).toMatch(/high-energy/i);
    expect(memory.captionStyle).toMatch(/bold/i);
    expect(memory.preferredPacing).toMatch(/fast/i);
    expect(memory.exportPlatforms).toEqual(['reels']);
  });

  it('returns the project unchanged for an unknown preset id', () => {
    const project = makeProject();
    expect(applyStylePreset(project, 'nope')).toBe(project);
  });
});
