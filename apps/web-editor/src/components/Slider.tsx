/**
 * Slider — token-styled range control (master-prompt §4).
 *
 * Wraps a real `<input type="range">` (kept for native keyboard support: arrows,
 * Home/End, Page Up/Down, and screen-reader value reporting) and themes the track
 * + thumb via `styles.css`. Presentational; the parent owns the value.
 */
import { useRef } from 'react';

export interface SliderProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  /**
   * Optional end-of-gesture callback for expensive, durable edits. `onChange`
   * can update a cheap local preview while this fires once on pointer release,
   * keyboard release, or blur. Without it the slider keeps its original
   * immediate-change behaviour.
   */
  readonly onCommit?: (value: number) => void;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly ariaLabel: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  ariaLabel,
  id,
  disabled,
  className,
}: SliderProps): JSX.Element {
  const dirtyRef = useRef(false);
  const commit = (input: HTMLInputElement): void => {
    if (!onCommit || !dirtyRef.current) return;
    dirtyRef.current = false;
    onCommit(Number(input.value));
  };

  return (
    <input
      type="range"
      id={id}
      className={`slider ${className ?? ''}`}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        dirtyRef.current = true;
        onChange(Number(event.target.value));
      }}
      onPointerUp={(event) => commit(event.currentTarget)}
      onPointerCancel={(event) => commit(event.currentTarget)}
      onKeyUp={(event) => commit(event.currentTarget)}
      onBlur={(event) => commit(event.currentTarget)}
    />
  );
}
