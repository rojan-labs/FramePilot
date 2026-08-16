/**
 * @framepilot/shared-types/projects-root — the canonical projects-folder location
 * and the "active project" pointer the desktop app and MCP server share.
 *
 * WHY this is shared (node-only) and not per-package: the Electron main process and
 * the standalone MCP host MUST agree on (a) *where* `.fp.json` files live by default
 * and (b) *which* project the user currently has open, or an external AI agent edits
 * a different file than the one in the GUI. Both facts used to live only on the
 * desktop side (`apps/desktop/.../projects-dir.ts`), leaving the MCP server to throw
 * when `FRAMEPILOT_PROJECTS_ROOT` was unset and with no way to learn the open
 * project. Hoisting them here gives both runtimes one implementation.
 *
 * Imported via the `@framepilot/shared-types/projects-root` subpath so browser
 * bundles (the renderer) never pull in `node:path`.
 */
import path from 'node:path';

/** Folder name created under the user's Documents dir when no root is configured. */
export const DEFAULT_PROJECTS_FOLDER = 'FramePilot Projects';

/**
 * Hidden pointer file, kept *inside* the projects root, naming the project the
 * desktop GUI currently has open. The projects root is the one location the app
 * and the MCP server both compute identically, and the dot-prefixed name keeps it
 * out of the `*.fp.json` project listing. The MCP server reads this so an agent
 * edits the GUI's open project without guessing a path.
 */
export const ACTIVE_POINTER_FILENAME = '.framepilot-active.json';

/**
 * Resolve the absolute default projects directory.
 *
 * Precedence: an explicit `FRAMEPILOT_PROJECTS_ROOT` (the same env var the Python
 * sidecar sandboxes to) wins; otherwise a `FramePilot Projects` folder under the OS
 * Documents directory. The path is always absolute so it can be sandboxed against.
 *
 * @param env - Process environment (injected for tests).
 * @param documentsDir - The OS Documents dir (e.g. Electron `app.getPath('documents')`
 *   in the app, or `os.homedir()/Documents` in the MCP server).
 */
export function resolveProjectsRoot(env: NodeJS.ProcessEnv, documentsDir: string): string {
  const configured = env.FRAMEPILOT_PROJECTS_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(documentsDir, DEFAULT_PROJECTS_FOLDER);
}

/** Absolute path of the active-project pointer for a given projects root. */
export function activePointerPath(projectsRoot: string): string {
  return path.join(projectsRoot, ACTIVE_POINTER_FILENAME);
}

/** Records the project the desktop GUI currently has open. */
export interface ActiveProjectPointer {
  /** Absolute path the project was last opened/saved to. */
  path: string;
  /** The project's id (informational; the MCP server keys off `path`). */
  projectId: string;
  /** Epoch milliseconds the pointer was written — caller-supplied (no ambient clock). */
  updatedAt: number;
}

/** Narrow unknown parsed JSON to a valid {@link ActiveProjectPointer}. */
export function isActivePointer(value: unknown): value is ActiveProjectPointer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const pointer = value as Record<string, unknown>;
  return (
    typeof pointer.path === 'string' &&
    typeof pointer.projectId === 'string' &&
    typeof pointer.updatedAt === 'number'
  );
}
