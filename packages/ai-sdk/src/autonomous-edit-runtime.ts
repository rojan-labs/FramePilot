/**
 * Transactional autonomous-edit runtime.
 *
 * The language model never mutates project state directly. It plans and proposes
 * typed patches; this runtime owns revision checks, validation, bounded correction,
 * atomic apply, verification, completion reconciliation, and rollback.
 */
import type { TimelineDiff } from '@framepilot/editor-core';
import {
  assessEditCompletion,
  completionCorrectionPrompt,
  type CompletionAssessment,
  type EditAcceptanceCriteria,
  type EditCompletionEvidence,
} from './completion-gate.js';

export type AutonomousRunStage =
  | 'normalize'
  | 'plan'
  | 'evidence'
  | 'propose'
  | 'validate'
  | 'correct'
  | 'apply'
  | 'render'
  | 'verify'
  | 'reconcile'
  | 'rollback'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface AutonomousRunEvent {
  readonly stage: AutonomousRunStage;
  readonly message: string;
  readonly attempt?: number;
  readonly progress?: number;
  readonly issues?: readonly string[];
}

export interface NormalizedEditIntent {
  readonly request: string;
  readonly criteria: EditAcceptanceCriteria;
  readonly measurableTasks: readonly string[];
}

export interface EditPlan {
  readonly tasks: readonly string[];
  readonly evidenceQueries: readonly string[];
}

export interface ValidationResult<TPatch> {
  readonly valid: boolean;
  readonly patch?: TPatch;
  readonly issues: readonly string[];
}

export interface ApplyResult<TState, TInverse> {
  readonly state: TState;
  readonly inverse: TInverse;
  readonly diff?: TimelineDiff;
  readonly appliedOperationCount: number;
  readonly revision: number;
}

export interface RenderResult {
  readonly rendered: boolean;
  readonly outputPath?: string;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly renderVerified: boolean;
  readonly visualEvidenceCount: number;
  readonly actualDurationFrames?: number;
  readonly issues: readonly string[];
}

export interface AutonomousEditAdapters<TState, TEvidence, TPatch, TInverse> {
  readonly getRevision: (state: TState) => number;
  readonly normalizeIntent: (request: string, state: TState) => Promise<NormalizedEditIntent>;
  readonly plan: (intent: NormalizedEditIntent, state: TState) => Promise<EditPlan>;
  readonly collectEvidence: (
    plan: EditPlan,
    state: TState,
    signal: AbortSignal,
  ) => Promise<TEvidence>;
  readonly proposePatch: (
    intent: NormalizedEditIntent,
    plan: EditPlan,
    evidence: TEvidence,
    state: TState,
    correction?: string,
  ) => Promise<TPatch>;
  readonly validatePatch: (patch: TPatch, state: TState) => Promise<ValidationResult<TPatch>>;
  readonly applyPatch: (
    patch: TPatch,
    state: TState,
    expectedRevision: number,
  ) => Promise<ApplyResult<TState, TInverse>>;
  readonly render?: (state: TState, signal: AbortSignal) => Promise<RenderResult>;
  readonly verify: (
    state: TState,
    intent: NormalizedEditIntent,
    evidence: TEvidence,
    render: RenderResult | undefined,
    signal: AbortSignal,
  ) => Promise<VerificationResult>;
  readonly rollback: (inverse: TInverse, state: TState) => Promise<TState>;
}

export interface AutonomousEditRunInput<TState, TEvidence, TPatch, TInverse> {
  readonly request: string;
  readonly initialState: TState;
  readonly adapters: AutonomousEditAdapters<TState, TEvidence, TPatch, TInverse>;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
  /**
   * Stable editing-context identity for idempotent replay. Callers with a project id
   * should pass it explicitly. When omitted, the runtime derives a conservative identity
   * from common state shapes (`state.id` or `state.project.id`) and folds it into the cache
   * key as an extra guard against two different projects colliding on the same idempotency
   * key, revision, and request text. When no identity can be proven at all, completed-run
   * caching still dedups on (idempotencyKey, revision, request) alone -- it is never disabled
   * outright, since that would break idempotent replay for every caller that does not (or
   * cannot) supply an identity-bearing state.
   */
  readonly idempotencyScope?: string;
  readonly maxCorrectionAttempts?: number;
  readonly onEvent?: (event: AutonomousRunEvent) => void;
}

