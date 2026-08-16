/**
 * Authoritative durable run command boundary for Electron main.
 *
 * Commands are validated, serialized per run, persisted as domain events, reduced
 * into a snapshot, and only then published to subscribers. No renderer-owned
 * Promise, queue, or React state participates in run authority.
 */
import { randomUUID } from 'node:crypto';
import {
  JsonValueSchema,
  RUN_PROTOCOL_SCHEMA_VERSION,
  RunOutcomeSchema,
  RunStatusSchema,
  parseWorkingState,
  parseEditorRunStageEvent,
  parseRunCommand,
  type JsonValue,
  type ProjectRevision,
  type RunCommandEnvelope,
  type RunCommandKind,
  type RunEventEnvelope,
  type RunOutcome,
  type RunSnapshot,
} from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import { RunStore, RunStoreConflictError, type StoredRun } from './run-store.js';
import { exceedsTransportBudget } from './ai-event-transport.js';

const log = createLogger('desktop:ai:run-coordinator');
const TERMINAL_STATUSES = new Set<RunSnapshot['status']>(['completed', 'failed', 'cancelled']);
const MAX_REPLAY_EVENTS = 1_000;
/**
 * Ceiling on one runtime-effect audit field written to the WAL.
 *
 * Callers are expected to hand over an already-bounded projection (see
 * `effect-record.ts`), but the WAL is append-only, cached in memory for the life of the
 * process, AND pushed to every subscribed renderer — so a single oversized value is a
 * process-wide memory fault, not a cosmetic one. This is the boundary that makes that
 * impossible regardless of what any future caller passes. Deliberately NOT applied to
 * `run.stream_event`: those payloads are the renderer's UI contract (a `diff` carries
 * the patch the review pane renders) and are bounded by `prepareAiEventForTransport`.
 */
const MAX_DURABLE_EFFECT_FIELD_CHARS = 256 * 1024;

/** `value`, or an omission marker when it would blow the durable audit budget. */
function boundEffectField(value: JsonValue | undefined, field: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (!exceedsTransportBudget(value, MAX_DURABLE_EFFECT_FIELD_CHARS)) return value;
  log.warn('oversized durable effect field replaced', { field });
  return {
    omitted: true,
    reason:
      `Effect ${field} exceeded the ${String(MAX_DURABLE_EFFECT_FIELD_CHARS)}-character ` +
      `durable audit budget and was not persisted.`,
  };
}
/**
 * Stream deltas remain durable in the WAL, but a full snapshot rewrite per token
 * turns a long response into thousands of atomic file replacements. Checkpoint the
 * projection periodically and immediately on meaningful lifecycle changes instead.
 */
const STREAM_SNAPSHOT_INTERVAL = 50;

export interface RunSubscription {
  readonly snapshot: RunSnapshot | null;
  readonly events: readonly RunEventEnvelope[];
  readonly hasMore: boolean;
  unsubscribe(): void;
}

export type RunEventListener = (event: RunEventEnvelope) => void;

export interface StartRunInput {
  readonly projectId: string;
  readonly projectRevision: ProjectRevision;
  readonly userPrompt: string;
  readonly mode: Extract<RunCommandEnvelope, { kind: 'start' }>['payload']['mode'];
  readonly selection?: JsonValue;
  readonly agentOptions?: JsonValue;
  readonly contextHandles?: readonly string[];
  readonly patchPolicy?: 'review' | 'auto_commit';
}

export interface RunCommandInput {
  readonly runId: string;
  readonly projectId: string;
  readonly expectedProjectRevision?: ProjectRevision;
  readonly kind: Exclude<RunCommandKind, 'start'>;
  readonly payload: unknown;
}

export interface AcceptedRunCommand {
  readonly command: RunCommandEnvelope;
  readonly event: RunEventEnvelope;
  readonly snapshot: RunSnapshot;
}

export interface OpenRunGateInput {
  readonly runId: string;
  readonly projectId: string;
  readonly gateId: string;
  readonly kind: NonNullable<RunSnapshot['pendingGate']>['kind'];
  readonly payload: JsonValue;
  readonly requestedAt?: number;
  readonly expiresAt?: number;
}

export interface CompleteRunInput {
  readonly runId: string;
  readonly projectId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly outcome: RunOutcome;
  readonly occurredAt?: number;
}

export interface RecordStreamEventInput {
  readonly runId: string;
  readonly projectId: string;
  readonly event: JsonValue;
  readonly occurredAt?: number;
}

export interface RecordEditorLifecycleInput {
  readonly runId: string;
  readonly projectId: string;
  readonly event: unknown;
}

export interface RecordRuntimeEffectInput {
  readonly runId: string;
  readonly projectId: string;
  readonly effectId: string;
  readonly taskId: string;
  readonly effectKind: string;
  readonly idempotencyKey: string;
  readonly phase: 'requested' | 'settled' | 'failed' | 'cancelled';
  readonly detail?: JsonValue;
  readonly outcome?: JsonValue;
  readonly occurredAt?: number;
}

export interface RecordPatchLifecycleInput {
  readonly runId: string;
  readonly projectId: string;
  readonly patchId: string;
  readonly state: 'proposed' | 'stale' | 'committed' | 'rebased';
  readonly projectRevision?: ProjectRevision;
  readonly reason?: string;
  readonly occurredAt?: number;
}

