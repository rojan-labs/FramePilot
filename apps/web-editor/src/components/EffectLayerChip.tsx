/**
 * One effect layer on the timeline (schema v13, ADR 0088).
 *
 * WHY this is not `TimelineClip`: a clip gesture has to reason about source
 * in/out, speed, ripple, roll, fades, transitions and neighbour collisions. An
 * effect layer has none of those — it is a time range with no media behind it, it
 * may freely overlap its neighbours (stacking is a feature here, not an error),
 * and trimming it cannot run out of source handles. Reusing the clip machinery
 * would mean disabling most of it; a small dedicated component is both simpler and
 * safer.
 *
 * Gestures commit ONE patch on pointer-up, never per pointer-move: a drag across
 * the lane must be one undo step, not two hundred. Live feedback comes from local
 * state until then.
 */
import { useCallback, useRef, useState } from 'react';
import type { EffectLayer } from '@framepilot/timeline-schema';
import { findEffect } from '@framepilot/timeline-schema/effect-catalog';
import { EyeOff, ICON_SIZE } from './icons.js';

/** Grab width (px) of each trim edge. */
const HANDLE_PX = 6;

/** Shortest layer a trim gesture may produce, in seconds. */
const MIN_DURATION = 0.05;

type GestureKind = 'move' | 'trim-start' | 'trim-end';

interface Gesture {
  readonly kind: GestureKind;
  readonly pointerId: number;
  readonly originX: number;
  readonly originStart: number;
  readonly originEnd: number;
}

export interface EffectLayerChipProps {
  readonly layer: EffectLayer;
  readonly trackId: string;
  readonly pxPerSecond: number;
  readonly selected: boolean;
  readonly onSelect: (layerId: string, additive: boolean) => void;
  /** Commit a move. `toStart` is already snapped by the caller's grid. */
  readonly onMove: (layerId: string, toStart: number) => void;
  readonly onTrim: (layerId: string, start: number, end: number) => void;
  readonly onContextMenu: (layerId: string, x: number, y: number) => void;
  /** Snap a proposed time to the timeline grid; `raw` when snapping is suppressed. */
  readonly snap: (seconds: number, disabled: boolean) => number;
}

