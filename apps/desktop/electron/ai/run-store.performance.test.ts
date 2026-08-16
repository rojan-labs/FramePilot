import { describe, expect, it, vi } from 'vitest';
import {
  RUN_PROTOCOL_SCHEMA_VERSION,
  type RunEventEnvelope,
  type RunSnapshot,
} from '@framepilot/ai-sdk';
import { RunStore, pageRunEvents, type RunStoreIO } from './run-store.js';

const event = (sequence: number): RunEventEnvelope => ({
  schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
  eventId: `event_${sequence}`,
  runId: 'run_1',
  projectId: 'project_1',
  sequence,
  occurredAt: sequence,
  kind: 'run.stream_event',
  payload: { event: null },
});

const TERMINAL_STATUSES = new Set<RunSnapshot['status']>(['completed', 'failed', 'cancelled']);

const snapshot = (
  lastSequence: number,
  status: RunSnapshot['status'] = 'executing',
): RunSnapshot => ({
  schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
  runId: 'run_1',
  projectId: 'project_1',
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
  // The contract couples the two: a terminal snapshot must carry an outcome,
  // a live one must omit it.
  ...(TERMINAL_STATUSES.has(status)
    ? { outcome: { kind: 'completed_no_changes' as const, changed: false, warnings: [] } }
    : {}),
});

function memoryIO(): RunStoreIO & {
  appendWal: ReturnType<typeof vi.fn>;
  checkpointWal: ReturnType<typeof vi.fn>;
  closeWal: ReturnType<typeof vi.fn>;
  writeSnapshot: ReturnType<typeof vi.fn>;
} {
  let wal = '';
  let snapshotRaw: string | null = null;
  const appendWal = vi.fn(async (_runId: string, record: string) => {
    wal += record;
  });
  const checkpointWal = vi.fn(async () => {});
  const closeWal = vi.fn(async () => {});
  const writeSnapshot = vi.fn(async (_runId: string, record: string) => {
    snapshotRaw = record;
  });
  return {
    readSnapshot: async () => snapshotRaw,
    readWal: async () => wal || null,
    appendWal,
    checkpointWal,
    closeWal,
    writeSnapshot,
    quarantineRun: async () => null,
    listRunIds: async () => [],
  };
}

describe('durable run hot-path bounds', () => {
  it('pages contiguous sequence suffixes with one slice rather than a full filter', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => event(index + 1));
    expect(pageRunEvents(events, 9_990, 5).map((item) => item.sequence)).toEqual([
      9_991, 9_992, 9_993, 9_994, 9_995,
    ]);
    expect(pageRunEvents(events, 10_000, 5)).toEqual([]);
  });

  it('does not fsync/checkpoint per stream append, but checkpoints before a snapshot', async () => {
    const io = memoryIO();
    const store = new RunStore(io);
    await store.append(event(1));
    await store.append(event(2));
    expect(io.appendWal).toHaveBeenCalledTimes(2);
    expect(io.checkpointWal).not.toHaveBeenCalled();

    await store.saveSnapshot(snapshot(2));
    expect(io.checkpointWal).toHaveBeenCalledTimes(1);
    expect(io.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(io.checkpointWal.mock.invocationCallOrder[0]).toBeLessThan(
      io.writeSnapshot.mock.invocationCallOrder[0],
    );
  });

  it('syncs and releases the WAL descriptor when the run becomes terminal', async () => {
    const io = memoryIO();
    const store = new RunStore(io);
    await store.append(event(1));
    await store.saveSnapshot(snapshot(1, 'completed'));
    expect(io.checkpointWal).toHaveBeenCalledTimes(1);
    expect(io.closeWal).toHaveBeenCalledWith('run_1');
  });
});