export interface AutonomousEditSuccess<TState, TPatch, TInverse> {
  readonly status: 'completed';
  readonly state: TState;
  readonly patch: TPatch;
  readonly inverse: TInverse;
  readonly assessment: CompletionAssessment;
  readonly attempts: number;
}

export interface AutonomousEditFailure<TState> {
  readonly status: 'failed' | 'cancelled';
  readonly state: TState;
  readonly reason: string;
  readonly issues: readonly string[];
  readonly attempts: number;
  readonly rolledBack: boolean;
}

export type AutonomousEditRunResult<TState, TPatch, TInverse> =
  | AutonomousEditSuccess<TState, TPatch, TInverse>
  | AutonomousEditFailure<TState>;

/** Successful idempotent results, bounded so a desktop session cannot grow forever. */
const MAX_COMPLETED_RUNS = 128;
const completedRuns = new Map<string, unknown>();

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Derive an editing-context identity only when the state proves one. A revision is not
 * an identity: two projects can both be revision 4, which was the old collision hole.
 */
function stateIdentity(state: unknown): string | undefined {
  const record = objectRecord(state);
  if (!record) return undefined;
  if (typeof record.id === 'string' && record.id.trim() !== '') return record.id;
  const project = objectRecord(record.project);
  return typeof project?.id === 'string' && project.id.trim() !== '' ? project.id : undefined;
}

/** Shared bucket for callers that cannot prove an editing-context identity. */
const UNSCOPED_IDENTITY = 'unscoped';

function completedRunKey<TState, TEvidence, TPatch, TInverse>(
  input: AutonomousEditRunInput<TState, TEvidence, TPatch, TInverse>,
): string | undefined {
  if (!input.idempotencyKey) return undefined;
  // A proven identity (explicit scope, or state.id / state.project.id) is folded into the
  // key as an extra collision guard: two different projects that happen to land on the same
  // revision, request text, and caller-supplied idempotency key can never replay each other's
  // result. When no identity can be proven, every such call shares one constant bucket, which
  // preserves the pre-existing base contract (dedup on key + revision + request alone) instead
  // of disabling the cache outright -- see autonomous-edit-runtime.transaction.test.ts,
  // contract-hardening.audit.test.ts, and runtime-policy.audit.test.ts.
  const scope =
    input.idempotencyScope?.trim() || stateIdentity(input.initialState) || UNSCOPED_IDENTITY;
  const revision = input.adapters.getRevision(input.initialState);
  return `${scope}\u0000${input.idempotencyKey}\u0000rev:${String(revision)}\u0000request:${input.request}`;
}

function rememberCompleted(key: string, result: unknown): void {
  completedRuns.set(key, result);
  while (completedRuns.size > MAX_COMPLETED_RUNS) {
    const oldest = completedRuns.keys().next().value as string | undefined;
    /* v8 ignore next -- a Map with size > 0 always yields a first key. */
    if (oldest === undefined) break;
    completedRuns.delete(oldest);
  }
}

const abortReason = (signal: AbortSignal): string =>
  signal.reason instanceof Error ? signal.reason.message : 'The edit was cancelled.';

