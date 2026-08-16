/**
 * On-canvas transform controls for the program monitor (Phase 15 H4; rotation,
 * snapping, guides and reset added in revamp Phase 3).
 *
 * Clicking the stage selects the active picture clip; the selected clip gets a
 * bounding box with corner handles directly over the preview. Dragging the box
 * repositions (`x`/`y`, canvas-pixel offsets from centered), dragging a corner
 * scales proportionally, and dragging the rotation handle spins the clip
 * (`rotation`, degrees). While dragging, the parent shows a LIVE override; on
 * release the gesture commits ONE validated patch (`add_keyframes` at time 0 with
 * `replace: true`) through the normal validate→apply→record store path, so the
 * edit is undoable and reaches preview, timeline, save, and export identically.
 *
 * **Uniform scale only, on purpose.** The engine's transform model is a single
 * `scale`; non-uniform stretch is intentionally not offered because the render
 * cannot produce it. That is also why there is no "aspect lock" toggle — aspect is
 * always locked, so a switch would be a no-op. `Reset` is the useful control in its
 * place. There is likewise no anchor-point handle: `evaluate_clip_transform` has no
 * anchor (rotation and scale are both about the clip's own centre), so the handle
 * would write keyframes the render ignores. See the sub-plan's Phase 3 note.
 *
 * Geometry is expressed in PERCENT of the frame, so the overlay needs no
 * ResizeObserver; pointer math converts px→canvas units off the frame rect
 * captured once per gesture.
 *
 * **Modifiers.** `Shift` constrains — a move locks to the dominant axis, a rotation
 * steps in 15° increments. `Alt` defeats snapping mid-drag (the same convention as
 * timeline snapping and the Phase 2 scrub bar).
 */
import { useRef, useState } from 'react';
import { rotationToCssDegrees } from '../preview/picture-transform.js';
import { normalizeRotation, snapRotation, snapTransform } from '../preview/snapping.js';
import { Tooltip } from './Tooltip.js';
import { ICON_SIZE, RotateCcw } from './icons.js';

/** The transform slice the controls edit (engine convention: PRD §6.3). */
export interface ClipTransformValues {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  /**
   * Degrees, ANTICLOCKWISE-positive (the project/MoviePy convention). Optional
   * because a clip with no rotation keyframe has no rotation — absent and `0` mean
   * the same thing, and the render treats them identically.
   */
  readonly rotation?: number;
}

/** A live drag override, or null when idle. */
export type TransformOverride = ClipTransformValues | null;

/** Alignment guides to draw during a snapped drag, as frame fractions. */
export interface TransformGuides {
  readonly x: number | null;
  readonly y: number | null;
}

export interface PreviewTransformProps {
  /** Current committed transform of the selected clip (evaluated at time 0). */
  readonly value: ClipTransformValues;
  /** Project canvas, for px→canvas-unit conversion. */
  readonly resolution: { readonly width: number; readonly height: number };
  /** Live-preview an in-progress gesture (null = gesture ended/cancelled). */
  readonly onPreview: (override: TransformOverride) => void;
  /** Commit the gesture's final transform as one validated patch. */
  readonly onCommit: (values: ClipTransformValues) => void;
  /**
   * Whether magnetic snapping is on (the user's `EditorSettings.snapping`
   * preference). `Alt` inverts it per-gesture. Defaults to on.
   */
  readonly snapping?: boolean;
}

/** Scale bounds for the corner handles (matches the engine's sane range). */
export const TRANSFORM_SCALE_BOUNDS = { min: 0.05, max: 20 } as const;

/**
 * Snap tolerance as a fraction of the frame's size on that axis. Proportional
 * rather than a pixel count so the magnet feels the same on a 1080p project as on a
 * 4K one — 1.5 % of 1920 is ~29 project px, about 9 screen px on a half-size monitor.
 */
const SNAP_TOLERANCE_FRACTION = 0.015;

