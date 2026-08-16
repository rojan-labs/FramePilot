/**
 * @framepilot/ai-sdk/concurrency — turn-level tool-call batching (E1,
 * plan/ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md).
 *
 * A turn's tool calls are partitioned into batches: runs of consecutive
 * *concurrency-safe* calls form one batch the executor may run concurrently against a
 * bounded pool; every other call is its own singleton batch executed strictly serially.
 * Mutating calls stay serial because the turn's speculative working copy (`turnCtx`
 * threading in `executeToolCalls`) is the correctness backbone.
 */
import { toolRequiresSerialExecution } from './tool-contract.js';

/** Env var bounding how many concurrency-safe tool calls run at once. */
export const TOOL_CONCURRENCY_ENV = 'FRAMEPILOT_MAX_TOOL_CONCURRENCY';

/**
 * Default pool size. Deliberately conservative (the reference architecture defaults
 * to 10): most safe calls round-trip the engine sidecar, and a busy sidecar thrashed
 * by parallel ffmpeg probes is slower than a short queue. Raise only with desktop-scale
 * perf evidence (plan §5, "Sidecar contention").
 */
export const DEFAULT_MAX_TOOL_CONCURRENCY = 4;

/**
 * One partition of a turn's calls. `concurrent` marks a batch of consecutive
 * concurrency-safe calls (which may still have length 1); a non-concurrent batch is
 * always a single call.
 */
export interface ConcurrencyBatch<T> {
  readonly concurrent: boolean;
  readonly calls: readonly T[];
}

function contractRequiresSerial(call: unknown): boolean {
  if (typeof call !== 'object' || call === null || Array.isArray(call)) return false;
  const name = (call as { readonly name?: unknown }).name;
  return typeof name === 'string' && toolRequiresSerialExecution(name);
}

/**
 * Partition a turn's calls into concurrency batches, preserving call order exactly:
 * flattening the result reproduces the input. Runs of consecutive calls the predicate
 * accepts merge into one concurrent batch; every rejected call becomes its own serial
 * singleton. A predicate that throws marks the call *not* safe.
 *
 * First-class tool execution contracts are enforced before the generic safety predicate.
 * This is what keeps a legacy `analysis` tool such as `transcribe` serial even though its
 * host result commits project state.
 *
 * `keyOf` keeps duplicate calls out of one batch so memo/evidence semantics remain
 * deterministic across repeats.
 */
export function partitionConcurrencyBatches<T>(
  calls: readonly T[],
  isSafe: (call: T) => boolean,
  keyOf?: (call: T) => string,
): ConcurrencyBatch<T>[] {
  const batches: ConcurrencyBatch<T>[] = [];
  let run: T[] = [];
  let runKeys = new Set<string>();
  const flushRun = (): void => {
    if (run.length > 0) {
      batches.push({ concurrent: true, calls: run });
      run = [];
      runKeys = new Set();
    }
  };
  for (const call of calls) {
    let safe = false;
    if (!contractRequiresSerial(call)) {
      try {
        safe = isSafe(call);
      } catch {
        safe = false;
      }
    }
    if (!safe) {
      flushRun();
      batches.push({ concurrent: false, calls: [call] });
      continue;
    }
    const key = keyOf?.(call);
    if (key !== undefined && runKeys.has(key)) flushRun();
    if (key !== undefined) runKeys.add(key);
    run.push(call);
  }
  flushRun();
  return batches;
}

/**
 * Map `items` through an async `fn` with at most `limit` calls in flight, returning
 * results in input order. A rejection propagates after the in-flight pool settles;
 * `limit` is clamped to at least 1.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const pool = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(pool, items.length) }, () => worker()),
  );
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

/**
 * Resolve the tool-call pool size from the raw env value. A missing, non-numeric,
 * or sub-1 value falls back to {@link DEFAULT_MAX_TOOL_CONCURRENCY}; fractions floor.
 */
export function resolveToolConcurrency(rawEnvValue: string | undefined): number {
  if (rawEnvValue === undefined || rawEnvValue.trim() === '') {
    return DEFAULT_MAX_TOOL_CONCURRENCY;
  }
  const parsed = Number(rawEnvValue);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_TOOL_CONCURRENCY;
  return Math.floor(parsed);
}
