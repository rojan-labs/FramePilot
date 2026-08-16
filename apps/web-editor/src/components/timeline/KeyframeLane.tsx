/**
 * One property's keyframe lane on a clip, and the markers in it
 * (revamp Phase 6, F4).
 *
 * ## The lane owns its pointer, absolutely
 *
 * A keyframe drag must **never** drag the clip. Every pointer handler here calls
 * `stopPropagation`, and the pointerdown also `preventDefault`s, mirroring how
 * `.clip-transition-pill` already opts out of the clip-drag selector. The lane also
 * takes pointer *capture*, so a drag that leaves the lane vertically keeps going
 * instead of being handed back to the clip underneath.
 *
 * ## A drag is one patch, on release
 *
 * The marker follows the pointer as local state; nothing is written until pointerup,
 * and then it is a single `moveKeyframePatch` (or one merged patch for a group), so a
 * drag costs exactly one undo press. Mid-drag writes would flood history with a patch
 * per animation frame.
 *
 * ## Marker states
 *
 * at rest · hover · selected · at-playhead · in-multiselection. Distinguished by
 * **fill, ring and size — never hue alone**, and each is in the marker's accessible
 * name, because none of those cues survive a screen reader.
 */
import { useRef, useState } from 'react';
import type { Clip, Keyframe, Marker } from '@framepilot/timeline-schema';
import { secondsToPx } from '../../editor/selectors.js';
import {
  KEYFRAME_LANE_HEIGHT,
  KEYFRAME_SNAP_PX,
  clampGroupDelta,
  describeKeyframe,
  keyframeKey,
  keyframeSnapTargets,
  parseKeyframeKey,
  snapKeyframeTime,
} from './keyframe-lanes.js';

export interface KeyframeLaneProps {
  readonly clip: Clip;
  readonly property: string;
  readonly keyframes: readonly Keyframe[];
  readonly pxPerSecond: number;
  /** Lane index from the top of this clip's lane stack. */
  readonly row: number;
  /** The playhead in clip-relative seconds, or `null` when it is off this clip. */
  readonly playheadClipTime: number | null;
  readonly markers: readonly Marker[];
  readonly selectedKeys: ReadonlySet<string>;
  /** Whether snapping is on for this gesture (Alt inverts it, as everywhere else). */
  readonly snapEnabled: boolean;
  readonly onSelect: (key: string, additive: boolean) => void;
  /**
   * Commit a move of the whole selection by `delta` clip-relative seconds, anchored
   * on the keyframe that was grabbed.
   */
  readonly onMove: (grabbedKey: string, delta: number) => void;
  /** Add a keyframe for this property at a clip-relative time (double-click). */
  readonly onAddAt: (property: string, clipTime: number) => void;
}

/** Live drag state. `delta` is clip-relative seconds from where the grab started. */
interface Drag {
  readonly key: string;
  readonly startX: number;
  readonly delta: number;
  readonly snapped: boolean;
  readonly pointerId: number;
}

