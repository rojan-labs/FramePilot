import type { ButtonHTMLAttributes } from 'react';
import './tokens.css';
import './primitives.css';

export interface SwitchProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'type' | 'role' | 'aria-checked' | 'aria-label' | 'onChange' | 'onClick'
  > {
  readonly checked: boolean;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
}

/**
 * Accessible binary switch used across editor preference surfaces.
 *
 * The primitive owns switch semantics and state classes. Feature components own
 * the surrounding label/hint layout so Settings, toolbars, and future panels can
 * place the same control without reimplementing its interaction contract.
 */
export function Switch({
  checked,
  label,
  onCheckedChange,
  className,
  disabled,
  ...rest
}: SwitchProps): JSX.Element {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-ui="switch"
      data-state={checked ? 'on' : 'off'}
      className={`switch${checked ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheckedChange(!checked);
      }}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