/** Rotation increment while the constrain modifier is held. */
const ROTATION_SNAP_DEGREES = 15;

/**
 * How far a move must travel before axis-constrain picks a direction. Below this
 * the dominant axis flickers between X and Y on sub-pixel jitter, which reads as
 * the constraint being broken.
 */
const AXIS_LOCK_DEADZONE_PX = 3;

const clampScale = (value: number): number =>
  Math.min(TRANSFORM_SCALE_BOUNDS.max, Math.max(TRANSFORM_SCALE_BOUNDS.min, value));

/**
 * The selection box's frame-percent geometry for a transform. The clip fills the
 * canvas at scale 1 centered; `x`/`y` shift it in canvas pixels.
 *
 * Rotation is deliberately NOT part of this: it is a `transform`, not a box
 * position, and keeping them separate means the box's layout math stays
 * rotation-independent (see {@link transformBoxRotation}).
 */
export function transformBoxStyle(
  value: ClipTransformValues,
  resolution: { readonly width: number; readonly height: number },
): { left: string; top: string; width: string; height: string } {
  const offsetXPct = (value.x / resolution.width) * 100;
  const offsetYPct = (value.y / resolution.height) * 100;
  const sizePct = value.scale * 100;
  return {
    left: `${50 + offsetXPct - sizePct / 2}%`,
    top: `${50 + offsetYPct - sizePct / 2}%`,
    width: `${sizePct}%`,
    height: `${sizePct}%`,
  };
}

/**
 * The CSS `transform` that puts the selection box at the clip's angle, or
 * `undefined` when the clip is unrotated (so an unrotated box stamps no transform
 * at all). Signs come from {@link rotationToCssDegrees} — the one place that owns
 * the project-anticlockwise ↔ CSS-clockwise conversion — so the box can never sit
 * at a different angle from the picture it frames.
 */
export function transformBoxRotation(value: ClipTransformValues): string | undefined {
  const degrees = value.rotation ?? 0;
  if (degrees === 0) return undefined;
  return `rotate(${rotationToCssDegrees(degrees)}deg)`;
}

/**
 * The transform a MOVE gesture produces: pointer delta (frame px) mapped to
 * canvas-pixel offsets on top of the gesture's base transform.
 *
 * `constrainAxis` locks to the dominant direction (the `Shift` modifier), which is
 * resolved from the raw pixel delta rather than the converted offsets — on a
 * non-square project the two disagree, and the user means "the direction my hand is
 * moving", not "the direction in project units".
 */
export function moveGestureTransform(
  base: ClipTransformValues,
  deltaPx: { dx: number; dy: number },
  frame: { width: number; height: number },
  resolution: { readonly width: number; readonly height: number },
  constrainAxis = false,
): ClipTransformValues {
  if (frame.width <= 0 || frame.height <= 0) return base;
  let { dx, dy } = deltaPx;
  if (constrainAxis && Math.hypot(dx, dy) >= AXIS_LOCK_DEADZONE_PX) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  return {
    ...base,
    x: base.x + (dx / frame.width) * resolution.width,
    y: base.y + (dy / frame.height) * resolution.height,
  };
}

/**
 * The transform a CORNER gesture produces: proportional scale about the box
 * center, from the ratio of the pointer's current to starting distance from
 * that center. Position is preserved (scaling about the clip's own center).
 */
export function cornerGestureTransform(
  base: ClipTransformValues,
  startDistancePx: number,
  currentDistancePx: number,
): ClipTransformValues {
  if (startDistancePx <= 0) return base;
  return { ...base, scale: clampScale(base.scale * (currentDistancePx / startDistancePx)) };
}

/**
 * The transform a ROTATE gesture produces: the angle the pointer has swept around
 * the box centre, added to the base rotation.
 *
 * **The sweep is subtracted, not added.** Screen space is y-down, so `atan2`
 * increases CLOCKWISE, while project rotation is anticlockwise-positive. Dragging
 * the handle clockwise must therefore *decrease* the stored rotation — otherwise the
 * clip would turn the opposite way from the hand moving it.
 */
