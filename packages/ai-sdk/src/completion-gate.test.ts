import { readFile } from 'node:fs/promises';
import type { TimelineDiff } from '@framepilot/editor-core';
import { describe, expect, it } from 'vitest';
import {
  assessEditCompletion,
  completionCorrectionPrompt,
  type EditCompletionEvidence,
} from './completion-gate.js';

const changedDiff = { summary: ['trimmed 1 clip'] } as TimelineDiff;
const unchangedDiff = { summary: ['no changes'] } as TimelineDiff;

const evidence = (overrides: Partial<EditCompletionEvidence> = {}): EditCompletionEvidence => ({
  diff: changedDiff,
  appliedOperationCount: 1,
  plannedTaskCount: 1,
  completedTaskCount: 1,
  failedTaskCount: 0,
  rendered: false,
  renderVerified: false,
  visualEvidenceCount: 1,
  ...overrides,
});

describe('assessEditCompletion', () => {
  it('accepts a verified mutation with meaningful applied work', () => {
    expect(assessEditCompletion({ intentKind: 'mutation' }, evidence())).toEqual({
      complete: true,
      failures: [],
    });
  });

  it('rejects zero-operation and no-change mutation output', () => {
    const result = assessEditCompletion(
      { intentKind: 'mutation' },
      evidence({ appliedOperationCount: 0, diff: unchangedDiff }),
    );
    expect(result.complete).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual([
      'no_applied_edit',
      'no_meaningful_change',
    ]);
  });

  it('allows a question or analysis to complete without a timeline mutation', () => {
    expect(
      assessEditCompletion(
        { intentKind: 'question' },
        evidence({
          appliedOperationCount: 0,
          diff: undefined,
          plannedTaskCount: 0,
          completedTaskCount: 0,
        }),
      ).complete,
    ).toBe(true);
    expect(
      assessEditCompletion(
        { intentKind: 'analysis', requireVisualEvidence: true },
        evidence({ appliedOperationCount: 0, diff: undefined }),
      ).complete,
    ).toBe(true);
  });

  it('rejects failed and unreconciled planned work', () => {
    const result = assessEditCompletion(
      { intentKind: 'mutation' },
      evidence({ plannedTaskCount: 4, completedTaskCount: 2, failedTaskCount: 1 }),
    );
    expect(result.failures.map((failure) => failure.code)).toEqual([
      'task_failed',
      'planned_work_incomplete',
    ]);
  });

  it('requires a render and deterministic verification for render intents', () => {
    expect(
      assessEditCompletion({ intentKind: 'render' }, evidence()).failures.map(
        (failure) => failure.code,
      ),
    ).toContain('render_missing');
    expect(
      assessEditCompletion(
        { intentKind: 'render' },
        evidence({ rendered: true, renderVerified: false }),
      ).failures.map((failure) => failure.code),
    ).toContain('render_unverified');
    expect(
      assessEditCompletion(
        { intentKind: 'render' },
        evidence({ rendered: true, renderVerified: true }),
      ).complete,
    ).toBe(true);
  });

  it('requires visual evidence only when the acceptance contract says so', () => {
    const result = assessEditCompletion(
      { intentKind: 'analysis', requireVisualEvidence: true },
      evidence({ appliedOperationCount: 0, diff: undefined, visualEvidenceCount: 0 }),
    );
    expect(result.failures).toEqual([
      {
        code: 'visual_evidence_missing',
        message: 'A visual conclusion was made without a frame or segment as evidence.',
      },
    ]);
  });

  it('checks target duration in integer frames with a one-frame default tolerance', () => {
    expect(
      assessEditCompletion(
        { intentKind: 'mutation', targetDurationFrames: 900 },
        evidence({ actualDurationFrames: 901 }),
      ).complete,
    ).toBe(true);
    const missed = assessEditCompletion(
      { intentKind: 'mutation', targetDurationFrames: 900, durationToleranceFrames: 0 },
      evidence({ actualDurationFrames: 901 }),
    );
    expect(missed.failures[0]).toMatchObject({ code: 'target_duration_missed' });
  });
});

describe('completionCorrectionPrompt', () => {
  it('returns no correction text for a completed run', () => {
    expect(completionCorrectionPrompt({ complete: true, failures: [] })).toBe('');
  });

  it('produces a bounded actionable correction prompt', () => {
    const assessment = assessEditCompletion(
      { intentKind: 'mutation' },
      evidence({ appliedOperationCount: 0, diff: unchangedDiff }),
    );
    expect(completionCorrectionPrompt(assessment)).toContain('[no_applied_edit]');
    expect(completionCorrectionPrompt(assessment)).toContain('[no_meaningful_change]');
    expect(completionCorrectionPrompt(assessment)).toContain('smallest typed correction');
  });
});

/**
 * GAP-006, as a standing guard.
 *
 * This module was written to stop a run reporting incomplete work as success, and then wired
 * only into `autonomous-edit-runtime.ts` — which no production code ever called. Its tests
 * passed against fake adapters for as long as that lasted, which is worse than no tests: a
 * green suite for a rail that was not installed.
 *
 * Asserting the WIRING, not just the logic, is what keeps that from happening again. A
 * reviewer deleting the conductor call would have to delete this too, and say why.
 */
describe('the gate is actually installed', () => {
  it('is called from the conductor’s finalize fold, not only from tests', async () => {
    const conductor = await readFile(new URL('./kernel/conductor.ts', import.meta.url), 'utf8');
    expect(conductor).toContain('assessEditCompletion(');
  });

  it('has no second, unshipped runtime standing beside it', async () => {
    // `autonomous-edit-runtime.ts` was that runtime. If it comes back, it needs a production
    // caller — or this module is orphaned again the moment the two disagree.
    await expect(
      readFile(new URL('./autonomous-edit-runtime.ts', import.meta.url), 'utf8'),
    ).rejects.toThrow();
  });
});
