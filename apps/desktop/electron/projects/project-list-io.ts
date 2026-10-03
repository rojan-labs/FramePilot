/**
 * Node file access behind the home screen's project list ({@link ProjectListIO}).
 *
 * Read-only and sandboxed: every path, a bare top-level name or a recents entry's absolute
 * path alike, goes through {@link sandboxProjectPath} (the shared `resolveWithin`, which
 * also follows symlinks) before anything is stat'ed or read, so a symlink or recents entry
 * that leads outside the projects root is skipped, never followed.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { createLogger } from '@framepilot/shared-types';
import { sandboxProjectPath } from '../ipc/sandbox.js';
import type { ProjectFileInfo, ProjectListIO } from './project-list.js';

const log = createLogger('desktop:project-list');

/** Errors that only mean "no such project file here". */
const ABSENT_FILE_CODES = new Set(['ENOENT', 'ENOTDIR']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * Resolve `candidate` inside `projectsRoot`, or `null` when it escapes. A root that is
 * missing makes the sandbox itself throw; that also reads as "not listable".
 */
function sandboxed(projectsRoot: string, candidate: string): string | null {
  try {
    const guard = sandboxProjectPath(projectsRoot, candidate);
    return guard.ok ? guard.path : null;
  } catch {
    return null;
  }
}

/**
 * File access for one projects root. Nothing here writes, and nothing creates the root:
 * a missing folder simply lists no projects.
 *
 * @param projectsRoot - The absolute projects folder (`resolveProjectsDir`).
 */
export function createProjectListIO(projectsRoot: string): ProjectListIO {
  return {
    readRootNames: () => readdir(projectsRoot),

    statProjectFile: async (candidate: string): Promise<ProjectFileInfo | null> => {
      const resolved = sandboxed(projectsRoot, candidate);
      if (resolved === null) return null;
      try {
        const info = await stat(resolved);
        if (!info.isFile()) return null;
        return { path: resolved, fileKey: `${info.dev}:${info.ino}`, modifiedAt: info.mtimeMs };
      } catch (error) {
        const code = errorCode(error);
        if (code === undefined || !ABSENT_FILE_CODES.has(code)) {
          log.debug('project file skipped: stat failed', { path: resolved, code });
        }
        return null;
      }
    },

    readHead: async (filePath: string, maxBytes: number): Promise<string> => {
      const resolved = sandboxed(projectsRoot, filePath);
      if (resolved === null) {
        throw new Error(`Refusing to read outside the projects folder: ${filePath}`);
      }
      const handle = await open(resolved, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
