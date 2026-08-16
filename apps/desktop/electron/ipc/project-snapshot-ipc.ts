import { readFile } from 'node:fs/promises';
import { app } from 'electron';
import { activePointerPath } from '@framepilot/shared-types/projects-root';
import { readProjectFile } from '@framepilot/timeline-schema/file';
import type { ProjectOpenResult } from './contract.js';
import { ActiveProjectStore } from '../projects/active-project.js';
import { resolveProjectsDir } from '../projects/projects-dir.js';
import { readProjectSnapshot } from '../projects/project-snapshot.js';

/** Lazy implementation behind the lightweight deferred IPC registry. */
export async function handleProjectSnapshot(projectId: unknown): Promise<ProjectOpenResult> {
  const projectsRoot = resolveProjectsDir(process.env, app.getPath('documents'));
  const pointerPath = activePointerPath(projectsRoot);
  const store = new ActiveProjectStore({
    read: async () => {
      try {
        return await readFile(pointerPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: async () => {
      throw new Error('Project snapshot IPC is read-only.');
    },
    clear: async () => {
      throw new Error('Project snapshot IPC is read-only.');
    },
  });
  return readProjectSnapshot(projectId, store, readProjectFile);
}
