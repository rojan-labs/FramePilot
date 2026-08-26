/**
 * Startup reconciliation of interrupted durable runs.
 *
 * A run left non-terminal by a crash / hard-kill / quit-that-raced-its-settlement has
 * no live producer after a restart, so a renderer that recovers it would re-subscribe
 * and hang on "Stop" forever. {@link RunCoordinator.reconcileInterruptedRuns} closes
 * every such orphan as `interrupted` at startup. No Electron; an in-memory store IO.
 */
import { describe, expect, it } from 'vitest';
import { RunCoordinator, RunGateway } from './run-coordinator.js';
import { RunMigrationRegistry, RunStore, type RunStoreIO } from './run-store.js';

/** In-memory {@link RunStoreIO}: WAL as an appended string, snapshot as latest write. */
class MemoryRunStoreIO implements RunStoreIO {
  private readonly wal = new Map<string, string>();
  private readonly snapshots = new Map<string, string>();
  public snapshotWrites = 0;
  public snapshotReads = 0;
  public walReads = 0;
  public quarantines = 0;

  public readSnapshot(runId: string): Promise<string | null> {
    this.snapshotReads += 1;
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
    this.snapshotWrites += 1;
    this.snapshots.set(runId, record);
    return Promise.resolve();
  }
  public quarantineRun(): Promise<string | null> {
    this.quarantines += 1;
    return Promise.resolve(null);
  }
  public listRunIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.wal.keys()]);
  }

  public walEventCount(runId: string): number {
    return (this.wal.get(runId) ?? '').trim().split('\n').filter(Boolean).length;
  }

  public seedWal(runId: string, wal: string): void {
    this.wal.set(runId, wal);
  }
}

function newCoordinator(): {
  coordinator: RunCoordinator;
  gateway: RunGateway;
  io: MemoryRunStoreIO;
} {
  const io = new MemoryRunStoreIO();
  const coordinator = new RunCoordinator(new RunStore(io));
  return { coordinator, gateway: new RunGateway(coordinator), io };
}

