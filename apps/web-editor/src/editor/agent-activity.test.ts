import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentActivity,
  getAgentActivity,
  getAgentActivityServerSnapshot,
  publishAgentActivity,
  subscribeAgentActivity,
} from './agent-activity.js';

afterEach(() => clearAgentActivity());

describe('agent activity store', () => {
  it('starts idle and reports what was published', () => {
    expect(getAgentActivity()).toEqual({ running: false, label: null });
    publishAgentActivity({ running: true, label: 'Reading the timeline' });
    expect(getAgentActivity()).toEqual({ running: true, label: 'Reading the timeline' });
  });

  it('keeps the SAME object identity when nothing changed', () => {
    // `useSyncExternalStore` compares snapshots by reference, so a getter that
    // returned a fresh object each call would re-render forever.
    publishAgentActivity({ running: true, label: 'Working' });
    const first = getAgentActivity();
    publishAgentActivity({ running: true, label: 'Working' });
    expect(getAgentActivity()).toBe(first);
  });

  it('does not notify for a duplicate publish, so callers need not compare', () => {
    publishAgentActivity({ running: true, label: 'Working' });
    const listener = vi.fn();
    subscribeAgentActivity(listener);
    publishAgentActivity({ running: true, label: 'Working' });
    expect(listener).not.toHaveBeenCalled();
    publishAgentActivity({ running: true, label: 'Trimming' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes cleanly', () => {
    const listener = vi.fn();
    const off = subscribeAgentActivity(listener);
    off();
    publishAgentActivity({ running: true, label: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeAgentActivity(a);
    subscribeAgentActivity(b);
    publishAgentActivity({ running: true, label: null });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('always hands a server render the same idle object', () => {
    publishAgentActivity({ running: true, label: 'Working' });
    expect(getAgentActivityServerSnapshot()).toEqual({ running: false, label: null });
    expect(getAgentActivityServerSnapshot()).toBe(getAgentActivityServerSnapshot());
  });

  it('clears back to idle', () => {
    publishAgentActivity({ running: true, label: 'Working' });
    clearAgentActivity();
    expect(getAgentActivity()).toEqual({ running: false, label: null });
  });
});