interface Subscriber {
  readonly listener: RunEventListener;
}

function commandAsJson(command: RunCommandEnvelope): JsonValue {
  return JsonValueSchema.parse(command);
}

function commandFromEvent(event: RunEventEnvelope): RunCommandEnvelope | null {
  if (
    event.kind !== 'run.command_accepted' &&
    event.kind !== 'run.patch_accepted' &&
    event.kind !== 'run.patch_rejected'
  ) {
    return null;
  }
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    return null;
  }
  const command = (event.payload as { readonly [key: string]: JsonValue })['command'];
  return command === undefined ? null : parseRunCommand(command);
}

function withoutOutcome(snapshot: RunSnapshot): Omit<RunSnapshot, 'outcome'> {
  const { outcome: _outcome, ...rest } = snapshot;
  return rest;
}

function requirePendingGate(
  snapshot: RunSnapshot,
  kind: NonNullable<RunSnapshot['pendingGate']>['kind'],
): void {
  if (snapshot.pendingGate?.kind !== kind) {
    throw new RunStoreConflictError(`Run is not waiting at a ${kind} gate.`);
  }
}

function updatePatchDecision(
  snapshot: RunSnapshot,
  command: Extract<RunCommandEnvelope, { kind: 'accept_patch' | 'reject_patch' }>,
): RunSnapshot['patchDecisions'] {
  let found = false;
  const patchDecisions = snapshot.patchDecisions.map((decision) => {
    if (decision.patchId !== command.payload.patchId) return decision;
    if (decision.state === 'committed' && command.kind === 'accept_patch') {
      found = true;
      return decision;
    }
    if (decision.state !== 'pending') {
      throw new RunStoreConflictError(
        `Patch "${decision.patchId}" has already been decided as "${decision.state}".`,
      );
    }
    found = true;
    return {
      ...decision,
      state: command.kind === 'accept_patch' ? ('committed' as const) : ('rejected' as const),
      decidedAt: command.issuedAt,
      decidedByCommandId: command.commandId,
      ...(command.payload.projectRevision === undefined
        ? {}
        : { projectRevision: command.payload.projectRevision }),
      ...(command.payload.reason === undefined ? {} : { reason: command.payload.reason }),
    };
  });
  if (!found) {
    throw new RunStoreConflictError(`Patch "${command.payload.patchId}" is not pending review.`);
  }
  return patchDecisions;
}

/** Pure command reducer. Execution effects will fold into this same snapshot in F2. */
function reduceCommand(snapshot: RunSnapshot, command: RunCommandEnvelope): RunSnapshot {
  if (command.kind === 'start') return snapshot;
  if (snapshot.projectId !== command.projectId) {
    throw new RunStoreConflictError(`Run and command project ids do not match.`);
  }
  if (
    command.expectedProjectRevision !== undefined &&
    command.expectedProjectRevision !== snapshot.currentProjectRevision
  ) {
    throw new RunStoreConflictError(
      `Project revision conflict: expected ${command.expectedProjectRevision}, ` +
        `current ${snapshot.currentProjectRevision}.`,
    );
  }
  if (
    TERMINAL_STATUSES.has(snapshot.status) &&
    command.kind !== 'resume' &&
    command.kind !== 'accept_patch' &&
    command.kind !== 'reject_patch'
  ) {
    throw new RunStoreConflictError(`Run is terminal with status "${snapshot.status}".`);
  }

  const common = {
    ...snapshot,
    lastSequence: snapshot.lastSequence + 1,
    updatedAt: command.issuedAt,
  };
  switch (command.kind) {
    case 'approve_plan':
      requirePendingGate(snapshot, 'plan_approval');
      if (snapshot.pendingGate?.gateId !== command.payload.planId) {
        throw new RunStoreConflictError(`Plan decision does not match the pending plan.`);
      }
      return { ...common, status: 'executing', pendingGate: undefined };
    case 'reject_plan':
      requirePendingGate(snapshot, 'plan_approval');
      if (snapshot.pendingGate?.gateId !== command.payload.planId) {
        throw new RunStoreConflictError(`Plan decision does not match the pending plan.`);
      }
      return {
        ...common,
        status: 'cancelled',
        pendingGate: undefined,
        outcome: {
          kind: 'rejected',
          source: 'plan_rejected',
          changed: false,
          warnings: [],
          ...(command.payload.reason === undefined ? {} : { reason: command.payload.reason }),
        },
      };
    case 'answer':
      requirePendingGate(snapshot, 'question');
      if (snapshot.pendingGate?.gateId !== command.payload.toolCallId) {
        throw new RunStoreConflictError(`Answer does not match the pending question.`);
      }
      return { ...common, status: 'executing', pendingGate: undefined };
    case 'steer':
      return { ...common, status: snapshot.status };
    case 'cancel':
      return {
        ...common,
        status: 'cancelled',
        pendingGate: undefined,
        outcome: {
          kind: 'cancelled',
          source: command.payload.source,
          changed: snapshot.patchDecisions.some((decision) => decision.state === 'committed'),
          warnings: [],
          reason: command.payload.reason,
        },
      };
    case 'resume':
      if (snapshot.status !== 'suspended') {
        throw new RunStoreConflictError(`Only a suspended run can resume.`);
      }
      return { ...withoutOutcome(common), status: 'accepted', pendingGate: undefined };
    case 'accept_patch':
    case 'reject_patch':
      return {
        ...common,
        status: snapshot.status,
        patchDecisions: updatePatchDecision(snapshot, command),
        ...(command.kind === 'accept_patch'
          ? {
              outcome: {
                kind: 'completed_with_changes' as const,
                changed: true,
                warnings: snapshot.outcome?.warnings ?? [],
              },
            }
          : {}),
        pendingGate:
          snapshot.pendingGate?.kind === 'patch_review' &&
          snapshot.pendingGate.gateId === command.payload.patchId
            ? undefined
            : snapshot.pendingGate,
      };
  }
}

