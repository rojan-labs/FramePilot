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
  const canReset = defaultValue !== undefined && value !== defaultValue;
  const progress =
    ((clamp(value, min, max) - min) / Math.max(Number.EPSILON, max - min)) * 100;
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
      <span className="scrub-track" aria-hidden="true">
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
