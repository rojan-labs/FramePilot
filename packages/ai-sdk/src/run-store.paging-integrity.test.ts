import { describe, expect, it } from 'vitest';
import {
  RunStore,
  RunStoreCorruptionError,
  type RunStoreIO,
} from './run-store.js';

interface EventOptions {
  readonly sequence: number;
  readonly eventId: string;
  readonly projectId?: string;
}

function event(options: EventOptions): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    eventId: options.eventId,
    runId: 'run_paged',
    projectId: options.projectId ?? 'project_a',
    sequence: options.sequence,
    occurredAt: options.sequence,
    kind: 'test_event',
    payload: {},
  })}\n`;
}

class PagedIO implements RunStoreIO {
  public quarantineCalls = 0;

  public constructor(private readonly records: readonly string[]) {}

  async readSnapshot(): Promise<string | null> {
    return null;
  }

  async readWal(): Promise<string | null> {
    return this.records.join('');
  }

  async readWalPage(
    _runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly string[]> {
    return this.records.slice(afterSequence, afterSequence + limit);
  }

  async appendWal(): Promise<void> {}
  async writeSnapshot(): Promise<void> {}
  async listRunIds(): Promise<readonly string[]> {
    return ['run_paged'];
  }

  async quarantineRun(): Promise<string | null> {
    this.quarantineCalls += 1;
    return 'quarantine/run_paged';
  }
}

class BlockingPagedIO extends PagedIO {
  public pageCalls = 0;
  public readonly firstPageStarted: Promise<void>;
  private resolveFirstPageStarted!: () => void;
  private readonly releaseFirstPagePromise: Promise<void>;
  private resolveFirstPage!: () => void;

  public constructor(records: readonly string[]) {
    super(records);
    this.firstPageStarted = new Promise<void>((resolve) => {
      this.resolveFirstPageStarted = resolve;
    });
    this.releaseFirstPagePromise = new Promise<void>((resolve) => {
      this.resolveFirstPage = resolve;
    });
  }

  public releaseFirstPage(): void {
    this.resolveFirstPage();
  }

  public override async readWalPage(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly string[]> {
    this.pageCalls += 1;
    if (this.pageCalls === 1) {
      this.resolveFirstPageStarted();
      await this.releaseFirstPagePromise;
    }
    return super.readWalPage(runId, afterSequence, limit);
  }
}

describe('RunStore native page integrity', () => {
  it('detects an event id repeated on a later page', async () => {
    const io = new PagedIO([
      event({ sequence: 1, eventId: 'evt_a' }),
      event({ sequence: 2, eventId: 'evt_a' }),
    ]);
    const store = new RunStore(io);

    await expect(store.eventsAfter('run_paged', 0, 1)).resolves.toHaveLength(1);
    await expect(store.eventsAfter('run_paged', 1, 1)).rejects.toBeInstanceOf(
      RunStoreCorruptionError,
    );
    expect(io.quarantineCalls).toBe(1);
  });

  it('detects project authority changing on a later page', async () => {
    const io = new PagedIO([
      event({ sequence: 1, eventId: 'evt_a', projectId: 'project_a' }),
      event({ sequence: 2, eventId: 'evt_b', projectId: 'project_b' }),
    ]);
    const store = new RunStore(io);

    await expect(store.eventsAfter('run_paged', 0, 1)).resolves.toHaveLength(1);
    await expect(store.eventsAfter('run_paged', 1, 1)).rejects.toBeInstanceOf(
      RunStoreCorruptionError,
    );
    expect(io.quarantineCalls).toBe(1);
  });

  it('validates skipped prefix authority before serving a direct later-page cursor', async () => {
    const io = new PagedIO([
      event({ sequence: 1, eventId: 'evt_a' }),
      event({ sequence: 2, eventId: 'evt_a' }),
    ]);
    const store = new RunStore(io);

    await expect(store.eventsAfter('run_paged', 1, 1)).rejects.toBeInstanceOf(
      RunStoreCorruptionError,
    );
    expect(io.quarantineCalls).toBe(1);
  });

  it('serializes concurrent native page validation for the same run', async () => {
    const io = new BlockingPagedIO([
      event({ sequence: 1, eventId: 'evt_a' }),
      event({ sequence: 2, eventId: 'evt_b' }),
    ]);
    const store = new RunStore(io);

    const first = store.eventsAfter('run_paged', 0, 2);
    await io.firstPageStarted;
    const second = store.eventsAfter('run_paged', 0, 2);

    await Promise.resolve();
    expect(io.pageCalls).toBe(1);

    io.releaseFirstPage();
    const [left, right] = await Promise.all([first, second]);

    expect(left.map((item) => item.sequence)).toEqual([1, 2]);
    expect(right.map((item) => item.sequence)).toEqual([1, 2]);
    expect(io.pageCalls).toBe(2);
    expect(io.quarantineCalls).toBe(0);
  });
});
