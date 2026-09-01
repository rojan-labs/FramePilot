/**
 * The floating control that keeps a running agent reachable.
 *
 * ## The problem it solves
 *
 * With "open the Inspector when I click something" turned on, clicking a clip
 * takes the right rail — which is where the agent's run was being shown. The panel
 * does what the user asked, and in doing so hides the thing that is still
 * happening. Losing sight of a run you started is worse than the click being
 * ignored: you cannot tell whether it is still going, and the only way back is to
 * remember which tab it was on.
 *
 * So the run follows you. While an agent is working and its panel is not on
 * screen, this sits above the timeline: it says work is in progress, says what the
 * work currently is, and takes one click to go back to it.
 *
 * ## Why it costs nothing
 *
 * It subscribes to {@link subscribeAgentActivity} — a store outside React — rather
 * than reading a prop threaded down from the editor. The agent emits events at the
 * rate it makes tool calls, and a prop would re-render the editor (timeline,
 * preview, rails) for each one. Here the only component that re-renders on an
 * agent event is this button.
 *
 * It renders `null` when there is no run, so mounting it unconditionally costs one
 * subscription and nothing else.
 */
import { useSyncExternalStore } from 'react';
import {
  getAgentActivity,
  getAgentActivityServerSnapshot,
  subscribeAgentActivity,
} from '../editor/agent-activity.js';
import { Sparkles } from './icons.js';

export interface AgentFabProps {
  /**
   * Whether the agent's own panel is already visible. The button is a way BACK to
   * a run you cannot see; while you are looking at it, it would be one more thing
   * on screen saying what the screen already says.
   */
  readonly aiPanelVisible: boolean;
  /** Bring the agent's panel back. */
  readonly onOpenAi: () => void;
}

export function AgentFab({ aiPanelVisible, onOpenAi }: AgentFabProps): JSX.Element | null {
  const activity = useSyncExternalStore(
    subscribeAgentActivity,
    getAgentActivity,
    getAgentActivityServerSnapshot,
  );

  if (!activity.running || aiPanelVisible) return null;

  return (
    <button
      type="button"
      className="agent-fab"
      // The label carries the state, not just the destination: a screen reader user
      // gets "working" and the current step, which is exactly what the ring and the
      // caption convey visually.
      aria-label={
        activity.label === null
          ? 'FramePilot is working. Open the AI panel'
          : `FramePilot is working: ${activity.label}. Open the AI panel`
      }
      // Polite, not assertive: this is progress, and it must never interrupt what
      // the editor is typing or dragging.
      aria-live="polite"
      onClick={onOpenAi}
    >
      <span className="agent-fab-mark" aria-hidden="true">
        <Sparkles size={15} />
      </span>
      <span className="agent-fab-copy" aria-hidden="true">
        {activity.label ?? 'Working'}
      </span>
    </button>
  );
}
