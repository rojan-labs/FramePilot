/**
 * Tests for scope resolution (redesign §16.1, K5.1): project memory overrides user
 * memory field by field; a user default only fills a field the project leaves blank.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectMemory } from './memory-store.js';
import type { UserMemory } from './user-memory.js';
import { effectiveEditorialMemory, summarizeScopedMemory } from './scoped-memory.js';

const emptyProject: ProjectMemory = {
  exportPlatforms: [],
  acceptedEdits: [],
  rejectedEdits: [],
};

const user: UserMemory = {
  captionStyle: 'karaoke',
  brandStyle: 'user-bold',
  targetAudience: 'founders',
  preferredPacing: 'fast',
  favoriteExportPlatforms: ['reels', 'shorts'],
};

describe('scoped memory resolution', () => {
  it('returns project memory unchanged when there is no user scope', () => {
    const project = { ...emptyProject, captionStyle: 'bold' };
    expect(effectiveEditorialMemory(project)).toBe(project);
  });

  it('fills blank project fields from the user defaults', () => {
    const effective = effectiveEditorialMemory(emptyProject, user);
    expect(effective.captionStyle).toBe('karaoke');
    expect(effective.brandStyle).toBe('user-bold');
    expect(effective.targetAudience).toBe('founders');
    expect(effective.preferredPacing).toBe('fast');
    expect(effective.exportPlatforms).toEqual(['reels', 'shorts']);
  });

  it('project values win over user defaults, field by field', () => {
    const project: ProjectMemory = {
      ...emptyProject,
      captionStyle: 'project-minimal',
      exportPlatforms: ['x'],
    };
    const effective = effectiveEditorialMemory(project, user);
    expect(effective.captionStyle).toBe('project-minimal'); // project wins
    expect(effective.exportPlatforms).toEqual(['x']); // non-empty project list wins
    expect(effective.brandStyle).toBe('user-bold'); // blank project field filled
  });

  it('preserves the project-only learning signals (accepted/rejected edits)', () => {
    const project: ProjectMemory = {
      ...emptyProject,
      acceptedEdits: [{ patchId: 'p1', reason: 'good' }],
    };
    expect(effectiveEditorialMemory(project, user).acceptedEdits).toEqual([
      { patchId: 'p1', reason: 'good' },
    ]);
  });

  it('summarizes the layered scopes (project over user)', () => {
    const project: ProjectMemory = { ...emptyProject, captionStyle: 'project-minimal' };
    const summary = summarizeScopedMemory(project, user);
    expect(summary).toContain('Caption style: project-minimal');
    expect(summary).toContain('Brand style: user-bold');
    expect(summary).toContain('Export platforms: reels, shorts');
  });

  it('summarizes to empty when neither scope remembers anything', () => {
    expect(summarizeScopedMemory(emptyProject)).toBe('');
  });
});