export function rotateGestureTransform(
  base: ClipTransformValues,
  startAngleRad: number,
  currentAngleRad: number,
  snapToIncrements = false,
): ClipTransformValues {
  const sweptDeg = ((currentAngleRad - startAngleRad) * 180) / Math.PI;
  const raw = (base.rotation ?? 0) - sweptDeg;
  const snapped = snapToIncrements ? snapRotation(raw, ROTATION_SNAP_DEGREES) : raw;
  return { ...base, rotation: normalizeRotation(snapped) };
}

type GestureKind = 'move' | 'corner' | 'rotate';

interface Gesture {
  readonly kind: GestureKind;
  readonly pointerId: number;
  readonly base: ClipTransformValues;
  readonly frameRect: DOMRect;
  readonly startX: number;
  readonly startY: number;
  /** Box-center position at gesture start (viewport px) — the scale/rotate pivot. */
  readonly centerX: number;
  readonly centerY: number;
  readonly startDistance: number;
  /** Pointer angle about the box centre at gesture start (radians, screen space). */
  readonly startAngle: number;
  /** The latest transform produced by the gesture (committed on release). */
  latest: ClipTransformValues;
}

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

/** Whether two transforms differ in any property the handles can write. */
const transformChanged = (a: ClipTransformValues, b: ClipTransformValues): boolean =>
  a.scale !== b.scale || a.x !== b.x || a.y !== b.y || (a.rotation ?? 0) !== (b.rotation ?? 0);

