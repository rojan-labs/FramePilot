import type { Patch } from '@framepilot/editor-core';
import {
  PROJECT_PATCH_TRANSPORT_KIND,
  type FramePilotBridge,
  type ProjectSnapshotBridge,
} from '@framepilot/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoProject } from './demo.js';
import { createProjectAwareBridge, resetProjectBridgeCacheForTests } from './bridge.js';

const patch: Patch = {
  patchId: 'patch_recovery' as Patch['patchId'],
  createdBy: 'user',
  reason: 'recovery test',
  operations: [],
};

describe('compact project recovery', () => {
  afterEach(() => resetProjectBridgeCacheForTests());

  it('uses the side-effect-free project snapshot instead of reopening the project', async () => {
    const recoveredProject = { ...demoProject, name: 'Recovered authoritative project' };
    const openProject = vi.fn(async () => ({
      ok: true as const,
      path: '/project.fp.json',
      project: demoProject,
      revision: 1,
    }));
    const projectSnapshot = vi.fn(async () => ({
      ok: true as const,
      path: '/project.fp.json',
      project: recoveredProject,
    }));
    const commitProjectPatch = vi.fn(async () => ({
      ok: true as const,
      project: {
        kind: PROJECT_PATCH_TRANSPORT_KIND,
        id: demoProject.id,
        baseRevision: 99,
        revision: 2,
        patch,
        history: [],
      },
      revision: 2,
      rebased: false,
    }));
    const raw = Object.freeze({
      openProject,
      projectSnapshot,
      commitProjectPatch,
    }) as unknown as FramePilotBridge & ProjectSnapshotBridge;
    const bridge = createProjectAwareBridge(raw);

    await bridge.openProject('/project.fp.json');
    const result = await bridge.commitProjectPatch!({
      projectId: demoProject.id,
      expectedRevision: 1,
      patch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project).toMatchObject({ name: recoveredProject.name });
    expect(projectSnapshot).toHaveBeenCalledWith(demoProject.id);
    expect(openProject).toHaveBeenCalledTimes(1);
  });
});
