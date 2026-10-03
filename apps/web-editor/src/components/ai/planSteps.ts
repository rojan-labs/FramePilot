/**
 * How a plan step reads once the run that owns it is over.
 *
 * A step only leaves `running` when its producer re-emits the plan, and the producer only
 * does that on a clean finish. A run that ends any other way — the host refusing an event
 * (run f8574746's durable-log overflow), a provider or graph throw, a Stop mid-stream, the
 * app closing — left the checklist with a spinner on its in-progress step for good. The
 * SDK fold now settles those steps by log order; this is the renderer's half of the same
 * rule, keyed on the sidebar's `runEnded`, so the spinner stops even on an SDK build that
 * predates the fold and on a plan whose run the log never closed.
 */
import type { PlanStep } from '@framepilot/ai-sdk';

/**
 * Every status a plan step can render with. `stopped` — the run ended before the step was
 * done — is spelled out here as well as in the SDK's `PlanStep`, so the renderer compiles
 * against either side of that change.
 */
export type PlanStepStatus = PlanStep['status'] | 'stopped';

/** A plan step as the sidebar renders it. */
export type PlanStepView = Omit<PlanStep, 'status'> & { readonly status: PlanStepStatus };

/** True for a step that is not finished: what a run that ended leaves behind. */
function isUnfinished(step: PlanStepView): boolean {
  return step.status === 'pending' || step.status === 'running';
}

/**
 * The steps as they should read now.
 *
 * Once the run has ended, a step still `pending` or `running` reads as `stopped` — not
 * done, and not failed either: nothing went wrong with the step, the run ended first.
 * Steps the producer settled itself keep their status and detail.
 *
 * @param steps - The plan node's steps.
 * @param runEnded - The run that owns the plan is over.
 * @returns The same array while the run is live or nothing is unfinished.
 */
export function settlePlanSteps(
  steps: readonly PlanStepView[],
  runEnded: boolean,
): readonly PlanStepView[] {
  if (!runEnded || !steps.some(isUnfinished)) return steps;
  return steps.map((step) => (isUnfinished(step) ? { ...step, status: 'stopped' } : step));
}
