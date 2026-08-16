import { describe, expect, it } from 'vitest';
import type { DurableRunEventMessage } from '../ipc/contract.js';
import { RunCoordinator, RunGateway } from './run-coordinator.js';
import { RunIpcHub, type RunIpcSender } from './run-ipc.js';
import { RunStore, type RunStoreIO } from './run-store.js';

class MemoryRunStoreIO implements RunStoreIO {
  private readonly wal = new Map<string, string>();
  private readonly snapshots = new Map<string, string>();

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
    this.snapshots.set(runId, record);
    return Promise.resolve();
  }

  public quarantineRun(): Promise<string | null> {
    return Promise.resolve(null);
  }

  public listRunIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.wal.keys()]);
  }
}

class RacingSender implements RunIpcSender {
  public readonly id = 7;
  public sendAttempts = 0;
  public failSend = false;
  private destroyedListener: (() => void) | undefined;

  public isDestroyed(): boolean {
    return false;
  }

  public send(_channel: string, _message: DurableRunEventMessage): void {
    this.sendAttempts += 1;
    if (this.failSend) throw new Error('Render frame was disposed');
  }

  public once(_event: 'destroyed', listener: () => void): void {
    this.destroyedListener = listener;
  }

  public removeListener(_event: 'destroyed', listener: () => void): void {
    if (this.destroyedListener === listener) this.destroyedListener = undefined;
  }
}

describe('RunIpcHub', () => {
  it('bounds oversized tool details replayed from a legacy WAL', async () => {
    const coordinator = new RunCoordinator(new RunStore(new MemoryRunStoreIO()));
    const hub = new RunIpcHub(new RunGateway(coordinator), 'run-event');
    const sender = new RacingSender();
    try {
      const started = await hub.start(sender, {
        projectId: 'project',
        projectRevision: 0,
        userPrompt: 'edit this',
        mode: 'agent',
      });
      await coordinator.recordStreamEvent({
        runId: started.snapshot.runId,
        projectId: 'project',
        event: {
          id: 'large-result',
          conversationId: 'conversation',
          turnId: 'turn',
          ts: 1,
          type: 'tool_result',
          toolCallId: 'read-project',
          summary: 'Reading the project',
          result: { history: [{ inverse: 'x'.repeat(300_000) }] },
        },
      });

      const replay = await hub.subscribe(sender, {
        runId: started.snapshot.runId,
        projectId: 'project',
        afterSequence: started.snapshot.lastSequence,
      });

      expect(JSON.stringify(replay.events)).not.toContain('x'.repeat(1_000));
      expect(replay.events[0]?.payload).toMatchObject({
        event: {
          summary: 'Reading the project',
          result: { omitted: true },
        },
      });
    } finally {
      hub.close();
    }
  });

  it('detaches a subscription when the renderer is disposed during send', async () => {
    const coordinator = new RunCoordinator(new RunStore(new MemoryRunStoreIO()));
    const hub = new RunIpcHub(new RunGateway(coordinator), 'run-event');
    const sender = new RacingSender();
    try {
      const started = await hub.start(sender, {
        projectId: 'project',
        projectRevision: 0,
        userPrompt: 'edit this',
        mode: 'agent',
      });
      await hub.subscribe(sender, {
        runId: started.snapshot.runId,
        projectId: 'project',
        afterSequence: started.snapshot.lastSequence,
      });

      sender.failSend = true;
      await coordinator.recordStreamEvent({
        runId: started.snapshot.runId,
        projectId: 'project',
        event: {
          id: 'event-1',
          conversationId: 'conversation',
          turnId: 'turn',
          ts: 1,
          type: 'notification',
          text: 'first',
        },
      });
      await coordinator.recordStreamEvent({
        runId: started.snapshot.runId,
        projectId: 'project',
        event: {
          id: 'event-2',
          conversationId: 'conversation',
          turnId: 'turn',
          ts: 2,
          type: 'notification',
          text: 'second',
        },
      });

      expect(sender.sendAttempts).toBe(1);
    } finally {
      hub.close();
    }
  });
});
