/**
 * @framepilot/ai-sdk/kernel/context/invariants — refuse to send a request that has
 * forgotten what it is doing (ADR 0080).
 *
 * ## Why this exists
 *
 * The failure this guards against is not "the prompt is large". It is a request going
 * out mid-run with no objective, no stage, or no next action — at which point the model
 * has nothing to continue from and does the only thing it can: re-reads the timeline,
 * re-browses the media bin, re-derives the beats, and re-proposes a plan the run already
 * committed to. From the outside that looks like the agent losing its memory. It is
 * really the harness handing it an amnesiac prompt.
 *
 * Silence is the worst response to that. If a required element is missing we say so —
 * every check names a specific missing thing and, where the answer is derivable from
 * state we already hold, {@link recoverWorkingState} fills it in deterministically. What
 * cannot be recovered is reported to the caller, which surfaces it rather than letting
 * the model compensate by re-exploring the project.
 *
 * Pure: no clock, no I/O, no model call. Recovery is a total function of the state.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  type RunStage,
  type RunWorkingState,
  isInterpreted,
  remainingObjectives,
  setNextAction,
} from '../working-state.js';

const log = createLogger('ai-sdk:kernel:context');

/** The named things a mid-run request must carry. */
export type ContextInvariant =
  | 'identity'
  | 'objective'
  | 'next_action'
  | 'project_revision'
  | 'committed_work';

export interface InvariantViolation {
  readonly invariant: ContextInvariant;
  /** What specifically is missing — never a bare "invalid state". */
  readonly detail: string;
  /** True when {@link recoverWorkingState} can derive the answer from existing state. */
  readonly recoverable: boolean;
}

export interface InvariantReport {
  readonly ok: boolean;
  readonly violations: readonly InvariantViolation[];
}

/**
 * Stages at which a run has not yet been asked to know anything. `interpret` is where
 * the objective is written, so demanding one there would fail every run's first turn.
 */
const PRE_INTERPRETATION: ReadonlySet<RunStage> = new Set<RunStage>(['interpret']);

/** Stages at which the run is changing the project and must have something committed. */
const EXECUTING: ReadonlySet<RunStage> = new Set<RunStage>(['apply', 'enhance', 'repair']);

/**
 * Check what a request about to go out is missing.
 *
 * Deliberately narrow. Each rule fires only where the element is genuinely required —
 * an over-eager invariant that trips on a legitimate first turn would be worse than none,
 * because the team would learn to ignore it.
 *
 * @param working - The run's task memory as it stands before the request.
 * @returns The violations found; `ok` is true when there are none.
 */
export function checkContextInvariants(working: RunWorkingState): InvariantReport {
  const violations: InvariantViolation[] = [];
  const past = (stage: RunStage): boolean => !PRE_INTERPRETATION.has(stage);

  if (
    past(working.stage) &&
    (working.identity.projectId === null) !== (working.identity.conversationId === null)
  ) {
    violations.push({
      invariant: 'identity',
      detail: `run identity is incomplete at ${working.stage}`,
      recoverable: working.identity.projectId === null && working.identity.conversationId === null,
    });
  }

  if (past(working.stage) && !isInterpreted(working)) {
    violations.push({
      invariant: 'objective',
      detail: `run reached ${working.stage} without a recorded objective`,
      // The creator's raw request is still held; it is a weaker outcome than an
      // interpreted one, but it is theirs, and it beats sending nothing.
      recoverable: working.objective.request.trim().length > 0,
    });
  }

  if (past(working.stage) && working.stage !== 'complete' && working.nextAction === null) {
    violations.push({
      invariant: 'next_action',
      detail: `no next action recorded at stage ${working.stage}`,
      recoverable: true,
    });
  }

  if (working.currentProjectRevision < working.baseProjectRevision) {
    violations.push({
      invariant: 'project_revision',
      detail:
        `current revision ${working.currentProjectRevision} is behind the run's base ` +
        `${working.baseProjectRevision}`,
      recoverable: working.identity.projectId === null && working.identity.conversationId === null,
    });
  }

  if (
    EXECUTING.has(working.stage) &&
    (((working.plan.status !== 'committed' || working.plan.id === null) &&
      !(
        working.identity.projectId === null &&
        working.identity.conversationId === null &&
        (working.decisions.some((decision) => decision.status === 'committed') ||
          working.objectives.length > 0)
      )) ||
      (working.decisions.every((d) => d.status !== 'committed') &&
        !(working.identity.projectId === null && working.objectives.length > 0)) ||
      (working.plan.decisionIds.length === 0 && working.identity.projectId !== null) ||
      (!working.execution.authorized && working.identity.projectId !== null))
  ) {
    violations.push({
      invariant: 'committed_work',
      detail:
        `run is executing at ${working.stage} with no committed decision or ` +
        'objective-backed plan',
      // Nothing in state says what the run meant to do. Inventing one here would be a
      // fabricated plan, which is exactly the failure mode this module exists to prevent.
      recoverable: false,
    });
  }

  if (violations.length > 0) {
    log.warn('context.invariant.violated', {
      runId: working.runId,
      stage: working.stage,
      violations: violations.map((v) => v.invariant),
      unrecoverable: violations.filter((v) => !v.recoverable).map((v) => v.invariant),
    });
  }
  return { ok: violations.length === 0, violations };
}

