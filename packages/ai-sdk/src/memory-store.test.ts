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
    expect(memory).toEqual({
      exportPlatforms: [],
      acceptedEdits: [],
      rejectedEdits: [],
      provenance: {},
    });
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

describe('memory provenance and TTL (UC-09)', () => {
  it('a contradicting instruction supersedes the earlier one rather than merging', () => {
    // Turn 2 states a caption style; turn 3 contradicts it. Turn 5 must read turn 3's,
    // and must not see turn 2's at all — a superseded decision is dropped, not offered
    // alongside its replacement for the model to pick between.
    let project = setPreference(makeProject(), 'captionStyle', 'bold yellow keywords', {
      source: 'user',
      turn: 2,
    });
    project = setPreference(project, 'captionStyle', 'small white subtitles', {
      source: 'user',
      turn: 3,
    });

    const atTurnFive = readMemory(project, 5);
    expect(atTurnFive.captionStyle).toBe('small white subtitles');
    expect(atTurnFive.provenance['captionStyle']).toEqual({ source: 'user', turn: 3 });
    expect(summarizeMemory(atTurnFive)).not.toContain('bold yellow');
  });

  it('a preference with no contradiction survives to a later turn', () => {
    const project = setPreference(makeProject(), 'captionStyle', 'bold yellow keywords', {
      source: 'user',
      turn: 2,
    });
    expect(readMemory(project, 5).captionStyle).toBe('bold yellow keywords');
  });

  it('an expiring preference is filtered out once its TTL has passed', () => {
    const project = setPreference(makeProject(), 'preferredPacing', 'fast', {
      source: 'inferred',
      turn: 2,
      expiresAfterTurns: 2,
    });

    expect(readMemory(project, 4).preferredPacing).toBe('fast');
    expect(readMemory(project, 5).preferredPacing).toBeUndefined();
    // Expiry is a read-side filter, so the file still holds it — reading without a
    // turn (a fresh session with no conversation clock) shows it again.
    expect(readMemory(project).preferredPacing).toBe('fast');
  });

  it('drops the expired entry\u2019s provenance with it', () => {
    const project = setPreference(makeProject(), 'brandStyle', 'muted', {
      source: 'reference',
      turn: 1,
      expiresAfterTurns: 1,
    });
    expect(readMemory(project, 9).provenance['brandStyle']).toBeUndefined();
  });

  it('a preference written before provenance existed never expires', () => {
    // The shape every project file on disk already has: values, no provenance.
    const project = makeProject({ aiMemory: { captionStyle: 'bold yellow keywords' } });
    expect(readMemory(project, 9_999).captionStyle).toBe('bold yellow keywords');
  });

  it('names a non-user source in the prompt block, and stays silent about the user', () => {
    let project = setPreference(makeProject(), 'captionStyle', 'bold yellow', {
      source: 'user',
      turn: 1,
    });
    project = setPreference(project, 'brandStyle', 'muted teal', {
      source: 'reference',
      turn: 1,
    });

    const block = summarizeMemory(readMemory(project, 1));
    expect(block).toContain('Caption style: bold yellow');
    expect(block).not.toContain('(user)');
    expect(block).toContain('Brand style: muted teal (reference)');
  });

  it('rewriting a preference without provenance clears the stale attribution', () => {
    // Otherwise the block would credit a reference for a value the reference never set.
    let project = setPreference(makeProject(), 'brandStyle', 'muted teal', {
      source: 'reference',
      turn: 1,
    });
    project = setPreference(project, 'brandStyle', 'high contrast');
    expect(readMemory(project).provenance['brandStyle']).toBeUndefined();
  });
});
