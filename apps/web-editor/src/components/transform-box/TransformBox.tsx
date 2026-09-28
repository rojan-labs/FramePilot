/**
 * The on-canvas bounding box: one control for moving, scaling and rotating any layer on the
 * program monitor (a clip, a still, a sticker, a text overlay).
 *
 * It owns only UI state — the pointer, the gesture, the live box — and speaks in {@link Box}es
 * (project pixels). What a box MEANS for a layer (transform keyframes for a picture, a text
 * overlay's position, size and wrap width) is the adapter's business, so the data model never
 * learns about pointers and this component never learns about keyframes.
 *
 * - Drag inside the box to move it (after a 3 px threshold, so a click stays a click); Shift
 *   locks an axis, and Alt defeats snapping.
 * - Eight handles resize it: corners and edges keep the aspect, Shift stretches freely, Alt
 *   resizes about the centre. It never turns inside out: past the opposite handle it stops at a
 *   10 px minimum (screen pixels, whatever the zoom).
 * - The lollipop above the top edge, or the zones just outside the corners, rotate it about its
 *   centre; Shift steps 15°.
 * - Arrows nudge the focused box a pixel (Shift, ten); on a corner they scale it a percent; on
 *   the rotation handle they turn it a degree.
 *
 * Pointer moves are coalesced to one update per animation frame, so a fast drag on a slow
 * machine renders the latest position rather than queueing every intermediate one.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rotationToCssDegrees } from '../../preview/picture-transform.js';
import {
  type Box,
  type Point,
  type ResizeHandle,
  type TransformGesture,
  RESIZE_HANDLES,
  moveBox,
  passedDragThreshold,
  pointerAngle,
  projectPerScreenPixel,
  resizeBox,
  resizeCursor,
  rotateBox,
  toProjectPoint,
} from '../../preview/transform-box/geometry.js';
import { normalizeRotation } from '../../preview/snapping.js';
import { ICON_SIZE, RotateCcw } from '../icons.js';

export type { TransformGesture };

export interface TransformBoxProps {
  /** The layer's committed box, in project pixels. */
  readonly box: Box;
  /** The project frame, for mapping the pointer through the frame element's rect. */
  readonly resolution: { readonly width: number; readonly height: number };
  /** Accessible name of the box ("Transform intro.mp4"). */
  readonly label: string;
  /** Live box during a gesture; `null` when it ends or is cancelled. */
  readonly onPreview: (box: Box | null, gesture: TransformGesture) => void;
  /** The gesture's final box, once, on release (only when it changed). */
  readonly onCommit: (box: Box, gesture: TransformGesture) => void;
  /** Magnetic snapping for moves (the user's preference); Alt inverts it per gesture. */
  readonly snapping?: boolean;
  /**
   * Handles that always resize freely along their own axis (a text overlay's left and right
   * edges change its wrap width, not its size). Others keep the aspect unless Shift is held.
   */
  readonly freeHandles?: readonly ResizeHandle[];
  /** Handles to show; all eight by default. */
  readonly handles?: readonly ResizeHandle[];
  /** Double-click inside the box (a text overlay enters editing). */
  readonly onDoubleClick?: () => void;
  /** Content drawn inside the box, turned with it (a text overlay's editable words). */
  readonly children?: ReactNode;
  /** Whether pointer gestures are accepted (off while a text overlay is being typed into). */
  readonly interactive?: boolean;
  /**
   * What the resize handles report to assistive tech: the layer's size as its model states it
   * (a picture's scale in percent, a text overlay's size). Absent, the box's pixel size.
   */
  readonly sizeValue?: { readonly now: number; readonly text: string };
  /** Accessible name of the rotation handle. */
  readonly rotateLabel?: string;
  /** Back to the layer's identity transform; shown as a small button beside the box. */
  readonly onReset?: () => void;
  /** Accessible name and tooltip of the reset button. */
  readonly resetLabel?: string;
}

