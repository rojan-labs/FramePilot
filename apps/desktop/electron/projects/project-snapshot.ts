import type { Project } from '@framepilot/timeline-schema';
import type { ActiveProjectStore } from './active-project.js';

export type ProjectSnapshotResult =
  | { readonly ok: true; readonly path: string; readonly project: Project }
  | { readonly ok: false; readonly error: string };

/** Read the currently-authoritative project without invoking project-open workflows. */
export async function readProjectSnapshot(
  projectId: unknown,
  activeProject: Pick<ActiveProjectStore, 'current'>,
  readProject: (path: string) => Promise<Project>,
): Promise<ProjectSnapshotResult> {
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    return { ok: false, error: 'A project id is required for snapshot recovery.' };
  }
  const active = await activeProject.current();
  if (!active || active.projectId !== projectId) {
    return { ok: false, error: 'The requested project is not currently active.' };
  }
  try {
    const project = await readProject(active.path);
    if (project.id !== projectId) {
      return { ok: false, error: 'The active project does not match the project file.' };
    }
    return { ok: true, path: active.path, project };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
