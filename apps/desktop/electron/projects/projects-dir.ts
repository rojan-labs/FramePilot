/**
 * Default projects-folder resolution and safe auto file-naming (plan/PLAN.md
 * Phase 8 — "Surface the folder" / autosave).
 *
 * WHY this is its own module: the Electron `main.ts` glue is intentionally not
 * unit-tested (it needs a runtime), but *where* a path-less project autosaves
 * and *what* it is named is real logic with security implications (a project
 * name is user-controlled and must never escape the projects folder via path
 * separators or `..`). Keeping it pure here lets it be tested to 100% offline.
 */
import path from 'node:path';
import {
  DEFAULT_PROJECTS_FOLDER,
  resolveProjectsRoot,
} from '@framepilot/shared-types/projects-root';

// Re-exported so existing importers keep working; the canonical definition now
// lives in shared-types so the MCP server resolves the same default folder.
export { DEFAULT_PROJECTS_FOLDER };

/**
 * Resolve the absolute default projects directory.
 *
 * Thin wrapper over the shared {@link resolveProjectsRoot} so the desktop app and
 * the MCP server agree on where `.fp.json` files live. Precedence: an explicit
 * `FRAMEPILOT_PROJECTS_ROOT` wins; otherwise a `FramePilot Projects` folder under
 * the OS Documents directory.
 *
 * @param env - Process environment (injected for tests).
 * @param documentsDir - The OS Documents dir (`app.getPath('documents')`).
 */
export function resolveProjectsDir(env: NodeJS.ProcessEnv, documentsDir: string): string {
  return resolveProjectsRoot(env, documentsDir);
}

/**
 * Derive a safe `*.fp.json` file name from a project id.
 *
 * The id is reduced to `[a-z0-9_-]` and stripped of any path separators, so the
 * result is a *bare* file name that cannot traverse out of the projects folder
 * (defense-in-depth even though ids are already slugged at construction time).
 */
export function projectFileName(projectId: string): string {
  const safe = projectId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return `${safe || 'untitled'}.fp.json`;
}

/**
 * Absolute autosave destination for a path-less project, guaranteed to stay
 * inside `projectsDir` (the file name is bare, so `join` cannot escape).
 */
export function defaultProjectPath(projectsDir: string, projectId: string): string {
  return path.join(projectsDir, projectFileName(projectId));
}
