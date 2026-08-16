/**
 * Playhead clock — a tiny external store for the live playhead (perf slice 1b,
 * plan Phase 12.1).
 *
 * The playhead advances ~60×/s during playback and per pointer-sample while
 * scrubbing. Keeping it in the main reducer means every seek re-renders the whole
 * editor subtree. This store lets the few components that actually DISPLAY the
 * live playhead (the timeline marker, the sr-only scrubber, the ruler's
 * `aria-valuenow`) subscribe to it directly via `useSyncExternalStore`, so a seek
 * re-renders only those tiny nodes — not `TimelineView`, `Toolbar`, or the panels.
 *
 * It is a MIRROR, not a second source of truth: `useEditor.seek` writes the
 * reducer AND this clock with the same clamped value, and `seek` is the sole
 * runtime mutator of `playhead` (store.ts) — so the two never diverge. The reducer
 * playhead remains authoritative for logic, undo, save, and AI context.
 */

/** A minimal subscribable value store for the live playhead (seconds). */
export interface PlayheadClock {
  /** The current playhead (seconds). Used as the `useSyncExternalStore` snapshot. */
  get(): number;
  /** Set the playhead and notify subscribers (no-op if unchanged). */
  set(value: number): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Create a playhead clock seeded with `initial` seconds. */
export function createPlayheadClock(initial: number): PlayheadClock {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: number) => {
      if (next === value) return; // identical snapshot → skip notify (no wasted render)
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