export function KeyframeLane({
  clip,
  property,
  keyframes,
  pxPerSecond,
  row,
  playheadClipTime,
  markers,
  selectedKeys,
  snapEnabled,
  onSelect,
  onMove,
  onAddAt,
}: KeyframeLaneProps): JSX.Element {
  const [drag, setDrag] = useState<Drag | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const duration = clip.end - clip.start;

  /**
   * The times that move with this drag: every selected keyframe on this clip, or just
   * the grabbed one when it is not part of the selection. Grabbing an unselected
   * keyframe moves only it — the alternative (dragging the whole selection from
   * outside it) moves things the user is not pointing at.
   */
  const draggingTimes = (grabbedKey: string): readonly number[] => {
    if (!selectedKeys.has(grabbedKey)) {
      return [parseKeyframeKey(grabbedKey)?.time ?? 0];
    }
    return [...selectedKeys]
      .map(parseKeyframeKey)
      .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
      .filter((parsed) => parsed.clipId === clip.id)
      .map((parsed) => parsed.time);
  };

  const resolveDelta = (grabbedKey: string, clientX: number, startX: number, altKey: boolean) => {
    const grabbed = parseKeyframeKey(grabbedKey);
    const rawDelta = (clientX - startX) / pxPerSecond;
    const times = draggingTimes(grabbedKey);
    const clamped = clampGroupDelta(times, rawDelta, duration);
    // Snapping applies to the GRABBED keyframe's landing time; the rest of the group
    // rides the same delta, so the group keeps its shape while the one under the
    // pointer lands cleanly on the target.
    if (!snapEnabled || altKey || grabbed === null) return { delta: clamped, snapped: false };
    const targets = keyframeSnapTargets(clip, property, playheadClipTime, markers);
    const { time, snapped } = snapKeyframeTime(
      grabbed.time + clamped,
      targets,
      KEYFRAME_SNAP_PX / pxPerSecond,
    );
    const snappedDelta = clampGroupDelta(times, time - grabbed.time, duration);
    return { delta: snapped ? snappedDelta : clamped, snapped };
  };

  return (
    <div
      ref={laneRef}
      className="keyframe-lane"
      data-property={property}
      style={{ top: `${row * KEYFRAME_LANE_HEIGHT}px`, height: `${KEYFRAME_LANE_HEIGHT}px` }}
      // The lane is a labelled group so the markers inside it are announced with the
      // property they belong to — a bare "keyframe" tells a screen-reader user
      // nothing about which of four animations they are in.
      role="group"
      aria-label={`${property} keyframes`}
      onDoubleClick={(event) => {
        // Double-click on empty lane adds a keyframe there. On a marker, the marker's
        // own handler stops propagation first, so this cannot fire on top of one.
        event.stopPropagation();
        const rect = laneRef.current?.getBoundingClientRect();
        if (!rect) return;
        const clipTime = (event.clientX - rect.left) / pxPerSecond;
        if (clipTime < 0 || clipTime > duration) return;
        onAddAt(property, clipTime);
      }}
      // Swallow the pointerdown so a click on empty lane space does not start a clip
      // drag underneath.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="keyframe-lane-label" aria-hidden="true">
        {property}
      </span>
      {keyframes.map((keyframe) => {
        const key = keyframeKey(clip.id, keyframe.property, keyframe.time);
        const selected = selectedKeys.has(key);
        const dragging =
          drag?.key === key || (drag !== null && selected && selectedKeys.has(drag.key));
        const time = keyframe.time + (dragging ? drag.delta : 0);
        const atPlayhead =
          playheadClipTime !== null && Math.abs(playheadClipTime - keyframe.time) <= 0.001;
        const inGroup = selected && selectedKeys.size > 1;
        const readout = describeKeyframe(keyframe);
        return (
          <button
            key={key}
            type="button"
            className="keyframe-marker"
            data-selected={selected ? 'true' : undefined}
            data-at-playhead={atPlayhead ? 'true' : undefined}
            data-in-group={inGroup ? 'true' : undefined}
            data-dragging={drag?.key === key ? 'true' : undefined}
            data-snapped={drag?.key === key && drag.snapped ? 'true' : undefined}
            style={{ left: `${secondsToPx(time, pxPerSecond)}px` }}
            title={readout}
            // Every state that the fill and ring convey, also in words.
            aria-label={`${readout}${selected ? ', selected' : ''}${
              inGroup ? `, 1 of ${selectedKeys.size} selected` : ''
            }${atPlayhead ? ', at the playhead' : ''}`}
            aria-pressed={selected}
            onPointerDown={(event) => {
              // BOTH, and in this order: stopPropagation keeps the clip-drag handler
              // out of it, preventDefault stops the browser's native drag/selection.
              event.stopPropagation();
              event.preventDefault();
              const additive = event.shiftKey || event.metaKey || event.ctrlKey;
              // Pressing on a marker that is ALREADY part of a multi-selection must
              // not collapse the selection — the user is very likely about to drag
              // the group, and destroying it on the way down would move only one
              // keyframe. The collapse is deferred to pointerup, and only happens if
              // the gesture turned out to be a click rather than a drag.
              if (additive || !selected) onSelect(key, additive);
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                /* v8 ignore next -- only a stale pointer id throws; the drag still works */
              }
              setDrag({
                key,
                startX: event.clientX,
                delta: 0,
                snapped: false,
                pointerId: event.pointerId,
              });
            }}
            onPointerMove={(event) => {
              if (drag?.key !== key || drag.pointerId !== event.pointerId) return;
              event.stopPropagation();
              const { delta, snapped } = resolveDelta(
                key,
                event.clientX,
                drag.startX,
                event.altKey,
              );
              setDrag({ ...drag, delta, snapped });
            }}
            onPointerUp={(event) => {
              if (drag?.key !== key || drag.pointerId !== event.pointerId) return;
              event.stopPropagation();
              const { delta } = resolveDelta(key, event.clientX, drag.startX, event.altKey);
              const additive = event.shiftKey || event.metaKey || event.ctrlKey;
              setDrag(null);
              if (delta !== 0) {
                onMove(key, delta);
                return;
              }
              // The gesture was a click, not a drag. THIS is where a plain click on
              // an already-selected marker collapses the selection to it — deferred
              // from pointerdown so that pressing on a group to drag it does not
              // destroy the group first (see the pointerdown note).
              if (!additive && selected && selectedKeys.size > 1) onSelect(key, false);
            }}
            onPointerCancel={() => setDrag(null)}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span className="keyframe-marker-shape" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
