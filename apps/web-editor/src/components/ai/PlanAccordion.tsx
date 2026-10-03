import type { PlanNode } from '@framepilot/ai-sdk';
import { ArrowUpRight, ChevronDown, ICON_SIZE } from '../icons.js';
import { PlanStepMark } from './PlanStepMark.js';
import type { StepOutcome } from './EventNode.js';
import { type PlanStepView, settlePlanSteps } from './planSteps.js';

export interface PlanAccordionProps {
  readonly node: PlanNode;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  /**
   * What each step's own edit did, keyed by step id (see `DiffEvent.planStepId`).
   *
   * A step and its edit are the same event described twice, so they render as one row.
   * When the edit had its own card the sidebar told the story in two parallel narratives —
   * a checklist saying "Remove them" and, elsewhere, a card saying "9 changes" — which the
   * reader had to join by eye. With no decision left to make, the edit has no reason to
   * hold a surface of its own.
   */
  readonly outcomes?: ReadonlyMap<string, StepOutcome>;
  /** Move the playhead to where a step's change begins. */
  readonly onSeek?: (seconds: number) => void;
  /**
   * The run that owns this plan is over: an unfinished step reads as stopped, never as a
   * spinner (see `planSteps.ts`).
   */
  readonly runEnded?: boolean;
}

/**
 * Pick the step that best represents where the run is now. A run that stopped reads like
 * one that finished — its last completed step, with the header's count saying how far it
 * got — and only a plan with nothing completed shows where it stopped.
 */
export function recentPlanStep(node: {
  readonly steps: readonly PlanStepView[];
}): PlanStepView | undefined {
  const reversed = [...node.steps].reverse();
  return (
    reversed.find((step) => step.status === 'running') ??
    reversed.find((step) => step.status === 'failed') ??
    reversed.find((step) => step.status === 'completed') ??
    node.steps.find((step) => step.status === 'stopped') ??
    node.steps.find((step) => step.status === 'pending')
  );
}

function PlanStepRow({
  step,
  outcome,
  onSeek,
}: {
  step: PlanStepView;
  outcome?: StepOutcome;
  onSeek?: (seconds: number) => void;
}): JSX.Element {
  return (
    <li className="ai-plan-step" data-status={step.status}>
      <PlanStepMark step={step} />
      <span className={`ai-plan-step-label${step.status === 'running' ? ' ai-shimmer-text' : ''}`}>
        {step.label}
      </span>
      {step.status === 'running' && step.detail && step.detail !== step.label ? (
        <span className="ai-plan-detail">{step.detail}</span>
      ) : null}
      {outcome && (
        <span className="ai-plan-outcome tabular">
          {outcome.operationCount} change{outcome.operationCount === 1 ? '' : 's'}
        </span>
      )}
      {outcome?.jumpSeconds !== undefined && onSeek && (
        <button
          type="button"
          className="ai-plan-jump"
          aria-label={`Jump to what "${step.label}" changed`}
          onClick={() => onSeek(outcome.jumpSeconds!)}
        >
          <ArrowUpRight size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

/** Header-adjacent, recent-first plan ledger for the active run. */
export function PlanAccordion({
  node,
  expanded,
  onExpandedChange,
  outcomes,
  onSeek,
  runEnded,
}: PlanAccordionProps): JSX.Element {
  const steps = settlePlanSteps(node.steps, runEnded === true);
  const doneCount = steps.filter((step) => step.status === 'completed').length;
  const recent = recentPlanStep({ steps });
  const bodyId = `plan-steps-${node.id}`;

  return (
    <section className="ai-plan-accordion" data-expanded={expanded} aria-label="Run plan">
      <button
        type="button"
        className="ai-plan-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className="ai-plan-title">Plan</span>
        <span className="ai-plan-progress tabular">
          {doneCount}/{steps.length}
        </span>
        <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
      </button>
      <ul
        id={bodyId}
        className="ai-plan"
        aria-label={expanded ? 'All plan steps' : 'Current plan step'}
      >
        {(expanded ? steps : recent ? [recent] : []).map((step) => (
          <PlanStepRow
            key={step.id}
            step={step}
            {...(outcomes?.get(step.id) ? { outcome: outcomes.get(step.id)! } : {})}
            {...(onSeek ? { onSeek } : {})}
          />
        ))}
      </ul>
    </section>
  );
}
