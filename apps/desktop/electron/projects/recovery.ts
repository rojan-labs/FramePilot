/**
 * Crash recovery for the last valid project state (plan Phase 3.1).
 *
 * "Last valid state" = the most recent project that was successfully validated
 * and saved. After every successful save the main process writes a recovery
 * snapshot; on a clean quit it clears it. If the app crashes, the snapshot
 * survives, so on the next launch {@link RecoveryStore.pending} returns it and
 * the renderer can offer to restore — the user never loses a validated state.
 *
 * All IO is injected ({@link RecoveryIO}) so the snapshot/clear/restore logic is
 * unit-testable without `electron`/`fs`.
 */

/** A validated project snapshot kept for crash recovery. */
export interface RecoverySnapshot {
  /** Absolute path the project was last saved to. */
  path: string;
  /** The validated project document. */
  project: unknown;
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

function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.path === 'string' &&
    typeof snapshot.savedAt === 'number' &&
    'project' in snapshot
  );
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
   * @returns The pending snapshot, or `null` when there is none or the file is
   *   corrupt — a damaged recovery file must never block startup.
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
    return isRecoverySnapshot(parsed) ? parsed : null;
  }

  /** Discard the snapshot — called on a clean quit. */
  async clear(): Promise<void> {
    await this.io.clear();
  }
}
