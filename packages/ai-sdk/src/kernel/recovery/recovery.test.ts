/** Tests for the saga recovery policy (kernel/recovery/recovery.ts, §16.3, K5.3). */
import { describe, expect, it } from 'vitest';
import { MAX_MODEL_RETRIES, RETRY_BACKOFF_BASE_MS, type Failure, recoveryFor } from './recovery.js';

const fail = (over: Partial<Failure> & { class: Failure['class'] }): Failure => ({
  attempt: 1,
  ...over,
});

describe('recoveryFor — model transient failures (timeout/error)', () => {
  it('retries with exponential backoff while attempts remain', () => {
    const first = recoveryFor(fail({ class: 'model_timeout', attempt: 1 }));
    expect(first).toEqual({
      action: 'retry',
      backoffMs: RETRY_BACKOFF_BASE_MS,
      reason: expect.stringContaining('timed out'),
    });
    const second = recoveryFor(fail({ class: 'model_error', attempt: 2 }));
    expect(second.action).toBe('retry');
    if (second.action === 'retry') expect(second.backoffMs).toBe(RETRY_BACKOFF_BASE_MS * 2);
  });

  it('falls back to a recipe when retries are exhausted and one covers the intent', () => {
    const strategy = recoveryFor(
      fail({ class: 'model_timeout', attempt: MAX_MODEL_RETRIES + 1, hasRecipeFallback: true }),
    );
    expect(strategy.action).toBe('fallback_recipe');
  });

  it('falls back to a lower tier when retries are exhausted and no recipe covers it', () => {
    const strategy = recoveryFor(fail({ class: 'model_error', attempt: MAX_MODEL_RETRIES + 1 }));
    expect(strategy.action).toBe('fallback_tier');
  });
});

describe('recoveryFor — tool / patch / cancel / base / proposal', () => {
  it('routes around a failed tool when an alternative exists, else fails the subgraph', () => {
    expect(recoveryFor(fail({ class: 'tool_failed', hasAlternative: true })).action).toBe(
      'route_around',
    );
    expect(recoveryFor(fail({ class: 'tool_failed' })).action).toBe('fail_subgraph');
  });

  it('keeps the cumulative patch and pauses at review on an invalid patch', () => {
    expect(recoveryFor(fail({ class: 'invalid_patch' })).action).toBe('pause_review');
  });

  it('checkpoints and cancels on user interruption', () => {
    expect(recoveryFor(fail({ class: 'user_cancelled' })).action).toBe('checkpoint_cancel');
  });

  it('rebases or restarts on a stale base', () => {
    expect(recoveryFor(fail({ class: 'stale_base' })).action).toBe('rebase_or_restart');
  });

  it('self-corrects once on a malformed proposal', () => {
    expect(recoveryFor(fail({ class: 'malformed_proposal' })).action).toBe('self_correct');
  });

  it('every strategy carries a human-readable reason', () => {
    const classes: Failure['class'][] = [
      'model_timeout',
      'model_error',
      'tool_failed',
      'invalid_patch',
      'user_cancelled',
      'stale_base',
      'malformed_proposal',
    ];
    for (const c of classes) {
      expect(recoveryFor(fail({ class: c })).reason.length).toBeGreaterThan(0);
    }
  });
});