function projectPatchLifecycle(snapshot: RunSnapshot, event: RunEventEnvelope): RunSnapshot {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    throw new RunStoreConflictError('Patch lifecycle event payload is invalid.');
  }
  const value = event.payload as { readonly [key: string]: JsonValue };
  const patchId = value['patchId'];
  const state = value['state'];
  if (
    typeof patchId !== 'string' ||
    (state !== 'proposed' && state !== 'stale' && state !== 'committed' && state !== 'rebased')
  ) {
    throw new RunStoreConflictError('Patch lifecycle event fields are invalid.');
  }
  const existing = snapshot.patchDecisions.find((decision) => decision.patchId === patchId);
  const projectRevision = event.projectRevision;
  const nextDecision: RunSnapshot['patchDecisions'][number] =
    state === 'proposed'
      ? (existing ?? { patchId, state: 'pending' })
      : {
          ...(existing ?? { patchId, state: 'pending' as const }),
          state: state === 'stale' ? 'stale' : 'committed',
          decidedAt: event.occurredAt,
          ...(projectRevision === undefined ? {} : { projectRevision }),
          ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
        };
  return {
    ...snapshot,
    ...(projectRevision === undefined ? {} : { currentProjectRevision: projectRevision }),
    patchDecisions: [
      ...snapshot.patchDecisions.filter((decision) => decision.patchId !== patchId),
      nextDecision,
    ],
    lastSequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}

function initialSnapshot(command: Extract<RunCommandEnvelope, { kind: 'start' }>): RunSnapshot {
  return {
    schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
    runId: command.runId,
    projectId: command.projectId,
    status: 'accepted',
    baseProjectRevision: command.expectedProjectRevision ?? 0,
    currentProjectRevision: command.expectedProjectRevision ?? 0,
    lastSequence: 1,
    graphVersion: 1,
    tasks: [],
    effects: [],
    patchDecisions: [],
    budgets: {},
    contextHandles: command.payload.contextHandles,
    patchPolicy: command.payload.patchPolicy,
    createdAt: command.issuedAt,
    updatedAt: command.issuedAt,
  };
}

function gateFromEvent(event: RunEventEnvelope): NonNullable<RunSnapshot['pendingGate']> {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    throw new RunStoreConflictError('Gate event payload is invalid.');
  }
  const value = event.payload as { readonly [key: string]: JsonValue };
  const gateId = value['gateId'];
  const kind = value['gateKind'];
  const requestedAt = value['requestedAt'];
  if (
    typeof gateId !== 'string' ||
    (kind !== 'plan_approval' && kind !== 'question' && kind !== 'patch_review') ||
    typeof requestedAt !== 'number'
  ) {
    throw new RunStoreConflictError('Gate event fields are invalid.');
  }
  const expiresAt = value['expiresAt'];
  return {
    gateId,
    kind,
    requestedAt,
    payload: value['gatePayload'] ?? null,
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
  };
}

function terminalFromEvent(event: RunEventEnvelope): {
  readonly status: CompleteRunInput['status'];
  readonly outcome: RunOutcome;
} {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    throw new RunStoreConflictError('Terminal event payload is invalid.');
  }
  const value = event.payload as { readonly [key: string]: JsonValue };
  const status = value['status'];
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    throw new RunStoreConflictError('Terminal run status is invalid.');
  }
  const outcome = RunOutcomeSchema.parse(value['outcome']);
  return { status, outcome };
}

function streamStatus(event: JsonValue): RunSnapshot['status'] | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  const record = event as { readonly [key: string]: JsonValue };
  if (record['type'] !== 'status') return null;
  const parsed = RunStatusSchema.safeParse(record['status']);
  if (!parsed.success || TERMINAL_STATUSES.has(parsed.data)) return null;
  return parsed.data;
}

function streamWorkingState(event: JsonValue): JsonValue | undefined {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined;
  const record = event as { readonly [key: string]: JsonValue };
  return record['type'] === 'run_state' ? record['working'] : undefined;
}

