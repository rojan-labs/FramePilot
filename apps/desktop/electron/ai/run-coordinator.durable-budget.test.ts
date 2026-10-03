/**
 * Recording a run is not allowed to end it (run f8574746).
 *
 * That run's WAL was 53 MB of `run_state` ledgers out of 65 MB, each one superseding the
 * last, and the append that crossed the durable limit threw out of the host's publish
 * path. Ledgers now go to the snapshot only, a store that skips an over-budget stream
 * event is honoured without publishing or cursoring on it, and the per-token snapshot is
 * folded forward instead of replayed from the WAL tail. No Electron; in-memory store IO.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RunEventEnvelope } from '@framepilot/ai-sdk';
import { RunCoordinator, RunGateway } from './run-coordinator.js';
import { RunStore, type RunStoreIO } from './run-store.js';

class MemoryRunStoreIO implements RunStoreIO {
  private readonly wal = new Map<string, string>();
  private readonly snapshots = new Map<string, string>();
  public snapshotWrites = 0;

  public readSnapshot(runId: string): Promise<string | null> {
    return Promise.resolve(this.snapshots.get(runId) ?? null);
  }
  public readWal(runId: string): Promise<string | null> {
    return Promise.resolve(this.wal.get(runId) ?? null);
  }
  public appendWal(runId: string, record: string): Promise<void> {
    this.wal.set(runId, (this.wal.get(runId) ?? '') + record);
    return Promise.resolve();
  }
  public writeSnapshot(runId: string, record: string): Promise<void> {
    this.snapshotWrites += 1;
    this.snapshots.set(runId, record);
    return Promise.resolve();
  }
  public quarantineRun(): Promise<string | null> {
    return Promise.resolve(null);
  }
  public listRunIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.wal.keys()]);
  }
  public walRecords(runId: string): readonly RunEventEnvelope[] {
    return (this.wal.get(runId) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEventEnvelope);
  }
  public snapshot(runId: string): Record<string, unknown> | null {
    const raw = this.snapshots.get(runId);
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  }
}

/**
 * The store contract a budget-aware `RunStore` honours: an over-budget stream event is
 * not persisted and the run's last persisted event comes back instead. Simulated here so
 * the coordinator's half of the contract is tested against whichever store build is
 * installed.
 */
class SkippingRunStore extends RunStore {
  public skipTypes = new Set<string>();

  public override async append(value: unknown): Promise<RunEventEnvelope> {
    const event = value as RunEventEnvelope;
    const inner = (event.payload as { event?: { type?: string } } | null)?.event;
    if (event.kind === 'run.stream_event' && this.skipTypes.has(inner?.type ?? '')) {
      const head = (await this.load(event.runId)).events.at(-1);
      if (head !== undefined) return head;
    }
    return super.append(value);
  }
}

function ledger(runId: string, version: number, statement: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    runId,
    identity: { conversationId: 'conv', projectId: 'proj', attemptId: runId },
    version,
    objective: { request: 'cut it', outcome: '', acceptance: [], provisional: true },
    stage: 'interpret',
    completedStages: [],
    stageEnteredAtTurn: 0,
    facts: [
      {
        id: 'fact_1',
        kind: 'asset',
        statement,
        evidenceIds: [],
        scope: 'revision_independent',
        observedAtRevision: 0,
        stage: 'inspect',
      },
    ],
    decisions: [],
    plan: {
      status: 'none',
      id: null,
      committedAtTurn: null,
      basedOnProjectRevision: null,
      decisionIds: [],
    },
    execution: { authorized: false },
    evidence: [],
    objectives: [],
    operations: [],
    verifications: [],
    nextAction: null,
    blockedOn: null,
    integrity: { status: 'valid', diagnostics: [] },
    baseProjectRevision: 0,
    currentProjectRevision: 0,
  };
}

async function startedRun(store?: RunStore): Promise<{
  coordinator: RunCoordinator;
  io: MemoryRunStoreIO;
  runId: string;
}> {
  const io = new MemoryRunStoreIO();
  const coordinator = new RunCoordinator(store ?? new RunStore(io));
  const started = await new RunGateway(coordinator).start({
    projectId: 'proj',
    projectRevision: 0,
    userPrompt: 'cut it',
    mode: 'agent',
  });
  return { coordinator, io, runId: started.snapshot.runId };
}

