import { createLogger } from '@framepilot/shared-types';
import { isSafeRunId, type RunStoreIO } from '@framepilot/ai-sdk';

const log = createLogger('web-editor:browser-run-store');
const DATABASE_NAME = 'framepilot-orchestration';
const DATABASE_VERSION = 2;
const RUNS_STORE = 'runs';
const EVENTS_STORE = 'events';
const EVENTS_RUN_INDEX = 'runId';
const QUARANTINE_STORE = 'quarantine';
const FALLBACK_PREFIX = 'framepilot:orchestration:v1:';
export const MAX_LOCAL_RUN_CHARS = 1_000_000;
export const MAX_LOCAL_TOTAL_CHARS = 4_000_000;

interface BrowserRunMetadata {
  readonly runId: string;
  readonly snapshot: string | null;
  readonly updatedAt: number;
}

interface BrowserRunRecord extends BrowserRunMetadata {
  readonly wal: string;
}

interface BrowserRunEventRecord {
  readonly runId: string;
  readonly sequence: number;
  readonly record: string;
}

interface BrowserQuarantineRecord extends BrowserRunRecord {
  readonly quarantineId: string;
  readonly reason: string;
  readonly quarantinedAt: number;
}

/** IndexedDB-backed browser WAL/snapshot adapter with append-only event records. */
export class IndexedDbRunStoreIO implements RunStoreIO {
  private database: Promise<IDBDatabase> | undefined;

  public constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

  public async readSnapshot(runId: string): Promise<string | null> {
    return (await this.read(runId))?.snapshot ?? null;
  }

  public async readWal(runId: string): Promise<string | null> {
    const events = await this.eventsForRun(runId);
    return events.length === 0 ? null : events.map(({ record }) => record).join('');
  }

