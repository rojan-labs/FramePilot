/**
 * Status → semantic-token tone mapping for the AI sidebar (Phase 11 M4, ADR 0033).
 *
 * The spec maps statuses to colors; we map to the EXISTING design-system tones (ADR
 * 0028) rather than inventing colors: running→accent, completed→success,
 * warning→warning, failed→danger, idle→muted. Returned as a `data-tone` value the
 * CSS keys off (see `styles.css` `.ai-tone`), so there are no inline colors.
 */
import type { RunStatus, ToolStatus } from '@framepilot/ai-sdk';

export type StatusTone = 'running' | 'completed' | 'warning' | 'failed' | 'idle';

/** Tool-card status maps onto a tone; `cancelled` reads as a warning, never success. */
export function toolStatusTone(status: ToolStatus): StatusTone {
  return status === 'cancelled' ? 'warning' : status;
}

/** Collapse the richer run lifecycle onto the five visible tones. */
export function runStatusTone(status: RunStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'warning';
    case 'idle':
      return 'idle';
    // Both of these are stopped, waiting on the creator: a gated plan (P11.3) and a
    // question the model asked (P12). They read as "needs your attention" — the warning
    // tone — never a plain "running" spinner, which would imply progress that isn't
    // happening and hide the fact that the run is waiting on THEM.
    case 'awaiting_approval':
    case 'awaiting_answer':
    case 'awaiting_input':
    case 'awaiting_review':
    case 'suspended':
      return 'warning';
    default:
      return 'running';
  }
}

/** Human label for a run status (header + aria-live). */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'accepted':
      return 'Starting…';
    case 'thinking':
      return 'Thinking…';
    case 'searching':
      return 'Searching…';
    case 'reading':
      return 'Reading…';
    case 'planning':
      return 'Planning…';
    case 'awaiting_approval':
      return 'Awaiting your approval…';
    case 'awaiting_answer':
      return 'Waiting for your answer…';
    case 'awaiting_input':
      return 'Waiting for input…';
    case 'editing':
      return 'Editing…';
    case 'executing':
      return 'Executing…';
    case 'generating':
      return 'Generating…';
    case 'running_tool':
      return 'Running tool…';
    case 'rendering':
      return 'Rendering…';
    case 'reconciling':
      return 'Reconciling…';
    case 'verifying':
      return 'Verifying…';
    case 'awaiting_review':
      return 'Awaiting your review…';
    case 'suspended':
      return 'Paused for recovery';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}
