import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { Patch } from '@framepilot/editor-core';
import { isProjectPatchTransport } from '@framepilot/shared-types';
import { ProjectCommandService } from './project-command-service.js';

const project = (): Project =>
  parseProject({
    id: 'project_1',
    name: 'Transport test',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: 'media/clip.mp4',
        kind: 'video',
        durationSeconds: 10,
        media: { peaks: Array.from({ length: 50_000 }, () => 0.5) },
      },
    ],
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
  });

const patch: Patch = {
  patchId: 'p1' as Patch['patchId'],
  createdBy: 'agent',
  reason: 'marker',
  operations: [{ type: 'add_marker', id: 'm1', time: 1 }],
};

describe('ProjectCommandService renderer transport', () => {
  it('returns a compact patch envelope for the normal same-revision commit', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project();
    const revision = service.observe(initial).revision;
    const result = await service.commitPatch(initial.id, revision, patch, async () => {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rebased).toBe(false);
    expect(isProjectPatchTransport(result.project)).toBe(true);
    if (!isProjectPatchTransport(result.project)) return;
    expect(result.project.baseRevision).toBe(revision);
    expect(result.project.revision).toBe(result.revision);
    expect(result.project.patch).toBe(patch);
    // The 50k waveform peaks stay host-owned and do not ride the commit response.
    expect(JSON.stringify(result.project)).not.toContain('0.5,0.5,0.5');
  });

  it('keeps full-snapshot fallback when a stale but disjoint patch was rebased', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project();
    const revision = service.observe(initial).revision;
    await service.write({ ...initial, name: 'Persisted elsewhere' }, revision, async () => {});
    const result = await service.commitPatch(initial.id, revision, patch, async () => {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rebased).toBe(true);
    expect(isProjectPatchTransport(result.project)).toBe(false);
    expect((result.project as Project).assets[0]?.media?.peaks).toHaveLength(50_000);
  });

  it('returns the full authoritative snapshot for an idempotent patch replay', async () => {
    const service = new ProjectCommandService(JSON.stringify);
    const initial = project();
    const revision = service.observe(initial).revision;
    const first = await service.commitPatch(initial.id, revision, patch, async () => undefined, 'run_1');
    expect(first.ok).toBe(true);
    const replay = await service.commitPatch(initial.id, revision, patch, async () => undefined, 'run_1');
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (!replay.ok) return;
    expect(isProjectPatchTransport(replay.project)).toBe(false);
    expect((replay.project as Project).history).toHaveLength(1);
  });
});