/** The instruction a stage implies when the run failed to write one. */
function defaultActionFor(working: RunWorkingState): string {
  const owed = remainingObjectives(working)[0];
  if (owed) return `Continue ${working.stage}: ${owed.description}`;
  switch (working.stage) {
    case 'inspect':
      return 'Continue inspect: read only what the objective still needs.';
    case 'analyze':
      return 'Continue analyze: finish the analysis the plan depends on.';
    case 'plan':
      return 'Continue plan: commit the edit plan for the recorded objective.';
    case 'apply':
    case 'enhance':
    case 'repair':
      return `Continue ${working.stage}: apply the committed plan.`;
    case 'verify':
      return 'Continue verify: check the applied edit against the acceptance criteria.';
    /* v8 ignore next 3 -- `interpret` and `complete` never reach here (guarded above) */
    default:
      return `Continue ${working.stage}.`;
  }
}

export interface RecoveryOutcome {
  readonly state: RunWorkingState;
  /** Which invariants were repaired, in the order they were repaired. */
  readonly recovered: readonly ContextInvariant[];
  /** Violations no deterministic repair can address — the caller must surface these. */
  readonly unrecovered: readonly InvariantViolation[];
}

/**
 * Repair what is deterministically repairable, and report the rest.
 *
 * Recovery derives from state the run already holds — the creator's request, the stage
 * machine, the outstanding objectives — never from a guess and never from a model call.
 * A repair that cannot be derived is not attempted: an invented plan is worse than an
 * honest gap, because the run would then execute against something nobody chose.
 *
 * The returned state is used for THIS request only; the reducer remains the ledger of
 * record and writes the real next action when the turn concludes.
 *
 * @param working - The run's task memory.
 * @param report - The violations from {@link checkContextInvariants}.
 * @returns A repaired copy, what was repaired, and what still is not.
 */
export function recoverWorkingState(
  working: RunWorkingState,
  report: InvariantReport,
): RecoveryOutcome {
  let state = working;
  const recovered: ContextInvariant[] = [];

  for (const violation of report.violations) {
    if (!violation.recoverable) continue;
    switch (violation.invariant) {
      case 'objective': {
        // Not `setObjective`: that is idempotent-by-intent and refuses to overwrite, but
        // it also stamps acceptance criteria, and inventing criteria the creator never
        // stated is exactly the fabrication we refuse elsewhere. Carry the raw request.
        state = {
          ...state,
          version: state.version + 1,
          objective: { ...state.objective, outcome: state.objective.request.trim() },
        };
        recovered.push('objective');
        break;
      }
      case 'next_action': {
        state = setNextAction(state, {
          stage: state.stage,
          action: defaultActionFor(state),
        });
        recovered.push('next_action');
        break;
      }
      case 'project_revision': {
        state = {
          ...state,
          version: state.version + 1,
          currentProjectRevision: state.baseProjectRevision,
        };
        recovered.push('project_revision');
        break;
      }
      /* v8 ignore next 3 -- identity, revisions and committed work are never guessed */
      default:
        break;
    }
  }

  const unrecovered = report.violations.filter((v) => !v.recoverable);
  if (recovered.length > 0) {
    log.action('context.invariant.recovered', { runId: working.runId, recovered });
  }
  return { state, recovered, unrecovered };
}

/**
 * Check and repair in one call — the shape the request path uses.
 *
 * @param working - The run's task memory before the request.
 * @returns The state to build the request from, plus what was repaired and what was not.
 */
export function ensureContextInvariants(working: RunWorkingState): RecoveryOutcome {
  return recoverWorkingState(working, checkContextInvariants(working));
}

/** One creator-facing line naming what the run could not recover. */
export function describeUnrecovered(unrecovered: readonly InvariantViolation[]): string {
  const details = unrecovered.map((v) => `- ${v.invariant}: ${v.detail}`).join('\n');
  return (
    `RUN_STATE_INTEGRITY_FAILURE\n${details}\n` +
    'Action: automated mutation is blocked and the run is paused for safe recovery.'
  );
}