function validateWorkingStateProjection(snapshot: RunSnapshot, value: JsonValue): JsonValue {
  const next = parseWorkingState(value);
  if (next === null) {
    throw new RunStoreConflictError('Run-state event contains an invalid causal ledger.');
  }
  if (next.runId !== snapshot.runId || next.identity.projectId !== snapshot.projectId) {
    throw new RunStoreConflictError('Run-state identity does not match the durable run.');
  }
  const previous = parseWorkingState(snapshot.workingState);
  if (previous && next.version < previous.version) {
    throw new RunStoreConflictError(
      `Run-state version moved backward from ${previous.version} to ${next.version}.`,
    );
  }
  if (
    previous &&
    next.version === previous.version &&
    JSON.stringify(next) !== JSON.stringify(previous)
  ) {
    throw new RunStoreConflictError(
      `Run-state version ${next.version} was reused with different content.`,
    );
  }
  return JsonValueSchema.parse(next);
}

function projectRuntimeEffect(snapshot: RunSnapshot, event: RunEventEnvelope): RunSnapshot {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    throw new RunStoreConflictError('Runtime effect event payload is invalid.');
  }
  const value = event.payload as { readonly [key: string]: JsonValue };
  const effectId = value['effectId'];
  const taskId = value['taskId'];
  const effectKind = value['effectKind'];
  const idempotencyKey = value['idempotencyKey'];
  const phase = value['phase'];
  if (
    typeof effectId !== 'string' ||
    typeof taskId !== 'string' ||
    typeof effectKind !== 'string' ||
    typeof idempotencyKey !== 'string' ||
    (phase !== 'requested' && phase !== 'settled' && phase !== 'failed' && phase !== 'cancelled')
  ) {
    throw new RunStoreConflictError('Runtime effect event fields are invalid.');
  }
  const previous = snapshot.effects.find((effect) => effect.effectId === effectId);
  const nextEffect: RunSnapshot['effects'][number] = {
    effectId,
    taskId,
    kind: effectKind,
    state:
      phase === 'requested'
        ? 'running'
        : phase === 'settled'
          ? 'settled'
          : phase === 'cancelled'
            ? 'cancelled'
            : 'failed',
    attempt: previous?.attempt ?? 1,
    idempotencyKey,
    ...(value['outcome'] === undefined ? {} : { outcome: value['outcome'] }),
  };
  return {
    ...snapshot,
    effects: [...snapshot.effects.filter((effect) => effect.effectId !== effectId), nextEffect],
    lastSequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}

/**
 * Owns command ordering, durable state transitions, and publication for every
 * desktop run. The execution runtime records its outcomes through this boundary
 * in the next foundation phase.
 */
export class RunCoordinator {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  public constructor(private readonly store: RunStore) {}

  public accept(value: unknown): Promise<AcceptedRunCommand> {
    const command = parseRunCommand(value);
    return this.withRunLane(command.runId, () => this.acceptUnlocked(command));
  }

  public snapshot(runId: string): Promise<RunSnapshot | null> {
    return this.withRunLane(runId, async () => {
      const stored = await this.store.load(runId);
      return this.recoverSnapshot(stored);
    });
  }

