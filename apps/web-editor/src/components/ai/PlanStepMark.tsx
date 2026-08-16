import type { PlanStep } from '@framepilot/ai-sdk';
import { Check, ICON_SIZE, X } from '../icons.js';
import { Tooltip } from '../Tooltip.js';

/** Plain-language status for the mark's `aria-label` — color/shape carries this for
 *  sighted users, but nothing else in a plan row conveys status to a screen reader. */
const STEP_STATUS_LABEL: Record<PlanStep['status'], string> = {
  completed: 'Completed',
  failed: 'Failed',
  running: 'In progress',
  pending: 'Pending',
};

/**
 * One step's status glyph — shared by the in-stream plan checklist (`EventNode`'s
 * `PlanChecklist`) and the header-docked plan ledger (`PlanAccordion`). Same mark,
 * two different placements, so it lives once here rather than twice.
 */
export function PlanStepMark({ step }: { step: PlanStep }): JSX.Element {
  const mark =
    step.status === 'completed' ? (
      <Check size={ICON_SIZE.sm} aria-hidden="true" />
    ) : step.status === 'failed' ? (
      <X size={ICON_SIZE.sm} aria-hidden="true" />
    ) : step.status === 'running' ? (
      <span className="ai-spinner" aria-hidden="true" />
    ) : (
      <span className="ai-dot" aria-hidden="true" />
    );

  // A failed step reveals WHY on hover/focus of its cross via the shared tooltip — the
  // detail IS the label here, more useful than the generic "Failed".
  if (step.status === 'failed' && step.detail) {
    return (
      <Tooltip label={step.detail}>
        <span
          className="ai-plan-mark ai-plan-mark--interactive"
          tabIndex={0}
          aria-label={step.detail}
        >
          {mark}
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="ai-plan-mark" aria-label={STEP_STATUS_LABEL[step.status]}>
      {mark}
    </span>
  );
}
