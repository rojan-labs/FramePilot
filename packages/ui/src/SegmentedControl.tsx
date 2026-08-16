import type { ReactNode } from 'react';
import './tokens.css';
import './primitives.css';

export interface SegmentedControlOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly options: readonly SegmentedControlOption<T>[];
  readonly label: string;
  readonly onValueChange: (value: T) => void;
  readonly className?: string;
}

/**
 * Single-select compact choice group.
 *
 * Uses pressed-button semantics because every option is an immediately applied
 * editor preference rather than a page tab.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  label,
  onValueChange,
  className,
}: SegmentedControlProps<T>): JSX.Element {
  return (
    <div
      className={`segmented${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      data-ui="segmented-control"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={value === option.value ? 'is-active' : ''}
          disabled={option.disabled}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
