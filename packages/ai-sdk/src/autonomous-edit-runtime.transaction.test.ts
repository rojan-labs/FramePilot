/**
 * The autonomous edit transaction.
 *
 * This runtime's promise is narrow and important: an autonomous edit either completes and
 * verifies, or the project is left as it was. Every test here is about that boundary —
 * bounded correction, rollback on every post-apply failure path, cancellation, and
 * idempotency. A leaked half-applied edit is the failure the whole module exists to
 * prevent, and it is silent: the run reports "failed" while the timeline stays changed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runAutonomousEdit,
  type AutonomousEditAdapters,
  type AutonomousRunEvent,
} from './autonomous-edit-runtime.js';

type State = { revision: number; applied: number };
type Patch = { id: string };

const intent = (over: Record<string, unknown> = {}) => ({
  request: 'tighten the intro',
  criteria: { intentKind: 'mutation' as const, requireTimelineChange: true, ...over },
  measurableTasks: ['trim'],
});

/** Adapters that succeed end to end; each test replaces exactly one. */
function adapters(
  over: Partial<AutonomousEditAdapters<State, string[], Patch, string>> = {},
): AutonomousEditAdapters<State, string[], Patch, string> {
  return {
    getRevision: (state) => state.revision,
    normalizeIntent: async () => intent(),
    plan: async () => ({ tasks: ['trim'], evidenceQueries: [] }),
    collectEvidence: async () => ['ev'],
    proposePatch: async () => ({ id: 'p1' }),
    validatePatch: async (patch) => ({ valid: true, patch, issues: [] }),
    applyPatch: async (_patch, state) => ({
      state: { revision: state.revision + 1, applied: state.applied + 1 },
      inverse: 'undo',
      // A real diff, because the completion gate refuses to call a mutation complete
      // without a meaningful change — an "applied" run with an empty diff is exactly
      // the fabricated success the gate exists to catch (ADR 0083).
      diff: { summary: ['[video_1] ~ clip clip_a (0–6s → 1–5s)'] } as unknown as never,
      appliedOperationCount: 1,
      revision: state.revision + 1,
    }),
    verify: async () => ({
      passed: true,
      issues: [],
      renderVerified: true,
      visualEvidenceCount: 1,
    }),
    rollback: async (_inverse, state) => ({ ...state, applied: state.applied - 1 }),
    ...over,
  } as AutonomousEditAdapters<State, string[], Patch, string>;
}

const initialState: State = { revision: 1, applied: 0 };

const run = (
  over: Partial<AutonomousEditAdapters<State, string[], Patch, string>> = {},
  input: Record<string, unknown> = {},
) =>
  runAutonomousEdit<State, string[], Patch, string>({
    request: 'tighten the intro',
    initialState,
    adapters: adapters(over),
    ...input,
  });

describe('the happy path', () => {
  it('completes, returning the patch and its inverse', async () => {
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.inverse).toBe('undo');
    expect(result.state.applied).toBe(1);
  });

  it('emits the run stages in order', async () => {
    const events: AutonomousRunEvent[] = [];
    await run({}, { onEvent: (event: AutonomousRunEvent) => events.push(event) });
    const stages = events.map((event) => event.stage);
    expect(stages[0]).toBe('normalize');
    expect(stages).toContain('validate');
    expect(stages).toContain('apply');
    expect(stages).toContain('verify');
    expect(stages.at(-1)).toBe('complete');
  });
});

describe('bounded correction', () => {
  it('retries an invalid patch, then gives up with the validator’s issues', async () => {
    const validatePatch = vi.fn(async () => ({
      valid: false,
      patch: undefined,
      issues: ['clip not found'],
    }));
    const result = await run({ validatePatch });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.issues).toContain('clip not found');
    // Default budget is two corrections, so three attempts total — bounded, not endless.
    expect(validatePatch).toHaveBeenCalledTimes(3);
  });

  it('feeds the validator’s issues back to the proposer as a correction', async () => {
    const proposePatch = vi.fn(async () => ({ id: 'p1' }));
    let calls = 0;
    await run({
      proposePatch,
      validatePatch: async (patch) => {
        calls += 1;
        return calls === 1
          ? { valid: false, patch: undefined, issues: ['clip not found'] }
          : { valid: true, patch, issues: [] };
      },
    });
    // The second proposal must be told what was wrong, or the retry is a coin flip.
    expect(proposePatch.mock.calls[1]?.[4]).toMatch(/clip not found/);
  });

  it('honours maxCorrectionAttempts: 0 — one attempt, no retry', async () => {
    const validatePatch = vi.fn(async () => ({ valid: false, patch: undefined, issues: ['x'] }));
    await run({ validatePatch }, { maxCorrectionAttempts: 0 });
    expect(validatePatch).toHaveBeenCalledTimes(1);
  });

  it('clamps an absurd correction budget to two', async () => {
    const validatePatch = vi.fn(async () => ({ valid: false, patch: undefined, issues: ['x'] }));
    await run({ validatePatch }, { maxCorrectionAttempts: 99 });
    expect(validatePatch).toHaveBeenCalledTimes(3);
  });

  it('does not apply anything when validation never passes', async () => {
    const applyPatch = vi.fn();
    await run({
      validatePatch: async () => ({ valid: false, patch: undefined, issues: ['x'] }),
      applyPatch,
    });
    expect(applyPatch).not.toHaveBeenCalled();
  });
});

