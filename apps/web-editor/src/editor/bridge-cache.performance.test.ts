import type { FramePilotBridge, ProjectOpenResult } from '@framepilot/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoProject } from './demo.js';
import {
  PROJECT_CACHE_LIMIT,
  createProjectAwareBridge,
  projectBridgeCacheSizeForTests,
  resetProjectBridgeCacheForTests,
} from './bridge.js';

const projectFor = (id: string) => ({ ...demoProject, id, name: id });

describe('authoritative project cache lifetime', () => {
  afterEach(() => resetProjectBridgeCacheForTests());

  it('retains a bounded working set regardless of projects opened in one session', async () => {
    const openProject = vi.fn(async (path: string): Promise<ProjectOpenResult> => ({
      ok: true,
      path,
      project: projectFor(path),
      revision: 1,
    }));
    const raw = Object.freeze({ openProject }) as unknown as FramePilotBridge;
    const bridge = createProjectAwareBridge(raw);

    for (let index = 0; index < 50; index += 1) {
      await bridge.openProject(`project_${index}`);
      expect(projectBridgeCacheSizeForTests()).toBeLessThanOrEqual(PROJECT_CACHE_LIMIT);
    }

    expect(projectBridgeCacheSizeForTests()).toBe(PROJECT_CACHE_LIMIT);
  });
});
