/**
 * Sender-scoped Electron adapter for the durable run gateway.
 *
 * The adapter contains no Electron import, so privileged sender handles never
 * enter the protocol layer and the lifecycle/scoping logic remains reusable.
 */
import { randomUUID } from 'node:crypto';
import { DURABLE_RUN_MODES, type AiEvent } from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import type {
  DurableRunAccepted,
  DurableRunCommandRequest,
  DurableRunEvent,
  DurableRunEventMessage,
  DurableRunSnapshot,
  DurableRunSnapshotRequest,
  DurableRunStartRequest,
  DurableRunSubscribeRequest,
  DurableRunSubscription,
} from '../ipc/contract.js';
import {
  RunGateway,
  type RunSubscription,
  type StartRunInput,
  type RunCommandInput,
} from './run-coordinator.js';
import { RunStoreConflictError } from './run-store.js';
import { prepareAiEventForTransport } from './ai-event-transport.js';

const log = createLogger('desktop:ai:run-ipc');

export interface RunIpcSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, message: DurableRunEventMessage): void;
  once(event: 'destroyed', listener: () => void): void;
  removeListener(event: 'destroyed', listener: () => void): void;
}

interface OwnedRun {
  readonly senderId: number;
  readonly projectId: string;
}

interface LiveSubscription {
  readonly senderId: number;
  readonly runId: string;
  readonly subscription: RunSubscription;
  lastAcknowledged: number;
  lastSent: number;
  lastActivityAt: number;
}

const MAX_UNACKNOWLEDGED_EVENTS = 256;
const SUBSCRIPTION_LEASE_MS = 60_000;
const LEASE_SWEEP_MS = 15_000;

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Modes a renderer may START. `planned-edit` is absent: the route was retired (ADR 0126),
 * so asking for it is a renderer/main version mismatch and must fail loudly rather than
 * silently running something else. Historic durable records that still carry it are handled
 * on the read side by `run-contracts.ts`, which normalizes them to `agent`.
 */
const RUN_MODES: ReadonlySet<string> = new Set(DURABLE_RUN_MODES);
const RUN_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'approve_plan',
  'reject_plan',
  'answer',
  'steer',
  'cancel',
  'resume',
  'accept_patch',
  'reject_patch',
]);

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requirePrompt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('User prompt must be a non-empty string.');
  }
  return value;
}

function parseStartRequest(value: unknown): DurableRunStartRequest {
  const record = requireObject(value, 'Run start request');
  const mode = requireId(record['mode'], 'Run mode');
  if (!RUN_MODES.has(mode)) throw new Error(`Unsupported run mode "${mode}".`);
  const userPrompt = requirePrompt(record['userPrompt']);
  const contextHandles = record['contextHandles'];
  const patchPolicy = record['patchPolicy'];
  if (patchPolicy !== undefined && patchPolicy !== 'review' && patchPolicy !== 'auto_commit') {
    throw new Error('Run patch policy must be "review" or "auto_commit".');
  }
  if (
    contextHandles !== undefined &&
    (!Array.isArray(contextHandles) ||
      contextHandles.some((handle) => typeof handle !== 'string' || handle.length === 0))
  ) {
    throw new Error('Context handles must be an array of non-empty strings.');
  }
  return {
    projectId: requireId(record['projectId'], 'Project id'),
    projectRevision: requireRevision(record['projectRevision'], 'Project revision'),
    userPrompt,
    mode: mode as DurableRunStartRequest['mode'],
    ...(record['selection'] === undefined ? {} : { selection: record['selection'] }),
    ...(record['agentOptions'] === undefined ? {} : { agentOptions: record['agentOptions'] }),
    ...(contextHandles === undefined
      ? {}
      : { contextHandles: contextHandles as readonly string[] }),
    ...(patchPolicy === undefined ? {} : { patchPolicy: patchPolicy as 'review' | 'auto_commit' }),
  };
}

function parseCommandRequest(value: unknown): DurableRunCommandRequest {
  const record = requireObject(value, 'Run command request');
  const kind = requireId(record['kind'], 'Run command kind');
  if (!RUN_COMMAND_KINDS.has(kind)) {
    throw new Error(`Unsupported run command "${kind}".`);
  }
  const expectedProjectRevision = record['expectedProjectRevision'];
  return {
    runId: requireId(record['runId'], 'Run id'),
    projectId: requireId(record['projectId'], 'Project id'),
    ...(expectedProjectRevision === undefined
      ? {}
      : {
          expectedProjectRevision: requireRevision(
            expectedProjectRevision,
            'Expected project revision',
          ),
        }),
    kind: kind as DurableRunCommandRequest['kind'],
    payload: record['payload'],
  };
}