export function PreviewTransform({
  value,
  resolution,
  onPreview,
  onCommit,
  snapping = true,
}: PreviewTransformProps): JSX.Element {
  const gesture = useRef<Gesture | null>(null);
  // Local mirror of the live override so the BOX itself follows the drag even
  // if the parent debounces its preview state.
  const [live, setLive] = useState<TransformOverride>(null);
  // Which alignment guides to draw. Only ever non-null mid-gesture, so the canvas
  // is clean at rest — chrome recedes (design direction §3).
  const [guides, setGuides] = useState<TransformGuides>({ x: null, y: null });
  const shown = live ?? value;

  const beginGesture = (
    event: React.PointerEvent<HTMLElement>,
    kind: GestureKind,
    boxEl: HTMLElement,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const frameEl = boxEl.parentElement; // the .preview-frame
    if (!frameEl) return;
    const frameRect = frameEl.getBoundingClientRect();
    const boxRect = boxEl.getBoundingClientRect();
    const centerX = boxRect.left + boxRect.width / 2;
    const centerY = boxRect.top + boxRect.height / 2;
    gesture.current = {
      kind,
      pointerId: event.pointerId,
      base: value,
      frameRect,
      startX: event.clientX,
      startY: event.clientY,
      centerX,
      centerY,
      startDistance: Math.hypot(event.clientX - centerX, event.clientY - centerY),
      startAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
      latest: value,
    };
    /* v8 ignore start -- setPointerCapture throws only for a pointer id with no
       active pointer, which a real event by definition has. */
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      /* Capture is an optimisation — the drag still tracks without it. */
    }
    /* v8 ignore stop */
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    let next: ClipTransformValues;
    let nextGuides: TransformGuides = { x: null, y: null };
    if (active.kind === 'move') {
      next = moveGestureTransform(
        active.base,
        { dx: event.clientX - active.startX, dy: event.clientY - active.startY },
        { width: active.frameRect.width, height: active.frameRect.height },
        resolution,
        event.shiftKey,
      );
      // Alt inverts the user's snapping preference, per-gesture.
      const snapOn = event.altKey ? !snapping : snapping;
      if (snapOn) {
        const tolerance = Math.min(resolution.width, resolution.height) * SNAP_TOLERANCE_FRACTION;
        const snapped = snapTransform(next, resolution, tolerance);
        next = { ...next, x: snapped.values.x, y: snapped.values.y };
        nextGuides = { x: snapped.guideX, y: snapped.guideY };
      }
    } else if (active.kind === 'corner') {
      next = cornerGestureTransform(
        active.base,
        active.startDistance,
        Math.hypot(event.clientX - active.centerX, event.clientY - active.centerY),
      );
    } else {
      next = rotateGestureTransform(
        active.base,
        active.startAngle,
        Math.atan2(event.clientY - active.centerY, event.clientX - active.centerX),
        event.shiftKey,
      );
    }
    active.latest = next;
    setLive(next);
    setGuides(nextGuides);
    onPreview(next);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    gesture.current = null;
    setLive(null);
    setGuides({ x: null, y: null });
    onPreview(null);
    // Commit only a real change — a click that never moved must not spam history.
    if (transformChanged(active.latest, active.base)) onCommit(active.latest);
  };

  /** Back to the engine's identity transform, as one committed patch. */
  const resetTransform = (): void => {
    if (!transformChanged(value, { scale: 1, x: 0, y: 0, rotation: 0 })) return;
    onCommit({ scale: 1, x: 0, y: 0, rotation: 0 });
  };

  const rotationDeg = normalizeRotation(shown.rotation ?? 0);

  return (
    <>
      {/* Alignment guides span the whole FRAME, not the box — the point is where
          the box sits relative to the frame, so a guide clipped to the box would
          say nothing. Outside the box element so the box's own rotation does not
          rotate them. */}
      {guides.x !== null && (
        <span
          className="preview-align-guide preview-align-guide--v"
          aria-hidden="true"
          style={{ left: `${guides.x * 100}%` }}
        />
      )}
      {guides.y !== null && (
        <span
          className="preview-align-guide preview-align-guide--h"
          aria-hidden="true"
          style={{ top: `${guides.y * 100}%` }}
        />
      )}
      <div
        className="preview-transform"
        role="group"
        aria-label="Transform selected clip"
        style={{ ...transformBoxStyle(shown, resolution), transform: transformBoxRotation(shown) }}
        onPointerDown={(event) => beginGesture(event, 'move', event.currentTarget)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {CORNERS.map((corner) => (
          <span
            key={corner}
            role="slider"
            aria-label={`Resize handle ${corner}`}
            aria-valuenow={Math.round(shown.scale * 100)}
            aria-valuemin={TRANSFORM_SCALE_BOUNDS.min * 100}
            aria-valuemax={TRANSFORM_SCALE_BOUNDS.max * 100}
            tabIndex={0}
            className={`preview-transform-handle preview-transform-handle--${corner}`}
            onPointerDown={(event) => {
              const box = event.currentTarget.parentElement;
              if (box) beginGesture(event, 'corner', box);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
        {/* Rotation handle: on a stalk above the box, the convention every NLE and
            design tool shares, so it is never mistaken for a resize corner. */}
        <span
          role="slider"
          aria-label="Rotate clip"
          aria-valuenow={Math.round(rotationDeg)}
          aria-valuemin={-180}
          aria-valuemax={180}
          aria-valuetext={`${Math.round(rotationDeg)}°`}
          tabIndex={0}
          className="preview-transform-rotate"
          onPointerDown={(event) => {
            const box = event.currentTarget.parentElement;
            if (box) beginGesture(event, 'rotate', box);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {/* Live rotation readout — a rotation you cannot read is a rotation you
            cannot match on a second clip. Only while actually rotating. */}
        {live !== null && rotationDeg !== 0 && (
          <span className="preview-transform-readout" aria-hidden="true">
            {Math.round(rotationDeg)}°
          </span>
        )}
        <Tooltip label="Reset position, scale and rotation">
          <button
            type="button"
            className="preview-transform-reset"
            aria-label="reset clip transform"
            // The box owns a move gesture on pointerdown; without this the button
            // would start dragging the clip instead of being clicked.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              resetTransform();
            }}
          >
            <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </>
  );
}
