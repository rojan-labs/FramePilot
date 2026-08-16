/**
 * Recently-opened projects list (plan Phase 3.1 — "Project open/save/recent").
 *
 * Persists a small, most-recent-first list of {@link RecentProject} entries to a
 * JSON file in the app's user-data directory. All file IO is injected
 * ({@link RecentFilesIO}) so the dedupe/cap/ordering logic is unit-testable and
 * this module stays free of `electron`/`fs` imports.
 *
 * WHY defensive parsing: a corrupt or hand-edited recents file must never crash
 * the editor on launch — an unreadable list simply reads as empty and is
 * rewritten on the next `add`.
 */
import type { RecentProject } from '../ipc/contract.js';

/** Persistence for a single recents file. The path/atomic-write live in `main`. */
export interface RecentFilesIO {
  /** Return the file contents, or `null` if it does not exist yet. */
  read(): Promise<string | null>;
  /** Write the file contents (callers provide an atomic implementation). */
  write(contents: string): Promise<void>;
}

/** Maximum entries retained; older projects fall off the end. */
export const MAX_RECENT_PROJECTS = 10;

/** True when `value` has the shape of a {@link RecentProject}. */
function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.openedAt === 'number'
  );
}

/**
 * Reads and maintains the recent-projects list with dedupe-by-path,
 * most-recent-first ordering, and a fixed cap.
 */
export class RecentFilesStore {
  constructor(
    private readonly io: RecentFilesIO,
    private readonly max: number = MAX_RECENT_PROJECTS,
  ) {}

  /**
   * The current list, most-recent-first. A missing or corrupt file yields an
   * empty list rather than throwing.
   */
  async list(): Promise<RecentProject[]> {
    const raw = await this.io.read();
    if (raw === null) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isRecentProject).slice(0, this.max);
  }

  /**
   * Record a project as most-recently-opened.
   *
   * Any existing entry for the same path is removed first (so a re-open moves
   * the project to the front rather than duplicating it), then the list is
   * capped to {@link RecentFilesStore.max}.
   *
   * @param entry - The project to promote to the front. `openedAt` is supplied
   *   by the caller — this module keeps no ambient clock.
   * @returns The updated list, most-recent-first.
   */
  async add(entry: RecentProject): Promise<RecentProject[]> {
    const existing = await this.list();
    const deduped = existing.filter((item) => item.path !== entry.path);
    const next = [entry, ...deduped].slice(0, this.max);
    await this.io.write(JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Remove a project from the list (e.g. when its file no longer exists).
   *
   * @param path - Absolute path of the entry to drop.
   * @returns The updated list.
   */
  async remove(path: string): Promise<RecentProject[]> {
    const existing = await this.list();
    const next = existing.filter((item) => item.path !== path);
    await this.io.write(JSON.stringify(next, null, 2));
    return next;
  }
}