describe('rollback — the project is never left half-edited', () => {
  it('rolls back when verification fails, and reports rolledBack', async () => {
    const rollback = vi.fn(async (_inverse: string, state: State) => ({
      ...state,
      applied: state.applied - 1,
    }));
    const result = await run({
      verify: async () => ({
        passed: false,
        issues: ['captions drifted'],
        renderVerified: false,
        visualEvidenceCount: 0,
      }),
      rollback,
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.rolledBack).toBe(true);
    expect(rollback).toHaveBeenCalled();
  });

  it('rolls back when an adapter throws after apply, and reports it', async () => {
    const rollback = vi.fn(async (_inverse: string, state: State) => state);
    const result = await run({
      verify: async () => {
        throw new Error('verifier exploded');
      },
      rollback,
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.rolledBack).toBe(true);
    expect(result.status === 'failed' && result.issues[0]).toMatch(/verifier exploded/);
  });

  it('reports a FAILED rollback rather than hiding it', async () => {
    // The worst case: the edit failed AND could not be undone. The user has to be told.
    const result = await run({
      verify: async () => {
        throw new Error('verifier exploded');
      },
      rollback: async () => {
        throw new Error('disk full');
      },
    });
    expect(result.status === 'failed' && result.issues.join(' ')).toMatch(
      /Rollback failed.*disk full/,
    );
    expect(result.status === 'failed' && result.rolledBack).toBe(false);
  });

  it('does not roll back a failure that happened BEFORE apply', async () => {
    const rollback = vi.fn();
    const result = await run({
      plan: async () => {
        throw new Error('planner exploded');
      },
      rollback,
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(result.status === 'failed' && result.rolledBack).toBe(false);
  });
});

describe('evidence assembly', () => {
  it('omits the diff and duration when the adapters did not report them', async () => {
    // Both are optional and conditionally spread. An absent field must stay absent
    // rather than becoming `undefined`, which a strict completion gate would read as a
    // reported zero.
    const result = await run({
      normalizeIntent: async () => intent({ requireTimelineChange: false }),
      applyPatch: async (_patch, state) => ({
        state: { revision: state.revision + 1, applied: state.applied + 1 },
        inverse: 'undo',
        appliedOperationCount: 1,
        revision: state.revision + 1,
      }),
    });
    expect(result.status).toBe('completed');
  });

  it('carries a reported duration into the completion assessment', async () => {
    const result = await run({
      verify: async () => ({
        passed: true,
        issues: [],
        renderVerified: true,
        visualEvidenceCount: 1,
        actualDurationFrames: 120,
      }),
    });
    expect(result.status).toBe('completed');
  });
});

describe('cancellation', () => {
  it('returns `cancelled`, not `failed`, when the caller aborts', async () => {
    const controller = new AbortController();
    const result = await run(
      {
        collectEvidence: async () => {
          controller.abort();
          return ['ev'];
        },
      },
      { signal: controller.signal },
    );
    expect(result.status).toBe('cancelled');
  });

  it('reports the caller’s abort REASON when one was given', async () => {
    // "The edit was cancelled" is the fallback. When the host says why it stopped, the
    // user should see that instead.
    const controller = new AbortController();
    controller.abort(new Error('window closed'));
    const result = await run({}, { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.status === 'cancelled' && result.reason).toBe('window closed');
  });

  it('falls back to a generic reason when the abort carried none', async () => {
    const controller = new AbortController();
    controller.abort('just a string');
    const result = await run({}, { signal: controller.signal });
    expect(result.status === 'cancelled' && result.reason).toMatch(/cancelled/i);
  });

  it('returns immediately when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const normalizeIntent = vi.fn(async () => intent());
    const result = await run({ normalizeIntent }, { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(normalizeIntent).not.toHaveBeenCalled();
  });

  it('rolls back a mid-flight cancellation that already applied', async () => {
    const controller = new AbortController();
    const rollback = vi.fn(async (_inverse: string, state: State) => state);
    const result = await run(
      {
        verify: async () => {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        },
        rollback,
      },
      { signal: controller.signal },
    );
    expect(result.status).toBe('cancelled');
    expect(rollback).toHaveBeenCalled();
  });
});

describe('render', () => {
  it('fails honestly when a render is required but no adapter is configured', async () => {
    // `render` is optional on the adapter set, so this is reachable in real wiring —
    // and claiming completion without the render the request demanded would be a lie.
    const base = adapters();
    const withoutRender = { ...base };
    delete (withoutRender as { render?: unknown }).render;
    const result = await runAutonomousEdit<State, string[], Patch, string>({
      request: 'export it',
      initialState,
      adapters: {
        ...withoutRender,
        normalizeIntent: async () => intent({ requireRender: true }),
      } as AutonomousEditAdapters<State, string[], Patch, string>,
    });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.issues.join(' ')).toMatch(/no render adapter/);
  });

  it('renders when required and an adapter exists', async () => {
    const render = vi.fn(async () => ({
      rendered: true,
      renderVerified: true,
      durationFrames: 100,
    }));
    await run({
      normalizeIntent: async () => intent({ requireRender: true }),
      render: render as unknown as AutonomousEditAdapters<State, string[], Patch, string>['render'],
    });
    expect(render).toHaveBeenCalled();
  });
});

describe('idempotency', () => {
  it('returns the recorded result for a repeated key, without re-running', async () => {
    // Retrying a request that already succeeded must not apply the edit twice.
    const key = `k_${Math.random().toString(36).slice(2)}`;
    const first = await run({}, { idempotencyKey: key });
    const applyPatch = vi.fn();
    const second = await run({ applyPatch }, { idempotencyKey: key });
    expect(second).toBe(first);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('does not record a FAILED run, so a retry can still succeed', async () => {
    const key = `k_${Math.random().toString(36).slice(2)}`;
    await run(
      { validatePatch: async () => ({ valid: false, patch: undefined, issues: ['x'] }) },
      { idempotencyKey: key },
    );
    const second = await run({}, { idempotencyKey: key });
    expect(second.status).toBe('completed');
  });
});