describe('RunCoordinator.reconcileInterruptedRuns', () => {
  it('classifies a run left in progress as interrupted and leaves a terminal run untouched', async () => {
    const { coordinator, gateway } = newCoordinator();

    const interrupted = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'trim the intro',
      mode: 'agent',
    });
    const finished = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'add captions',
      mode: 'agent',
    });
    // Drive the second run to a real terminal state before reconciliation runs.
    await coordinator.complete({
      runId: finished.snapshot.runId,
      projectId: 'proj',
      status: 'completed',
      outcome: { kind: 'completed_no_changes', changed: false, warnings: [] },
    });

    const reconciled = await coordinator.reconcileInterruptedRuns('closed mid-run');

    expect(reconciled).toEqual([interrupted.snapshot.runId]);
    const after = await coordinator.snapshot(interrupted.snapshot.runId);
    expect(after?.status).toBe('failed');
    expect(after?.outcome).toMatchObject({
      kind: 'interrupted',
      source: 'process_restart',
      reason: 'closed mid-run',
    });
    // The genuinely completed run is not disturbed.
    const finishedAfter = await coordinator.snapshot(finished.snapshot.runId);
    expect(finishedAfter?.status).toBe('completed');
  });

  it('is a no-op when there are no persisted runs', async () => {
    const { coordinator } = newCoordinator();
    expect(await coordinator.reconcileInterruptedRuns()).toEqual([]);
  });

  it('keeps every stream event durable without rewriting a full snapshot per token', async () => {
    const { coordinator, gateway, io } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'long edit',
      mode: 'agent',
    });

    for (let index = 0; index < 120; index += 1) {
      await coordinator.recordStreamEvent({
        runId: started.snapshot.runId,
        projectId: 'proj',
        event: {
          id: `delta-${String(index)}`,
          conversationId: 'conversation',
          turnId: 'turn',
          ts: index,
          type: 'reasoning_delta',
          parentId: 'reasoning',
          chunk: String(index),
        },
      });
    }

    expect(io.walEventCount(started.snapshot.runId)).toBe(121);
    // The validated run index stays hot. The old path reread and reparsed the growing
    // WAL twice for every token (plus each checkpoint), producing quadratic CPU/heap use.
    expect(io.walReads).toBe(1);
    expect(io.snapshotReads).toBe(1);
    // Start + sequence 50 + sequence 100. The remaining WAL tail is replayable.
    expect(io.snapshotWrites).toBe(3);
  });

  it('persists editor lifecycle events beside UI events and replays them through recovery', async () => {
    const { coordinator, gateway, io } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'roll this cut',
      mode: 'edit',
    });
    const runId = started.snapshot.runId;

    const lifecycle = await coordinator.recordEditorLifecycle({
      runId,
      projectId: 'proj',
      event: {
        schemaVersion: 1,
        runId,
        route: 'edit',
        sequence: 1,
        stage: 'understand',
        state: 'entered',
        occurredAt: 1000,
        attempt: 1,
        evidence: ['adapter:accepted'],
      },
    });
    await coordinator.recordStreamEvent({
      runId,
      projectId: 'proj',
      event: {
        id: 'status',
        conversationId: 'conversation',
        turnId: 'turn',
        ts: 1001,
        type: 'status',
        status: 'editing',
      },
    });

    expect(lifecycle).toMatchObject({ kind: 'run.editor_lifecycle', sequence: 2 });
    expect(lifecycle.payload).toMatchObject({
      event: { stage: 'understand', state: 'entered' },
    });
    expect((await coordinator.snapshot(runId))?.lastSequence).toBe(3);
    expect(io.walEventCount(runId)).toBe(3);
  });

  it('quarantines a legacy WAL before parsing a project-sized payload', async () => {
    const io = new MemoryRunStoreIO();
    io.seedWal('oversized-run', 'x'.repeat(1_025));

    await expect(
      new RunStore(io, new RunMigrationRegistry(), 1_024).load('oversized-run'),
    ).rejects.toThrow('corrupt');
    expect(io.quarantines).toBe(1);
  });

  it('drops an exact repeated stream event instead of amplifying it', async () => {
    const { coordinator, gateway, io } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'long edit',
      mode: 'agent',
    });
    const event = {
      id: 'same-event',
      conversationId: 'conversation',
      turnId: 'turn',
      ts: 1,
      type: 'notification',
      text: 'same',
    } as const;
    const first = await coordinator.recordStreamEvent({
      runId: started.snapshot.runId,
      projectId: 'proj',
      event,
    });
    const duplicate = await coordinator.recordStreamEvent({
      runId: started.snapshot.runId,
      projectId: 'proj',
      event,
    });

    expect(duplicate.sequence).toBe(first.sequence);
    expect(io.walEventCount(started.snapshot.runId)).toBe(2);
  });

  it('projects an accepted committed patch once when the renderer retries its decision', async () => {
    const { coordinator, gateway, io } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'trim the intro',
      mode: 'agent',
    });
    const runId = started.snapshot.runId;
    await coordinator.recordPatchLifecycle({
      runId,
      projectId: 'proj',
      patchId: 'patch_1',
      state: 'proposed',
      projectRevision: 0,
    });
    await coordinator.recordPatchLifecycle({
      runId,
      projectId: 'proj',
      patchId: 'patch_1',
      state: 'committed',
      projectRevision: 1,
    });
    await coordinator.complete({
      runId,
      projectId: 'proj',
      status: 'failed',
      outcome: {
        kind: 'failed',
        source: 'internal_error',
        reason: 'Reviewer unavailable; proposal remained human-reviewed.',
        changed: false,
        warnings: [],
      },
    });

    const accepted = await gateway.command({
      runId,
      projectId: 'proj',
      kind: 'accept_patch',
      payload: { patchId: 'patch_1', projectRevision: 1 },
    });
    const replay = await gateway.command({
      runId,
      projectId: 'proj',
      kind: 'accept_patch',
      payload: { patchId: 'patch_1', projectRevision: 1 },
    });

    expect(replay.event.eventId).toBe(accepted.event.eventId);
    expect(io.walEventCount(runId)).toBe(5);
    expect(await coordinator.snapshot(runId)).toMatchObject({
      currentProjectRevision: 1,
      outcome: { kind: 'completed_with_changes', changed: true },
      patchDecisions: [{ patchId: 'patch_1', state: 'committed', projectRevision: 1 }],
    });
  });

  it('emits a terminal event after a sourced cancel command already made the snapshot terminal', async () => {
    const { coordinator, gateway } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'long edit',
      mode: 'agent',
    });
    const cancelled = await gateway.command({
      runId: started.snapshot.runId,
      projectId: 'proj',
      kind: 'cancel',
      payload: { source: 'user_stop', reason: 'Stopped by the editor.' },
    });
    expect(cancelled.snapshot.status).toBe('cancelled');

    await coordinator.complete({
      runId: started.snapshot.runId,
      projectId: 'proj',
      status: 'cancelled',
      outcome: {
        kind: 'cancelled',
        source: 'user_stop',
        reason: 'provider aborted',
        changed: false,
        warnings: [],
      },
    });
    const replay = await coordinator.subscribe(started.snapshot.runId, 0, () => undefined);
    const terminal = replay.events.find((event) => event.kind === 'run.terminal');

    expect(terminal?.payload).toMatchObject({
      status: 'cancelled',
      outcome: {
        kind: 'cancelled',
        source: 'user_stop',
        reason: 'Stopped by the editor.',
      },
    });
    replay.unsubscribe();
  });

  it('classifies finished runs from their snapshot without reading their WALs', async () => {
    const { coordinator, gateway, io } = newCoordinator();
    for (const prompt of ['one', 'two', 'three']) {
      const started = await gateway.start({
        projectId: 'proj',
        projectRevision: 0,
        userPrompt: prompt,
        mode: 'agent',
      });
      await coordinator.complete({
        runId: started.snapshot.runId,
        projectId: 'proj',
        status: 'completed',
        outcome: { kind: 'completed_no_changes', changed: false, warnings: [] },
      });
    }
    const readsBefore = io.walReads;

    expect(await coordinator.reconcileInterruptedRuns()).toEqual([]);

    // Startup used to full-load every run the user had ever made — tens of MB of WAL
    // each — to read a status the few-KB snapshot already carried.
    expect(io.walReads).toBe(readsBefore);
  });

  it('replaces an oversized runtime-effect field rather than persisting it', async () => {
    const { coordinator, gateway } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'analyze',
      mode: 'agent',
    });

    const event = await coordinator.recordRuntimeEffect({
      runId: started.snapshot.runId,
      projectId: 'proj',
      effectId: 'effect_1',
      taskId: 'task_1',
      effectKind: 'host_tool',
      idempotencyKey: 'key_1',
      phase: 'requested',
      detail: { project: { history: 'x'.repeat(2_000_000) } },
    });

    expect(event.payload).toMatchObject({
      effectId: 'effect_1',
      detail: { omitted: true },
    });
    expect(JSON.stringify(event.payload)).not.toContain('xxxx');
  });

  it('persists a runtime-effect field that fits the audit budget unchanged', async () => {
    const { coordinator, gateway } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'analyze',
      mode: 'agent',
    });

    const event = await coordinator.recordRuntimeEffect({
      runId: started.snapshot.runId,
      projectId: 'proj',
      effectId: 'effect_1',
      taskId: 'task_1',
      effectKind: 'host_tool',
      idempotencyKey: 'key_1',
      phase: 'settled',
      outcome: { status: 'completed', summary: 'Found 12 silences' },
    });

    expect(event.payload).toMatchObject({
      outcome: { status: 'completed', summary: 'Found 12 silences' },
    });
  });
});

