/**
 * Which keyframes are selected, and which clips have their lanes open
 * (revamp Phase 6, F4).
 *
 * Two pieces of **view** state, deliberately kept out of the editor store: neither is
 * part of the project, neither belongs in undo history, and a user pressing undo after
 * expanding a clip means "undo my edit", not "collapse that clip again".
 *
 * Selection is a set of {@link keyframeKey}s rather than object references, because
 * the timeline is rebuilt on every patch — a reference-based selection would be
 * dropped by every edit, including the edits made *to the selection itself*.
 */
import { useCallback, useMemo, useState } from 'react';
import type { Timeline } from '@framepilot/timeline-schema';
import { keyframeKey, parseKeyframeKey } from './keyframe-lanes.js';

export interface KeyframeSelection {
  /** The selected keyframes, by {@link keyframeKey}. */
  readonly keys: ReadonlySet<string>;
  /** Clips whose per-property lanes are open. */
  readonly expanded: ReadonlySet<string>;
  readonly isSelected: (key: string) => boolean;
  /**
   * Select one keyframe. `additive` (shift/ctrl-click) toggles it into the existing
   * selection; otherwise it replaces the selection.
   */
  readonly select: (key: string, additive?: boolean) => void;
  /** Replace the selection outright (box-select's commit). */
  readonly setKeys: (keys: readonly string[]) => void;
  readonly clear: () => void;
  readonly toggleExpanded: (clipId: string) => void;
  /**
   * Re-key the selection after a group move, so the keyframes the user dragged stay
   * selected at their NEW times. Without this a drag deselects everything it moved,
   * and a second nudge is impossible without re-selecting.
   */
  readonly shiftSelectionBy: (delta: number) => void;
  /** Drop keys whose keyframe no longer exists (after a delete, or an undo). */
  readonly pruneAgainst: (timeline: Timeline) => void;
}

export function useKeyframeSelection(): KeyframeSelection {
  const [keys, setKeysState] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const select = useCallback((key: string, additive = false): void => {
    setKeysState((current) => {
      if (!additive) return new Set([key]);
      const next = new Set(current);
      // Toggle: shift-clicking a selected keyframe removes it, which is the only way
      // to trim one item out of a box-select without starting over.
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setKeys = useCallback((next: readonly string[]): void => {
    setKeysState(new Set(next));
  }, []);

  const clear = useCallback((): void => setKeysState(new Set()), []);

  const toggleExpanded = useCallback((clipId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  }, []);

  const shiftSelectionBy = useCallback((delta: number): void => {
    setKeysState((current) => {
      const next = new Set<string>();
      for (const key of current) {
        const parsed = parseKeyframeKey(key);
        // An unparseable key cannot be shifted; keep it rather than silently losing
        // it, and let `pruneAgainst` decide whether it still refers to anything.
        next.add(
          parsed === null ? key : keyframeKey(parsed.clipId, parsed.property, parsed.time + delta),
        );
      }
      return next;
    });
  }, []);

  const pruneAgainst = useCallback((timeline: Timeline): void => {
    setKeysState((current) => {
      if (current.size === 0) return current;
      const live = new Set<string>();
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          for (const keyframe of clip.keyframes) {
            live.add(keyframeKey(clip.id, keyframe.property, keyframe.time));
          }
        }
      }
      const next = new Set([...current].filter((key) => live.has(key)));
      // Preserve identity when nothing was dropped, so this can be called freely
      // without causing a re-render.
      return next.size === current.size ? current : next;
    });
  }, []);

  const isSelected = useCallback((key: string): boolean => keys.has(key), [keys]);

  return useMemo(
    () => ({
      keys,
      expanded,
      isSelected,
      select,
      setKeys,
      clear,
      toggleExpanded,
      shiftSelectionBy,
      pruneAgainst,
    }),
    [
      keys,
      expanded,
      isSelected,
      select,
      setKeys,
      clear,
      toggleExpanded,
      shiftSelectionBy,
      pruneAgainst,
    ],
  );
}
