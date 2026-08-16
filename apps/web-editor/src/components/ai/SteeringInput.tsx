/**
 * Mid-run steering input (P11.4, P12.5 — plan/AGENT-NATIVE-COMPLETION-PLAN.md).
 *
 * A small, always-available input shown next to the running-task view: the creator
 * types guidance WHILE the agent is working, distinct from Stop and from waiting
 * for the run to finish. Sending queues the message (`onSend`) — the orchestrator's
 * `runTurn` handler pops it at its NEXT per-turn boundary (never mid-step; see
 * `run-controls.ts` / `orchestrator.ts`'s `agentRun`). This component tracks which of
 * its own sent messages have been confirmed applied (via `appliedMessages`, the raw
 * "Steering applied: …" notification texts already in the conversation) so the
 * "queued" note honestly clears once the run actually folded it in.
 */
import { useEffect, useState } from 'react';
import { ICON_SIZE, Send } from '../icons.js';

export interface SteeringInputProps {
  /** Queue a guidance message for the running agent's next turn boundary. */
  readonly onSend: (message: string) => void;
  /** Raw "Steering applied: …" notification texts seen so far this run. */
  readonly appliedMessages: readonly string[];
}

export function SteeringInput({ onSend, appliedMessages }: SteeringInputProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [queued, setQueued] = useState<readonly string[]>([]);

  // Drop a queued message once its own confirmation notice has landed.
  useEffect(() => {
    setQueued((current) => current.filter((m) => !appliedMessages.some((t) => t.includes(m))));
  }, [appliedMessages]);

  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setQueued((current) => [...current, text]);
    setDraft('');
  };

  return (
    <div className="ai-steering" role="group" aria-label="Steer the running agent">
      <div className="ai-steering-row">
        <input
          type="text"
          className="ai-steering-input"
          placeholder="Steer the agent while it works…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          data-testid="ai-steering-input"
        />
        <button
          type="button"
          className="ai-composer-send"
          onClick={send}
          disabled={!draft.trim()}
          aria-label="Send steering guidance"
          data-testid="ai-steering-send"
        >
          <Send size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </div>
      {queued.length > 0 && (
        <p className="ai-steering-queued" data-testid="ai-steering-queued">
          Queued — applied at the next step: &ldquo;{queued[queued.length - 1]}&rdquo;
        </p>
      )}
    </div>
  );
}