function parseSnapshotRequest(value: unknown): DurableRunSnapshotRequest {
  const record = requireObject(value, 'Run snapshot request');
  return {
    runId: requireId(record['runId'], 'Run id'),
    projectId: requireId(record['projectId'], 'Project id'),
  };
}

function parseSubscribeRequest(value: unknown): DurableRunSubscribeRequest {
  const record = requireObject(value, 'Run subscription request');
  return {
    ...parseSnapshotRequest(record),
    afterSequence: requireRevision(record['afterSequence'], 'Run cursor'),
  };
}

/** Bound a legacy WAL event before an invoke response or live push crosses Electron IPC. */
function prepareDurableEventForTransport(event: DurableRunEvent): DurableRunEvent {
  if (
    event.kind !== 'run.stream_event' ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return event;
  }
  const payload = event.payload as Record<string, unknown>;
  const streamEvent = payload['event'];
  if (
    typeof streamEvent !== 'object' ||
    streamEvent === null ||
    Array.isArray(streamEvent) ||
    (streamEvent as Record<string, unknown>)['type'] !== 'tool_result'
  ) {
    return event;
  }
  const prepared = prepareAiEventForTransport(streamEvent as AiEvent);
  return prepared === streamEvent
    ? event
    : ({ ...event, payload: { ...payload, event: prepared } } as DurableRunEvent);
}

/**
 * Bridges IPC invocations to one gateway while preventing a renderer from
 * commanding or observing a run owned by another live sender.
 */
export class RunIpcHub {
  private readonly owners = new Map<string, OwnedRun>();
  private readonly subscriptions = new Map<string, LiveSubscription>();
  private readonly senderCleanup = new Map<number, () => void>();
  private readonly leaseTimer: ReturnType<typeof setInterval>;

  public constructor(
    private readonly gateway: RunGateway,
    private readonly eventChannel: string,
  ) {
    this.leaseTimer = setInterval(() => this.expireInactiveSubscriptions(), LEASE_SWEEP_MS);
    this.leaseTimer.unref();
  }

  public async start(sender: RunIpcSender, value: unknown): Promise<DurableRunAccepted> {
    const input = parseStartRequest(value);
    const accepted = await this.gateway.start(input as StartRunInput);
    this.claim(sender, accepted.snapshot.runId, accepted.snapshot.projectId);
    return accepted;
  }

  public async command(sender: RunIpcSender, value: unknown): Promise<DurableRunAccepted> {
    const input = parseCommandRequest(value);
    await this.authorize(sender, input.runId, input.projectId);
    return this.gateway.command(input as RunCommandInput);
  }

  public async snapshot(sender: RunIpcSender, value: unknown): Promise<DurableRunSnapshot | null> {
    const input = parseSnapshotRequest(value);
    await this.authorize(sender, input.runId, input.projectId);
    return this.gateway.snapshot(input.runId);
  }

  public async subscribe(sender: RunIpcSender, value: unknown): Promise<DurableRunSubscription> {
    const input = parseSubscribeRequest(value);
    await this.authorize(sender, input.runId, input.projectId);
    const subscriptionId = randomUUID();
    const pendingEvents: DurableRunEvent[] = [];
    let armed = false;
    const subscription = await this.gateway.subscribe(input.runId, input.afterSequence, (event) => {
      const transportEvent = prepareDurableEventForTransport(event);
      if (!armed) {
        pendingEvents.push(transportEvent);
        return;
      }
      const active = this.subscriptions.get(subscriptionId);
      if (active === undefined) return;
      if (transportEvent.sequence - active.lastAcknowledged > MAX_UNACKNOWLEDGED_EVENTS) {
        this.sendToRenderer(sender, subscriptionId, {
          subscriptionId,
          resyncRequired: { afterSequence: active.lastAcknowledged },
        });
        this.detachSubscription(subscriptionId, active);
        return;
      }
      active.lastSent = transportEvent.sequence;
      this.sendToRenderer(sender, subscriptionId, { subscriptionId, event: transportEvent });
    });
    this.subscriptions.set(subscriptionId, {
      senderId: sender.id,
      runId: input.runId,
      subscription,
      lastAcknowledged: input.afterSequence,
      lastSent: subscription.events.at(-1)?.sequence ?? input.afterSequence,
      lastActivityAt: Date.now(),
    });
    armed = true;
    for (const event of pendingEvents) {
      if (!this.sendToRenderer(sender, subscriptionId, { subscriptionId, event })) break;
    }
    this.trackSender(sender);
    log.action('renderer subscribed to durable run', {
      senderId: sender.id,
      runId: input.runId,
      subscriptionId,
      afterSequence: input.afterSequence,
    });
    return {
      subscriptionId,
      snapshot: subscription.snapshot,
      events: subscription.events.map(prepareDurableEventForTransport),
      hasMore: subscription.hasMore,
    };
  }

