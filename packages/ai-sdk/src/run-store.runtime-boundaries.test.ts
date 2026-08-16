import { describe, expect, it } from 'vitest';
import { RunStore, RunStoreIOError, type RunStoreIO } from './run-store.js';

class ReadFailureIO implements RunStoreIO {
  quarantineCalls = 0;

  async readSnapshot(): Promise<string | null> {
    throw new Error('storage temporarily unavailable');
  }
  async readWal(): Promise<string | null> {
    return null;
  }
  async appendWal(): Promise<void> {}
  async writeSnapshot(): Promise<void> {}
  async quarantineRun(): Promise<string | null> {
    this.quarantineCalls += 1;
    return 'should-not-be-used';
  }
  async listRunIds(): Promise<readonly string[]> {
    return [];
  }
}

describe('RunStore runtime boundaries', () => {
  it('propagates storage read failures as I/O without quarantining valid state', async () => {
    const io = new ReadFailureIO();
    const store = new RunStore(io);

    await expect(store.load('run_io_failure')).rejects.toBeInstanceOf(RunStoreIOError);
    expect(io.quarantineCalls).toBe(0);
  });

  it('does the same for snapshot-only reconciliation reads', async () => {
    const io = new ReadFailureIO();
    const store = new RunStore(io);

    await expect(store.peekSnapshot('run_peek_failure')).rejects.toBeInstanceOf(RunStoreIOError);
    expect(io.quarantineCalls).toBe(0);
  });
});
