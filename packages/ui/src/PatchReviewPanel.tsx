/**
 * @framepilot/ui/PatchReviewPanel — apply/reject patch UI (placeholder).
 * Implemented in plan/PLAN.md Phase 4.3 (Review UX — apply/reject flow).
 */
export interface PatchReviewPanelProps {
  readonly reason?: string;
}

export function PatchReviewPanel({ reason }: PatchReviewPanelProps): JSX.Element {
  return (
    <aside aria-label="patch-review">
      <p>TODO Phase 4.3 — patch review panel.{reason ? ` Reason: ${reason}` : ''}</p>
    </aside>
  );
}
