import type { TimelineDiff } from '@framepilot/editor-core';
import { describe, expect, it, vi } from 'vitest';
import {
  runAutonomousEdit,
  type AutonomousEditAdapters,
  type EditPlan,
  type NormalizedEditIntent,
} from './autonomous-edit-runtime.js';

interface State {
  readonly revision: number;
  readonly value: number;
}

interface Evidence {
  readonly visual: number;
}

interface Patch {
  readonly delta: number;
}

interface Inverse {
  readonly delta: number;
}

const changedDiff = (): TimelineDiff =>
  ({ summary: ['Changed the deterministic fixture'] }) as TimelineDiff;

const intent = (): NormalizedEditIntent => ({
  request: 'Change the fixture',
  criteria: {
    intentKind: 'mutation',
    requireTimelineChange: true,
    requireVisualEvidence: true,
  },
  measurableTasks: ['Change the fixture value'],
});

const plan = (): EditPlan => ({
  tasks: ['Change the fixture value'],
  evidenceQueries: ['Inspect the fixture'],
});

function adapters(
  overrides: Partial<AutonomousEditAdapters<State, Evidence, Patch, Inverse>> = {},
) {
  const base: AutonomousEditAdapters<State, Evidence, Patch, Inverse> = {
    getRevision: (state) => state.revision,
    normalizeIntent: async () => intent(),
    plan: async () => plan(),
    collectEvidence: async () => ({ visual: 1 }),
    proposePatch: async () => ({ delta: 1 }),
    validatePatch: async (patch) => ({ valid: true, patch, issues: [] }),
    applyPatch: async (patch, state, expectedRevision) => {
      if (state.revision !== expectedRevision) throw new Error('stale revision');
      return {
        state: { revision: state.revision + 1, value: state.value + patch.delta },
        inverse: { delta: -patch.delta },
        diff: changedDiff(),
        appliedOperationCount: patch.delta === 0 ? 0 : 1,
        revision: state.revision + 1,
      };
    },
    verify: async (state, _intent, evidence) => ({
      passed: state.value === 1,
      renderVerified: true,
      visualEvidenceCount: evidence.visual,
      issues: state.value === 1 ? [] : ['Unexpected value'],
    }),
    rollback: async (inverse, state) => ({
      revision: state.revision + 1,
      value: state.value + inverse.delta,
    }),
  };
  return { ...base, ...overrides };
}

describe('runAutonomousEdit', () => {
  it('completes only after apply, verification, and reconciliation pass', async () => {
    const events: string[] = [];
    const result = await runAutonomousEdit({
      request: 'Change the fixture',
      initialState: { revision: 0, value: 0 },
      adapters: adapters(),
      onEvent: (event) => events.push(event.stage),
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed result');
    expect(result.state).toEqual({ revision: 1, value: 1 });
    expect(result.attempts).toBe(1);
    expect(events).toEqual([
      'normalize',
      'plan',
      'evidence',
      'propose',
      'validate',
      'apply',
      'verify',
      'reconcile',
      'complete',
    ]);
  });

  it('feeds exact validation issues into one bounded correction', async () => {
    const proposePatch = vi
      .fn<AutonomousEditAdapters<State, Evidence, Patch, Inverse>['proposePatch']>()
      .mockResolvedValueOnce({ delta: 99 })
      .mockResolvedValueOnce({ delta: 1 });
    const validatePatch = vi
      .fn<AutonomousEditAdapters<State, Evidence, Patch, Inverse>['validatePatch']>()
      .mockResolvedValueOnce({ valid: false, issues: ['delta exceeds allowed range'] })
      .mockImplementation(async (patch) => ({ valid: true, patch, issues: [] }));

    const result = await runAutonomousEdit({
      request: 'Change the fixture',
      initialState: { revision: 0, value: 0 },
      adapters: adapters({ proposePatch, validatePatch }),
      maxCorrectionAttempts: 1,
    });

    expect(result.status).toBe('completed');
    expect(proposePatch).toHaveBeenCalledTimes(2);
    expect(proposePatch.mock.calls[1]?.[4]).toContain('delta exceeds allowed range');
  });

  it('rolls back a verified failure before proposing the correction', async () => {
    const statesSeen: State[] = [];
    const proposePatch = vi.fn(async () => ({ delta: 1 }));
    const verify = vi
      .fn<AutonomousEditAdapters<State, Evidence, Patch, Inverse>['verify']>()
      .mockResolvedValueOnce({
        passed: false,
        renderVerified: true,
        visualEvidenceCount: 1,
        issues: ['The first result did not match the intent'],
      })
      .mockImplementation(async (state) => {
        statesSeen.push(state);
        return {
          passed: true,
          renderVerified: true,
          visualEvidenceCount: 1,
          issues: [],
        };
      });

    const result = await runAutonomousEdit({
      request: 'Change the fixture',
      initialState: { revision: 0, value: 0 },
      adapters: adapters({ proposePatch, verify }),
      maxCorrectionAttempts: 1,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed result');
    expect(result.attempts).toBe(2);
    expect(result.state.value).toBe(1);
    expect(result.state.revision).toBe(3);
    expect(statesSeen).toEqual([{ revision: 3, value: 1 }]);
  });

  it('rejects and rolls back a no-op mutation instead of reporting success', async () => {
    const rollback = vi.fn(async (inverse: Inverse, state: State) => ({
      revision: state.revision + 1,
      value: state.value + inverse.delta,
    }));
    const result = await runAutonomousEdit({
      request: 'Change the fixture',
      initialState: { revision: 0, value: 0 },
      adapters: adapters({
        proposePatch: async () => ({ delta: 0 }),
        applyPatch: async (_patch, state) => ({
          state: { revision: state.revision + 1, value: state.value },
          inverse: { delta: 0 },
          diff: { summary: ['No changes'] } as TimelineDiff,
          appliedOperationCount: 0,
          revision: state.revision + 1,
        }),
        verify: async () => ({
          passed: true,
          renderVerified: true,
          visualEvidenceCount: 1,
          issues: [],
        }),
        rollback,
      }),
      maxCorrectionAttempts: 0,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed result');
    expect(result.rolledBack).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'The request required an edit, but no operation was applied.',
        'The applied patch produced no meaningful project or timeline change.',
      ]),
    );
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back an applied edit when cancellation interrupts verification', async () => {
    const controller = new AbortController();
    const rollback = vi.fn(async (inverse: Inverse, state: State) => ({
      revision: state.revision + 1,
      value: state.value + inverse.delta,
    }));
    const result = await runAutonomousEdit({
      request: 'Change the fixture',
      initialState: { revision: 0, value: 0 },
      signal: controller.signal,
      adapters: adapters({
        verify: async () => {
          controller.abort('cancelled in test');
          throw new DOMException('cancelled in test', 'AbortError');
        },
        rollback,
      }),
    });

    expect(result.status).toBe('cancelled');
    expect(result.rolledBack).toBe(true);
    expect(rollback).toHaveBeenCalledOnce();
  });
});
