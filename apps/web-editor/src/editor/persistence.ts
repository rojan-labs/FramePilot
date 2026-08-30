/**
 * Project persistence + autosave policy (plan/PLAN.md Phase 8).
 *
 * The live editor keeps its applied history in its native compact representation. Restart
 * history is collapsed and byte/entry-bounded only here, at a real persistence boundary,
 * so an interactive edit does not pay restart-serialization work merely to lift state into
 * App. The in-memory Project remains untouched.
 */
import {
  SCHEMA_VERSION,
  migrateToCurrent,
  safeParseProject,
  serializeProject,
  type Project,
  type RawProject,
} from '@framepilot/timeline-schema';
import {
  DEFAULT_DURABLE_HISTORY_LIMITS,
  toPersistedHistory,
  type HistoryEntry,
} from '@framepilot/editor-core';
import { type RendererBridge, getBridge } from './bridge.js';

export const BROWSER_PATH_PREFIX = 'local://';
const STORAGE_PREFIX = 'framepilot:project:';
const LAST_ID_KEY = 'framepilot:last-project-id';
const META_PREFIX = 'framepilot:project-meta:';
export const AUTOSAVE_DEBOUNCE_MS = 2000;
export const DURABLE_HISTORY_LIMITS = DEFAULT_DURABLE_HISTORY_LIMITS;

export type SaveOutcome =
  | { ok: true; path: string; desktop: boolean; revision?: number }
  | { ok: false; error: string };

export interface PersistOptions {
  bridge?: RendererBridge | null;
  storage?: Storage | null;
  expectedRevision?: number;
}

const isBrowserPath = (path: string): boolean =>
  path === '' || path.startsWith(BROWSER_PATH_PREFIX);

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Produce the restart-safe document once per save. `project.history` is editor-owned
 * internal data after schema validation, so the cast recovers the editor-core shape at
 * this package boundary just as Editor does when restoring it.
 */
export function projectForPersistence(project: Project): Project {
  const entries = (
    Array.isArray(project.history) ? project.history : []
  ) as readonly HistoryEntry[];
  const history = toPersistedHistory(
    { entries, cursor: entries.length },
    DURABLE_HISTORY_LIMITS,
  ) as Project['history'];
  if (history === project.history) return project;
  return { ...project, history };
}

/**
 * Persist a project. Desktop writes a real project file; browser mode writes localStorage.
 * The durable-history projection is created here exactly once for this save attempt.
 */
export async function persistProject(
  path: string,
  project: Project,
  options: PersistOptions = {},
): Promise<SaveOutcome> {
  const bridge = options.bridge !== undefined ? options.bridge : getBridge();
  const durableProject = projectForPersistence(project);

  if (bridge) {
    const result = isBrowserPath(path)
      ? await bridge.saveProjectDefault(durableProject, options.expectedRevision)
      : await bridge.saveProject(path, durableProject, options.expectedRevision);
    return result.ok
      ? {
          ok: true,
          path: result.path,
          desktop: true,
          ...(result.revision === undefined ? {} : { revision: result.revision }),
        }
      : { ok: false, error: result.error };
  }

  const storage = options.storage !== undefined ? options.storage : safeLocalStorage();
  if (!storage) return { ok: false, error: 'No storage available to save the project.' };
  try {
    // `serializeProject`, not a bare `JSON.stringify`: it stamps the `schemaVersion`
    // envelope. Without it a stored browser project can never be MIGRATED — the reader has
    // no version to migrate from — so the next transforming migration would silently drop
    // the field it was meant to move, or refuse to open the project at all. This was the
    // one persistence path in the repo writing project state with no envelope.
    storage.setItem(STORAGE_PREFIX + durableProject.id, serializeProject(durableProject));
    storage.setItem(LAST_ID_KEY, durableProject.id);
    writeBrowserProjectMeta(durableProject.id, durableProject.name, storage);
    return { ok: true, path: `${BROWSER_PATH_PREFIX}${durableProject.id}`, desktop: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface BrowserProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly openedAt: number;
}

export function writeBrowserProjectMeta(
  id: string,
  name: string,
  storage: Storage | null = safeLocalStorage(),
  now: number = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.setItem(META_PREFIX + id, JSON.stringify({ name, openedAt: now }));
  } catch {
    /* metadata is best-effort — the project blob is the source of truth */
  }
}

export function listBrowserProjectSummaries(
  storage: Storage | null = safeLocalStorage(),
): BrowserProjectSummary[] {
  if (!storage) return [];
  const summaries: BrowserProjectSummary[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const id = key.slice(STORAGE_PREFIX.length);
    const rawMeta = storage.getItem(META_PREFIX + id);
    if (rawMeta) {
      try {
        const meta = JSON.parse(rawMeta) as { name?: unknown; openedAt?: unknown };
        if (typeof meta.name === 'string') {
          summaries.push({
            id,
            name: meta.name,
            openedAt: typeof meta.openedAt === 'number' ? meta.openedAt : 0,
          });
          continue;
        }
      } catch {
        /* corrupt meta — fall through to the full parse below */
      }
    }
    const project = loadBrowserProject(id, storage);
    if (project) summaries.push({ id, name: project.name, openedAt: 0 });
  }
  return summaries.sort((a, b) => b.openedAt - a.openedAt || a.name.localeCompare(b.name));
}

/**
 * Read a stored browser project THROUGH the migration chain.
 *
 * The reader used to hand the raw parse straight to `safeParseProject`, so a stored project
 * was validated against the current schema and never migrated — the same gap the writer had.
 *
 * A blob with NO envelope is read as CURRENT rather than as v1. The only thing that ever
 * wrote an unversioned browser blob is the previous version of the writer above, and it
 * always wrote whatever shape was current at the time; running the full v1→v21 chain over
 * one would put two transforming steps (v9→v10 caption presets, v11→v12 transcript
 * attribution) over data they were never meant to see. Treating it as current is exactly
 * what this reader already assumed, so no stored project changes meaning — while everything
 * written from now on carries a version and migrates properly.
 *
 * @returns The migrated, validated project, or `null` if it is unreadable at any step.
 */
export function loadBrowserProject(
  id: string,
  storage: Storage | null = safeLocalStorage(),
): Project | null {
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_PREFIX + id);
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const stored = data as RawProject;
  const document =
    stored.schemaVersion === undefined ? { ...stored, schemaVersion: SCHEMA_VERSION } : stored;
  let migrated: RawProject;
  try {
    ({ raw: migrated } = migrateToCurrent(document));
  } catch {
    // Newer than this build, or a missing migration step. Both are "cannot open", which is
    // the honest answer — far better than validating a shape we do not understand.
    return null;
  }
  const parsed = safeParseProject(migrated);
  return parsed.success ? parsed.data : null;
}

export function loadLastBrowserProject(
  storage: Storage | null = safeLocalStorage(),
): Project | null {
  if (!storage) return null;
  const id = storage.getItem(LAST_ID_KEY);
  return id ? loadBrowserProject(id, storage) : null;
}

export function listBrowserProjects(
  storage: Storage | null = safeLocalStorage(),
): Array<{ id: string; project: Project }> {
  if (!storage) return [];
  const results: Array<{ id: string; project: Project }> = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) {
      const id = key.slice(STORAGE_PREFIX.length);
      const project = loadBrowserProject(id, storage);
      if (project) results.push({ id, project });
    }
  }
  return results.sort((a, b) => a.project.name.localeCompare(b.project.name));
}
