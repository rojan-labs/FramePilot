/**
 * The keyframe diamond's live state, including the one part of it that is not a
 * derivation (revamp Phase 5, F5).
 *
 * Four of the five diamond states are pure functions of the clip, the property and
 * the playhead — {@link keyframeStateAt} answers those, and it is tested without
 * React. The fifth, **"just changed"**, is genuinely stateful: it is a 150ms
 * acknowledgement that *this* row is the one that took the last write, which matters
 * because a keyframe write is otherwise silent (the diamond fills, but a filled
 * diamond looks the same whether you set it now or ten minutes ago).
 *
 * The pulse is driven off the keyframe *count and time*, not a click handler, so it
 * fires for writes that did not originate in this row — the canvas handles, an undo,
 * an AI patch — which is precisely when the user most needs telling where the change
 * landed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Keyframe } from '@framepilot/timeline-schema';
import { type KeyframeState, keyframeStateAt } from './keyframe-state.js';

/** How long the acknowledgement lasts. Within the revamp's 120–180ms motion band. */
export const KEYFRAME_PULSE_MS = 150;

export interface LiveKeyframeState extends KeyframeState {
  /** True for {@link KEYFRAME_PULSE_MS} after this property's keyframes changed. */
  readonly pulsing: boolean;
}

/**
 * A signature that changes exactly when this property's animation changes.
 *
 * Times and values, not the array identity: the timeline is rebuilt on every patch,
 * so identity would pulse every row on every unrelated edit. Ids are excluded because
 * a replace can reuse an id while changing the value.
 */
const signatureOf = (points: readonly Keyframe[]): string =>
  points.map((keyframe) => `${keyframe.time}:${keyframe.value}:${keyframe.easing}`).join('|');

export function useKeyframeState(
  keyframes: readonly Keyframe[],
  property: string,
  clipTime: number,
): LiveKeyframeState {
  const state = useMemo(
    () => keyframeStateAt(keyframes, property, clipTime),
    [keyframes, property, clipTime],
  );
  const signature = signatureOf(state.points);

  const [pulsing, setPulsing] = useState(false);
  // The first render must not pulse: arriving at a clip that is already animated is
  // not a change, and a panel that flashes every row on selection is noise.
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current === null) {
      previous.current = signature;
      return;
    }
    if (previous.current === signature) return;
    previous.current = signature;
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), KEYFRAME_PULSE_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  return { ...state, pulsing };
}
