/**
 * On-monitor handles for a selected shape (plan/elements EL4a): drag the body to move it, a side
 * or corner to resize a box, an end to aim an arrow or a line. One patch per gesture: the outline
 * follows the pointer live and the change commits once, on release. Arrow keys nudge (Shift for a
 * bigger step), one patch per press.
 *
 * The handle layer sits inside the clip's transform at the playhead (translated, turned and scaled
 * about the shape's centre, as the export places the raster), and the geometry lives in
 * `preview/shape-handles.ts`.
 *
 * **Keyboard.** The shape's body is one stop, named by what the shape is ("Move Arrow"); the
 * arrows move it. The resize and endpoint handles are pointer-only and hidden from assistive tech:
 * activated, they would do nothing, and the Inspector's Box and Ends fields are the keyboard route
 * to the same edits. (Shift to keep the aspect, Alt to resize from the centre, snapping and a
 * rotation handle — which the sticker box has — are not offered for shapes yet.)
 */
import { useRef, useState } from 'react';
import {
  BOX_HANDLES,
  NUDGE_PERCENT,
  boxDragChanges,
  boxRect,
  segmentDragChanges,
  shapePivot,
  toShapeDelta,
  type BoxHandle,
  type SegmentHandle,
} from '../preview/shape-handles.js';

type Params = Readonly<Record<string, unknown>>;

export interface ShapeHandleTransform {
  /** Offsets in output pixels, as the clip's `x`/`y` keyframes store them. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  /** Degrees, counter-clockwise, as the export turns the layer. */
  readonly rotation: number;
}

export interface PreviewShapeEditorProps {
  readonly clipId: string;
  /** What the shape is, as the catalogue names it ("Arrow"): its handles' accessible name. */
  readonly name: string;
  readonly params: Params;
  /** The project frame, in output pixels. */
  readonly resolution: { readonly width: number; readonly height: number };
  readonly transform: ShapeHandleTransform;
  /** Commit one gesture's changes as one patch. */
  readonly onCommit: (changes: Record<string, number>) => void;
}

interface Drag {
  readonly handle: BoxHandle | SegmentHandle;
  readonly startX: number;
  readonly startY: number;
  readonly frame: DOMRect;
}

/** The arrows the body answers, for `aria-keyshortcuts`. */
const NUDGE_KEYS = 'ArrowUp ArrowDown ArrowLeft ArrowRight';

const num = (params: Params, key: string): number => {
  const value = params[key];
  return typeof value === 'number' ? value : 0;
};

export function PreviewShapeEditor({
  clipId,
  name,
  params,
  resolution,
  transform,
  onCommit,
}: PreviewShapeEditorProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [live, setLive] = useState<Record<string, number> | null>(null);
  const aspect = resolution.width / resolution.height;
  const segment = params.x1 !== undefined && params.x1 !== null;
  const shown: Params = live === null ? params : { ...params, ...live };

  const changesFor = (drag: Drag, event: { clientX: number; clientY: number }) => {
    const { dx, dy } = toShapeDelta(
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      drag.frame.width,
      drag.frame.height,
      transform.rotation,
      transform.scale,
    );
    return segment
      ? segmentDragChanges(params, drag.handle as SegmentHandle, dx, dy)
      : boxDragChanges(params, drag.handle as BoxHandle, dx, dy, aspect);
  };

  const begin = (handle: BoxHandle | SegmentHandle) => (event: React.PointerEvent) => {
    // The frame the handles are laid out in: the unturned parent of the handle layer.
    const frame = layerRef.current?.parentElement?.getBoundingClientRect();
    if (!frame || frame.width === 0 || frame.height === 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { handle, startX: event.clientX, startY: event.clientY, frame };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    setLive(changesFor(drag, event));
  };
  const end = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    setLive(null);
    const moved = event.clientX !== drag.startX || event.clientY !== drag.startY;
    if (moved) onCommit(changesFor(drag, event));
  };
  const nudge = (event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? NUDGE_PERCENT.coarse : NUDGE_PERCENT.fine;
    const delta: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (d === undefined) return;
    event.preventDefault();
    // The arrows are this shape's now, not the editor's frame steps as well.
    event.stopPropagation();
    onCommit(
      segment
        ? segmentDragChanges(params, 'move', d[0], d[1])
        : boxDragChanges(params, 'move', d[0], d[1], aspect),
    );
  };

  const pivot = shapePivot(shown);
  const layerStyle: React.CSSProperties = {
    transformOrigin: `${pivot.x}% ${pivot.y}%`,
    transform:
      `translate(${(transform.x / resolution.width) * 100}%, ` +
      `${(transform.y / resolution.height) * 100}%) ` +
      `rotate(${-transform.rotation}deg) scale(${transform.scale})`,
  };
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  if (segment) {
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((key) => num(shown, key)) as [
      number,
      number,
      number,
      number,
    ];
    return (
      <div ref={layerRef} className="preview-shape-editor" data-clip-id={clipId} style={layerStyle}>
        <svg className="preview-shape-editor-line" viewBox="0 0 100 100" preserveAspectRatio="none">
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            role="button"
            tabIndex={0}
            aria-label={`Move ${name}`}
            aria-keyshortcuts={NUDGE_KEYS}
            onPointerDown={begin('move')}
            onKeyDown={nudge}
            {...handlers}
          />
        </svg>
        {(
          [
            ['start', x1, y1],
            ['end', x2, y2],
          ] as const
        ).map(([handle, x, y]) => (
          <span
            key={handle}
            className="preview-shape-handle is-end"
            data-end={handle}
            style={{ left: `${x}%`, top: `${y}%` }}
            aria-hidden="true"
            onPointerDown={begin(handle)}
            {...handlers}
          />
        ))}
      </div>
    );
  }

  const rect = boxRect(shown, aspect);
  return (
    <div ref={layerRef} className="preview-shape-editor" data-clip-id={clipId} style={layerStyle}>
      <div
        className="preview-shape-box"
        style={{
          left: `${rect.left}%`,
          top: `${rect.top}%`,
          width: `${rect.width}%`,
          height: `${rect.height}%`,
        }}
        role="button"
        tabIndex={0}
        aria-label={`Move ${name}`}
        aria-keyshortcuts={NUDGE_KEYS}
        onPointerDown={begin('move')}
        onKeyDown={nudge}
        {...handlers}
      >
        {BOX_HANDLES.map((handle) => (
          <span
            key={handle}
            className={`preview-shape-handle is-${handle}`}
            aria-hidden="true"
            onPointerDown={begin(handle)}
            {...handlers}
          />
        ))}
      </div>
    </div>
  );
}