  public acknowledge(sender: RunIpcSender, value: unknown): void {
    const request = requireObject(value, 'Run acknowledgement');
    const subscriptionId = request['subscriptionId'];
    const sequence = request['sequence'];
    if (typeof subscriptionId !== 'string' || typeof sequence !== 'number') return;
    const active = this.subscriptions.get(subscriptionId);
    if (
      active === undefined ||
      active.senderId !== sender.id ||
      !Number.isInteger(sequence) ||
      sequence < active.lastAcknowledged ||
      sequence > active.lastSent
    ) {
      return;
    }
    active.lastAcknowledged = sequence;
    active.lastActivityAt = Date.now();
  }

  public unsubscribe(sender: RunIpcSender, subscriptionId: unknown): void {
    if (typeof subscriptionId !== 'string') return;
    const active = this.subscriptions.get(subscriptionId);
    if (active === undefined || active.senderId !== sender.id) return;
    active.subscription.unsubscribe();
    this.subscriptions.delete(subscriptionId);
    log.debug('renderer unsubscribed from durable run', {
      senderId: sender.id,
      runId: active.runId,
      subscriptionId,
    });
  }

  public close(): void {
    clearInterval(this.leaseTimer);
    for (const active of this.subscriptions.values()) active.subscription.unsubscribe();
    this.subscriptions.clear();
    this.owners.clear();
    this.senderCleanup.clear();
  }

  private expireInactiveSubscriptions(): void {
    const cutoff = Date.now() - SUBSCRIPTION_LEASE_MS;
    for (const [subscriptionId, active] of this.subscriptions) {
      if (active.lastActivityAt >= cutoff) continue;
      active.subscription.unsubscribe();
      this.subscriptions.delete(subscriptionId);
      log.warn('durable run subscription lease expired', {
        subscriptionId,
        runId: active.runId,
        lastAcknowledged: active.lastAcknowledged,
      });
    }
  }

  private sendToRenderer(
    sender: RunIpcSender,
    subscriptionId: string,
    message: DurableRunEventMessage,
  ): boolean {
    const active = this.subscriptions.get(subscriptionId);
    if (active === undefined) return false;
    if (sender.isDestroyed()) {
      this.detachSubscription(subscriptionId, active);
      return false;
    }
    try {
      sender.send(this.eventChannel, message);
      return true;
    } catch (error) {
      // Electron can dispose a frame between `isDestroyed()` and `send()`.
      this.detachSubscription(subscriptionId, active);
      log.warn('durable run renderer send failed; subscription detached', {
        senderId: sender.id,
        runId: active.runId,
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private detachSubscription(subscriptionId: string, active: LiveSubscription): void {
    active.subscription.unsubscribe();
    this.subscriptions.delete(subscriptionId);
  }

  private async authorize(sender: RunIpcSender, runId: string, projectId: string): Promise<void> {
    if (typeof runId !== 'string' || typeof projectId !== 'string') {
      throw new Error('Run and project ids are required.');
    }
    const owner = this.owners.get(runId);
    if (owner !== undefined) {
      if (owner.senderId !== sender.id || owner.projectId !== projectId) {
        throw new RunStoreConflictError('Run is owned by another renderer or project.');
      }
      return;
    }

    // Recovery after a main-process restart has no in-memory owner. Possession of
    // the unguessable run id plus an exact durable project match claims it.
    const snapshot = await this.gateway.snapshot(runId);
    if (snapshot === null || snapshot.projectId !== projectId) {
      throw new RunStoreConflictError('Run does not belong to the requested project.');
    }
    this.claim(sender, runId, projectId);
  }

  private claim(sender: RunIpcSender, runId: string, projectId: string): void {
    const owner = this.owners.get(runId);
    if (owner !== undefined && (owner.senderId !== sender.id || owner.projectId !== projectId)) {
      throw new RunStoreConflictError('Run is already owned by another renderer or project.');
    }
    this.owners.set(runId, { senderId: sender.id, projectId });
    this.trackSender(sender);
  }

  private trackSender(sender: RunIpcSender): void {
    if (this.senderCleanup.has(sender.id)) return;
    const onDestroyed = (): void => {
      for (const [subscriptionId, active] of this.subscriptions) {
        if (active.senderId !== sender.id) continue;
        active.subscription.unsubscribe();
        this.subscriptions.delete(subscriptionId);
      }
      for (const [runId, owner] of this.owners) {
        if (owner.senderId === sender.id) this.owners.delete(runId);
      }
      this.senderCleanup.delete(sender.id);
    };
    this.senderCleanup.set(sender.id, onDestroyed);
    sender.once('destroyed', onDestroyed);
  }
}