/**
 * The previous run's ledger, for the next run to inherit (context-management P5.1).
 *
 * Run memory used to die at the run boundary: turn 1 could spend six turns reading the
 * transcript and mapping the footage, and turn 2 started knowing none of it. The SDK
 * decides what may actually cross (`carryForwardWorkingState` keeps only
 * `revision_independent` facts and committed decisions); this lookup's only job is to
 * find the right run and hand its ledger over.
 */
describe('RunCoordinator.latestWorkingStateFor', () => {
  /** Finish a run and give it a ledger, exactly as a live run's `run_state` events do. */
  async function finishedRun(
    coordinator: RunCoordinator,
    gateway: RunGateway,
    args: { readonly projectId: string; readonly conversationId: string; readonly fact: string },
  ): Promise<string> {
    const started = await gateway.start({
      projectId: args.projectId,
      projectRevision: 0,
      userPrompt: 'find the best moments',
      mode: 'agent',
    });
    const runId = started.snapshot.runId;
    await coordinator.recordStreamEvent({
      runId,
      projectId: args.projectId,
      event: {
        type: 'run_state',
        working: workingState(runId, args.projectId, args.conversationId, args.fact),
      },
    });
    await coordinator.complete({
      runId,
      projectId: args.projectId,
      status: 'completed',
      outcome: { kind: 'completed_no_changes', changed: false, warnings: [] },
    });
    return runId;
  }

  it('returns the ledger of the newest finished run for this conversation and project', async () => {
    const { coordinator, gateway } = newCoordinator();
    await finishedRun(coordinator, gateway, {
      projectId: 'proj',
      conversationId: 'conv',
      fact: 'asset_1 runs 8:42.',
    });
    await finishedRun(coordinator, gateway, {
      projectId: 'proj',
      conversationId: 'conv',
      fact: 'the strongest claim is at 4:12.',
    });
    const found = await coordinator.latestWorkingStateFor('conv', 'proj');
    expect(JSON.stringify(found)).toContain('the strongest claim is at 4:12.');
  });

  it('does not cross a project or a conversation boundary', async () => {
    // A ledger from somewhere else is not stale, it is about something else.
    const { coordinator, gateway } = newCoordinator();
    await finishedRun(coordinator, gateway, {
      projectId: 'proj',
      conversationId: 'conv',
      fact: 'asset_1 runs 8:42.',
    });
    expect(await coordinator.latestWorkingStateFor('conv', 'other_project')).toBeUndefined();
    expect(await coordinator.latestWorkingStateFor('other_conv', 'proj')).toBeUndefined();
  });

  it('ignores a run that has not finished', async () => {
    // An in-flight run is either this very request or a concurrent one whose conclusions
    // are not conclusions yet.
    const { coordinator, gateway } = newCoordinator();
    const started = await gateway.start({
      projectId: 'proj',
      projectRevision: 0,
      userPrompt: 'find the best moments',
      mode: 'agent',
    });
    await coordinator.recordStreamEvent({
      runId: started.snapshot.runId,
      projectId: 'proj',
      event: {
        type: 'run_state',
        working: workingState(started.snapshot.runId, 'proj', 'conv', 'in flight.'),
      },
    });
    expect(await coordinator.latestWorkingStateFor('conv', 'proj')).toBeUndefined();
  });

  it('answers from SNAPSHOTS, never by replaying a run’s event log', async () => {
    // A full load parses a run's entire WAL — tens of MB each — and this lookup sits at
    // the head of every agent turn. The few-KB snapshot already holds the answer.
    const { coordinator, gateway, io } = newCoordinator();
    await finishedRun(coordinator, gateway, {
      projectId: 'proj',
      conversationId: 'conv',
      fact: 'asset_1 runs 8:42.',
    });
    const walReadsBefore = io.walReads;
    await coordinator.latestWorkingStateFor('conv', 'proj');
    expect(io.walReads).toBe(walReadsBefore);
  });

  it('returns nothing rather than throwing when there is no history at all', async () => {
    const { coordinator } = newCoordinator();
    expect(await coordinator.latestWorkingStateFor('conv', 'proj')).toBeUndefined();
    expect(await coordinator.latestWorkingStateFor('', '')).toBeUndefined();
  });
});

/** A minimal but VALID causal ledger — `parseWorkingState` must accept it. */
function workingState(
  runId: string,
  projectId: string,
  conversationId: string,
  statement: string,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    runId,
    identity: { conversationId, projectId, attemptId: runId },
    version: 1,
    objective: { request: 'find the best moments', outcome: '', acceptance: [], provisional: true },
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
