/**
 * A one-value external store for "is the agent working, and on what".
 *
 * ## Why this is not React state
 *
 * The agent's activity has to be visible from a control that lives OUTSIDE the AI
 * sidebar — the floating button that offers a way back to a run you have navigated
 * away from. The obvious way to arrange that is to lift the sidebar's `running`
 * flag into the editor and pass it down. That works, and it makes the editor
 * re-render every time the agent's state changes.
 *
 * Which would be fine if the state were just `running`. It is not: a useful
 * indicator says what the agent is *doing*, and that changes on every tool call
 * and every streamed step. Threading it through React means the editor — with the
 * timeline, the preview and the whole rail under it — re-renders at the agent's
 * event rate, to update a 40px button in the corner.
 *
 * So the value lives here, outside React, and the button subscribes to it with
 * `useSyncExternalStore`. Nothing else in the application observes it, so nothing
 * else re-renders: the cost of an agent event is one small component, whatever the
 * agent is doing.
 *
 * ## The contract
 *
 * The snapshot is a **stable object identity** while nothing has changed —
 * `useSyncExternalStore` compares by reference and will loop forever on a getter
 * that builds a fresh object each call. `publish` therefore compares field by
 * field and keeps the previous object when they match, which also makes a
 * duplicate publish free.
 */

/** What the agent is doing, as much as an indicator needs to know. */
export interface AgentActivity {
  /** A run is in flight. */
  readonly running: boolean;
  /**
   * A short, human phrase for the current step ("Reading the timeline"), or `null`
   * when there is nothing more specific to say than "working".
   */
  readonly label: string | null;
}

const IDLE: AgentActivity = { running: false, label: null };

let current: AgentActivity = IDLE;
const listeners = new Set<() => void>();

/**
 * Publish the agent's current activity.
 *
 * Idempotent: publishing a value equal to the current one notifies nobody and
 * keeps the existing object identity, so a caller may publish on every event
 * without thinking about whether anything changed.
 */
export function publishAgentActivity(next: AgentActivity): void {
  if (current.running === next.running && current.label === next.label) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Reset to idle. Equivalent to publishing `{ running: false, label: null }`. */
export function clearAgentActivity(): void {
  publishAgentActivity(IDLE);
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeAgentActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current activity. Stable by identity between changes. */
export function getAgentActivity(): AgentActivity {
  return current;
}

/**
 * The snapshot a server render sees.
 *
 * Always the shared `IDLE` constant, never `current`: a module-scope value would
 * otherwise leak one render's agent state into the next, and it must be the same
 * object every call or `useSyncExternalStore` treats each render as a change.
 */
export function getAgentActivityServerSnapshot(): AgentActivity {
  return IDLE;
}
