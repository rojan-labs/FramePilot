/** Node filesystem adapter for the host-neutral durable run store. */
import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { assertSafeRunId, isSafeRunId, type RunStoreIO } from '@framepilot/ai-sdk';

export {
  DEFAULT_RUN_RETENTION,
  MAX_CACHED_RUNS,
  MAX_DURABLE_RUN_WAL_CHARS,
  RunMigrationRegistry,
  RunStore,
  RunStoreConflictError,
  RunStoreCorruptionError,
  pageRunEvents,
} from '@framepilot/ai-sdk';
export type {
  RunMigration,
  RunRecordKind,
  RunRetentionPolicy,
  RunStoreIO,
  StoredRun,
} from '@framepilot/ai-sdk';

export class FileRunStoreIO implements RunStoreIO {
  private readonly walHandles = new Map<string, FileHandle>();

  public constructor(private readonly rootDirectory: string) {}

  public readSnapshot(runId: string): Promise<string | null> {
    return this.readText(this.snapshotPath(runId));
  }

  public readWal(runId: string): Promise<string | null> {
    return this.readText(this.walPath(runId));
  }

  public async appendWal(runId: string, record: string): Promise<void> {
    const handle = await this.walHandle(runId);
    await handle.writeFile(record, 'utf8');
  }

  public async checkpointWal(runId: string): Promise<void> {
    const handle = this.walHandles.get(runId);
    if (handle) await handle.sync();
  }

  public async closeWal(runId: string): Promise<void> {
    const handle = this.walHandles.get(runId);
    if (!handle) return;
    this.walHandles.delete(runId);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async writeSnapshot(runId: string, record: string): Promise<void> {
    const runDirectory = this.runDirectory(runId);
    await mkdir(runDirectory, { recursive: true });
    const destination = this.snapshotPath(runId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(record, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await this.syncDirectory(runDirectory);
  }

  public async listRunIds(): Promise<readonly string[]> {
    const runsRoot = path.join(this.rootDirectory, 'runs');
    let entries: Dirent[];
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && isSafeRunId(entry.name))
      .map((entry) => entry.name);
  }

  /** Run ids newest-first, ordered by their snapshot's (or directory's) mtime. */
  public async listRunIdsByRecency(): Promise<readonly string[]> {
    const runIds = await this.listRunIds();
    const stamped = await Promise.all(
      runIds.map(async (runId) => ({
        runId,
        mtime: await this.lastModified(this.runDirectory(runId)),
      })),
    );
    return stamped.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.runId);
  }

  public async deleteRun(runId: string): Promise<void> {
    // Release the append descriptor first: on Windows an open handle blocks the unlink,
    // and on POSIX it would otherwise keep the deleted inode's bytes allocated.
    await this.closeWal(runId);
    await rm(this.runDirectory(runId), { recursive: true, force: true });
  }

  public async pruneQuarantine(maxAgeMs: number): Promise<number> {
    const quarantineRoot = path.join(this.rootDirectory, 'quarantine');
    let entries: Dirent[];
    try {
      entries = await readdir(quarantineRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(quarantineRoot, entry.name);
      if ((await this.lastModified(directory)) > cutoff) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** Modification time in ms, or `0` when it cannot be read (treated as oldest). */
  private async lastModified(target: string): Promise<number> {
    try {
      return (await stat(target)).mtimeMs;
    } catch {
      return 0;
    }
  }

  public async quarantineRun(runId: string, reason: string): Promise<string | null> {
    await this.closeWal(runId);
    const source = this.runDirectory(runId);
    try {
      await access(source, constants.F_OK);
    } catch {
      return null;
    }
    const quarantineRoot = path.join(this.rootDirectory, 'quarantine');
    await mkdir(quarantineRoot, { recursive: true });
    const destination = path.join(
      quarantineRoot,
      `${runId}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    );
    await rename(source, destination);
    await writeFile(
      path.join(destination, 'quarantine.json'),
      JSON.stringify({ runId, reason, quarantinedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    await this.syncDirectory(quarantineRoot);
    return destination;
  }

  private async walHandle(runId: string): Promise<FileHandle> {
    const existing = this.walHandles.get(runId);
    if (existing) return existing;
    const runDirectory = this.runDirectory(runId);
    await mkdir(runDirectory, { recursive: true });
    const handle = await open(this.walPath(runId), 'a');
    this.walHandles.set(runId, handle);
    return handle;
  }

  private runDirectory(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.rootDirectory, 'runs', runId);
  }

  private snapshotPath(runId: string): string {
    return path.join(this.runDirectory(runId), 'snapshot.json');
  }

  private walPath(runId: string): string {
    return path.join(this.runDirectory(runId), 'events.wal');
  }

  private async readText(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