/** Screen pixels a box may shrink to (its width or height), at any zoom. */
const MIN_SCREEN_SIZE = 10;
/** The largest a box may grow, in multiples of the frame's larger side. */
const MAX_FRAME_MULTIPLE = 20;
/** Snap tolerance as a share of the frame's smaller side (the magnet feels alike at any size). */
const SNAP_TOLERANCE_FRACTION = 0.015;
/** Arrow keys: pixels, percent and degrees per press (plain, Shift). */
const KEY_NUDGE_PX = { fine: 1, coarse: 10 } as const;
const KEY_SCALE_PERCENT = { fine: 1, coarse: 10 } as const;
const KEY_ROTATE_DEGREES = { fine: 1, coarse: 15 } as const;

const NUDGE: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowUp: 1,
  ArrowRight: 1,
  ArrowDown: -1,
  ArrowLeft: -1,
};

/** A curved-arrow cursor for rotation, drawn to read on light and dark footage alike. */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 14a7 7 0 1 0 2-7" stroke="#fff" stroke-width="4"/>' +
    '<path d="M4 4v4h4" stroke="#fff" stroke-width="4"/>' +
    '<path d="M6 14a7 7 0 1 0 2-7" stroke="#111" stroke-width="1.8"/>' +
    '<path d="M4 4v4h4" stroke="#111" stroke-width="1.8"/></g></svg>',
)}") 12 12, alias`;

interface ActiveGesture {
  readonly pointerId: number;
  readonly gesture: TransformGesture;
  readonly start: Box;
  readonly startClient: Point;
  readonly frameEl: HTMLElement;
  readonly startAngle: number;
  /** Whether the pointer has passed the drag threshold (a move waits for it). */
  dragging: boolean;
  latest: Box;
}

const boxChanged = (a: Box, b: Box): boolean =>
  a.cx !== b.cx ||
  a.cy !== b.cy ||
  a.width !== b.width ||
  a.height !== b.height ||
  a.rotation !== b.rotation;

/** The box's placement as frame percentages (rotation is a separate CSS transform). */
function placement(box: Box, resolution: TransformBoxProps['resolution']): React.CSSProperties {
  return {
    left: `${((box.cx - box.width / 2) / resolution.width) * 100}%`,
    top: `${((box.cy - box.height / 2) / resolution.height) * 100}%`,
    width: `${(box.width / resolution.width) * 100}%`,
    height: `${(box.height / resolution.height) * 100}%`,
    transform: box.rotation === 0 ? undefined : `rotate(${rotationToCssDegrees(box.rotation)}deg)`,
  };
}

