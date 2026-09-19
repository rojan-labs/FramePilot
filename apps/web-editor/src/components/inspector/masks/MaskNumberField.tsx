/**
 * A numeric mask property in the Inspector (MK4.2): typed pixel input, scrub-to-change, and an
 * optional keyframe control.
 *
 * Unlike `ScrubNumber`, which reports every intermediate value, a mask edit must reach history
 * once: typing commits on Enter or blur (Escape reverts), and a scrub previews live through
 * `onLive` and commits one value on release. Arrow keys in the field commit per press, which is
 * one discrete edit each.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { InspectorRow } from '../InspectorRow.js';

export interface MaskNumberFieldProps {
  readonly label: string;
  /** Accessible name of the input; also the row's name. */
  readonly name: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step: number;
  readonly unit?: string;
  readonly disabled?: boolean;
  /** Preview a value during a scrub; `null` when the scrub ends. */
  readonly onLive?: (value: number | null) => void;
  readonly onCommit: (value: number) => void;
  readonly keyframe?: ReactNode;
}

/** Display precision: enough to show sub-pixel positions without float noise. */
const DISPLAY_DECIMALS = 3;

const clamp = (value: number, min: number | undefined, max: number | undefined): number =>
  Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value));

const shown = (value: number): string =>
  String(Math.round(value * 10 ** DISPLAY_DECIMALS) / 10 ** DISPLAY_DECIMALS);

export function MaskNumberField({
  label,
  name,
  value,
  min,
  max,
  step,
  unit,
  disabled = false,
  onLive,
  onCommit,
  keyframe,
}: MaskNumberFieldProps): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const scrub = useRef<{ startX: number; startValue: number; latest: number } | null>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  // A new committed value (undo, playhead move) replaces a stale draft.
  useEffect(() => setDraft(null), [value]);

  const commitText = (text: string): void => {
    setDraft(null);
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) return;
    const next = clamp(parsed, min, max);
    if (next !== value) onCommit(next);
  };

  const shownValue = scrubbing ?? value;

  return (
    <InspectorRow label={label} name={name} keyframe={keyframe}>
      <span className="mask-number" data-disabled={disabled || undefined}>
        <span
          className="mask-number-scrub"
          aria-hidden="true"
          title="Drag to change"
          onPointerDown={(event) => {
            if (disabled) return;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* capture is an optimisation */
            }
            scrub.current = { startX: event.clientX, startValue: value, latest: value };
          }}
          onPointerMove={(event) => {
            const active = scrub.current;
            if (active === null) return;
            const next = clamp(
              active.startValue + (event.clientX - active.startX) * step,
              min,
              max,
            );
            active.latest = next;
            setScrubbing(next);
            onLive?.(next);
          }}
          onPointerUp={() => {
            const active = scrub.current;
            scrub.current = null;
            setScrubbing(null);
            onLive?.(null);
            if (active !== null && active.latest !== active.startValue) onCommit(active.latest);
          }}
        >
          ↔
        </span>
        <input
          type="number"
          className="mask-number-input tabular"
          aria-label={name}
          disabled={disabled}
          step={step}
          {...(min === undefined ? {} : { min })}
          {...(max === undefined ? {} : { max })}
          value={draft ?? shown(shownValue)}
          onChange={(event) => {
            // Spinner arrows change by exactly one step: commit them; typing waits for Enter.
            const native = event.nativeEvent as InputEvent;
            if (native.inputType === undefined || native.inputType === '') {
              commitText(event.target.value);
              return;
            }
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitText((event.target as HTMLInputElement).value);
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft(null);
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const factor = event.shiftKey ? 10 : 1;
              const next = clamp(
                value + (event.key === 'ArrowUp' ? step : -step) * factor,
                min,
                max,
              );
              if (next !== value) onCommit(next);
            }
          }}
          onBlur={(event) => {
            if (draft !== null) commitText(event.target.value);
          }}
        />
        {unit !== undefined && <span className="scrub-unit">{unit}</span>}
      </span>
    </InspectorRow>
  );
}
