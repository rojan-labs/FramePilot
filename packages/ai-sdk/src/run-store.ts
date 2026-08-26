/**
 * Host-neutral durable orchestration run storage.
 *
 * Persistence adapters provide WAL and snapshot I/O. The authority validates every
 * record, serializes writes per run, enforces idempotency and retention, and quarantines
 * corrupted state identically in desktop and browser hosts.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  RUN_PROTOCOL_SCHEMA_VERSION,
  parseRunEvent,
  parseRunSnapshot,
  type RunEventEnvelope,
  type RunSnapshot,
} from './run-contracts.js';

const log = createLogger('ai-sdk:run-store');
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const FIRST_EVENT_SEQUENCE = 1;
const PAGE_VALIDATION_CHUNK = 1_000;
export const MAX_DURABLE_RUN_WAL_CHARS = 64 * 1024 * 1024;
export const MAX_CACHED_RUNS = 8;
export const MAX_CACHED_WAL_CHARS = 128 * 1024 * 1024;

export type RunRecordKind = 'event' | 'snapshot';

export interface RunMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(kind: RunRecordKind, record: Readonly<Record<string, unknown>>): unknown;
}

export class RunMigrationRegistry {
  private readonly bySourceVersion = new Map<number, RunMigration>();

  public constructor(migrations: readonly RunMigration[] = []) {
    for (const migration of migrations) {
      if (
        !Number.isInteger(migration.fromVersion) ||
        !Number.isInteger(migration.toVersion) ||
        migration.fromVersion < 0 ||
        migration.toVersion !== migration.fromVersion + 1
      ) {
        throw new Error('Run migrations must advance exactly one non-negative schema version.');
      }
      if (this.bySourceVersion.has(migration.fromVersion)) {
        throw new Error(`Duplicate run migration from schema v${migration.fromVersion}.`);
      }
      this.bySourceVersion.set(migration.fromVersion, migration);
    }
  }

  public migrate(kind: RunRecordKind, value: unknown): unknown {
    if (!isRecord(value)) throw new Error(`Persisted run ${kind} must be a JSON object.`);
    const initialVersion = value['schemaVersion'];
    if (!Number.isInteger(initialVersion) || (initialVersion as number) < 0) {
      throw new Error(`Persisted run ${kind} has no valid schemaVersion.`);
    }
    if ((initialVersion as number) > RUN_PROTOCOL_SCHEMA_VERSION) {
      throw new Error(
        `Persisted run ${kind} uses future schema v${String(initialVersion)}; ` +
          `this build supports v${RUN_PROTOCOL_SCHEMA_VERSION}.`,
      );
    }

    let current: unknown = value;
    let version = initialVersion as number;
    while (version < RUN_PROTOCOL_SCHEMA_VERSION) {
      const migration = this.bySourceVersion.get(version);
      if (migration === undefined) {
        throw new Error(`No run ${kind} migration exists from schema v${version}.`);
      }
      current = migration.migrate(kind, current as Readonly<Record<string, unknown>>);
      if (!isRecord(current) || current['schemaVersion'] !== migration.toVersion) {
        throw new Error(
          `Run ${kind} migration v${version}→v${migration.toVersion} returned an invalid version.`,
        );
      }
      version = migration.toVersion;
    }
    return current;
  }
}

export interface RunRetentionPolicy {
  readonly maxRuns: number;
  readonly maxQuarantineAgeMs: number;
}

export const DEFAULT_RUN_RETENTION: RunRetentionPolicy = {
  maxRuns: 50,
  maxQuarantineAgeMs: 14 * 24 * 60 * 60 * 1000,
};

export interface RunStoreIO {
  readSnapshot(runId: string): Promise<string | null>;
  readWal(runId: string): Promise<string | null>;
  readWalPage?(runId: string, afterSequence: number, limit: number): Promise<readonly string[]>;
  listRunIdsByRecency?(): Promise<readonly string[]>;
  deleteRun?(runId: string): Promise<void>;
  pruneQuarantine?(maxAgeMs: number): Promise<number>;
  appendWal(runId: string, record: string): Promise<void>;
  checkpointWal?(runId: string): Promise<void>;
  closeWal?(runId: string): Promise<void>;
  writeSnapshot(runId: string, record: string): Promise<void>;
  quarantineRun(runId: string, reason: string): Promise<string | null>;
  listRunIds(): Promise<readonly string[]>;
}

export interface StoredRun {
  readonly snapshot: RunSnapshot | null;
  readonly events: readonly RunEventEnvelope[];
}

interface CachedRun {
  snapshot: RunSnapshot | null;
  readonly events: RunEventEnvelope[];
  readonly eventSignatures: Map<string, string>;
  walChars: number;
}

interface PageValidationState {
  throughSequence: number;
  projectId: string | undefined;
  readonly eventIds: Set<string>;
}

export class RunStoreCorruptionError extends Error {
  public override readonly name = 'RunStoreCorruptionError';
  public constructor(
    public readonly runId: string,
    public readonly quarantinePath: string | null,
    cause: unknown,
  ) {
    super(
      quarantinePath === null
        ? `Run "${runId}" is corrupt.`
        : `Run "${runId}" is corrupt and was quarantined at "${quarantinePath}".`,
      { cause },
    );
  }
}

export class RunStoreIOError extends Error {
  public override readonly name = 'RunStoreIOError';
  public constructor(
    public readonly runId: string,
    operation: string,
    cause: unknown,
  ) {
    super(`Could not ${operation} durable run "${runId}": ${errorMessage(cause)}`, { cause });
  }
}

export class RunStoreConflictError extends Error {
  public override readonly name = 'RunStoreConflictError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

export function assertSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) throw new Error('Run id must be a bounded file-safe identifier.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminal(snapshot: RunSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

export function pageRunEvents(
  events: readonly RunEventEnvelope[],
  afterSequence: number,
  limit: number,
): readonly RunEventEnvelope[] {
  const start = Math.min(events.length, Math.max(0, afterSequence));
  return events.slice(start, start + limit);
}

export class RunStore {
  private readonly writeLanes = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, CachedRun>();
  private readonly pageValidation = new Map<string, PageValidationState>();

  public constructor(
    private readonly io: RunStoreIO,
    private readonly migrations = new RunMigrationRegistry(),
    private readonly maxWalChars = MAX_DURABLE_RUN_WAL_CHARS,
    private readonly maxCachedRuns = MAX_CACHED_RUNS,
    private readonly maxCachedWalChars = MAX_CACHED_WAL_CHARS,
  ) {}

  public evict(runId: string): void {
    this.cache.delete(runId);
    this.pageValidation.delete(runId);
  }

  public load(runId: string): Promise<StoredRun> {
    assertSafeRunId(runId);
    return this.withRunLane(runId, () => this.loadUnlocked(runId));
  }

  public append(value: unknown): Promise<RunEventEnvelope> {
    const event = parseRunEvent(value);
    assertSafeRunId(event.runId);
    return this.withRunLane(event.runId, async () => {
      const stored = await this.loadUnlocked(event.runId);
      const eventSignature = JSON.stringify(event);
      const duplicateSignature = stored.eventSignatures.get(event.eventId);
      if (duplicateSignature !== undefined) {
        if (duplicateSignature !== eventSignature) {
          throw new RunStoreConflictError(
            `Event id "${event.eventId}" already exists with different content.`,
          );
        }
        return stored.events.find((candidate) => candidate.eventId === event.eventId)!;
      }

      const lastEvent = stored.events.at(-1);
      const expectedSequence =
        (lastEvent?.sequence ?? stored.snapshot?.lastSequence ?? FIRST_EVENT_SEQUENCE - 1) + 1;
      if (event.sequence !== expectedSequence) {
        throw new RunStoreConflictError(
          `Run "${event.runId}" expected sequence ${expectedSequence}, received ${event.sequence}.`,
        );
      }
      const projectId = lastEvent?.projectId ?? stored.snapshot?.projectId;
      if (projectId !== undefined && projectId !== event.projectId) {
        throw new RunStoreConflictError(
          `Run "${event.runId}" belongs to project "${projectId}", not "${event.projectId}".`,
        );
      }

      const record = `${eventSignature}\n`;
      if (stored.walChars + record.length > this.maxWalChars) {
        throw new RunStoreConflictError(
          `Run "${event.runId}" exceeded the ${String(this.maxWalChars)}-character durable log limit.`,
        );
      }
      try {
        await this.io.appendWal(event.runId, record);
      } catch (error) {
        throw new RunStoreIOError(event.runId, 'append to', error);
      }
      stored.events.push(event);
      stored.eventSignatures.set(event.eventId, eventSignature);
      stored.walChars += record.length;
      this.pageValidation.delete(event.runId);
      this.evictBeyondCapacity(event.runId);
      log.action('run event persisted', {
        runId: event.runId,
        sequence: event.sequence,
        kind: event.kind,
      });
      return event;
    });
  }

  public saveSnapshot(value: unknown): Promise<RunSnapshot> {
    const snapshot = parseRunSnapshot(value);
    assertSafeRunId(snapshot.runId);
    return this.withRunLane(snapshot.runId, async () => {
      const stored = await this.loadUnlocked(snapshot.runId);
      const lastEvent = stored.events.at(-1);
      if (lastEvent !== undefined && lastEvent.projectId !== snapshot.projectId) {
        throw new RunStoreConflictError(
          `Run "${snapshot.runId}" belongs to project "${lastEvent.projectId}".`,
        );
      }
      if (snapshot.lastSequence > (lastEvent?.sequence ?? 0)) {
        throw new RunStoreConflictError(
          `Snapshot sequence ${snapshot.lastSequence} is ahead of the durable WAL.`,
        );
      }
      if (stored.snapshot !== null && snapshot.lastSequence < stored.snapshot.lastSequence) {
        throw new RunStoreConflictError(
          `Snapshot sequence cannot move backward from ${stored.snapshot.lastSequence}.`,
        );
      }

      try {
        await this.io.checkpointWal?.(snapshot.runId);
        await this.io.writeSnapshot(snapshot.runId, JSON.stringify(snapshot, null, 2));
      } catch (error) {
        throw new RunStoreIOError(snapshot.runId, 'write snapshot for', error);
      }
      stored.snapshot = snapshot;
      if (terminal(snapshot)) {
        try {
          await this.io.closeWal?.(snapshot.runId);
        } catch (error) {
          throw new RunStoreIOError(snapshot.runId, 'close WAL for', error);
        }
        this.cache.delete(snapshot.runId);
        this.pageValidation.delete(snapshot.runId);
      }
      log.action('run snapshot persisted', {
        runId: snapshot.runId,
        sequence: snapshot.lastSequence,
        status: snapshot.status,
      });
      return snapshot;
    });
  }

  public listRunIds(): Promise<readonly string[]> {
    return this.io.listRunIds();
  }

  /**
   * Run ids newest-first, when the backing store can order them; otherwise unordered.
   *
   * Exposed for the same reason `prune` uses it internally: "the previous run" is a
   * recency question, and answering it by loading every run in arbitrary order would
   * read the entire history to find the newest entry.
   */
  public listRunIdsByRecency(): Promise<readonly string[]> {
    return this.io.listRunIdsByRecency?.() ?? this.io.listRunIds();
  }

  public async prune(
    policy: RunRetentionPolicy = DEFAULT_RUN_RETENTION,
  ): Promise<{ readonly runs: number; readonly quarantined: number }> {
    let runs = 0;
    const listByRecency = this.io.listRunIdsByRecency?.bind(this.io);
    const deleteRun = this.io.deleteRun?.bind(this.io);
    if (listByRecency !== undefined && deleteRun !== undefined) {
      const ordered = await listByRecency();
      for (const runId of ordered.slice(Math.max(0, policy.maxRuns))) {
        const snapshot = await this.peekSnapshot(runId);
        if (snapshot === null || !terminal(snapshot)) continue;
        await deleteRun(runId);
        this.cache.delete(runId);
        this.pageValidation.delete(runId);
        runs += 1;
      }
    }
    const quarantined = (await this.io.pruneQuarantine?.(policy.maxQuarantineAgeMs)) ?? 0;
    if (runs > 0 || quarantined > 0) {
      log.action('durable run retention applied', { runs, quarantined });
    }
    return { runs, quarantined };
  }

  public async peekSnapshot(runId: string): Promise<RunSnapshot | null> {
    assertSafeRunId(runId);
    const cached = this.cache.get(runId);
    if (cached !== undefined) return cached.snapshot;
    let raw: string | null;
    try {
      raw = await this.io.readSnapshot(runId);
    } catch (error) {
      throw new RunStoreIOError(runId, 'read snapshot for', error);
    }
    try {
      return this.parseSnapshot(raw);
    } catch {
      return null;
    }
  }

  public async eventsAfter(
    runId: string,
    sequence: number,
    limit = 1_000,
  ): Promise<readonly RunEventEnvelope[]> {
    assertSafeRunId(runId);
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error('Event cursor must be a non-negative integer.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Event page limit must be between 1 and 10,000.');
    }
    const cached = this.cache.get(runId);
    if (cached !== undefined) return pageRunEvents(cached.events, sequence, limit);

    const pager = this.io.readWalPage?.bind(this.io);
    if (pager !== undefined) {
      try {
        return await this.withRunLane(runId, () =>
          this.readValidatedNativePage(runId, sequence, limit, pager),
        );
      } catch (error) {
        if (error instanceof RunStoreIOError) throw error;
        await this.quarantineCorruption(runId, error);
      }
    }

    const stored = await this.load(runId);
    return pageRunEvents(stored.events, sequence, limit);
  }

  private async readValidatedNativePage(
    runId: string,
    sequence: number,
    limit: number,
    pager: NonNullable<RunStoreIO['readWalPage']>,
  ): Promise<readonly RunEventEnvelope[]> {
    let state = this.pageValidation.get(runId);
    if (state === undefined || state.throughSequence > sequence) {
      state = { throughSequence: 0, projectId: undefined, eventIds: new Set<string>() };
      this.rememberPageValidation(runId, state);
    } else {
      this.rememberPageValidation(runId, state);
    }

    // A caller may jump directly to page N. Validate the skipped authority incrementally first,
    // retaining only IDs/project metadata rather than hydrating the full WAL object graph.
    while (state.throughSequence < sequence) {
      const needed = Math.min(PAGE_VALIDATION_CHUNK, sequence - state.throughSequence);
      const raws = await this.readNativePage(runId, state.throughSequence, needed, pager);
      if (raws.length === 0) {
        // Cursor is beyond the durable end. That is a valid empty page, not corruption.
        return [];
      }
      const events = raws.map((raw) => this.parseWalRecord(raw));
      this.assertPageConsistent(runId, state, events);
      if (raws.length < needed && state.throughSequence < sequence) return [];
    }

    const raws = await this.readNativePage(runId, sequence, limit, pager);
    const events = raws.map((raw) => this.parseWalRecord(raw));
    this.assertPageConsistent(runId, state, events);
    return events;
  }

  private async readNativePage(
    runId: string,
    afterSequence: number,
    limit: number,
    pager: NonNullable<RunStoreIO['readWalPage']>,
  ): Promise<readonly string[]> {
    try {
      return await pager(runId, afterSequence, limit);
    } catch (error) {
      throw new RunStoreIOError(runId, 'read event page for', error);
    }
  }

  private rememberPageValidation(runId: string, state: PageValidationState): void {
    this.pageValidation.delete(runId);
    this.pageValidation.set(runId, state);
    while (this.pageValidation.size > this.maxCachedRuns) {
      const oldest = this.pageValidation.keys().next();
      if (oldest.done) return;
      this.pageValidation.delete(oldest.value);
    }
  }

  private async loadUnlocked(runId: string): Promise<CachedRun> {
    const cached = this.cache.get(runId);
    if (cached !== undefined) {
      this.cache.delete(runId);
      this.cache.set(runId, cached);
      return cached;
    }

    let snapshotRaw: string | null;
    let walRaw: string | null;
    try {
      [snapshotRaw, walRaw] = await Promise.all([
        this.io.readSnapshot(runId),
        this.io.readWal(runId),
      ]);
    } catch (error) {
      throw new RunStoreIOError(runId, 'read', error);
    }

    try {
      if (walRaw !== null && walRaw.length > this.maxWalChars) {
        throw new Error(
          `Durable WAL exceeds the ${String(this.maxWalChars)}-character safety limit.`,
        );
      }
      const snapshot = this.parseSnapshot(snapshotRaw);
      const events = this.parseWal(walRaw);
      this.assertConsistent(runId, snapshot, events);
      const stored: CachedRun = {
        snapshot,
        events,
        eventSignatures: new Map(events.map((event) => [event.eventId, JSON.stringify(event)])),
        walChars: walRaw?.length ?? 0,
      };
      this.pageValidation.delete(runId);
      this.cache.set(runId, stored);
      this.evictBeyondCapacity(runId);
      return stored;
    } catch (error) {
      return await this.quarantineCorruption(runId, error);
    }
  }

  private async quarantineCorruption(runId: string, error: unknown): Promise<never> {
    this.cache.delete(runId);
    this.pageValidation.delete(runId);
    const reason = errorMessage(error);
    let quarantinePath: string | null;
    try {
      quarantinePath = await this.io.quarantineRun(runId, reason);
    } catch (quarantineError) {
      throw new RunStoreIOError(runId, 'quarantine corrupt', quarantineError);
    }
    log.error('corrupt run state quarantined', { runId, quarantinePath, reason });
    throw new RunStoreCorruptionError(runId, quarantinePath, error);
  }

  private evictBeyondCapacity(protectedRunId?: string): void {
    const cachedWalChars = (): number =>
      [...this.cache.values()].reduce((sum, run) => sum + run.walChars, 0);
    while (
      this.cache.size > this.maxCachedRuns ||
      (this.cache.size > 1 && cachedWalChars() > this.maxCachedWalChars)
    ) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) return;
      if (oldest.value === protectedRunId && this.cache.size > 1) {
        const current = this.cache.get(oldest.value);
        if (current !== undefined) {
          this.cache.delete(oldest.value);
          this.cache.set(oldest.value, current);
          continue;
        }
      }
      this.cache.delete(oldest.value);
    }
  }

  private parseSnapshot(raw: string | null): RunSnapshot | null {
    if (raw === null) return null;
    return parseRunSnapshot(this.migrations.migrate('snapshot', JSON.parse(raw) as unknown));
  }

  private parseWalRecord(raw: string): RunEventEnvelope {
    return parseRunEvent(this.migrations.migrate('event', JSON.parse(raw.trim()) as unknown));
  }

  private parseWal(raw: string | null): RunEventEnvelope[] {
    if (raw === null || raw.trim().length === 0) return [];
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => this.parseWalRecord(line));
  }

  private assertPageConsistent(
    runId: string,
    state: PageValidationState,
    events: readonly RunEventEnvelope[],
  ): void {
    let expected = state.throughSequence + 1;
    for (const event of events) {
      if (event.runId !== runId)
        throw new Error(`WAL page contains event for run "${event.runId}".`);
      if (event.sequence !== expected) {
        throw new Error(`WAL page expected sequence ${expected}, found ${event.sequence}.`);
      }
      if (state.eventIds.has(event.eventId)) {
        throw new Error(`WAL contains duplicate event id "${event.eventId}" across pages.`);
      }
      if (state.projectId !== undefined && state.projectId !== event.projectId) {
        throw new Error('WAL contains events for multiple projects across pages.');
      }
      state.projectId ??= event.projectId;
      state.eventIds.add(event.eventId);
      state.throughSequence = event.sequence;
      expected += 1;
    }
  }

  private assertConsistent(
    runId: string,
    snapshot: RunSnapshot | null,
    events: readonly RunEventEnvelope[],
  ): void {
    let expectedSequence = FIRST_EVENT_SEQUENCE;
    let projectId = snapshot?.projectId;
    const eventIds = new Set<string>();
    for (const event of events) {
      if (event.runId !== runId) throw new Error(`WAL contains event for run "${event.runId}".`);
      if (event.sequence !== expectedSequence) {
        throw new Error(
          `WAL sequence is discontinuous: expected ${expectedSequence}, found ${event.sequence}.`,
        );
      }
      if (eventIds.has(event.eventId)) {
        throw new Error(`WAL contains duplicate event id "${event.eventId}".`);
      }
      if (projectId !== undefined && event.projectId !== projectId) {
        throw new Error('WAL contains events for multiple projects.');
      }
      projectId = event.projectId;
      eventIds.add(event.eventId);
      expectedSequence += 1;
    }
    if (snapshot !== null) {
      if (snapshot.runId !== runId) throw new Error(`Snapshot belongs to run "${snapshot.runId}".`);
      const lastSequence = events.at(-1)?.sequence ?? 0;
      if (snapshot.lastSequence > lastSequence) {
        throw new Error('Snapshot is ahead of the durable WAL.');
      }
    }
  }

  private withRunLane<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeLanes.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const lane = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeLanes.set(runId, lane);
    void lane.finally(() => {
      if (this.writeLanes.get(runId) === lane) this.writeLanes.delete(runId);
    });
    return result;
  }
}
