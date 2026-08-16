/**
 * @framepilot/ui/TimelineDiffView — before/after timeline diff (placeholder).
 * Implemented in plan/PLAN.md Phase 4.3 (Review UX — timeline diff UI).
 */
export interface TimelineDiffViewProps {
  /** Optional patch id being visualized. */
  readonly patchId?: string;
}

export function TimelineDiffView({ patchId }: TimelineDiffViewProps): JSX.Element {
  return (
    <section aria-label="timeline-diff">
      <p>TODO Phase 4.3 — timeline diff view{patchId ? ` for ${patchId}` : ''}.</p>
    </section>
  );
}
