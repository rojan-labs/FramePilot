/**
 * Recording a run is not allowed to end it.
 *
 * Run f8574746 died mid-edit with `exceeded the 67108864-character durable log limit`,
 * thrown from the append of yet another superseded `run_state` ledger. The WAL limit is
 * now spent in tiers: optional stream events stop persisting first, other stream events
 * next, and integrity records keep a reserve so the run can still be settled.
 */
import { describe, expect, it } from 'vitest';
import {
  RunMigrationRegistry,
  RunStore,
  RunStoreConflictError,
  durableRecordTier,
  type RunStoreIO,
} from './run-store.js';
import type { RunEventEnvelope } from './run-contracts.js';

class MemoryIO implements RunStoreIO {
  public readonly wal = new Map<string, string>();
  async readSnapshot(): Promise<string | null> {
    return null;
  }
  async readWal(runId: string): Promise<string | null> {
    return this.wal.get(runId) ?? null;
  }
  async appendWal(runId: string, record: string): Promise<void> {
    this.wal.set(runId, (this.wal.get(runId) ?? '') + record);
  }
  async writeSnapshot(): Promise<void> {}
  async quarantineRun(): Promise<string | null> {
    return null;
  }
  async listRunIds(): Promise<readonly string[]> {
    return [...this.wal.keys()];
  }
  records(runId: string): readonly RunEventEnvelope[] {
    return (this.wal.get(runId) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEventEnvelope);
  }
}

const RUN = 'run_budget';
/** Small enough to fill in a test: tiers fall at 3 000 / 3 600 / 4 000 characters. */
const LIMIT = 4_000;

function envelope(sequence: number, kind: string, payload: unknown): RunEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `evt_${String(sequence)}_${kind}`,
    runId: RUN,
    projectId: 'project_a',
    sequence,
    occurredAt: sequence,
    kind,
    payload: payload as RunEventEnvelope['payload'],
  };
}

const streamEvent = (sequence: number, type: string, size = 0): RunEventEnvelope =>
  envelope(sequence, 'run.stream_event', { event: { type, text: 'x'.repeat(size) } });

/** Append through the store the way a host does: the next sequence follows the WAL head. */
async function appendNext(
  store: RunStore,
  build: (sequence: number) => RunEventEnvelope,
): Promise<{ readonly sent: RunEventEnvelope; readonly stored: RunEventEnvelope }> {
  const head = (await store.load(RUN)).events.at(-1)?.sequence ?? 0;
  const sent = build(head + 1);
  return { sent, stored: await store.append(sent) };
}

describe('durableRecordTier', () => {
  it('classifies stream payloads by how much a re-attaching renderer needs them', () => {
    expect(durableRecordTier(streamEvent(1, 'assistant_delta'))).toBe('optional');
    expect(durableRecordTier(streamEvent(1, 'reasoning_delta'))).toBe('optional');
    expect(durableRecordTier(streamEvent(1, 'reasoning'))).toBe('optional');
    expect(durableRecordTier(streamEvent(1, 'context_usage'))).toBe('optional');
    expect(durableRecordTier(streamEvent(1, 'run_state'))).toBe('optional');
    expect(durableRecordTier(streamEvent(1, 'diff'))).toBe('stream');
    expect(durableRecordTier(streamEvent(1, 'status'))).toBe('stream');
    expect(durableRecordTier(envelope(1, 'run.stream_event', null))).toBe('stream');
    expect(durableRecordTier(envelope(1, 'run.terminal', { status: 'failed' }))).toBe('integrity');
    expect(durableRecordTier(envelope(1, 'run.patch_committed', { patchId: 'p' }))).toBe(
      'integrity',
    );
  });
});

describe('RunStore WAL budget', () => {
  it('skips optional stream events past their share without consuming a sequence', async () => {
    const io = new MemoryIO();
    const store = new RunStore(io, new RunMigrationRegistry(), LIMIT);
    await appendNext(store, (sequence) => envelope(sequence, 'run.command_accepted', {}));
    // Fill to just under the optional share.
    while ((io.wal.get(RUN) ?? '').length < 2_700) {
      await appendNext(store, (sequence) => streamEvent(sequence, 'assistant_delta', 100));
    }
    const headBefore = (await store.load(RUN)).events.at(-1)!;

    const skipped = await appendNext(store, (sequence) => streamEvent(sequence, 'run_state', 600));
    // The caller is handed the last PERSISTED event, so it can tell and cursor on that.
    expect(skipped.stored.eventId).toBe(headBefore.eventId);
    expect(skipped.stored.eventId).not.toBe(skipped.sent.eventId);

    // A record that still fits its own tier goes in at the SAME sequence — no hole.
    const diff = await appendNext(store, (sequence) => streamEvent(sequence, 'diff', 300));
    expect(diff.stored.eventId).toBe(diff.sent.eventId);
    expect(diff.stored.sequence).toBe(headBefore.sequence + 1);
    const sequences = io.records(RUN).map((record) => record.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it('keeps the last share for integrity records once stream events stop', async () => {
    const io = new MemoryIO();
    const store = new RunStore(io, new RunMigrationRegistry(), LIMIT);
    await appendNext(store, (sequence) => envelope(sequence, 'run.command_accepted', {}));
    while ((io.wal.get(RUN) ?? '').length < 3_400) {
      await appendNext(store, (sequence) => streamEvent(sequence, 'diff', 100));
    }
    const skipped = await appendNext(store, (sequence) => streamEvent(sequence, 'diff', 400));
    expect(skipped.stored.eventId).not.toBe(skipped.sent.eventId);

    // The run can still be settled: the terminal event fits in the reserve.
    const terminal = await appendNext(store, (sequence) =>
      envelope(sequence, 'run.terminal', { status: 'failed' }),
    );
    expect(terminal.stored.eventId).toBe(terminal.sent.eventId);
    expect(io.records(RUN).at(-1)?.kind).toBe('run.terminal');
    // ...and the WAL it left behind still loads (it never crossed the hard limit).
    const reloaded = new RunStore(io, new RunMigrationRegistry(), LIMIT);
    expect((await reloaded.load(RUN)).events.at(-1)?.kind).toBe('run.terminal');
  });

  it('still refuses an integrity record that would cross the hard limit', async () => {
    const io = new MemoryIO();
    const store = new RunStore(io, new RunMigrationRegistry(), LIMIT);
    await appendNext(store, (sequence) => envelope(sequence, 'run.command_accepted', {}));
    await expect(
      appendNext(store, (sequence) =>
        envelope(sequence, 'run.effect_settled', { detail: 'x'.repeat(LIMIT) }),
      ),
    ).rejects.toBeInstanceOf(RunStoreConflictError);
  });

  it('keeps idempotency and sequence checks ahead of the budget', async () => {
    const io = new MemoryIO();
    const store = new RunStore(io, new RunMigrationRegistry(), LIMIT);
    await appendNext(store, (sequence) => envelope(sequence, 'run.command_accepted', {}));
    // A wrong sequence is a conflict even for a record the budget would have skipped.
    await expect(store.append(streamEvent(5, 'assistant_delta', 5_000))).rejects.toBeInstanceOf(
      RunStoreConflictError,
    );
  });
});
