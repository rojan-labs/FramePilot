/**
 * One mask's keyframes on the timeline (MK4.3, plan 10 "Timeline").
 *
 * Mask keyframes live on the asset SOURCE clock (ADR 0178), so a marker sits where the clip
 * shows that source instant, through speed changes and ramps. A marker gathers every keyframe
 * of the mask at that instant (shape, feather, opacity…), because they were set together and
 * move together. Dragging commits one `move_mask_keyframes` command on release; arrow keys nudge
 * one frame (Shift: ten).
 */
import { useState } from 'react';
import type { Clip } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../editor/useEditor.js';
import {
  clipSourceTimeAt,
  clipTimelineTimeForSource,
  runMaskCommand,
} from '../../editor/mask-editing.js';
import { secondsToPx } from '../../editor/selectors.js';
import { maskToolStore } from '../inspector/masks/useMaskTools.js';
import { KEYFRAME_LANE_HEIGHT, type MaskLane, type MaskLaneInstant } from './keyframe-lanes.js';

export interface MaskKeyframeLaneProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly lane: MaskLane;
  readonly row: number;
  readonly pxPerSecond: number;
  readonly fps: number;
  /** Playhead, clip-relative seconds, or `null` off the clip. */
  readonly playheadClipTime: number | null;
}

interface Drag {
  readonly sourceTime: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly deltaPx: number;
}

export function MaskKeyframeLane({
  editor,
  clip,
  lane,
  row,
  pxPerSecond,
  fps,
  playheadClipTime,
}: MaskKeyframeLaneProps): JSX.Element {
  const [drag, setDrag] = useState<Drag | null>(null);
  const duration = clip.end - clip.start;
  const localOf = (sourceTime: number): number =>
    clipTimelineTimeForSource(clip, sourceTime) - clip.start;

  /** The source-time shift that moves `instant` by `localDelta` clip seconds, clamped to the clip. */
  const sourceDeltaFor = (instant: MaskLaneInstant, localDelta: number): number => {
    const local = Math.min(duration, Math.max(0, localOf(instant.sourceTime) + localDelta));
    return clipSourceTimeAt(clip, clip.start + local) - instant.sourceTime;
  };

  const move = (instant: MaskLaneInstant, deltaSeconds: number): void => {
    if (deltaSeconds === 0) return;
    const refusal = runMaskCommand(editor, {
      type: 'move_mask_keyframes',
      clipId: clip.id,
      maskId: lane.maskId,
      keyframeIds: instant.keyframeIds,
      deltaSeconds,
    });
    maskToolStore.update({ message: refusal });
  };

  return (
    <div
      className="keyframe-lane mask-keyframe-lane"
      data-mask-id={lane.maskId}
      style={{ top: `${row * KEYFRAME_LANE_HEIGHT}px`, height: `${KEYFRAME_LANE_HEIGHT}px` }}
      role="group"
      aria-label={`${lane.name} mask keyframes`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="keyframe-lane-label" aria-hidden="true">
        {lane.name}
      </span>
      {lane.instants.map((instant) => {
        const dragging = drag !== null && drag.sourceTime === instant.sourceTime;
        const local = localOf(instant.sourceTime);
        const shownLocal = dragging
          ? Math.min(duration, Math.max(0, local + drag.deltaPx / pxPerSecond))
          : local;
        const atPlayhead = playheadClipTime !== null && Math.abs(playheadClipTime - local) <= 0.001;
        const readout = `${lane.name} ${instant.properties.join(', ')} @ source ${instant.sourceTime.toFixed(2)}s`;
        return (
          <button
            key={instant.sourceTime}
            type="button"
            className="keyframe-marker mask-keyframe-marker"
            style={{ left: `${secondsToPx(shownLocal, pxPerSecond)}px`, color: lane.color }}
            data-at-playhead={atPlayhead ? 'true' : undefined}
            data-dragging={dragging ? 'true' : undefined}
            title={readout}
            aria-label={`${readout}${atPlayhead ? ', at the playhead' : ''}`}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
              if (step === 0) return;
              event.preventDefault();
              event.stopPropagation();
              const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
              move(instant, sourceDeltaFor(instant, (step * (event.shiftKey ? 10 : 1)) / rate));
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                /* capture is an optimisation */
              }
              setDrag({
                sourceTime: instant.sourceTime,
                pointerId: event.pointerId,
                startX: event.clientX,
                deltaPx: 0,
              });
            }}
            onPointerMove={(event) => {
              if (!dragging || drag.pointerId !== event.pointerId) return;
              event.stopPropagation();
              setDrag({ ...drag, deltaPx: event.clientX - drag.startX });
            }}
            onPointerUp={(event) => {
              if (!dragging || drag.pointerId !== event.pointerId) return;
              event.stopPropagation();
              setDrag(null);
              const deltaPx = event.clientX - drag.startX;
              if (deltaPx === 0) {
                editor.seek(clip.start + local);
                return;
              }
              move(instant, sourceDeltaFor(instant, deltaPx / pxPerSecond));
            }}
            onPointerCancel={() => setDrag(null)}
          >
            <span className="keyframe-marker-shape" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
