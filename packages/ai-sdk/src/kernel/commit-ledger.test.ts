import { describe, expect, it } from 'vitest';
import {
  InMemoryPatchCommitLedger,
  UNEXPLAINED_HOST_REFUSAL,
  hostRefusalFor,
} from './commit-ledger.js';

describe('hostRefusalFor', () => {
  it('is silent when the host committed the patch', () => {
    expect(hostRefusalFor({ state: 'committed', revision: 4 })).toBeUndefined();
  });

  // The captured divergence: every patch came back stale while the run's own ledger read
  // `succeeded` against a project still at revision 0 with an empty bin.
  it('carries the host’s own reason back to the run', () => {
    expect(hostRefusalFor({ state: 'stale', reason: 'the project is no longer open' })).toBe(
      'the project is no longer open',
    );
  });

  // A turn whose edit vanished with no explanation is indistinguishable, to the model, from
  // one that landed — which is the whole failure this module exists to end.
  it('never answers a refusal with silence', () => {
    expect(hostRefusalFor({ state: 'stale' })).toBe(UNEXPLAINED_HOST_REFUSAL);
  });

  // `deferred` is the host saying it is not the authority here (a run under review policy,
  // where the renderer applies). Not a refusal, and not something to report as one.
  it('treats a deferred patch, and no host at all, as nothing to report', () => {
    expect(hostRefusalFor({ state: 'deferred' })).toBeUndefined();
    expect(hostRefusalFor(undefined)).toBeUndefined();
  });
});

describe('InMemoryPatchCommitLedger.settled', () => {
  it('resolves immediately for a verdict already recorded', async () => {
    const ledger = new InMemoryPatchCommitLedger();
    ledger.record('p1', { state: 'committed', revision: 3 });
    await expect(ledger.settled('p1')).resolves.toEqual({ state: 'committed', revision: 3 });
  });

  // The whole point of waiting: the run asks before the host has ruled, far more often than
  // after. Sampling instead of waiting is what made the first attempt at this fix silently
  // do nothing.
  it('resolves a waiter recorded after the fact, and wakes every one of them', async () => {
    const ledger = new InMemoryPatchCommitLedger();
    const first = ledger.settled('p1');
    const second = ledger.settled('p1');
    ledger.record('p1', { state: 'stale', reason: 'not open' });
    await expect(first).resolves.toMatchObject({ state: 'stale' });
    await expect(second).resolves.toMatchObject({ state: 'stale' });
  });
});

describe('InMemoryPatchCommitLedger', () => {
  it('keeps verdicts apart by patch and lets a later one correct an earlier', () => {
    const ledger = new InMemoryPatchCommitLedger();
    ledger.record('p1', { state: 'stale', reason: 'first' });
    ledger.record('p2', { state: 'committed' });
    ledger.record('p1', { state: 'committed', revision: 2 });
    expect(ledger.outcomeFor('p1')).toEqual({ state: 'committed', revision: 2 });
    expect(ledger.outcomeFor('p2')).toEqual({ state: 'committed' });
  });
});
