import {
  RUN_PROTOCOL_SCHEMA_VERSION,
  JsonValueSchema,
  RunStore,
  type AiEvent,
  type EditorRunStageEvent,
  type RunEventEnvelope,
  type RunOutcome,
  type RunSnapshot,
  type RunStatus,
} from '@framepilot/ai-sdk';

/** Persists one in-process browser editor run without gaining patch execution authority. */
export class BrowserRunRecorder {
  private lane: Promise<void> = Promise.resolve();
  private started = false;
  private lastSequence = 0;
  private changed = false;
  private createdAt: number | undefined;
  private terminal = false;
  private readonly pendingPatchIds = new Set<string>();
  private patchDecisions: RunSnapshot['patchDecisions'] = [];

  public constructor(
    private readonly store: RunStore,
    private readonly projectId: string,
    private readonly projectRevision: number,
    private readonly conversationId: string,
  ) {}

  public observeAiEvent(event: AiEvent): void {
    if (event.type === 'diff' && event.edit.validation.valid && event.edit.diff !== undefined) {
      this.changed = true;
      const patchId = event.edit.patch.patchId;
      if (!this.pendingPatchIds.has(patchId)) {
        this.pendingPatchIds.add(patchId);
        this.lane = this.lane.then(() => this.persistPendingPatch(patchId, event.ts));
      }
    }
  }

  public record(stage: EditorRunStageEvent): void {
    if (
      stage.state === 'failed' ||
      stage.state === 'cancelled' ||
      (stage.stage === 'finalize' && stage.state === 'completed')
    ) {
      this.terminal = true;
    }
    this.lane = this.lane.then(() => this.persist(stage));
  }

  public isTerminal(): boolean {
    return this.terminal;
  }

  public flush(): Promise<void> {
    return this.lane;
  }

  private async persist(stage: EditorRunStageEvent): Promise<void> {
    if (!this.started) await this.start(stage);
    const event: RunEventEnvelope = {
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      eventId: `${stage.runId}:lifecycle:${stage.sequence}`,
      runId: stage.runId,
      projectId: this.projectId,
      sequence: this.lastSequence + 1,
      projectRevision: this.projectRevision,
      occurredAt: stage.occurredAt,
      kind: 'run.editor_lifecycle',
      payload: { event: JsonValueSchema.parse(stage) },
    };
    await this.store.append(event);
    this.lastSequence = event.sequence;
    await this.store.saveSnapshot(this.snapshot(stage));
  }

  private async start(stage: EditorRunStageEvent): Promise<void> {
    this.createdAt = stage.occurredAt;
    saveBrowserRunHandle({
      schemaVersion: 1,
      runId: stage.runId,
      projectId: this.projectId,
      conversationId: this.conversationId,
    });
    const event: RunEventEnvelope = {
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      eventId: `${stage.runId}:browser:start`,
      runId: stage.runId,
      projectId: this.projectId,
      sequence: 1,
      projectRevision: this.projectRevision,
      occurredAt: stage.occurredAt,
      kind: 'run.command_accepted',
      payload: { kind: 'start', route: stage.route, host: 'browser' },
    };
    await this.store.append(event);
    this.lastSequence = event.sequence;
    this.started = true;
  }

  private snapshot(stage: EditorRunStageEvent): RunSnapshot {
    const status = statusFor(stage);
    const outcome = outcomeFor(status, this.changed, stage.reason);
    return {
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      runId: stage.runId,
      projectId: this.projectId,
      status,
      ...(outcome === undefined ? {} : { outcome }),
      baseProjectRevision: this.projectRevision,
      currentProjectRevision: this.projectRevision,
      lastSequence: this.lastSequence,
      graphVersion: 1,
      tasks: [],
      effects: [],
      patchDecisions: this.patchDecisions,
      workingState: { route: stage.route, stage: stage.stage, state: stage.state },
      budgets: {},
      contextHandles: [],
      patchPolicy: 'review',
      createdAt: this.createdAt ?? stage.occurredAt,
      updatedAt: stage.occurredAt,
    };
  }

  private async persistPendingPatch(patchId: string, occurredAt: number): Promise<void> {
    const stored = await this.store.load(this.runId());
    const snapshot = stored.snapshot;
    if (snapshot === null || snapshot.patchDecisions.some((item) => item.patchId === patchId)) return;
    const event: RunEventEnvelope = {
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      eventId: `${snapshot.runId}:patch:${patchId}:proposed`,
      runId: snapshot.runId,
      projectId: snapshot.projectId,
      sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
      projectRevision: snapshot.currentProjectRevision,
      occurredAt,
      kind: 'run.patch_proposed',
      payload: { patchId },
    };
    await this.store.append(event);
    this.lastSequence = event.sequence;
    this.patchDecisions = [...snapshot.patchDecisions, { patchId, state: 'pending' }];
    await this.store.saveSnapshot({
      ...snapshot,
      lastSequence: event.sequence,
      updatedAt: occurredAt,
      patchDecisions: this.patchDecisions,
    });
  }

  private runId(): string {
    const handle = loadBrowserRunHandle(this.projectId);
    if (handle === null) throw new Error('Browser run handle is unavailable before durability flush.');
    return handle.runId;
  }
}

export interface BrowserRunHandle {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
}

export function loadBrowserRunHandle(projectId: string): BrowserRunHandle | null {
  try {
    const raw = globalThis.localStorage?.getItem(handleKey(projectId));
    if (raw === null || raw === undefined) return null;
    const value = JSON.parse(raw) as Partial<BrowserRunHandle>;
    return value.schemaVersion === 1 && value.projectId === projectId &&
      typeof value.runId === 'string' && typeof value.conversationId === 'string'
      ? value as BrowserRunHandle
      : null;
  } catch {
    return null;
  }
}

export function clearBrowserRunHandle(projectId: string): void {
  try { globalThis.localStorage?.removeItem(handleKey(projectId)); } catch { /* storage denied */ }
}

function saveBrowserRunHandle(handle: BrowserRunHandle): void {
  try { globalThis.localStorage?.setItem(handleKey(handle.projectId), JSON.stringify(handle)); }
  catch { /* the durable record still remains discoverable in IndexedDB */ }
}

function handleKey(projectId: string): string {
  return `framepilot:browser-run-handle:v1:${projectId}`;
}

function statusFor(stage: EditorRunStageEvent): RunStatus {
  if (stage.state === 'failed') return 'failed';
  if (stage.state === 'cancelled') return 'cancelled';
  if (stage.stage === 'finalize' && stage.state === 'completed') return 'completed';
  const byStage: Record<EditorRunStageEvent['stage'], RunStatus> = {
    understand: 'thinking',
    resolve: 'reading',
    inspect: 'reading',
    plan: 'planning',
    compile: 'editing',
    execute: 'executing',
    verify: 'verifying',
    review: 'verifying',
    repair: 'editing',
    finalize: 'reconciling',
  };
  return byStage[stage.stage];
}

function outcomeFor(
  status: RunStatus,
  changed: boolean,
  reason: string | undefined,
): RunOutcome | undefined {
  if (status === 'completed') {
    return { kind: changed ? 'completed_with_changes' : 'completed_no_changes', changed, warnings: [] };
  }
  if (status === 'failed') {
    return { kind: 'failed', changed, warnings: [], source: 'internal_error', ...(reason ? { reason } : {}) };
  }
  if (status === 'cancelled') {
    return { kind: 'cancelled', changed, warnings: [], source: 'user_stop', ...(reason ? { reason } : {}) };
  }
  return undefined;
}
