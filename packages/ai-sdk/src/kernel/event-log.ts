/**
 * @framepilot/ai-sdk/kernel/event-log — WAL snapshot & compaction
 * (plan/AI-ORCHESTRATION-REDESIGN.md §16.1/§16.3, Phase K5.3).
 *
 * The run/conversation memory scope is the {@link AiEvent} write-ahead log (§16.1). It is
 * append-only and grows with every streamed token, so the *persisted* form must be
 * compacted: a long run emits thousands of `assistant_delta`/`reasoning_delta` chunks and
 * re-emits status/reasoning/tool events in place by id. None of that streaming noise is
 * needed to reload the conversation — only the terminal, last-per-id events are.
 *
 * {@link compactEventLog} produces the compact log that renders **identically** on reload;
 * {@link snapshotEventLog} adds the derived run summary (turn/event counts, last status,
 * last checkpoint) used for resume and telemetry. Both are pure and lossless *for reload*:
 * a delta only ever accumulated into a terminal event that is itself kept.
 */
import type { AiEvent, CheckpointEvent, RunStatus } from '../events.js';

/**
 * Streaming delta events: pure incremental chunks that are fully superseded by the
 * terminal event they accumulate into (`assistant_message`, `reasoning`). Dropping them
 * is lossless for reload — the terminal event carries the final text.
 */
const STREAMING_DELTA_TYPES: ReadonlySet<AiEvent['type']> = new Set([
  'assistant_delta',
  'reasoning_delta',
]);

/**
 * Compact an append-only WAL for persistence (§16.3): drop streaming deltas, then keep
 * only the **last** event per id (status/reasoning/tool/progress events update in place by
 * re-emitting their id — only the final state matters on reload). Order is preserved by
 * each id's *last* position, so the compacted log reads in the same sequence it rendered.
 *
 * @param events - The raw append-only event log (oldest→newest).
 * @returns The compacted log — a strict subsequence of the input.
 */
export function compactEventLog(events: readonly AiEvent[]): AiEvent[] {
  const withoutDeltas = events.filter((e) => !STREAMING_DELTA_TYPES.has(e.type));

  // Keep the last occurrence per id. Walk once, recording each id's final event and the
  // position at which it last appeared, then re-emit in ascending last-position order.
  const lastById = new Map<string, { event: AiEvent; pos: number }>();
  withoutDeltas.forEach((event, pos) => {
    lastById.set(event.id, { event, pos });
  });
  return [...lastById.values()].sort((a, b) => a.pos - b.pos).map((e) => e.event);
}

/** A compacted run/conversation log plus its derived summary. */
export interface EventLogSnapshot {
  /** The compacted event log (see {@link compactEventLog}). */
  readonly events: readonly AiEvent[];
  /** Distinct user turns in the log. */
  readonly turnCount: number;
  /** Events after compaction (what actually persists). */
  readonly eventCount: number;
  /** Events dropped by compaction (streaming/superseded) — the compaction win. */
  readonly droppedCount: number;
  /** The most recent run status, if any status event was emitted. */
  readonly lastStatus?: RunStatus;
  /** The most recent resume checkpoint, if the run was interrupted. */
  readonly lastCheckpoint?: CheckpointEvent;
}

/** The most recent event of a given type in a log (searching newest→oldest). */
function lastOfType<T extends AiEvent['type']>(
  events: readonly AiEvent[],
  type: T,
): Extract<AiEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === type) return event as Extract<AiEvent, { type: T }>;
  }
  return undefined;
}

/**
 * Snapshot a WAL: compact it and derive the run summary (turn/event counts, last status,
 * last checkpoint). Pure. The snapshot is what a store persists between sessions and what
 * resume reads to decide whether an interrupted run can continue.
 *
 * @param events - The raw append-only event log.
 * @returns The compacted log + derived summary.
 */
export function snapshotEventLog(events: readonly AiEvent[]): EventLogSnapshot {
  const compacted = compactEventLog(events);
  const turnIds = new Set(events.filter((e) => e.type === 'user_message').map((e) => e.turnId));
  const status = lastOfType(compacted, 'status');
  const checkpoint = lastOfType(compacted, 'checkpoint');
  return {
    events: compacted,
    turnCount: turnIds.size,
    eventCount: compacted.length,
    droppedCount: events.length - compacted.length,
    ...(status ? { lastStatus: status.status } : {}),
    ...(checkpoint ? { lastCheckpoint: checkpoint } : {}),
  };
}
