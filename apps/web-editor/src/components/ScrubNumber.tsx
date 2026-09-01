/**
 * A drag-to-scrub numeric field with an editor-style value track.
 *
 * The label remains a horizontal scrub handle, the value remains a real number input
 * for typing and keyboard access, and the track makes the current value scannable at
 * a glance without introducing a second interactive control.
 */
import { useRef } from 'react';
import { RotateCcw } from './icons.js';

export interface ScrubNumberProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  /** Accessible name for the input (defaults to the label). */
  readonly ariaLabel?: string;
  /** Double-click the label or use reset to restore this value. */
  readonly defaultValue?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function ScrubNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  ariaLabel,
  defaultValue,
}: ScrubNumberProps): JSX.Element {
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const trackDragRef = useRef(false);
  const canReset = defaultValue !== undefined && value !== defaultValue;
  const progress = ((clamp(value, min, max) - min) / Math.max(Number.EPSILON, max - min)) * 100;
  const reset = (): void => {
    if (defaultValue !== undefined) onChange(defaultValue);
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startValue: value };
  };
  const onPointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clamp(drag.startValue + (event.clientX - drag.startX) * step, min, max);
    onChange(Math.round(next / step) * step);
  };
  const onPointerUp = (event: React.PointerEvent): void => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore lost capture */
    }
  };

  /**
   * Absolute positioning for the track: where along the rail the pointer is IS the
   * value. Quantised to `step` so it can only produce values the field could also
   * be typed to.
   */
  const valueAtX = (clientX: number): number => {
    const rail = trackRef.current?.getBoundingClientRect();
    if (!rail || rail.width <= 0) return value;
    const ratio = Math.min(1, Math.max(0, (clientX - rail.left) / rail.width));
    const raw = min + ratio * (max - min);
    return clamp(Math.round(raw / step) * step, min, max);
  };
  const onTrackPointerDown = (event: React.PointerEvent): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    trackDragRef.current = true;
    onChange(valueAtX(event.clientX));
  };
  const onTrackPointerMove = (event: React.PointerEvent): void => {
    if (!trackDragRef.current) return;
    onChange(valueAtX(event.clientX));
  };
  /**
   * Ends the track drag, however it ended.
   *
   * Bound to `pointercancel` and `lostpointercapture` as well as `pointerup`: a
   * touch interrupted by the browser, or capture taken away mid-gesture, fires
   * neither `pointerup` nor a click — and the flag left `true` means every later
   * pointer move over the rail keeps writing values with no button held.
   */
  const onTrackPointerUp = (event: React.PointerEvent): void => {
    trackDragRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore lost capture */
    }
  };

  return (
    <div className="scrub-number">
      <span
        className="scrub-label"
        role="presentation"
        title={
          defaultValue !== undefined ? 'Drag to scrub · double-click to reset' : 'Drag to scrub'
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={defaultValue !== undefined ? reset : undefined}
      >
        {label}
      </span>
      {/*
        The track is a control, not a readout — and it is operated the way it is
        DRAWN.

        It renders a filled bar and a knob at `progress%` of its own width, which
        is the picture of an absolute-position slider, while only the label carried
        pointer handlers. In the inspector's row layout that label is hidden (the
        row draws its own in the aligned column), so the one thing that looked
        draggable was inert and the one thing that was draggable was invisible.

        The label keeps RELATIVE scrubbing (one step per pixel, the precision
        gesture — it can exceed the rail and does not care how wide it is). The
        track is ABSOLUTE: pointer position maps to position in [min, max], so the
        knob stays under the finger, a click jumps to a value, and both ends of the
        range are reachable. Handling it relatively here would have left the knob
        trailing the pointer and the top of the range unreachable on a 90px rail.

        `aria-hidden` stays: this is a second pointer path to a value the real
        number input beside it already exposes to assistive tech and the keyboard.
      */}
      <span
        ref={trackRef}
        className="scrub-track"
        aria-hidden="true"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
        onLostPointerCapture={onTrackPointerUp}
        onDoubleClick={defaultValue !== undefined ? reset : undefined}
      >
        <span className="scrub-track-fill" style={{ width: `${progress}%` }} />
      </span>
      <span className="scrub-input">
        <input
          type="number"
          className="tabular"
          value={value}
          min={min}
          max={max}
          step={step}
          aria-label={ariaLabel ?? label}
          onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
        />
        {unit && <span className="scrub-unit">{unit}</span>}
        {canReset && (
          <button
            type="button"
            className="scrub-reset"
            aria-label={`reset ${ariaLabel ?? label}`}
            title="Reset to default"
            onClick={reset}
          >
            <RotateCcw size={12} aria-hidden="true" />
          </button>
        )}
      </span>
    </div>
  );
}