export function EffectLayerChip({
  layer,
  trackId,
  pxPerSecond,
  selected,
  onSelect,
  onMove,
  onTrim,
  onContextMenu,
  snap,
}: EffectLayerChipProps): JSX.Element {
  const [gesture, setGesture] = useState<Gesture | null>(null);
  /** Live edges during a drag; null when idle so the layer's own values show. */
  const [preview, setPreview] = useState<{ start: number; end: number } | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);

  const entry = findEffect(layer.effectId);
  const label = entry?.label ?? layer.kind;
  const start = preview?.start ?? layer.start;
  const end = preview?.end ?? layer.end;
  const disabled = layer.disabled === true;

  const begin = useCallback(
    (kind: GestureKind) =>
      (event: React.PointerEvent<HTMLElement>): void => {
        // Left button only: a right-click opens the menu, and a middle-click drag
        // would otherwise start a silent edit.
        if (event.button !== 0) return;
        event.stopPropagation();
        // Pointer capture on the element means the gesture survives the pointer
        // leaving the chip — essential when dragging a 40px chip across the lane.
        //
        // Optional-called because the method is absent in jsdom (no PointerEvent
        // implementation): an unguarded call throws and takes the whole gesture
        // with it, which would make this component untestable and would break the
        // drag outright on any engine lacking the API.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setGesture({
          kind,
          pointerId: event.pointerId,
          originX: event.clientX,
          originStart: layer.start,
          originEnd: layer.end,
        });
        onSelect(layer.id, event.shiftKey || event.metaKey || event.ctrlKey);
      },
    [layer.end, layer.id, layer.start, onSelect],
  );

  const move = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (gesture === null || event.pointerId !== gesture.pointerId) return;
      const deltaSec = (event.clientX - gesture.originX) / Math.max(1, pxPerSecond);
      // Alt suppresses snapping, matching the clip gestures' convention.
      const raw = event.altKey;

      if (gesture.kind === 'move') {
        const nextStart = Math.max(0, snap(gesture.originStart + deltaSec, raw));
        setPreview({
          start: nextStart,
          end: nextStart + (gesture.originEnd - gesture.originStart),
        });
        return;
      }
      if (gesture.kind === 'trim-start') {
        // Clamped against the FIXED edge, so dragging past it stops rather than
        // inverting the layer (which the operation would reject anyway).
        const limit = gesture.originEnd - MIN_DURATION;
        const nextStart = Math.min(limit, Math.max(0, snap(gesture.originStart + deltaSec, raw)));
        setPreview({ start: nextStart, end: gesture.originEnd });
        return;
      }
      const limit = gesture.originStart + MIN_DURATION;
      const nextEnd = Math.max(limit, snap(gesture.originEnd + deltaSec, raw));
      setPreview({ start: gesture.originStart, end: nextEnd });
    },
    [gesture, pxPerSecond, snap],
  );

  const finish = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      if (gesture === null || event.pointerId !== gesture.pointerId) return;
      const committed = preview;
      setGesture(null);
      setPreview(null);
      if (committed === null) return;
      // A gesture that did not actually change anything commits nothing, so a
      // click-without-drag never pollutes the undo history.
      if (gesture.kind === 'move') {
        if (Math.abs(committed.start - gesture.originStart) > 1e-6) {
          onMove(layer.id, committed.start);
        }
        return;
      }
      if (
        Math.abs(committed.start - gesture.originStart) > 1e-6 ||
        Math.abs(committed.end - gesture.originEnd) > 1e-6
      ) {
        onTrim(layer.id, committed.start, committed.end);
      }
    },
    [gesture, layer.id, onMove, onTrim, preview],
  );

  /**
   * Pointer handlers for a trim handle.
   *
   * Every one stops propagation, not just `pointerdown`. The handles sit INSIDE
   * the element that carries the body's move gesture, so without this the handle's
   * `pointerup` bubbles up and `finish` runs twice — and because React batches the
   * state updates within one event, the second run still sees a non-null gesture
   * and commits the SAME trim again. That produced two patches (two undo steps)
   * for one drag, which a test caught.
   */
  const handleProps = (kind: 'trim-start' | 'trim-end') => ({
    onPointerDown: begin(kind),
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      move(event);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      finish(event);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      finish(event);
    },
  });

  const width = Math.max(HANDLE_PX * 2 + 2, (end - start) * pxPerSecond);

  return (
    <div
      ref={elementRef}
      className={`fx-layer${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}${
        gesture !== null ? ' is-dragging' : ''
      }`}
      data-layer-id={layer.id}
      data-track-id={trackId}
      data-effect-id={layer.effectId}
      style={{ left: `${start * pxPerSecond}px`, width: `${width}px` }}
      // `button` role + name is what makes the layer reachable and identifiable to
      // a screen reader; a bare div would be invisible to one.
      role="button"
      tabIndex={0}
      aria-label={`${label} effect, ${start.toFixed(2)} to ${end.toFixed(2)} seconds${
        disabled ? ', bypassed' : ''
      }`}
      aria-pressed={selected}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(layer.id, false);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(layer.id, event.clientX, event.clientY);
      }}
    >
      <span
        className="fx-layer-handle fx-layer-handle--start"
        {...handleProps('trim-start')}
        aria-hidden="true"
      />
      <span className="fx-layer-body">
        {disabled && <EyeOff size={ICON_SIZE.sm} aria-hidden="true" />}
        <span className="fx-layer-label">{label}</span>
      </span>
      <span
        className="fx-layer-handle fx-layer-handle--end"
        {...handleProps('trim-end')}
        aria-hidden="true"
      />
    </div>
  );
}