const emit = (
  callback: ((event: AutonomousRunEvent) => void) | undefined,
  event: AutonomousRunEvent,
): void => callback?.(event);

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException(abortReason(signal), 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function evidenceFrom(
  plan: EditPlan,
  apply: ApplyResult<unknown, unknown>,
  verify: VerificationResult,
  render: RenderResult | undefined,
): EditCompletionEvidence {
  return {
    ...(apply.diff ? { diff: apply.diff } : {}),
    appliedOperationCount: apply.appliedOperationCount,
    plannedTaskCount: plan.tasks.length,
    completedTaskCount: verify.passed
      ? plan.tasks.length
      : Math.max(0, plan.tasks.length - verify.issues.length),
    failedTaskCount: verify.passed ? 0 : verify.issues.length,
    rendered: render?.rendered === true,
    renderVerified: verify.renderVerified,
    visualEvidenceCount: verify.visualEvidenceCount,
    ...(verify.actualDurationFrames !== undefined
      ? { actualDurationFrames: verify.actualDurationFrames }
      : {}),
  };
}

/**
 * Execute one autonomous edit transaction. At most two correction attempts run by
 * default. Any post-apply failure rolls the grouped inverse back before returning.
 */
export async function runAutonomousEdit<TState, TEvidence, TPatch, TInverse>(
  input: AutonomousEditRunInput<TState, TEvidence, TPatch, TInverse>,
): Promise<AutonomousEditRunResult<TState, TPatch, TInverse>> {
  const controller = new AbortController();
  const externalAbort = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', externalAbort, { once: true });
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  const signal = controller.signal;
  const maxCorrections = Math.max(0, Math.min(2, input.maxCorrectionAttempts ?? 2));
  const cacheKey = completedRunKey(input);

  if (cacheKey !== undefined) {
    const cached = completedRuns.get(cacheKey);
    if (cached !== undefined) {
      return cached as AutonomousEditRunResult<TState, TPatch, TInverse>;
    }
  }

  let state = input.initialState;
  let inverse: TInverse | undefined;
  let attempts = 0;
  try {
    throwIfAborted(signal);
    emit(input.onEvent, {
      stage: 'normalize',
      message: 'Turning the request into measurable edit criteria.',
    });
    const intent = await input.adapters.normalizeIntent(input.request, state);

    throwIfAborted(signal);
    emit(input.onEvent, { stage: 'plan', message: 'Planning the smallest complete edit.' });
    const plan = await input.adapters.plan(intent, state);

    throwIfAborted(signal);
    emit(input.onEvent, {
      stage: 'evidence',
      message: 'Collecting deterministic and visual evidence.',
    });
    const collected = await input.adapters.collectEvidence(plan, state, signal);

    let correction: string | undefined;
    let finalIssues: readonly string[] = [];
    for (;;) {
      throwIfAborted(signal);
      attempts += 1;
      emit(input.onEvent, {
        stage: correction ? 'correct' : 'propose',
        attempt: attempts,
        message: correction ? 'Proposing a bounded correction.' : 'Proposing a typed edit patch.',
      });
      const proposed = await input.adapters.proposePatch(
        intent,
        plan,
        collected,
        state,
        correction,
      );

      throwIfAborted(signal);
      emit(input.onEvent, {
        stage: 'validate',
        attempt: attempts,
        message: 'Validating the patch before apply.',
      });
      const validated = await input.adapters.validatePatch(proposed, state);
      if (!validated.valid || validated.patch === undefined) {
        finalIssues = validated.issues;
        if (attempts > maxCorrections) {
          emit(input.onEvent, {
            stage: 'failed',
            attempt: attempts,
            message: 'The patch remained invalid after bounded correction.',
            issues: validated.issues,
          });
          return {
            status: 'failed',
            state,
            reason: 'Patch validation failed after bounded correction.',
            issues: validated.issues,
            attempts,
            rolledBack: false,
          };
        }
        correction = [
          'The proposed patch did not pass validation. Fix only these issues:',
          ...validated.issues.map((issue, index) => `${String(index + 1)}. ${issue}`),
        ].join('\n');
        continue;
      }

      const expectedRevision = input.adapters.getRevision(state);
      throwIfAborted(signal);
      emit(input.onEvent, {
        stage: 'apply',
        attempt: attempts,
        message: 'Applying the validated patch atomically.',
      });
      const applied = await input.adapters.applyPatch(validated.patch, state, expectedRevision);
      state = applied.state;
      inverse = applied.inverse;

      let render: RenderResult | undefined;
      if (intent.criteria.requireRender) {
        if (!input.adapters.render) {
          finalIssues = ['The request requires a render, but no render adapter is configured.'];
        } else {
          throwIfAborted(signal);
          emit(input.onEvent, {
            stage: 'render',
            attempt: attempts,
            message: 'Rendering the applied edit.',
          });
          render = await input.adapters.render(state, signal);
        }
      }

      throwIfAborted(signal);
      emit(input.onEvent, {
        stage: 'verify',
        attempt: attempts,
        message: 'Verifying the applied edit and render.',
      });
      const verified = await input.adapters.verify(state, intent, collected, render, signal);
      finalIssues = [...finalIssues, ...verified.issues];

      emit(input.onEvent, {
        stage: 'reconcile',
        attempt: attempts,
        message: 'Reconciling the result with the original intent.',
      });
      const assessment = assessEditCompletion(
        intent.criteria,
        evidenceFrom(plan, applied, verified, render),
      );
      if (assessment.complete && verified.passed) {
        const result: AutonomousEditSuccess<TState, TPatch, TInverse> = {
          status: 'completed',
          state,
          patch: validated.patch,
          inverse: applied.inverse,
          assessment,
          attempts,
        };
        emit(input.onEvent, {
          stage: 'complete',
          attempt: attempts,
          message: 'The edit is applied, verified, and complete.',
        });
        if (cacheKey !== undefined) rememberCompleted(cacheKey, result);
        return result;
      }

      const assessmentIssues = assessment.failures.map((failure) => failure.message);
      finalIssues = [...new Set([...finalIssues, ...assessmentIssues])];
      if (inverse !== undefined) {
        emit(input.onEvent, {
          stage: 'rollback',
          attempt: attempts,
          message: 'Rolling back the failed edit before correction.',
        });
        state = await input.adapters.rollback(inverse, state);
        inverse = undefined;
      }
      if (attempts > maxCorrections) {
        emit(input.onEvent, {
          stage: 'failed',
          attempt: attempts,
          message: 'The edit did not satisfy its acceptance criteria.',
          issues: finalIssues,
        });
        return {
          status: 'failed',
          state,
          reason: 'The edit failed deterministic completion reconciliation.',
          issues: finalIssues,
          attempts,
          rolledBack: true,
        };
      }
      correction = [
        completionCorrectionPrompt(assessment),
        ...verified.issues.filter((issue) => issue.trim() !== ''),
      ].join('\n');
    }
  } catch (error) {
    const cancelled = isAbort(error) || signal.aborted;
    /* v8 ignore next -- adapters reject with Errors; the String() arm is defensive */
    const issues = [error instanceof Error ? error.message : String(error)];
    let rolledBack = false;
    if (inverse !== undefined) {
      try {
        emit(input.onEvent, {
          stage: 'rollback',
          attempt: attempts,
          message: 'Rolling back the interrupted edit.',
        });
        state = await input.adapters.rollback(inverse, state);
        rolledBack = true;
      } catch (rollbackError) {
        /* v8 ignore next 3 */
        issues.push(
          `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    emit(input.onEvent, {
      stage: cancelled ? 'cancelled' : 'failed',
      attempt: attempts,
      message: cancelled ? 'The edit was cancelled.' : 'The edit failed.',
      issues,
    });
    return {
      status: cancelled ? 'cancelled' : 'failed',
      state,
      /* v8 ignore next -- `issues` always holds the caught error, so the ?? is defensive */
      reason: issues[0] ?? 'Unknown autonomous edit failure.',
      issues,
      attempts,
      rolledBack,
    };
    /* v8 ignore start */
  } finally {
    input.signal?.removeEventListener('abort', externalAbort);
  }
  /* v8 ignore stop */
}