  public subscribe(
    runId: string,
    afterSequence: number,
    listener: RunEventListener,
  ): Promise<RunSubscription> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      return Promise.reject(new Error('Run cursor must be a non-negative integer.'));
    }
    return this.withRunLane(runId, async () => {
      const stored = await this.store.load(runId);
      const snapshot = await this.recoverSnapshot(stored);
      const replay = stored.events.filter((event) => event.sequence > afterSequence);
      const events = replay.slice(0, MAX_REPLAY_EVENTS);
      const hasMore = replay.length > events.length;
      const subscriber = { listener };
      if (!hasMore) {
        const runSubscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
        runSubscribers.add(subscriber);
        this.subscribers.set(runId, runSubscribers);
      }
      return {
        snapshot,
        events,
        hasMore,
        unsubscribe: () => {
          const current = this.subscribers.get(runId);
          current?.delete(subscriber);
          if (current?.size === 0) this.subscribers.delete(runId);
        },
      };
    });
  }

  public openGate(input: OpenRunGateInput): Promise<RunSnapshot> {
    return this.withRunLane(input.runId, async () => {
      const stored = await this.store.load(input.runId);
      const current = await this.recoverSnapshot(stored);
      if (current === null || current.projectId !== input.projectId) {
        throw new RunStoreConflictError('Run gate project does not match the durable run.');
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new RunStoreConflictError('A terminal run cannot open a wait gate.');
      }
      if (current.pendingGate !== undefined) {
        if (
          current.pendingGate.gateId === input.gateId &&
          current.pendingGate.kind === input.kind
        ) {
          return current;
        }
        throw new RunStoreConflictError('Run already has a pending wait gate.');
      }
      const occurredAt = input.requestedAt ?? Date.now();
      const event: RunEventEnvelope = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: this.createEventId(),
        runId: input.runId,
        projectId: input.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        occurredAt,
        kind: 'run.gate_opened',
        payload: {
          gateId: input.gateId,
          gateKind: input.kind,
          requestedAt: occurredAt,
          gatePayload: input.payload,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
      };
      const snapshot: RunSnapshot = {
        ...current,
        status:
          input.kind === 'plan_approval'
            ? 'awaiting_approval'
            : input.kind === 'question'
              ? 'awaiting_answer'
              : 'awaiting_review',
        pendingGate: gateFromEvent(event),
        lastSequence: event.sequence,
        updatedAt: occurredAt,
      };
      await this.store.append(event);
      await this.store.saveSnapshot(snapshot);
      this.publish(event);
      return snapshot;
    });
  }

  public complete(input: CompleteRunInput): Promise<RunSnapshot> {
    return this.withRunLane(input.runId, async () => {
      const stored = await this.store.load(input.runId);
      const current = await this.recoverSnapshot(stored);
      if (current === null || current.projectId !== input.projectId) {
        throw new RunStoreConflictError('Terminal outcome project does not match the run.');
      }
      const existingTerminal = stored.events.some((event) => event.kind === 'run.terminal');
      if (existingTerminal) return current;
      const occurredAt = input.occurredAt ?? Date.now();
      // Cancel/reject commands become terminal as soon as their durable command is
      // accepted, before provider teardown settles. They still require the canonical
      // `run.terminal` event that subscribers use to stop replay. Preserve that
      // command-authored outcome rather than replacing its source/reason with the later
      // AbortController settlement.
      const alreadyTerminal = TERMINAL_STATUSES.has(current.status);
      const status = alreadyTerminal
        ? (current.status as CompleteRunInput['status'])
        : input.status;
      const outcome = RunOutcomeSchema.parse(
        alreadyTerminal && current.outcome !== undefined ? current.outcome : input.outcome,
      );
      const compatible =
        (status === 'completed' && outcome.kind.startsWith('completed_')) ||
        (status === 'failed' &&
          (outcome.kind === 'failed' ||
            outcome.kind === 'interrupted' ||
            outcome.kind === 'timed_out')) ||
        (status === 'cancelled' && (outcome.kind === 'cancelled' || outcome.kind === 'rejected'));
      if (!compatible) {
        throw new RunStoreConflictError('Terminal status and outcome kind do not match.');
      }
      const event: RunEventEnvelope = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: this.createEventId(),
        runId: input.runId,
        projectId: input.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        occurredAt,
        kind: 'run.terminal',
        payload: {
          status,
          outcome: JsonValueSchema.parse(outcome),
        },
      };
      const snapshot: RunSnapshot = {
        ...current,
        status,
        outcome,
        pendingGate: undefined,
        lastSequence: event.sequence,
        updatedAt: occurredAt,
      };
      await this.store.append(event);
      await this.store.saveSnapshot(snapshot);
      this.publish(event);
      log.action('terminal run outcome persisted', {
        runId: input.runId,
        status,
        kind: outcome.kind,
        source: outcome.source,
        reason: outcome.reason,
      });
      return snapshot;
    });
  }

  /**
   * Finalize every run left non-terminal by an interrupted process (a crash, a hard
   * kill, or a quit that raced the durable settlement write). Called once at startup
   * BEFORE any renderer can subscribe: an in-flight run has no live producer after a
   * restart, so recovery would otherwise re-subscribe and hang on "Stop" forever. Each
   * orphan is closed as an interrupted failure with an honest reason, so an app/process
   * loss can never masquerade as a user cancellation and the renderer cannot recover
   * into a permanently "in progress" run. Returns the ids it reconciled.
   */
  public async reconcileInterruptedRuns(
    reason = 'The app closed before this run finished.',
  ): Promise<readonly string[]> {
    const runIds = await this.store.listRunIds();
    const reconciled: string[] = [];
    for (const runId of runIds) {
      try {
        // Classify from the few-KB snapshot first. A full load would read and parse this
        // run's entire WAL — tens of MB each, for every run the user has ever made — and
        // the overwhelming majority are already finished. A terminal snapshot is written
        // only once no further events can be appended, so it is conclusive on its own.
        const committed = await this.store.peekSnapshot(runId);
        if (committed !== null && TERMINAL_STATUSES.has(committed.status)) continue;
        const snapshot = await this.snapshot(runId);
        if (snapshot === null || TERMINAL_STATUSES.has(snapshot.status)) {
          this.store.evict(runId);
          continue;
        }
        await this.complete({
          runId,
          projectId: snapshot.projectId,
          status: 'failed',
          outcome: {
            kind: 'interrupted',
            source: 'process_restart',
            changed: snapshot.patchDecisions.some((decision) => decision.state === 'committed'),
            warnings: [],
            reason,
          },
        });
        reconciled.push(runId);
      } catch (error) {
        // A single corrupt/quarantined run must not block reconciling the rest, nor
        // take down startup. Log and move on.
        log.warn('interrupted run reconciliation skipped', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (reconciled.length > 0) {
      log.action('reconciled interrupted runs at startup', { count: reconciled.length });
    }
    return reconciled;
  }

  /** Persist one compatibility-stream event before any renderer observes it. */
  public recordStreamEvent(input: RecordStreamEventInput): Promise<RunEventEnvelope> {
    return this.withRunLane(input.runId, async () => {
      const stored = await this.store.load(input.runId);
      // Do not persist the recovered projection here: this hot path is called for
      // every streamed token. It is replayed from at most one checkpoint interval
      // of WAL below, then checkpointed only when useful.
      const current = await this.recoverSnapshot(stored, false);
      if (current === null || current.projectId !== input.projectId) {
        throw new RunStoreConflictError('Stream event project does not match the durable run.');
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        // Benign race: the model can still emit a token or two AFTER the run reached a
        // terminal state (the user hit Stop, or rejected a gate — both mark the run
        // terminal mid-stream). Dropping these late events is correct — a finished
        // run's durable log is closed — and it must NOT be treated as an error.
        // Throwing here previously aborted the whole stream finalization, surfacing a
        // scary "A terminal run cannot accept stream events." banner and leaving the
        // last reasoning node shimmering "Thinking…". Return the last recorded event so
        // the caller gets a valid sequence and moves on; nothing new is appended.
        const last = stored.events.at(-1);
        if (last !== undefined) return last;
        throw new RunStoreConflictError('A terminal run cannot accept stream events.');
      }
      const previous = stored.events.at(-1);
      if (
        previous?.kind === 'run.stream_event' &&
        JSON.stringify(previous.payload) ===
          JSON.stringify({ event: JsonValueSchema.parse(input.event) })
      ) {
        log.debug('duplicate stream event dropped', {
          runId: input.runId,
          sequence: previous.sequence,
        });
        return previous;
      }
      const occurredAt = input.occurredAt ?? Date.now();
      const event: RunEventEnvelope = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: this.createEventId(),
        runId: input.runId,
        projectId: input.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        occurredAt,
        kind: 'run.stream_event',
        payload: { event: JsonValueSchema.parse(input.event) },
      };
      const status = streamStatus(input.event);
      const rawWorkingState = streamWorkingState(input.event);
      const workingState =
        rawWorkingState === undefined
          ? undefined
          : validateWorkingStateProjection(current, rawWorkingState);
      const statusChanged = status !== null && status !== current.status;
      const snapshot: RunSnapshot = {
        ...current,
        ...(status === null ? {} : { status }),
        ...(workingState === undefined ? {} : { workingState }),
        lastSequence: event.sequence,
        updatedAt: occurredAt,
      };
      await this.store.append(event);
      if (statusChanged || event.sequence % STREAM_SNAPSHOT_INTERVAL === 0) {
        await this.store.saveSnapshot(snapshot);
      }
      this.publish(event);
      return event;
    });
  }

  /** Persist one canonical EditorRun stage beside, not inside, presentation events. */
  public recordEditorLifecycle(input: RecordEditorLifecycleInput): Promise<RunEventEnvelope> {
    return this.withRunLane(input.runId, async () => {
      const stored = await this.store.load(input.runId);
      const current = await this.recoverSnapshot(stored, false);
      if (current === null || current.projectId !== input.projectId) {
        throw new RunStoreConflictError('Editor lifecycle project does not match the durable run.');
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new RunStoreConflictError('A terminal run cannot record editor lifecycle events.');
      }
      const stageEvent = parseEditorRunStageEvent(input.event);
      if (stageEvent.runId !== input.runId) {
        throw new RunStoreConflictError('Editor lifecycle event run id does not match its WAL.');
      }
      const event: RunEventEnvelope = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: this.createEventId(),
        runId: input.runId,
        projectId: input.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        occurredAt: stageEvent.occurredAt,
        kind: 'run.editor_lifecycle',
        payload: { event: JsonValueSchema.parse(stageEvent) },
      };
      await this.store.append(event);
      this.publish(event);
      return event;
    });
  }

  public recordRuntimeEffect(input: RecordRuntimeEffectInput): Promise<RunEventEnvelope> {
    return this.withRunLane(input.runId, async () => {
      const stored = await this.store.load(input.runId);
      const current = await this.recoverSnapshot(stored);
      if (current === null || current.projectId !== input.projectId) {
        throw new RunStoreConflictError('Runtime effect project does not match the run.');
      }
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new RunStoreConflictError('A terminal run cannot record runtime effects.');
      }
      const occurredAt = input.occurredAt ?? Date.now();
      const detail = boundEffectField(input.detail, 'detail');
      const outcome = boundEffectField(input.outcome, 'outcome');
      const event: RunEventEnvelope = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: this.createEventId(),
        runId: input.runId,
        projectId: input.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        causedByEffectId: input.effectId,
        occurredAt,
        kind: `run.effect_${input.phase}`,
        payload: {
          effectId: input.effectId,
          taskId: input.taskId,
          effectKind: input.effectKind,
          idempotencyKey: input.idempotencyKey,
          phase: input.phase,
          ...(detail === undefined ? {} : { detail }),
          ...(outcome === undefined ? {} : { outcome }),
        },
      };
      const snapshot = projectRuntimeEffect(current, event);
      await this.store.append(event);
      await this.store.saveSnapshot(snapshot);
      this.publish(event);
      return event;
    });
  }

  /** Persist project-patch truth independently of renderer review state. */
  public recordPatchLifecycle(input: RecordPatchLifecycleInput): Promise<RunEventEnvelope> {
    return this.withRunLane(input.runId, async () => {
      const stored = await this.store.load(input.runId);
      const current = await this.recoverSnapshot(stored);
      if (current === null || current.projectId !== input.projectId) {
        throw new RunStoreConflictError('Patch lifecycle project does not match the run.');
      }
      const occurredAt = input.occurredAt ?? Date.now();
      const event: RunEventEnvelope = {
        schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
        eventId: this.createEventId(),
        runId: input.runId,
        projectId: input.projectId,
        sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
        ...(input.projectRevision === undefined ? {} : { projectRevision: input.projectRevision }),
        occurredAt,
        kind: `run.patch_${input.state}`,
        payload: {
          patchId: input.patchId,
          state: input.state,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      };
      const snapshot = projectPatchLifecycle(current, event);
      await this.store.append(event);
      await this.store.saveSnapshot(snapshot);
      this.publish(event);
      return event;
    });
  }

  private async acceptUnlocked(command: RunCommandEnvelope): Promise<AcceptedRunCommand> {
    const stored = await this.store.load(command.runId);
    const currentSnapshot = await this.recoverSnapshot(stored);
    const duplicate = this.findCommand(stored, command.commandId);
    if (duplicate !== null) {
      if (JSON.stringify(duplicate) !== JSON.stringify(command)) {
        throw new RunStoreConflictError(
          `Command id "${command.commandId}" was already used with different content.`,
        );
      }
      if (currentSnapshot === null) {
        throw new RunStoreConflictError(`Durable command exists without a run snapshot.`);
      }
      const event = stored.events.find((candidate) => candidate.eventId === command.commandId);
      if (event === undefined) {
        throw new RunStoreConflictError(`Durable command event could not be resolved.`);
      }
      return { command, event, snapshot: currentSnapshot };
    }

    if (command.kind === 'start' && stored.events.length > 0) {
      throw new RunStoreConflictError(`Run "${command.runId}" has already started.`);
    }
    if (command.kind !== 'start' && currentSnapshot === null) {
      throw new RunStoreConflictError(`Run "${command.runId}" does not exist.`);
    }

    if (
      currentSnapshot !== null &&
      (command.kind === 'accept_patch' || command.kind === 'reject_patch')
    ) {
      const desiredState = command.kind === 'accept_patch' ? 'committed' : 'rejected';
      const existingDecision = currentSnapshot.patchDecisions.find(
        (decision) => decision.patchId === command.payload.patchId,
      );
      if (existingDecision?.state === desiredState) {
        const priorDecisionEvent = [...stored.events].reverse().find((candidate) => {
          const priorCommand = commandFromEvent(candidate);
          return priorCommand?.kind === command.kind &&
            priorCommand.payload.patchId === command.payload.patchId;
        });
        if (priorDecisionEvent !== undefined) {
          return { command, event: priorDecisionEvent, snapshot: currentSnapshot };
        }
      }
    }

    const event: RunEventEnvelope = {
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      eventId: command.commandId,
      runId: command.runId,
      projectId: command.projectId,
      sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
      causedByCommandId: command.commandId,
      projectRevision: command.expectedProjectRevision,
      occurredAt: command.issuedAt,
      kind:
        command.kind === 'accept_patch'
          ? 'run.patch_accepted'
          : command.kind === 'reject_patch'
            ? 'run.patch_rejected'
            : 'run.command_accepted',
      payload: { command: commandAsJson(command) },
    };
    const snapshot =
      command.kind === 'start'
        ? initialSnapshot(command)
        : reduceCommand(currentSnapshot as RunSnapshot, command);

    await this.store.append(event);
    await this.store.saveSnapshot(snapshot);
    this.publish(event);
    log.action('run command accepted', {
      runId: command.runId,
      commandId: command.commandId,
      kind: command.kind,
      sequence: event.sequence,
      ...(command.kind === 'cancel'
        ? { cancellationSource: command.payload.source, reason: command.payload.reason }
        : {}),
    });
    return { command, event, snapshot };
  }

  private findCommand(stored: StoredRun, commandId: string): RunCommandEnvelope | null {
    const event = stored.events.find((candidate) => candidate.eventId === commandId);
    return event === undefined ? null : commandFromEvent(event);
  }

  /**
   * Replays a fsynced command tail when a process stopped between WAL append and
   * snapshot rename. The repaired snapshot is persisted before it is returned.
   */
  private async recoverSnapshot(
    stored: StoredRun,
    persistRecovered = true,
  ): Promise<RunSnapshot | null> {
    let snapshot = stored.snapshot;
    const startingSequence = snapshot?.lastSequence ?? 0;
    for (const event of stored.events) {
      if (event.sequence <= startingSequence) continue;
      if (snapshot === null) {
        const command = commandFromEvent(event);
        if (command === null || command.kind !== 'start' || event.sequence !== 1) {
          throw new RunStoreConflictError(`Run WAL does not begin with a start command.`);
        }
        snapshot = initialSnapshot(command);
      } else {
        const command = commandFromEvent(event);
        if (command !== null) {
          snapshot = reduceCommand(snapshot, command);
        } else if (event.kind === 'run.gate_opened') {
          const gate = gateFromEvent(event);
          snapshot = {
            ...snapshot,
            status:
              gate.kind === 'plan_approval'
                ? 'awaiting_approval'
                : gate.kind === 'question'
                  ? 'awaiting_answer'
                  : 'awaiting_review',
            pendingGate: gate,
            lastSequence: event.sequence,
            updatedAt: event.occurredAt,
          };
        } else if (event.kind === 'run.terminal') {
          const terminal = terminalFromEvent(event);
          snapshot = {
            ...snapshot,
            status: terminal.status,
            outcome: terminal.outcome,
            pendingGate: undefined,
            lastSequence: event.sequence,
            updatedAt: event.occurredAt,
          };
        } else if (event.kind === 'run.stream_event') {
          if (
            typeof event.payload !== 'object' ||
            event.payload === null ||
            Array.isArray(event.payload)
          ) {
            throw new RunStoreConflictError('Stream event envelope is invalid.');
          }
          const streamEvent = (event.payload as { readonly [key: string]: JsonValue })['event'];
          if (streamEvent === undefined) {
            throw new RunStoreConflictError('Stream event payload is missing.');
          }
          const status = streamStatus(streamEvent);
          const rawWorkingState = streamWorkingState(streamEvent);
          const workingState =
            rawWorkingState === undefined
              ? undefined
              : validateWorkingStateProjection(snapshot, rawWorkingState);
          snapshot = {
            ...snapshot,
            ...(status === null ? {} : { status }),
            ...(workingState === undefined ? {} : { workingState }),
            lastSequence: event.sequence,
            updatedAt: event.occurredAt,
          };
        } else if (event.kind === 'run.editor_lifecycle') {
          if (
            typeof event.payload !== 'object' ||
            event.payload === null ||
            Array.isArray(event.payload)
          ) {
            throw new RunStoreConflictError('Editor lifecycle event envelope is invalid.');
          }
          const stageEvent = (event.payload as { readonly [key: string]: JsonValue })['event'];
          parseEditorRunStageEvent(stageEvent);
          snapshot = {
            ...snapshot,
            lastSequence: event.sequence,
            updatedAt: event.occurredAt,
          };
        } else if (event.kind.startsWith('run.effect_')) {
          snapshot = projectRuntimeEffect(snapshot, event);
        } else if (
          event.kind === 'run.patch_proposed' ||
          event.kind === 'run.patch_stale' ||
          event.kind === 'run.patch_committed' ||
          event.kind === 'run.patch_rebased'
        ) {
          snapshot = projectPatchLifecycle(snapshot, event);
        } else {
          throw new RunStoreConflictError(
            `No snapshot projector is registered for event kind "${event.kind}".`,
          );
        }
      }
      if (snapshot.lastSequence !== event.sequence) {
        throw new RunStoreConflictError(`Recovered snapshot sequence does not match the WAL.`);
      }
    }
    if (persistRecovered && snapshot !== null && snapshot.lastSequence > startingSequence) {
      await this.store.saveSnapshot(snapshot);
      log.action('run snapshot recovered from WAL', {
        runId: snapshot.runId,
        fromSequence: startingSequence,
        toSequence: snapshot.lastSequence,
      });
    }
    return snapshot;
  }

  private createEventId(): string {
    return randomUUID();
  }

  private publish(event: RunEventEnvelope): void {
    for (const subscriber of this.subscribers.get(event.runId) ?? []) {
      try {
        subscriber.listener(event);
      } catch (error) {
        log.warn('run subscriber rejected event', {
          runId: event.runId,
          sequence: event.sequence,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private withRunLane<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const lane = result.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(runId, lane);
    void lane.finally(() => {
      if (this.lanes.get(runId) === lane) this.lanes.delete(runId);
    });
    return result;
  }
}

/**
 * Client-facing facade that assigns unguessable ids and timestamps before a
 * command reaches the coordinator's schema boundary.
 */
export class RunGateway {
  public constructor(
    private readonly coordinator: RunCoordinator,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  public start(input: StartRunInput): Promise<AcceptedRunCommand> {
    return this.coordinator.accept({
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      commandId: this.createId(),
      runId: this.createId(),
      projectId: input.projectId,
      expectedProjectRevision: input.projectRevision,
      issuedAt: this.now(),
      kind: 'start',
      payload: {
        userPrompt: input.userPrompt,
        mode: input.mode,
        ...(input.selection === undefined ? {} : { selection: input.selection }),
        ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
        contextHandles: [...(input.contextHandles ?? [])],
        // Edits apply as they land; there is no manual review path to fall back to, so a
        // caller that names no policy gets the only one the product actually offers. The
        // old `review` default would have left such a run's edits parked forever with no
        // UI able to accept them.
        patchPolicy: input.patchPolicy ?? 'auto_commit',
      },
    });
  }

  public command(input: RunCommandInput): Promise<AcceptedRunCommand> {
    return this.coordinator.accept({
      schemaVersion: RUN_PROTOCOL_SCHEMA_VERSION,
      commandId: this.createId(),
      runId: input.runId,
      projectId: input.projectId,
      ...(input.expectedProjectRevision === undefined
        ? {}
        : { expectedProjectRevision: input.expectedProjectRevision }),
      issuedAt: this.now(),
      kind: input.kind,
      payload: input.payload,
    });
  }

  public subscribe(
    runId: string,
    afterSequence: number,
    listener: RunEventListener,
  ): Promise<RunSubscription> {
    return this.coordinator.subscribe(runId, afterSequence, listener);
  }

  public snapshot(runId: string): Promise<RunSnapshot | null> {
    return this.coordinator.snapshot(runId);
  }
}
