/**
 * Completion reconciliation for autonomous edit runs.
 *
 * A syntactically valid patch is not automatically a satisfying edit. This gate
 * compares the requested intent, the applied diff, and verification evidence so
 * the orchestrator cannot report a no-op, cosmetic-only result, unverified render,
 * or incomplete planned work as success.
 */
import type { TimelineDiff } from '@framepilot/editor-core';

export type EditIntentKind = 'question' | 'analysis' | 'mutation' | 'render';

export interface EditAcceptanceCriteria {
  readonly intentKind: EditIntentKind;
  readonly requireTimelineChange?: boolean;
  readonly requireRender?: boolean;
  readonly requireVisualEvidence?: boolean;
  readonly targetDurationFrames?: number;
  readonly durationToleranceFrames?: number;
}

export interface EditCompletionEvidence {
  readonly diff?: TimelineDiff;
  readonly appliedOperationCount: number;
  readonly plannedTaskCount: number;
  readonly completedTaskCount: number;
  readonly failedTaskCount: number;
  readonly rendered: boolean;
  readonly renderVerified: boolean;
  readonly visualEvidenceCount: number;
  readonly actualDurationFrames?: number;
}

export type CompletionFailureCode =
  | 'no_applied_edit'
  | 'no_meaningful_change'
  | 'planned_work_incomplete'
  | 'task_failed'
  | 'render_missing'
  | 'render_unverified'
  | 'visual_evidence_missing'
  | 'duration_evidence_missing'
  | 'target_duration_missed';

export interface CompletionFailure {
  readonly code: CompletionFailureCode;
  readonly message: string;
}

export interface CompletionAssessment {
  readonly complete: boolean;
  readonly failures: readonly CompletionFailure[];
}

const diffHasMeaningfulChange = (diff: TimelineDiff | undefined): boolean =>
  diff !== undefined && !diff.summary.every((line) => line.trim().toLowerCase() === 'no changes');

/** Reconcile the final run against measurable acceptance criteria. */
export function assessEditCompletion(
  criteria: EditAcceptanceCriteria,
  evidence: EditCompletionEvidence,
): CompletionAssessment {
  const failures: CompletionFailure[] = [];
  const mutationRequired =
    criteria.requireTimelineChange ??
    (criteria.intentKind === 'mutation' || criteria.intentKind === 'render');

  if (mutationRequired && evidence.appliedOperationCount === 0) {
    failures.push({
      code: 'no_applied_edit',
      message: 'The request required an edit, but no operation was applied.',
    });
  }
  if (mutationRequired && !diffHasMeaningfulChange(evidence.diff)) {
    failures.push({
      code: 'no_meaningful_change',
      message: 'The applied patch produced no meaningful project or timeline change.',
    });
  }
  if (evidence.failedTaskCount > 0) {
    failures.push({
      code: 'task_failed',
      message: `${String(evidence.failedTaskCount)} planned task(s) failed.`,
    });
  }
  if (evidence.completedTaskCount < evidence.plannedTaskCount) {
    failures.push({
      code: 'planned_work_incomplete',
      message:
        `${String(evidence.completedTaskCount)} of ${String(evidence.plannedTaskCount)} ` +
        'planned tasks completed.',
    });
  }

  const renderRequired = criteria.requireRender ?? criteria.intentKind === 'render';
  if (renderRequired && !evidence.rendered) {
    failures.push({
      code: 'render_missing',
      message: 'The request required a render, but none ran.',
    });
  } else if (renderRequired && !evidence.renderVerified) {
    failures.push({
      code: 'render_unverified',
      message: 'The render completed without passing deterministic validation.',
    });
  }

  if (criteria.requireVisualEvidence && evidence.visualEvidenceCount === 0) {
    failures.push({
      code: 'visual_evidence_missing',
      message: 'A visual conclusion was made without a frame or segment as evidence.',
    });
  }

  if (criteria.targetDurationFrames !== undefined) {
    if (evidence.actualDurationFrames === undefined) {
      failures.push({
        code: 'duration_evidence_missing',
        message:
          'The request has a target duration, but verification did not measure the final duration.',
      });
    } else {
      const tolerance = criteria.durationToleranceFrames ?? 1;
      const delta = Math.abs(evidence.actualDurationFrames - criteria.targetDurationFrames);
      if (delta > tolerance) {
        failures.push({
          code: 'target_duration_missed',
          message:
            `Final duration missed the target by ${String(delta)} frame(s); ` +
            `allowed tolerance is ${String(tolerance)}.`,
        });
      }
    }
  }

  return { complete: failures.length === 0, failures };
}

/** A bounded correction prompt containing only actionable completion failures. */
export function completionCorrectionPrompt(assessment: CompletionAssessment): string {
  if (assessment.complete) return '';
  return [
    'The edit cannot be reported as complete yet. Correct these issues:',
    ...assessment.failures.map(
      (failure, index) => `${String(index + 1)}. [${failure.code}] ${failure.message}`,
    ),
    'Propose only the smallest typed correction needed, then validate and verify again.',
  ].join('\n');
}
