/**
 * Crash-recovery snapshot store for the last validated project (plan Phase 3.1).
 *
 * **Read this before relying on it: nothing restores from this snapshot.** The promise the
 * original docstring made — "on the next launch `pending()` returns it and the renderer can
 * offer to restore" — is not implemented. {@link RecoveryStore.pending} has no caller
 * outside this module's own tests, and there is no IPC channel that could carry a pending
 * snapshot to the renderer. The main process only ever *writes* snapshots and clears them
 * on a clean quit.
 *
 * The payload is also byte-redundant. At all four `main.ts` call sites the snapshot is
 * written AFTER `writeProjectFile`, from the same `project` object, inside the same commit
 * callback — so it duplicates a document that has just been atomically written and fsynced
 * beside it. It therefore costs a second full `JSON.stringify` plus a whole-document write
 * on every autosave and every AI patch commit, and buys nothing the project file on disk
 * does not already provide.
 *
 * Two honest ways out, and choosing between them is a **maintainer decision, not a
 * refactor**: delete the writes (accepting that "last validated state" is exactly what
 * `project.fp.json` already holds), or wire the restore path — a startup `pending()` read,
 * an IPC channel, and a renderer prompt — and keep paying for it. Until that is decided,
 * this store validates what it stores so that a snapshot which IS eventually read is a
 * real project rather than an arbitrary JSON blob.
 *
 * All IO is injected ({@link RecoveryIO}) so the snapshot/clear/restore logic is
 * unit-testable without `electron`/`fs`.
 */
import { parseProject, type Project } from '@framepilot/timeline-schema';

/** A validated project snapshot kept for crash recovery. */
export interface RecoverySnapshot {
  /** Absolute path the project was last saved to. */
  path: string;
  /**
   * The validated project document. Typed as a real {@link Project}, not `unknown`: a
   * recovery snapshot exists to be restored, and a payload that cannot be proven to be a
   * project could only ever be restored by guessing.
   */
  project: Project;
  /** Epoch milliseconds of the snapshot — caller-supplied (no ambient clock). */
  savedAt: number;
}

/** Persistence for the single recovery snapshot file. */
export interface RecoveryIO {
  /** File contents, or `null` if no snapshot exists. */
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
  /** Remove the snapshot file (idempotent — a missing file is not an error). */
  clear(): Promise<void>;
}

/**
 * Narrow a parsed snapshot file, validating the project through the schema.
 *
 * The previous check only asserted `'project' in snapshot`, so any JSON value at all —
 * `null`, a number, a half-written document — satisfied it. A restore path fed that would
 * hand the editor something it cannot open, which is the one failure a crash-recovery
 * store must not have.
 */
function toRecoverySnapshot(value: unknown): RecoverySnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.path !== 'string' || typeof snapshot.savedAt !== 'number') return null;
  let project: Project;
  try {
    project = parseProject(snapshot.project);
  } catch {
    return null;
  }
  return { path: snapshot.path, project, savedAt: snapshot.savedAt };
}

/** Reads/writes the crash-recovery snapshot. */
export class RecoveryStore {
  constructor(private readonly io: RecoveryIO) {}

  /** Persist `snapshot` as the recoverable last-valid state. */
  async snapshot(snapshot: RecoverySnapshot): Promise<void> {
    await this.io.write(JSON.stringify(snapshot));
  }

  /**
   * The snapshot left behind by a previous session, if any.
   *
   * Currently unused in production — see the module docstring.
   *
   * @returns The pending snapshot, or `null` when there is none or it is corrupt/not a
   *   valid project — a damaged recovery file must never block startup.
   */
  async pending(): Promise<RecoverySnapshot | null> {
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
    return toRecoverySnapshot(parsed);
  }

  /** Discard the snapshot — called on a clean quit. */
  async clear(): Promise<void> {
    await this.io.clear();
  }
}
