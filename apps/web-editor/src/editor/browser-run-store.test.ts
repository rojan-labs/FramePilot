import { RunStore } from '@framepilot/ai-sdk';
import { describe, expect, it } from 'vitest';
import {
  LocalStorageRunStoreIO,
  MAX_LOCAL_RUN_CHARS,
} from './browser-run-store.js';

describe('LocalStorageRunStoreIO', () => {
  it('persists the shared RunStore WAL and snapshot across authority instances', async () => {
    const storage = new MemoryStorage();
    const first = new RunStore(new LocalStorageRunStoreIO(storage));
    await first.append(event('run-1', 1, 'event-1'));
    await first.saveSnapshot(snapshot('run-1', 1));

    const loaded = await new RunStore(new LocalStorageRunStoreIO(storage)).load('run-1');
    expect(loaded.events).toHaveLength(1);
    expect(loaded.snapshot?.lastSequence).toBe(1);
  });

  it('quarantines malformed durable state through the shared authority', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'framepilot:orchestration:v1:run:run-1',
      JSON.stringify({ runId: 'run-1', snapshot: null, wal: '{bad json}\n', updatedAt: 1 }),
    );
    await expect(new RunStore(new LocalStorageRunStoreIO(storage)).load('run-1')).rejects.toThrow(
      'quarantined',
    );
    expect(storage.getItem('framepilot:orchestration:v1:run:run-1')).toBeNull();
    expect(keys(storage).some((key) => key.includes('quarantine:run-1'))).toBe(true);
  });

  it('enumerates and quarantines a malformed fallback wrapper instead of hiding it', async () => {
    const storage = new MemoryStorage();
    storage.setItem('framepilot:orchestration:v1:run:run-1', '{broken');
    const io = new LocalStorageRunStoreIO(storage);
    expect(await io.listRunIds()).toEqual(['run-1']);
    await expect(new RunStore(io).load('run-1')).rejects.toThrow('quarantined');
    expect(storage.getItem('framepilot:orchestration:v1:run:run-1')).toBeNull();
  });

  it('fails closed when one fallback run exceeds its hard storage budget', async () => {
    const io = new LocalStorageRunStoreIO(new MemoryStorage());
    await expect(io.appendWal('run-1', 'x'.repeat(MAX_LOCAL_RUN_CHARS + 1))).rejects.toThrow(
      'exceeds',
    );
  });
});

function event(runId: string, sequence: number, eventId: string) {
  return {
    schemaVersion: 1,
    runId,
    projectId: 'project-1',
    eventId,
    sequence,
    occurredAt: 1,
    kind: 'run.stream_event',
    payload: { event: { type: 'text', text: 'hello' } },
  };
}

function snapshot(runId: string, lastSequence: number) {
  return {
    schemaVersion: 1,
    runId,
    projectId: 'project-1',
    status: 'executing',
    baseProjectRevision: 0,
    currentProjectRevision: 0,
    lastSequence,
    graphVersion: 1,
    tasks: [],
    effects: [],
    patchDecisions: [],
    budgets: {},
    contextHandles: [],
    patchPolicy: 'review',
    createdAt: 1,
    updatedAt: 1,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  public get length(): number { return this.values.size; }
  public clear(): void { this.values.clear(); }
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  public removeItem(key: string): void { this.values.delete(key); }
  public setItem(key: string, value: string): void { this.values.set(key, value); }
}

function keys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key !== null,
  );
}