  public async readWalPage(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly string[]> {
    if (!isSafeRunId(runId)) throw new Error('Run id must be a bounded file-safe identifier.');
    const database = await this.open();
    const transaction = database.transaction(EVENTS_STORE, 'readonly');
    const query = IDBKeyRange.bound(
      [runId, afterSequence + 1],
      [runId, Number.MAX_SAFE_INTEGER],
    );
    const events = await requestResult<BrowserRunEventRecord[]>(
      transaction.objectStore(EVENTS_STORE).getAll(query, limit),
    );
    await transactionDone(transaction);
    return events.map(({ record }) => record);
  }

  public async appendWal(runId: string, record: string): Promise<void> {
    if (!isSafeRunId(runId)) throw new Error('Run id must be a bounded file-safe identifier.');
    const sequence = eventSequence(record);
    const database = await this.open();
    const transaction = database.transaction([RUNS_STORE, EVENTS_STORE], 'readwrite');
    const runs = transaction.objectStore(RUNS_STORE);
    const current =
      (await requestResult<BrowserRunMetadata | undefined>(runs.get(runId))) ??
      ({ runId, snapshot: null, updatedAt: Date.now() } satisfies BrowserRunMetadata);
    transaction.objectStore(EVENTS_STORE).add({ runId, sequence, record } satisfies BrowserRunEventRecord);
    runs.put({ ...current, updatedAt: Date.now() } satisfies BrowserRunMetadata);
    await transactionDone(transaction);
  }

  public async writeSnapshot(runId: string, snapshot: string): Promise<void> {
    await this.mutateRun(runId, (current) => ({ ...current, snapshot }));
  }

  public async listRunIds(): Promise<readonly string[]> {
    return (await this.allRuns()).map(({ runId }) => runId).filter(isSafeRunId);
  }

  public async listRunIdsByRecency(): Promise<readonly string[]> {
    return (await this.allRuns())
      .filter(({ runId }) => isSafeRunId(runId))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ runId }) => runId);
  }

  public async deleteRun(runId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction([RUNS_STORE, EVENTS_STORE], 'readwrite');
    transaction.objectStore(RUNS_STORE).delete(runId);
    transaction.objectStore(EVENTS_STORE).delete(eventRange(runId));
    await transactionDone(transaction);
  }

  public async quarantineRun(runId: string, reason: string): Promise<string | null> {
    const database = await this.open();
    const transaction = database.transaction(
      [RUNS_STORE, EVENTS_STORE, QUARANTINE_STORE],
      'readwrite',
    );
    const runs = transaction.objectStore(RUNS_STORE);
    const existing = await requestResult<BrowserRunMetadata | undefined>(runs.get(runId));
    if (existing === undefined) {
      await transactionDone(transaction);
      return null;
    }
    const events = await requestResult<BrowserRunEventRecord[]>(
      transaction.objectStore(EVENTS_STORE).index(EVENTS_RUN_INDEX).getAll(runId),
    );
    events.sort((left, right) => left.sequence - right.sequence);
    const quarantineId = `${runId}:${Date.now()}:${crypto.randomUUID()}`;
    transaction.objectStore(QUARANTINE_STORE).put({
      ...existing,
      wal: events.map(({ record }) => record).join(''),
      quarantineId,
      reason,
      quarantinedAt: Date.now(),
    } satisfies BrowserQuarantineRecord);
    runs.delete(runId);
    transaction.objectStore(EVENTS_STORE).delete(eventRange(runId));
    await transactionDone(transaction);
    return `indexeddb:${DATABASE_NAME}/${QUARANTINE_STORE}/${quarantineId}`;
  }

  public async pruneQuarantine(maxAgeMs: number): Promise<number> {
    const database = await this.open();
    const transaction = database.transaction(QUARANTINE_STORE, 'readwrite');
    const store = transaction.objectStore(QUARANTINE_STORE);
    const records = await requestResult<BrowserQuarantineRecord[]>(store.getAll());
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    const expired = records.filter(({ quarantinedAt }) => quarantinedAt < cutoff);
    for (const record of expired) store.delete(record.quarantineId);
    await transactionDone(transaction);
    return expired.length;
  }

  private async read(runId: string): Promise<BrowserRunMetadata | undefined> {
    return this.request('readonly', RUNS_STORE, (store) => store.get(runId));
  }

  private async allRuns(): Promise<BrowserRunMetadata[]> {
    return this.request('readonly', RUNS_STORE, (store) => store.getAll());
  }

  private async eventsForRun(runId: string): Promise<BrowserRunEventRecord[]> {
    if (!isSafeRunId(runId)) throw new Error('Run id must be a bounded file-safe identifier.');
    const database = await this.open();
    const transaction = database.transaction(EVENTS_STORE, 'readonly');
    const events = await requestResult<BrowserRunEventRecord[]>(
      transaction.objectStore(EVENTS_STORE).index(EVENTS_RUN_INDEX).getAll(runId),
    );
    await transactionDone(transaction);
    events.sort((left, right) => left.sequence - right.sequence);
    return events;
  }

  private async mutateRun(
    runId: string,
    mutate: (record: BrowserRunMetadata) => BrowserRunMetadata,
  ): Promise<void> {
    if (!isSafeRunId(runId)) throw new Error('Run id must be a bounded file-safe identifier.');
    const database = await this.open();
    const transaction = database.transaction(RUNS_STORE, 'readwrite');
    const store = transaction.objectStore(RUNS_STORE);
    const current =
      (await requestResult<BrowserRunMetadata | undefined>(store.get(runId))) ??
      ({ runId, snapshot: null, updatedAt: Date.now() } satisfies BrowserRunMetadata);
    store.put({ ...mutate(current), updatedAt: Date.now() } satisfies BrowserRunMetadata);
    await transactionDone(transaction);
  }

  private async request<T>(
    mode: IDBTransactionMode,
    storeName: string,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open();
    const transaction = database.transaction(storeName, mode);
    const result = await requestResult(operation(transaction.objectStore(storeName)));
    await transactionDone(transaction);
    return result;
  }

  private open(): Promise<IDBDatabase> {
    if (this.database !== undefined) return this.database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction;
        if (transaction === null) {
          fail(new Error('IndexedDB upgrade transaction is unavailable.'));
          return;
        }
        const runs = database.objectStoreNames.contains(RUNS_STORE)
          ? transaction.objectStore(RUNS_STORE)
          : database.createObjectStore(RUNS_STORE, { keyPath: 'runId' });
        if (!database.objectStoreNames.contains(QUARANTINE_STORE)) {
          database.createObjectStore(QUARANTINE_STORE, { keyPath: 'quarantineId' });
        }
        const events = database.objectStoreNames.contains(EVENTS_STORE)
          ? transaction.objectStore(EVENTS_STORE)
          : database.createObjectStore(EVENTS_STORE, { keyPath: ['runId', 'sequence'] });
        if (!events.indexNames.contains(EVENTS_RUN_INDEX)) {
          events.createIndex(EVENTS_RUN_INDEX, 'runId', { unique: false });
        }

        if (event.oldVersion < 2) {
          const cursorRequest = runs.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor === null) return;
            const legacy = cursor.value as Partial<BrowserRunRecord>;
            if (typeof legacy.runId === 'string' && typeof legacy.wal === 'string') {
              const lines = legacy.wal.split('\n').filter((line) => line.trim().length > 0);
              lines.forEach((line, index) => {
                events.put({
                  runId: legacy.runId as string,
                  sequence: migrationSequence(line, index + 1),
                  record: `${line}\n`,
                } satisfies BrowserRunEventRecord);
              });
              cursor.update({
                runId: legacy.runId,
                snapshot: typeof legacy.snapshot === 'string' ? legacy.snapshot : null,
                updatedAt: typeof legacy.updatedAt === 'number' ? legacy.updatedAt : Date.now(),
              } satisfies BrowserRunMetadata);
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        // `onblocked`/`onerror` can settle this open before a blocker disappears. IndexedDB may
        // still later deliver success for that same request. A resolved database after failure
        // has no owner, so close it immediately rather than leaking a hidden version blocker.
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          if (this.database === opening) this.database = undefined;
        };
        resolve(database);
      };
      request.onerror = () => fail(request.error ?? new Error('IndexedDB open failed.'));
      request.onblocked = () => fail(new Error('IndexedDB upgrade is blocked by another tab.'));
    });
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) this.database = undefined;
    });
    return opening;
  }
}

