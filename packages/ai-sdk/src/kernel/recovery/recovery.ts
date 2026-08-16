/**
 * @framepilot/ai-sdk/kernel/recovery — saga-style recovery policy
 * (plan/AI-ORCHESTRATION-REDESIGN.md §16.3, Phase K5.3).
 *
 * A pure classifier from a **failure class** to the **recovery strategy** the redesign
 * prescribes per class (§16.3 table). It holds no I/O and runs nothing — it is the
 * decision the driver/scheduler consults when an effect fails, kept pure and table-tested
 * so the recovery behaviour is inspectable and can't silently drift. Every strategy
 * preserves the honesty rule: nothing here fabricates success; the worst case is an honest
 * pause at `review` or a failed subgraph that reports which node and why.
 */

import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:kernel:recovery');

/** The failure classes the redesign enumerates (§16.3), one row per recovery rule. */
export type FailureClass =
  | 'model_timeout'
  | 'model_error'
  | 'tool_failed'
  | 'invalid_patch'
  | 'user_cancelled'
  | 'stale_base'
  | 'malformed_proposal';

/** A single failure occurrence: its class plus how many times it has been attempted. */
export interface Failure {
  readonly class: FailureClass;
  /** 1 on the first failure, 2 on the second, … — drives retry exhaustion. */
  readonly attempt: number;
  /** Whether a deterministic recipe covers the same intent (enables the recipe fallback). */
  readonly hasRecipeFallback?: boolean;
  /** Whether the failed task has a still-viable alternative downstream (route-around). */
  readonly hasAlternative?: boolean;
}

/**
 * What to do about a failure. A discriminated union so the caller dispatches exhaustively;
 * each variant carries a `reason` for the trace (§18).
 */
export type RecoveryStrategy =
  /** Retry the same effect after `backoffMs` (Model Router / reliability layer). */
  | { readonly action: 'retry'; readonly backoffMs: number; readonly reason: string }
  /** Retry on a cheaper/lower model tier (the frontier tier timed out / errored). */
  | { readonly action: 'fallback_tier'; readonly reason: string }
  /** Abandon the model path for a deterministic recipe that covers the intent. */
  | { readonly action: 'fallback_recipe'; readonly reason: string }
  /** Skip the failed task; the scheduler routes to a downstream alternative. */
  | { readonly action: 'route_around'; readonly reason: string }
  /** Fail the dependent subgraph and report which node + why (never fabricate). */
  | { readonly action: 'fail_subgraph'; readonly reason: string }
  /** Keep the cumulative validated patch and pause the run at `review`. */
  | { readonly action: 'pause_review'; readonly reason: string }
  /** Cancel inflight effects and emit a checkpoint for Resume. */
  | { readonly action: 'checkpoint_cancel'; readonly reason: string }
  /** The base doc moved under the run: rebase the remainder, or restart honestly. */
  | { readonly action: 'rebase_or_restart'; readonly reason: string }
  /** Feed the validation error back to the proposer once (self-correct). */
  | { readonly action: 'self_correct'; readonly reason: string };

/** Max automatic retries before a transient model failure escalates to a fallback. */
export const MAX_MODEL_RETRIES = 2;
/** Exponential backoff base (ms); attempt n waits `BASE * 2^(n-1)`. */
export const RETRY_BACKOFF_BASE_MS = 500;

/** Backoff for the nth attempt (1-based): 500ms, 1s, 2s, … */
function backoffFor(attempt: number): number {
  return RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

/**
 * A transient model failure (timeout or error): retry with backoff while attempts remain,
 * then fall back to a deterministic recipe if one covers the intent, else to a lower tier.
 * Escalating to a recipe before a lower tier honours the redesign's "prefer deterministic"
 * bias — a covered intent should leave the model path entirely rather than burn another
 * (cheaper but still non-deterministic) call.
 */
function recoverModelTransient(failure: Failure, label: string): RecoveryStrategy {
  if (failure.attempt <= MAX_MODEL_RETRIES) {
    return {
      action: 'retry',
      backoffMs: backoffFor(failure.attempt),
      reason: `${label} (attempt ${String(failure.attempt)}/${String(MAX_MODEL_RETRIES)}) — retry with backoff`,
    };
  }
  if (failure.hasRecipeFallback) {
    return {
      action: 'fallback_recipe',
      reason: `${label} — retries exhausted; a recipe covers this intent`,
    };
  }
  return {
    action: 'fallback_tier',
    reason: `${label} — retries exhausted; fall back to a lower model tier`,
  };
}

/**
 * Map a failure to its recovery strategy (§16.3). Pure and total over {@link FailureClass}.
 *
 * @param failure - The failure occurrence (class + attempt + fallback availability).
 * @returns The prescribed recovery strategy, with a reason for the trace.
 */
export function recoveryFor(failure: Failure): RecoveryStrategy {
  const strategy = recoveryStrategyFor(failure);
  log.warn('recoveryFor → strategy chosen', {
    class: failure.class,
    attempt: failure.attempt,
    action: strategy.action,
    reason: strategy.reason,
  });
  return strategy;
}

function recoveryStrategyFor(failure: Failure): RecoveryStrategy {
  switch (failure.class) {
    case 'model_timeout':
      return recoverModelTransient(failure, 'Model call timed out');
    case 'model_error':
      return recoverModelTransient(failure, 'Model call failed');
    case 'tool_failed':
      // Route around it when a downstream alternative exists, else fail the subgraph and
      // report the node — never fabricate a successful tool result.
      return failure.hasAlternative
        ? {
            action: 'route_around',
            reason: 'Tool/host effect failed — an alternative downstream task exists',
          }
        : {
            action: 'fail_subgraph',
            reason:
              'Tool/host effect failed with no alternative — fail the subgraph and report the node',
          };
    case 'invalid_patch':
      // The validator rejected the turn's patch before apply: the working copy is still
      // valid; keep the cumulative patch and pause at review rather than looping.
      return {
        action: 'pause_review',
        reason: 'Patch failed validation — keep the cumulative patch, pause at review',
      };
    case 'user_cancelled':
      return {
        action: 'checkpoint_cancel',
        reason: 'User interrupted — cancel inflight effects and checkpoint for Resume',
      };
    case 'stale_base':
      return {
        action: 'rebase_or_restart',
        reason: 'Base doc changed under the run — rebase the remainder or restart honestly',
      };
    case 'malformed_proposal':
      return {
        action: 'self_correct',
        reason: 'Proposal failed schema validation — feed the error back to the proposer once',
      };
  }
}
