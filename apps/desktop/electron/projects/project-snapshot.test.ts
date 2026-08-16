import { parseProject, type Project } from '@framepilot/timeline-schema';
import { describe, expect, it, vi } from 'vitest';
import { readProjectSnapshot } from './project-snapshot.js';

const project = (): Project =>
  parseProject({
    id: 'project_1',
    name: 'Snapshot project',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [],
    timeline: { tracks: [] },
    transcript: [],
    aiMemory: {},
    history: [],
  });

describe('readProjectSnapshot', () => {
  it('reads only the active project path and returns the validated project', async () => {
    const expected = project();
    const current = vi.fn(async () => ({
      path: '/projects/demo/project.fp.json',
      projectId: expected.id,
      updatedAt: 1,
    }));
    const readProject = vi.fn(async () => expected);

    const result = await readProjectSnapshot(expected.id, { current }, readProject);

    expect(result).toEqual({
      ok: true,
      path: '/projects/demo/project.fp.json',
      project: expected,
    });
    expect(current).toHaveBeenCalledTimes(1);
    expect(readProject).toHaveBeenCalledWith('/projects/demo/project.fp.json');
  });

  it('refuses a different project without reading its file', async () => {
    const expected = project();
    const current = vi.fn(async () => ({
      path: '/projects/demo/project.fp.json',
      projectId: expected.id,
      updatedAt: 1,
    }));
    const readProject = vi.fn(async () => expected);

    const result = await readProjectSnapshot('other-project', { current }, readProject);

    expect(result.ok).toBe(false);
    expect(readProject).not.toHaveBeenCalled();
  });
});