/** Bounded compatibility adapter for browsers where IndexedDB is unavailable. */
export class LocalStorageRunStoreIO implements RunStoreIO {
  public constructor(private readonly storage: Storage = globalThis.localStorage) {}

  public async readSnapshot(runId: string): Promise<string | null> {
    return this.read(runId)?.snapshot ?? null;
  }

  public async readWal(runId: string): Promise<string | null> {
    return this.read(runId)?.wal ?? null;
  }

  public async appendWal(runId: string, record: string): Promise<void> {
    const current = this.read(runId) ?? { runId, snapshot: null, wal: '', updatedAt: Date.now() };
    this.write({ ...current, wal: current.wal + record, updatedAt: Date.now() });
  }

  public async writeSnapshot(runId: string, snapshot: string): Promise<void> {
    const current = this.read(runId) ?? { runId, snapshot: null, wal: '', updatedAt: Date.now() };
    this.write({ ...current, snapshot, updatedAt: Date.now() });
  }

  public async listRunIds(): Promise<readonly string[]> {
    return this.keys('run:')
      .map((key) => key.slice(`${FALLBACK_PREFIX}run:`.length))
      .filter(isSafeRunId);
  }

  public async listRunIdsByRecency(): Promise<readonly string[]> {
    return (await this.listRunIds())
      .map((runId) => {
        try {
          return { runId, updatedAt: this.read(runId)?.updatedAt ?? 0 };
        } catch {
          return { runId, updatedAt: 0 };
        }
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ runId }) => runId);
  }

  public async deleteRun(runId: string): Promise<void> {
    this.storage.removeItem(this.runKey(runId));
  }

  public async quarantineRun(runId: string, reason: string): Promise<string | null> {
    const runKey = this.runKey(runId);
    const raw = this.storage.getItem(runKey);
    if (raw === null) return null;
    const quarantineId = `${runId}:${Date.now()}`;
    let persisted: unknown;
    try {
      persisted = JSON.parse(raw) as unknown;
    } catch {
      persisted = { runId, corruptRaw: raw };
    }
    const value = JSON.stringify({ persisted, reason, quarantinedAt: Date.now() });
    this.ensureCapacity(this.quarantineKey(quarantineId), value);
    this.storage.setItem(this.quarantineKey(quarantineId), value);
    this.storage.removeItem(runKey);
    return `localstorage:${this.quarantineKey(quarantineId)}`;
  }

  public async pruneQuarantine(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let removed = 0;
    for (const key of this.keys('quarantine:')) {
      try {
        const value = JSON.parse(this.storage.getItem(key) ?? '') as { quarantinedAt?: unknown };
        if (typeof value.quarantinedAt === 'number' && value.quarantinedAt < cutoff) {
          this.storage.removeItem(key);
          removed += 1;
        }
      } catch {
        // Malformed quarantine evidence is retained for diagnosis instead of guessed away.
      }
    }
    return removed;
  }

  private read(runId: string): BrowserRunRecord | undefined {
    if (!isSafeRunId(runId)) throw new Error('Run id must be a bounded file-safe identifier.');
    const raw = this.storage.getItem(this.runKey(runId));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as BrowserRunRecord;
    } catch {
      // `readSnapshot`/`readWal` must never throw for corrupt persisted content — only for
      // genuine I/O failure — so `RunStore` can tell the two apart (RunStoreIOError vs
      // quarantine). Surface the raw envelope as an unparsable WAL line: `RunStore`'s WAL
      // parser will reject it and quarantine the run through the normal corruption path.
      return { runId, snapshot: null, wal: raw, updatedAt: 0 };
    }
  }

  private write(record: BrowserRunRecord): void {
    const value = JSON.stringify(record);
    if (value.length > MAX_LOCAL_RUN_CHARS) {
      throw new Error(`Browser fallback run exceeds ${MAX_LOCAL_RUN_CHARS} characters.`);
    }
    const key = this.runKey(record.runId);
    this.ensureCapacity(key, value);
    this.storage.setItem(key, value);
  }

  private ensureCapacity(key: string, nextValue: string): void {
    const existing = this.storage.getItem(key)?.length ?? 0;
    const total = this.keys('').reduce(
      (sum, candidate) => sum + (this.storage.getItem(candidate)?.length ?? 0),
      0,
    );
    if (total - existing + nextValue.length > MAX_LOCAL_TOTAL_CHARS) {
      throw new Error(`Browser fallback store exceeds ${MAX_LOCAL_TOTAL_CHARS} characters.`);
    }
  }

  private keys(suffix: string): string[] {
    const prefix = `${FALLBACK_PREFIX}${suffix}`;
    return Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(prefix));
  }

  private runKey(runId: string): string {
    return `${FALLBACK_PREFIX}run:${runId}`;
  }

  private quarantineKey(quarantineId: string): string {
    return `${FALLBACK_PREFIX}quarantine:${quarantineId}`;
  }
}

export function createBrowserRunStoreIO(): RunStoreIO {
  if (typeof globalThis.indexedDB !== 'undefined') return new IndexedDbRunStoreIO();
  log.warn('IndexedDB unavailable; using bounded localStorage run durability.');
  return new LocalStorageRunStoreIO();
}

function eventSequence(record: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.trim()) as unknown;
  } catch (error) {
    throw new Error(
      `Run WAL append is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('sequence' in parsed) ||
    !Number.isInteger((parsed as { sequence?: unknown }).sequence) ||
    Number((parsed as { sequence?: unknown }).sequence) < 1
  ) {
    throw new Error('Run WAL append is missing a positive integer sequence.');
  }
  return Number((parsed as { sequence: number }).sequence);
}

function migrationSequence(line: string, fallback: number): number {
  try {
    const parsed = JSON.parse(line) as { sequence?: unknown };
    return Number.isInteger(parsed.sequence) && Number(parsed.sequence) > 0
      ? Number(parsed.sequence)
      : fallback;
  } catch {
    return fallback;
  }
}

function eventRange(runId: string): IDBKeyRange {
  return IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}
