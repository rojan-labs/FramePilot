/**
 * Publishes which project the GUI currently has open, so the standalone MCP
 * server can target the same file an external AI agent edits.
 *
 * WHY this lives in the projects folder (not the app's `userData` like recents /
 * recovery): the MCP server is a separate process that knows nothing about
 * Electron's `userData` path, but it *does* compute the same projects root. The
 * pointer is therefore written to `<projectsRoot>/.framepilot-active.json`
 * ({@link activePointerPath}) — the one location both processes agree on.
 *
 * All IO is injected ({@link ActiveProjectIO}) so the record/clear logic is
 * unit-testable without `electron`/`fs`.
 */
import { type ActiveProjectPointer, isActivePointer } from '@framepilot/shared-types/projects-root';

/** Persistence for the single active-project pointer file. */
export interface ActiveProjectIO {
  /** File contents, or `null` if no pointer exists. */
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
  /** Remove the pointer file (idempotent — a missing file is not an error). */
  clear(): Promise<void>;
}

/** Reads/writes the active-project pointer the MCP server consumes. */
export class ActiveProjectStore {
  constructor(private readonly io: ActiveProjectIO) {}

  /** Record `pointer` as the project the GUI currently has open. */
  async record(pointer: ActiveProjectPointer): Promise<void> {
    await this.io.write(JSON.stringify(pointer));
  }

  /**
   * The currently-recorded pointer, if any.
   *
   * @returns The pointer, or `null` when there is none or the file is corrupt —
   *   a damaged pointer must never be treated as a valid target.
   */
  async current(): Promise<ActiveProjectPointer | null> {
    const raw = await this.io.read();
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return isActivePointer(parsed) ? parsed : null;
  }

  /** Discard the pointer (e.g. when no project is open). */
  async clear(): Promise<void> {
    await this.io.clear();
  }
}