describe('RunCoordinator — run_state ledgers live in the snapshot, not the WAL', () => {
  it('keeps only the newest ledger, durably, without appending any of them', async () => {
    const { coordinator, io, runId } = await startedRun();
    for (const [version, fact] of [
      [1, 'first look'],
      [2, 'second look'],
      [3, 'the strongest claim is at 4:12.'],
    ] as const) {
      const returned = await coordinator.recordStreamEvent({
        runId,
        projectId: 'proj',
        event: { type: 'run_state', working: ledger(runId, version, fact) },
      });
      // The caller cursors on the last PERSISTED event: the start command.
      expect(returned.sequence).toBe(1);
    }

    expect(io.walRecords(runId).map((record) => record.kind)).toEqual(['run.command_accepted']);
    expect(JSON.stringify(io.snapshot(runId)?.['workingState'])).toContain('4:12');
    // ...and it survives a restart: a fresh coordinator over the same files reads it back.
    const restarted = new RunCoordinator(new RunStore(io));
    expect(JSON.stringify((await restarted.snapshot(runId))?.workingState)).toContain('4:12');
  });

  it('does not rewrite the snapshot for a ledger it already holds', async () => {
    const { coordinator, io, runId } = await startedRun();
    const event = { type: 'run_state', working: ledger(runId, 1, 'same') };
    await coordinator.recordStreamEvent({ runId, projectId: 'proj', event });
    const writes = io.snapshotWrites;
    await coordinator.recordStreamEvent({ runId, projectId: 'proj', event });
    expect(io.snapshotWrites).toBe(writes);
  });

  it('drops an invalid ledger instead of failing the publish', async () => {
    const { coordinator, io, runId } = await startedRun();
    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'run_state', working: ledger(runId, 2, 'kept') },
    });
    // Version moving backward used to throw out of the host's publish path.
    await expect(
      coordinator.recordStreamEvent({
        runId,
        projectId: 'proj',
        event: { type: 'run_state', working: ledger(runId, 1, 'stale') },
      }),
    ).resolves.toMatchObject({ sequence: 1 });
    expect(JSON.stringify(io.snapshot(runId)?.['workingState'])).toContain('kept');
  });

  it('still carries the newest ledger into the terminal snapshot', async () => {
    const { coordinator, runId } = await startedRun();
    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'run_state', working: ledger(runId, 1, 'carried forward') },
    });
    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'status', status: 'executing' },
    });
    await coordinator.complete({
      runId,
      projectId: 'proj',
      status: 'completed',
      outcome: { kind: 'completed_no_changes', changed: false, warnings: [] },
    });
    expect(JSON.stringify(await coordinator.latestWorkingStateFor('conv', 'proj'))).toContain(
      'carried forward',
    );
  });
});

describe('RunCoordinator — a stream event the store skips', () => {
  it('is neither published nor cursored on, and the next event keeps the log contiguous', async () => {
    const io = new MemoryRunStoreIO();
    const store = new SkippingRunStore(io);
    const { coordinator, runId } = await startedRun(store);
    const seen: number[] = [];
    const subscription = await coordinator.subscribe(runId, 1, (event) =>
      seen.push(event.sequence),
    );
    store.skipTypes.add('assistant_delta');

    const skipped = await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'assistant_delta', parentId: 'a', chunk: 'tok' },
    });
    const kept = await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'assistant_message', text: 'Done.' },
    });

    expect(skipped.sequence).toBe(1);
    expect(kept.sequence).toBe(2);
    expect(seen).toEqual([2]);
    expect(io.walRecords(runId).map((record) => record.sequence)).toEqual([1, 2]);
    subscription.unsubscribe();
  });

  it('writes a skipped status straight to the snapshot so a restart still sees it', async () => {
    const io = new MemoryRunStoreIO();
    const store = new SkippingRunStore(io);
    const { coordinator, runId } = await startedRun(store);
    store.skipTypes.add('status');

    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'status', status: 'executing' },
    });

    expect(io.snapshot(runId)?.['status']).toBe('executing');
    expect(io.snapshot(runId)?.['lastSequence']).toBe(1);
    expect((await new RunCoordinator(new RunStore(io)).snapshot(runId))?.status).toBe('executing');
  });
});

describe('RunCoordinator — the per-token snapshot is folded, not replayed', () => {
  it('replays the WAL tail once, not once per streamed event', async () => {
    const { coordinator, runId } = await startedRun();
    const internals = coordinator as unknown as {
      recoverSnapshot: (...args: unknown[]) => Promise<unknown>;
    };
    const replay = vi.spyOn(internals, 'recoverSnapshot');
    for (let index = 0; index < 40; index += 1) {
      await coordinator.recordStreamEvent({
        runId,
        projectId: 'proj',
        event: { type: 'reasoning_delta', parentId: 'r', chunk: String(index) },
      });
    }
    expect(replay.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('re-folds after another path appends, so a cancel is never overwritten', async () => {
    const { coordinator, runId } = await startedRun();
    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'status', status: 'executing' },
    });
    await new RunGateway(coordinator).command({
      runId,
      projectId: 'proj',
      kind: 'cancel',
      payload: { source: 'user_stop', reason: 'Stopped by the editor.' },
    });
    // A late token after the cancel is dropped; the run stays cancelled.
    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: { type: 'assistant_delta', parentId: 'a', chunk: 'late' },
    });
    expect((await coordinator.snapshot(runId))?.status).toBe('cancelled');
  });
});
