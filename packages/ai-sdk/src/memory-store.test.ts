/**
 * Tests for the project memory store (PRD §8.7) over `Project.aiMemory`.
 */
import { describe, expect, it } from 'vitest';
import { asId } from '@framepilot/shared-types';
import type { Patch } from '@framepilot/editor-core';
import {
  readMemory,
  recordAccepted,
  recordRejected,
  setExportPlatforms,
  setPreference,
  summarizeMemory,
  writeMemory,
} from './memory-store.js';
import { makeProject } from './__fixtures__/project.js';

const patch = (id: string, reason: string): Patch => ({
  patchId: asId<'PatchId'>(id),
  createdBy: 'agent',
  reason,
  operations: [],
});

describe('memory store', () => {
  it('reads empty defaults from a fresh project', () => {
    const memory = readMemory(makeProject());
    expect(memory).toEqual({ exportPlatforms: [], acceptedEdits: [], rejectedEdits: [] });
  });

  it('falls back to defaults when aiMemory is garbage (untrusted file)', () => {
    const project = makeProject({ aiMemory: { acceptedEdits: 'not-an-array' } });
    expect(readMemory(project).acceptedEdits).toEqual([]);
  });

  it('round-trips preferences and platforms', () => {
    let project = setPreference(makeProject(), 'captionStyle', 'bold yellow keywords');
    project = setPreference(project, 'preferredPacing', 'fast');
    project = setExportPlatforms(project, ['reels', 'x']);
    const memory = readMemory(project);
    expect(memory.captionStyle).toBe('bold yellow keywords');
    expect(memory.preferredPacing).toBe('fast');
    expect(memory.exportPlatforms).toEqual(['reels', 'x']);
  });

  it('records accepted and rejected edits as learning signals', () => {
    let project = recordAccepted(makeProject(), patch('p1', 'tighten intro'));
    project = recordRejected(project, patch('p2', 'aggressive zoom'));
    const memory = readMemory(project);
    expect(memory.acceptedEdits).toEqual([{ patchId: 'p1', reason: 'tighten intro' }]);
    expect(memory.rejectedEdits).toEqual([{ patchId: 'p2', reason: 'aggressive zoom' }]);
  });

  it('writeMemory replaces the whole record', () => {
    const project = writeMemory(makeProject(), {
      targetAudience: 'founders',
      brandStyle: 'clean SaaS',
      exportPlatforms: [],
      acceptedEdits: [],
      rejectedEdits: [],
    });
    expect(readMemory(project).targetAudience).toBe('founders');
  });

  it('summarizeMemory renders only the populated fields', () => {
    expect(summarizeMemory(readMemory(makeProject()))).toBe('');
    let project = setPreference(makeProject(), 'targetAudience', 'founders');
    project = setPreference(project, 'brandStyle', 'clean SaaS');
    project = setPreference(project, 'captionStyle', 'bold yellow');
    project = setPreference(project, 'preferredPacing', 'fast');
    project = setExportPlatforms(project, ['reels']);
    project = recordAccepted(project, patch('p1', 'tighten intro'));
    project = recordRejected(project, patch('p2', 'aggressive zoom'));
    const summary = summarizeMemory(readMemory(project));
    expect(summary).toContain('Target audience: founders');
    expect(summary).toContain('Brand style: clean SaaS');
    expect(summary).toContain('Caption style: bold yellow');
    expect(summary).toContain('Preferred pacing: fast');
    expect(summary).toContain('Export platforms: reels');
    expect(summary).toContain('rejected edits (avoid repeating): aggressive zoom');
    expect(summary).toContain('accepted edits: tighten intro');
  });
});
