/**
 * Plan-approval step-list card (P11.3, P12.4 — plan/AGENT-NATIVE-COMPLETION-PLAN.md).
 *
 * For a high-blast-radius drafted plan (more than
 * `PLAN_APPROVAL_STEP_THRESHOLD` steps — `@framepilot/ai-sdk`'s `kernel/conductor.ts`),
 * the run pauses BEFORE its first turn and this card renders the plan as a friendly
 * numbered list in plain language (never "DAG" — the graph stays internal) with
 * inline Approve / Edit request / Cancel — no modal (P12.0). Manual mode reviews
 * diffs after the fact; this is autonomous mode reviewing the *plan* up front.
 */
export interface PlanApprovalCardProps {
  /** The drafted plan's step labels, in order. */
  readonly steps: readonly string[];
  /** Run the plan as drafted. */
  readonly onApprove: () => void;
  /**
   * Cancel the run (nothing has touched the timeline yet) and hand the original
   * request back to the composer so the creator can refine it before re-running —
   * not a full plan editor (deliberately scoped, see CHANGELOG/docs).
   */
  readonly onEdit: () => void;
  /** Cancel the run outright — no edit, no re-population of the composer. */
  readonly onCancel: () => void;
}

export function PlanApprovalCard({
  steps,
  onApprove,
  onEdit,
  onCancel,
}: PlanApprovalCardProps): JSX.Element {
  return (
    <div className="ai-approval-card" role="group" aria-label="Review the plan before it runs">
      <p className="ai-approval-title">
        This is a {steps.length}-step plan — review it before it runs:
      </p>
      <ol className="ai-approval-steps">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <div className="ai-diff-buttons">
        <button
          type="button"
          className="ai-btn ai-btn--accept"
          onClick={onApprove}
          data-testid="ai-approval-approve"
        >
          Approve
        </button>
        <button type="button" className="ai-btn" onClick={onEdit} data-testid="ai-approval-edit">
          Edit request
        </button>
        <button
          type="button"
          className="ai-btn"
          onClick={onCancel}
          data-testid="ai-approval-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
