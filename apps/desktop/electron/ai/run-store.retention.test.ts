/**
 * Memory and disk bounds on the durable run store.
 *
 * The regressions these guard, all measured on a real install (242 runs / 1.1 GB):
 *  - the parsed-WAL cache was unbounded, so startup reconciliation hydrated every run
 *    the user had ever made and never released it (~2 GB of resident main-process heap);
 *  - reconciliation full-loaded each run to read a status the small snapshot already had;
 *  - nothing ever deleted a finished run or stale quarantine evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  RUN_PROTOCOL_SCHEMA_VERSION,
  type RunEventEnvelope,
  type RunSnapshot,
} from '@framepilot/ai-sdk';
import { RunStore, type RunStoreIO } from './run-store.js';

const TERMINAL = new Set<RunSnapshot['status']>(['completed', 'failed', 'cancelled']);

function snapshotFor(runId: string, status: RunSnapshot['status'], lastSequence = 1): RunSnapshot {
  return {
    schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
    runId,
    projectId: 'proj',
    status,
    baseProjectRevision: 0,
    currentProjectRevision: 0,
    lastSequence,
    graphVersion: 1,
    tasks: [],
    effects: [],
    patchDecisions: [],
    budgets: {},
    createdAt: 0,
    updatedAt: lastSequence,
    ...(TERMINAL.has(status)
      ? { outcome: { kind: 'completed_no_changes' as const, changed: false, warnings: [] } }
      : {}),
  };
}

function eventFor(runId: string, sequence: number): RunEventEnvelope {
  return {
    schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
    eventId: `${runId}_${String(sequence)}`,
    runId,
    projectId: 'proj',
    sequence,
    occurredAt: sequence,
    kind: 'run.stream_event',
    payload: { event: null },
  };
}

class MemoryIO implements RunStoreIO {
  public readonly wal = new Map<string, string>();
  public readonly snapshots = new Map<string, string>();
  /** Newest-first order the fs adapter derives from mtime. */
  public recency: string[] = [];
  public walReads = 0;
  public deleted: string[] = [];
  public prunedQuarantine = 0;

  public readSnapshot(runId: string): Promise<string | null> {
    return Promise.resolve(this.snapshots.get(runId) ?? null);
  }
  public readWal(runId: string): Promise<string | null> {
    this.walReads += 1;
    return Promise.resolve(this.wal.get(runId) ?? null);
  }
  public appendWal(runId: string, record: string): Promise<void> {
    this.wal.set(runId, (this.wal.get(runId) ?? '') + record);
    return Promise.resolve();
  }
  public writeSnapshot(runId: string, record: string): Promise<void> {
    this.snapshots.set(runId, record);
    return Promise.resolve();
  }
  public quarantineRun(): Promise<string | null> {
    return Promise.resolve(null);
  }
  public listRunIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.wal.keys()]);
  }
  public listRunIdsByRecency(): Promise<readonly string[]> {
    return Promise.resolve(this.recency);
  }
  public deleteRun(runId: string): Promise<void> {
    this.deleted.push(runId);
    this.wal.delete(runId);
    this.snapshots.delete(runId);
    return Promise.resolve();
  }
  public pruneQuarantine(maxAgeMs: number): Promise<number> {
    this.prunedQuarantine = maxAgeMs;
    return Promise.resolve(3);
  }

  public seed(runId: string, status: RunSnapshot['status']): void {
    this.wal.set(runId, `${JSON.stringify(eventFor(runId, 1))}\n`);
    this.snapshots.set(runId, JSON.stringify(snapshotFor(runId, status)));
    this.recency = [runId, ...this.recency];
  }
}

describe('RunStore cache bound', () => {
  it('retires the least-recently-used run once past the cache capacity', async () => {
    const io = new MemoryIO();
    for (const runId of ['a', 'b', 'c']) io.seed(runId, 'completed');
    const store = new RunStore(io, undefined, undefined, 2);

    await store.load('a');
    await store.load('b');
    expect(io.walReads).toBe(2);

    // A cache hit must not re-read, and must refresh recency so 'a' is no longer oldest.
    await store.load('a');
    expect(io.walReads).toBe(2);

    // 'c' evicts 'b' (now least recent), so 'a' still answers from memory.
    await store.load('c');
    await store.load('a');
    expect(io.walReads).toBe(3);

    // 'b' was evicted, so it costs one honest re-read from the authoritative WAL.
    const reloaded = await store.load('b');
    expect(io.walReads).toBe(4);
    expect(reloaded.events).toHaveLength(1);
  });

  it('reloads an evicted run to identical state', async () => {
    const io = new MemoryIO();
    io.seed('a', 'executing');
    const store = new RunStore(io, undefined, undefined, 1);

    const first = await store.load('a');
    store.evict('a');
    const second = await store.load('a');

    expect(second.events).toEqual(first.events);
    expect(second.snapshot).toEqual(first.snapshot);
  });
});

describe('RunStore.peekSnapshot', () => {
  it('answers from the snapshot file without reading the WAL', async () => {
    const io = new MemoryIO();
    io.seed('a', 'completed');
    const store = new RunStore(io);

    expect((await store.peekSnapshot('a'))?.status).toBe('completed');
    expect(io.walReads).toBe(0);
  });

  it('returns null when no snapshot has been committed yet', async () => {
    const io = new MemoryIO();
    io.wal.set('a', `${JSON.stringify(eventFor('a', 1))}\n`);
    const store = new RunStore(io);

    expect(await store.peekSnapshot('a')).toBeNull();
    expect(io.walReads).toBe(0);
  });

  it('rejects an unsafe run id rather than touching the filesystem', async () => {
    const store = new RunStore(new MemoryIO());
    await expect(store.peekSnapshot('../escape')).rejects.toThrow(/file-safe/);
  });
});

describe('RunStore.prune', () => {
  it('deletes finished runs past the retention bound, newest kept', async () => {
    const io = new MemoryIO();
    for (const runId of ['oldest', 'middle', 'newest']) io.seed(runId, 'completed');
    const store = new RunStore(io);

    const result = await store.prune({ maxRuns: 1, maxQuarantineAgeMs: 5 });

    expect(io.deleted).toEqual(['middle', 'oldest']);
    expect(result.runs).toBe(2);
    expect(io.prunedQuarantine).toBe(5);
    expect(result.quarantined).toBe(3);
  });

  it('never deletes a run that is still in progress', async () => {
    const io = new MemoryIO();
    io.seed('finished', 'completed');
    io.seed('live', 'executing');
    // `live` is newest, so retention of 0 would otherwise consider both.
    const store = new RunStore(io);

    await store.prune({ maxRuns: 0, maxQuarantineAgeMs: 0 });

    expect(io.deleted).toEqual(['finished']);
  });

  it('is a no-op against an IO that does not support deletion', async () => {
    const io = new MemoryIO();
    io.seed('a', 'completed');
    const { listRunIdsByRecency: _unused, ...withoutRecency } = io;
    const store = new RunStore({
      ...withoutRecency,
      listRunIds: () => io.listRunIds(),
      readSnapshot: (runId) => io.readSnapshot(runId),
      readWal: (runId) => io.readWal(runId),
      appendWal: (runId, record) => io.appendWal(runId, record),
      writeSnapshot: (runId, record) => io.writeSnapshot(runId, record),
      quarantineRun: () => io.quarantineRun(),
    });

    expect(await store.prune({ maxRuns: 0, maxQuarantineAgeMs: 0 })).toEqual({
      runs: 0,
      quarantined: 0,
    });
    expect(io.deleted).toEqual([]);
  });
});
