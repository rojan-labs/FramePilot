import { describe, expect, it } from 'vitest';
import { combineSignals } from './signals.js';

describe('combineSignals', () => {
  it('returns a non-aborted signal when no inputs abort', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal, undefined);
    expect(combined.signal.aborted).toBe(false);
    combined.dispose();
  });

  it('aborts when any input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal);
    b.abort('boom');
    expect(combined.signal.aborted).toBe(true);
    combined.dispose();
  });

  it('aborts synchronously if an input is already aborted', () => {
    const a = new AbortController();
    a.abort('early');
    const combined = combineSignals(a.signal);
    expect(combined.signal.aborted).toBe(true);
    combined.dispose();
  });

  it('handles being called with no signals', () => {
    const combined = combineSignals();
    expect(combined.signal.aborted).toBe(false);
    combined.dispose();
  });

  it('dispose detaches listeners so later aborts are ignored', () => {
    const a = new AbortController();
    const combined = combineSignals(a.signal);
    combined.dispose();
    a.abort();
    expect(combined.signal.aborted).toBe(false);
  });
});
