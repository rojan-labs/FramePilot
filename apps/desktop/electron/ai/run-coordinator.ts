/**
 * Public durable-run coordinator surface.
 *
 * The protocol/state-machine implementation remains byte-for-byte in
 * run-coordinator-base.ts. Subscription replay is overridden here so resuming near the
 * tail of a long run slices the contiguous sequence log directly instead of filtering
 * every historical event first.
 */
export * from './run-coordinator-base.js';

import type { RunSnapshot } from '@framepilot/ai-sdk';
import {
  RunCoordinator as BaseRunCoordinator,
  type RunEventListener,
  type RunSubscription,
} from './run-coordinator-base.js';
import { pageRunEvents, type RunStore, type StoredRun } from './run-store.js';

const MAX_REPLAY_EVENTS = 1_000;
interface Subscriber {
  readonly listener: RunEventListener;
}

interface CoordinatorInternals {
  readonly store: RunStore;
  readonly subscribers: Map<string, Set<Subscriber>>;
  withRunLane<T>(runId: string, action: () => Promise<T>): Promise<T>;
  recoverSnapshot(stored: StoredRun): Promise<RunSnapshot | null>;
}

export interface SubscriptionPage {
  readonly events: StoredRun['events'];
  readonly hasMore: boolean;
}

/** Pure contiguous-sequence page projection, exported for deterministic work-bound tests. */
export function subscriptionPage(
  events: StoredRun['events'],
  afterSequence: number,
  limit = MAX_REPLAY_EVENTS,
): SubscriptionPage {
  const page = pageRunEvents(events, afterSequence, limit);
  const start = Math.min(events.length, Math.max(0, afterSequence));
  return { events: page, hasMore: start + page.length < events.length };
}

/** Same coordinator contract, with suffix replay proportional to the returned page. */
export class RunCoordinator extends BaseRunCoordinator {
  public override subscribe(
    runId: string,
    afterSequence: number,
    listener: RunEventListener,
  ): Promise<RunSubscription> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      return Promise.reject(new Error('Run cursor must be a non-negative integer.'));
    }
    const self = this as unknown as CoordinatorInternals;
    return self.withRunLane(runId, async () => {
      const stored = await self.store.load(runId);
      const snapshot = await self.recoverSnapshot(stored);
      const { events, hasMore } = subscriptionPage(stored.events, afterSequence);
      const subscriber = { listener };
      if (!hasMore) {
        const runSubscribers = self.subscribers.get(runId) ?? new Set<Subscriber>();
        runSubscribers.add(subscriber);
        self.subscribers.set(runId, runSubscribers);
      }
      return {
        snapshot,
        events,
        hasMore,
        unsubscribe: () => {
          const current = self.subscribers.get(runId);
          current?.delete(subscriber);
          if (current?.size === 0) self.subscribers.delete(runId);
        },
      };
    });
  }
}
