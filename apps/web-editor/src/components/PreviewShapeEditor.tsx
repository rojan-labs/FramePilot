/**
 * On-monitor handles for a selected shape (plan/elements EL4a).
 *
 * A box shape (a rectangle, a badge, an icon…) is edited in the bounding box ({@link TransformBox}):
 * drag to move it, a corner or edge to resize it (the aspect held unless Shift is pressed, Alt from
 * the centre; a shape stretches natively, so a free resize is just a new width and height), and
 * the lollipop to turn it (the clip's rotation). A line or an arrow keeps its two end handles:
 * drag an end to aim it, the line to move it.
 *
 * One gesture is one {@link ShapeCommit}: the caller applies it as one patch. While a gesture is
 * live, {@link PreviewShapeEditorProps.onLive} reports the params and transform it would store, so
 * the monitor can draw the shape itself following the hand rather than an outline.
 *
 * **Keyboard.** The box's arrows move the shape a pixel (Shift, ten), its corners scale it, the
 * rotation handle turns it; a line's body moves it by the percent steps it always did.
 */
import { useRef, useState } from 'react';
import { SHAPE_LIMITS } from '@framepilot/timeline-schema';
import {
  NUDGE_PERCENT,
  segmentDragChanges,
  shapePivot,
  toShapeDelta,
  type SegmentHandle,
} from '../preview/shape-handles.js';
import {
  shapeBoxOf,
  shapeEditAfter,
  type PictureBaseTransform,
} from '../preview/transform-box/adapters.js';
import type { Box, TransformGesture } from '../preview/transform-box/geometry.js';
import { TransformBox } from './transform-box/TransformBox.js';

type Params = Readonly<Record<string, unknown>>;

/** One committed shape edit: the params that changed, the new transform when it changed. */
export interface ShapeCommit {
  readonly params?: Record<string, number>;
  readonly transform?: PictureBaseTransform;
}

export interface PreviewShapeEditorProps {
  readonly clipId: string;
  /** What the shape is, as the catalogue names it ("Arrow"): its handles' accessible name. */
  readonly name: string;
  readonly params: Params;
  /** The project frame, in output pixels. */
  readonly resolution: { readonly width: number; readonly height: number };
  /** The clip's transform at the playhead (offsets in output pixels, degrees anticlockwise). */
  readonly transform: PictureBaseTransform;
  /** The clip's stored (time-0) transform, which a turn edits. */
  readonly baseTransform?: PictureBaseTransform;
  /** Commit one gesture's edit as one patch. */
  readonly onCommit: (edit: ShapeCommit) => void;
  /** A live gesture's edit, `null` when it ends: lets the monitor draw the shape following it. */
  readonly onLive?: (edit: ShapeCommit | null) => void;
}

interface Drag {
  readonly handle: SegmentHandle;
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
  baseTransform = transform,
  onCommit,
  onLive,
}: PreviewShapeEditorProps): JSX.Element {
  const segment = params.x1 !== undefined && params.x1 !== null;
  return segment ? (
    <SegmentEditor
      clipId={clipId}
      name={name}
      params={params}
      resolution={resolution}
      transform={transform}
      onCommit={onCommit}
      {...(onLive === undefined ? {} : { onLive })}
    />
  ) : (
    <BoxShapeEditor
      name={name}
      params={params}
      resolution={resolution}
      transform={transform}
      baseTransform={baseTransform}
      onCommit={onCommit}
      {...(onLive === undefined ? {} : { onLive })}
    />
  );
}

/** A box shape in the bounding box. */
function BoxShapeEditor({
  name,
  params,
  resolution,
  transform,
  baseTransform,
  onCommit,
  onLive,
}: Omit<PreviewShapeEditorProps, 'clipId' | 'baseTransform'> & {
  readonly baseTransform: PictureBaseTransform;
}): JSX.Element {
  const shape = {
    x: num(params, 'x'),
    y: num(params, 'y'),
    width: num(params, 'width'),
    height: num(params, 'height'),
  };
  const box: Box = shapeBoxOf(shape, transform, resolution);
  const editFor = (next: Box, gesture: TransformGesture): ShapeCommit => {
    const edit = shapeEditAfter(shape, baseTransform, box, next, gesture, resolution, SHAPE_LIMITS);
    const changed: Record<string, number> = {};
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (edit.params[key] !== shape[key]) changed[key] = edit.params[key];
    }
    const turned = edit.transform.rotation !== baseTransform.rotation;
    return {
      ...(Object.keys(changed).length > 0 ? { params: changed } : {}),
      ...(turned ? { transform: edit.transform } : {}),
    };
  };
  return (
    <TransformBox
      box={box}
      resolution={resolution}
      label={`Move ${name}`}
      rotateLabel={`Rotate ${name}`}
      onPreview={(next, gesture) => onLive?.(next === null ? null : editFor(next, gesture))}
      onCommit={(next, gesture) => {
        const edit = editFor(next, gesture);
        if (edit.params !== undefined || edit.transform !== undefined) onCommit(edit);
      }}
    />
  );
}

/** A line or an arrow: its two ends, drawn inside the clip's transform. */
function SegmentEditor({
  clipId,
  name,
  params,
  resolution,
  transform,
  onCommit,
  onLive,
}: Omit<PreviewShapeEditorProps, 'baseTransform'>): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [live, setLive] = useState<Record<string, number> | null>(null);
  const shown: Params = live === null ? params : { ...params, ...live };

  const changesFor = (drag: Drag, event: { clientX: number; clientY: number }) => {
    const { dx, dy } = toShapeDelta(
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      drag.frame.width,
      drag.frame.height,
      transform.rotation,
      transform.scale,
      { x: transform.scaleX, y: transform.scaleY },
    );
    return segmentDragChanges(params, drag.handle, dx, dy);
  };

  const begin = (handle: SegmentHandle) => (event: React.PointerEvent) => {
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
    const changes = changesFor(drag, event);
    setLive(changes);
    onLive?.({ params: changes });
  };
  const end = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    setLive(null);
    onLive?.(null);
    const moved = event.clientX !== drag.startX || event.clientY !== drag.startY;
    if (moved) onCommit({ params: changesFor(drag, event) });
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
    onCommit({ params: segmentDragChanges(params, 'move', d[0], d[1]) });
  };

  const pivot = shapePivot(shown);
  const layerStyle: React.CSSProperties = {
    transformOrigin: `${pivot.x}% ${pivot.y}%`,
    transform:
      `translate(${(transform.x / resolution.width) * 100}%, ` +
      `${(transform.y / resolution.height) * 100}%) ` +
      `rotate(${-transform.rotation}deg) ` +
      `scale(${transform.scale * transform.scaleX}, ${transform.scale * transform.scaleY})`,
  };
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
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