export function TransformBox({
  box,
  resolution,
  label,
  onPreview,
  onCommit,
  snapping = true,
  freeHandles = [],
  handles = RESIZE_HANDLES,
  onDoubleClick,
  children,
  interactive = true,
  sizeValue,
  rotateLabel = 'Rotate',
  onReset,
  resetLabel = 'Reset transform',
}: TransformBoxProps): JSX.Element {
  const active = useRef<ActiveGesture | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<{ client: Point; shift: boolean; alt: boolean } | null>(null);
  const [live, setLive] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  const [gestureKind, setGestureKind] = useState<TransformGesture['kind'] | null>(null);
  const shown = live ?? box;

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  /** The resize gesture as it stands: whether it is stretching depends on Shift at the time. */
  const gestureOf = (g: ActiveGesture, shift: boolean): TransformGesture =>
    g.gesture.kind === 'resize'
      ? {
          ...g.gesture,
          uniform: !freeHandles.includes(g.gesture.handle) && !shift,
        }
      : g.gesture;

  const apply = (client: Point, shift: boolean, alt: boolean): void => {
    const g = active.current;
    if (g === null) return;
    if (!g.dragging) {
      if (!passedDragThreshold(g.startClient, client)) return;
      g.dragging = true;
      setGestureKind(g.gesture.kind);
    }
    const rect = g.frameEl.getBoundingClientRect();
    const pointer = toProjectPoint(client, rect, resolution);
    const perScreen = projectPerScreenPixel(rect, resolution);
    let next: Box;
    let nextGuides: { x: number | null; y: number | null } = { x: null, y: null };
    if (g.gesture.kind === 'move') {
      const origin = toProjectPoint(g.startClient, rect, resolution);
      const snapOn = alt ? !snapping : snapping;
      const result = moveBox(
        g.start,
        { x: pointer.x - origin.x, y: pointer.y - origin.y },
        resolution,
        {
          constrainAxis: shift,
          snapTolerance: snapOn
            ? Math.min(resolution.width, resolution.height) * SNAP_TOLERANCE_FRACTION
            : null,
        },
      );
      next = result.box;
      nextGuides = result.guides;
    } else if (g.gesture.kind === 'resize') {
      const { handle } = g.gesture;
      const alwaysFree = freeHandles.includes(handle);
      next = resizeBox(g.start, handle, pointer, {
        uniform: !alwaysFree && !shift,
        fromCenter: alt,
        limits: {
          minSize: MIN_SCREEN_SIZE * perScreen,
          maxSize: Math.max(resolution.width, resolution.height) * MAX_FRAME_MULTIPLE,
        },
      });
    } else {
      next = rotateBox(g.start, g.startAngle, pointerAngle(g.start, pointer), shift);
    }
    g.latest = next;
    setLive(next);
    setGuides(nextGuides);
    onPreview(next, gestureOf(g, shift));
  };

  const begin = (event: React.PointerEvent<HTMLElement>, gesture: TransformGesture): void => {
    if (!interactive || event.button !== 0) return;
    const frameEl = event.currentTarget.closest<HTMLElement>('.transform-box')?.parentElement;
    if (!frameEl) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = frameEl.getBoundingClientRect();
    const client = { x: event.clientX, y: event.clientY };
    active.current = {
      pointerId: event.pointerId,
      gesture,
      start: box,
      startClient: client,
      frameEl,
      startAngle: pointerAngle(box, toProjectPoint(client, rect, resolution)),
      // Handles act from the first pixel; only a move waits for the threshold.
      dragging: gesture.kind !== 'move',
      latest: box,
    };
    if (gesture.kind !== 'move') setGestureKind(gesture.kind);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is an optimisation: the drag still tracks through the box without it. */
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const g = active.current;
    if (g === null || event.pointerId !== g.pointerId) return;
    pending.current = {
      client: { x: event.clientX, y: event.clientY },
      shift: event.shiftKey,
      alt: event.altKey,
    };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const latest = pending.current;
      pending.current = null;
      if (latest !== null) apply(latest.client, latest.shift, latest.alt);
    });
  };

  const end = (event: React.PointerEvent<HTMLElement>, cancelled: boolean): void => {
    const g = active.current;
    if (g === null || event.pointerId !== g.pointerId) return;
    // The last move may still be waiting for its frame: apply it now, so the release commits
    // where the pointer actually was.
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
      const latest = pending.current;
      pending.current = null;
      if (latest !== null && !cancelled) apply(latest.client, latest.shift, latest.alt);
    }
    active.current = null;
    setLive(null);
    setGuides({ x: null, y: null });
    setGestureKind(null);
    onPreview(null, g.gesture);
    if (!cancelled && g.dragging && boxChanged(g.latest, g.start)) {
      onCommit(g.latest, gestureOf(g, event.shiftKey));
    }
  };

  const handlers = {
    onPointerMove,
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => end(event, false),
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => end(event, true),
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => end(event, false),
  };

  const commitKey = (event: React.KeyboardEvent, next: Box, gesture: TransformGesture): void => {
    event.preventDefault();
    event.stopPropagation();
    if (boxChanged(next, box)) onCommit(next, gesture);
  };

  const onBoxKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    const direction = NUDGE[event.key];
    if (direction === undefined) return;
    const step = event.shiftKey ? KEY_NUDGE_PX.coarse : KEY_NUDGE_PX.fine;
    commitKey(
      event,
      { ...box, cx: box.cx + direction[0] * step, cy: box.cy + direction[1] * step },
      { kind: 'move' },
    );
  };

  const onHandleKeyDown = (event: React.KeyboardEvent<HTMLElement>, handle: ResizeHandle): void => {
    const sign = STEP[event.key];
    if (sign === undefined) return;
    const step = (event.shiftKey ? KEY_SCALE_PERCENT.coarse : KEY_SCALE_PERCENT.fine) / 100;
    const ratio = Math.max(0.01, 1 + sign * step);
    commitKey(
      event,
      { ...box, width: box.width * ratio, height: box.height * ratio },
      { kind: 'resize', handle, uniform: true },
    );
  };

  const onRotateKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const sign = STEP[event.key];
    if (sign === undefined) return;
    const step = event.shiftKey ? KEY_ROTATE_DEGREES.coarse : KEY_ROTATE_DEGREES.fine;
    commitKey(
      event,
      { ...box, rotation: normalizeRotation(box.rotation + sign * step) },
      { kind: 'rotate' },
    );
  };

  const rotation = normalizeRotation(shown.rotation);
  const readout =
    gestureKind === 'rotate'
      ? `${Math.round(rotation)}°`
      : gestureKind === 'resize'
        ? `${Math.round(shown.width)} × ${Math.round(shown.height)}`
        : null;

  return (
    <>
      {guides.x !== null && (
        <span
          className="transform-box-guide transform-box-guide--v"
          aria-hidden="true"
          style={{ left: `${guides.x * 100}%` }}
        />
      )}
      {guides.y !== null && (
        <span
          className="transform-box-guide transform-box-guide--h"
          aria-hidden="true"
          style={{ top: `${guides.y * 100}%` }}
        />
      )}
      <div
        className={`transform-box${gestureKind === null ? '' : ` is-${gestureKind}`}${
          interactive ? '' : ' is-passive'
        }`}
        role="group"
        aria-label={label}
        tabIndex={0}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        style={placement(shown, resolution)}
        onKeyDown={onBoxKeyDown}
        onPointerDown={(event) => begin(event, { kind: 'move' })}
        onDoubleClick={onDoubleClick}
        {...handlers}
      >
        {children}
        {interactive && (
          <>
            {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
              <span
                key={`rotate-${corner}`}
                className={`transform-box-rotate-zone transform-box-rotate-zone--${corner}`}
                style={{ cursor: ROTATE_CURSOR }}
                aria-hidden="true"
                onPointerDown={(event) => begin(event, { kind: 'rotate' })}
                {...handlers}
              />
            ))}
            {handles.map((handle) => (
              <span
                key={handle}
                role="slider"
                aria-label={`Resize handle ${handle}`}
                aria-valuenow={sizeValue?.now ?? Math.round(shown.width)}
                aria-valuetext={
                  sizeValue?.text ?? `${Math.round(shown.width)} by ${Math.round(shown.height)}`
                }
                tabIndex={0}
                className={`transform-box-handle transform-box-handle--${handle}`}
                style={{ cursor: resizeCursor(handle, shown.rotation) }}
                onKeyDown={(event) => onHandleKeyDown(event, handle)}
                onPointerDown={(event) =>
                  begin(event, {
                    kind: 'resize',
                    handle,
                    uniform: !freeHandles.includes(handle) && !event.shiftKey,
                  })
                }
                {...handlers}
              />
            ))}
            <span className="transform-box-stalk" aria-hidden="true" />
            <span
              role="slider"
              aria-label={rotateLabel}
              aria-valuenow={Math.round(rotation)}
              aria-valuemin={-180}
              aria-valuemax={180}
              aria-valuetext={`${Math.round(rotation)}°`}
              tabIndex={0}
              className="transform-box-rotate"
              style={{ cursor: ROTATE_CURSOR }}
              onKeyDown={onRotateKeyDown}
              onPointerDown={(event) => begin(event, { kind: 'rotate' })}
              {...handlers}
            />
          </>
        )}
        {interactive && onReset !== undefined && (
          <button
            type="button"
            className="transform-box-reset"
            aria-label={resetLabel}
            title={resetLabel}
            // The box owns a move on pointerdown; the button must be clicked, not dragged.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onReset();
            }}
          >
            <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        )}
        {readout !== null && (
          <span
            className="transform-box-readout"
            aria-hidden="true"
            // Upright however the box is turned: a readout you have to tilt your head to read
            // is not a readout.
            style={{
              transform: `translateX(-50%) rotate(${-rotationToCssDegrees(shown.rotation)}deg)`,
            }}
          >
            {readout}
          </span>
        )}
      </div>
    </>
  );
}
