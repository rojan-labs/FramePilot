/**
 * Relationships between arguments that a per-field schema cannot express.
 *
 * These are the calls whose individual fields are all well-typed but whose combination is
 * not a request the tool can honor. Rejecting them here costs the agent one turn and a
 * precise message; repairing them silently costs it the edit it thought it made.
 */
import { describe, expect, it } from 'vitest';
import { validateSemanticToolArgs } from './tool-dispatch.js';

const call = (name: string, args: unknown) => ({ id: 'c', name, arguments: args });

describe('punch_in windows', () => {
  it('accepts an ordered window and leaves an unspecified one alone', () => {
    expect(() =>
      validateSemanticToolArgs(call('punch_in', { startTime: 1, endTime: 3 })),
    ).not.toThrow();
    expect(() => validateSemanticToolArgs(call('punch_in', { startTime: 1 }))).not.toThrow();
    expect(() => validateSemanticToolArgs(call('punch_in', {}))).not.toThrow();
  });

  it('refuses an inverted or collapsed window instead of substituting a default span', () => {
    expect(() => validateSemanticToolArgs(call('punch_in', { startTime: 5, endTime: 3 }))).toThrow(
      /greater than startTime/i,
    );
    expect(() => validateSemanticToolArgs(call('punch_in', { startTime: 5, endTime: 5 }))).toThrow(
      /greater than startTime/i,
    );
  });
});

describe('manage_assets plans', () => {
  it('accepts a plan that actually contains a plan', () => {
    expect(() =>
      validateSemanticToolArgs(call('manage_assets', { strategy: 'plan', folders: [{ id: 'f' }] })),
    ).not.toThrow();
    expect(() =>
      validateSemanticToolArgs(
        call('manage_assets', { strategy: 'plan', assignments: [{ assetId: 'a' }] }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSemanticToolArgs(call('manage_assets', { strategy: 'by-kind' })),
    ).not.toThrow();
  });

  it('refuses an empty plan rather than silently reorganising by kind', () => {
    // Falling back to by-kind would reshape the whole bin under a request that asked for
    // something specific — a different edit than the one the model believes it made.
    expect(() => validateSemanticToolArgs(call('manage_assets', { strategy: 'plan' }))).toThrow(
      /at least one folder or assignment/i,
    );
    expect(() =>
      validateSemanticToolArgs(
        call('manage_assets', { strategy: 'plan', folders: [], assignments: [] }),
      ),
    ).toThrow(/at least one folder or assignment/i);
    expect(() =>
      validateSemanticToolArgs(
        call('manage_assets', { strategy: 'plan', folders: 'nope', assignments: 'nope' }),
      ),
    ).toThrow(/at least one folder or assignment/i);
  });
});

describe('malformed envelopes', () => {
  it('leaves a non-object argument payload to the schema layer', () => {
    for (const args of [undefined, null, 'nope', [1, 2]]) {
      expect(() => validateSemanticToolArgs(call('punch_in', args))).not.toThrow();
    }
  });
});
