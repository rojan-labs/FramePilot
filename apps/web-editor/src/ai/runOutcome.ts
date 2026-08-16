/**
 * End-of-run signal folding for the AI sidebar.
 *
 * The SDK agent loop can legitimately finish an *editing* run having applied
 * nothing — the model only read the timeline, described footage via
 * `search_visual`, answered a question, or planned. This module folds one turn's
 * event stream into {@link TurnSignals}: what the run did (produced an edit?),
 * how it ended (failed/cancelled?), and its real cost.
 *
 * Empty-run *gating* is deliberately OFF (see {@link emptyRunNotice}): a run that
 * lands no edit is not scolded with a "nothing changed" notice — its own output
 * stands on its own. The folded signals still drive cost reporting.
 *
 * It is intentionally pure and event-shape-driven so it is unit-testable and
 * carries no React state.
 */
import type { AiEvent } from '@framepilot/ai-sdk';

/** What one turn's event stream told us about whether the timeline changed. */
export interface TurnSignals {
  /** The run was expected to change the timeline (agent/edit mode, not chat). */
  readonly editing: boolean;
  /** A `timeline_action` or `diff` appeared — the run produced at least one edit. */
  readonly producedEdit: boolean;
  /** A tool reported its analysis engine is unavailable (browser without the sidecar). */
  readonly analysisUnavailable: boolean;
  /** An error/failed status already explains the outcome — don't double-report. */
  readonly failed: boolean;
  /** The user clicked Stop — a cancelled run's own status explains the outcome. */
  readonly cancelled: boolean;
  /**
   * This run's real, priced cost (P7.1/P7.2), folded from the orchestrator's `usage`
   * event — `undefined` until that event lands (a run that never reaches settlement,
   * e.g. one that throws before any event, reports no cost at all rather than a
   * fabricated zero).
   */
  readonly cost?: { readonly tokens: number; readonly usd: number; readonly modelCalls?: number };
}

/** A blank set of signals to fold turn events onto. */
export function initialTurnSignals(editing: boolean): TurnSignals {
  return {
    editing,
    producedEdit: false,
    analysisUnavailable: false,
    failed: false,
    cancelled: false,
  };
}

/** True when a tool result / warning says an engine is unavailable (honest, not fabricated). */
function mentionsUnavailable(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('unavailable') ||
    lower.includes('not available') ||
    // The host-tool runtime's honest "no engine connected" failure (P1).
    lower.includes('no analysis engine') ||
    lower.includes('not connected')
  );
}

/**
 * Fold one streamed event onto the running signals. Pure: returns the same object
 * when nothing relevant changed, a new object otherwise.
 */
export function foldTurnEvent(signals: TurnSignals, event: AiEvent): TurnSignals {
  switch (event.type) {
    case 'timeline_action':
    case 'diff':
      return signals.producedEdit ? signals : { ...signals, producedEdit: true };
    case 'usage':
      return {
        ...signals,
        cost: {
          tokens: event.tokens,
          usd: event.usd,
          // Carried so the chip can distinguish a genuinely free run from one whose
          // provider reported no usage — see `summarizeUsage`.
          ...(event.modelCalls !== undefined ? { modelCalls: event.modelCalls } : {}),
        },
      };
    case 'error':
      return signals.failed ? signals : { ...signals, failed: true };
    case 'status': {
      if (event.status === 'cancelled' && !signals.cancelled) {
        return { ...signals, cancelled: true };
      }
      if (event.status === 'failed' && !signals.failed) return { ...signals, failed: true };
      // An `auto` run (ADR 0055) doesn't know its editing-ness until the classifier picks a
      // route; an editing/planning status is the honest signal that this turn is attempting
      // an edit, so a run that then applies nothing still gets the "nothing changed" notice.
      // A chitchat/question turn only ever reaches 'thinking', so it stays non-editing.
      if (!signals.editing && (event.status === 'editing' || event.status === 'planning')) {
        return { ...signals, editing: true };
      }
      return signals;
    }
    case 'tool_result':
      return !signals.analysisUnavailable &&
        (mentionsUnavailable(event.summary) || event.warnings?.some(mentionsUnavailable))
        ? { ...signals, analysisUnavailable: true }
        : signals;
    case 'warning':
      return !signals.analysisUnavailable && mentionsUnavailable(event.text)
        ? { ...signals, analysisUnavailable: true }
        : signals;
    default:
      return signals;
  }
}

/**
 * Empty-run gating is intentionally OFF: an editing/agent run that lands no
 * timeline edit is no longer appended with a "nothing changed" notice.
 *
 * WHY: read/agent runs legitimately finish without an edit — describing footage
 * via `search_visual`, answering a question, planning — and the old gate scolded
 * every one of them with "I couldn't turn this into an applicable timeline edit /
 * try rephrasing", which read as a failure of a run that actually did its job.
 * The run's own streamed output (the answer, the evidence, the cost chip) now
 * stands on its own; nothing here overrides it.
 *
 * Kept as a function (branchless, no per-case gating) so the sidebar call site is
 * unchanged and cost/settlement reporting is unaffected.
 *
 * @param _signals - Turn signals accumulated via {@link foldTurnEvent} (unused).
 * @returns Always `null` — no gating notice is emitted.
 */
export function emptyRunNotice(_signals: TurnSignals): string | null {
  return null;
}
