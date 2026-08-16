/**
 * Checkbox — token-styled custom checkbox (master-prompt §4; user request: no
 * native-looking controls).
 *
 * Uses the accessible custom-control pattern: a real `<input type="checkbox">` is
 * kept (visually hidden) so the control stays fully keyboard-operable (Tab + Space)
 * and screen-reader correct, while a custom box renders the on-brand check. The
 * visible label is the children.
 */
import type { ReactNode } from 'react';
import { Check, ICON_SIZE } from './icons.js';

export interface CheckboxProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Accessible name for the control (when the visible children aren't enough). */
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly children?: ReactNode;
}

export function Checkbox({
  checked,
  onChange,
  ariaLabel,
  disabled,
  id,
  children,
}: CheckboxProps): JSX.Element {
  return (
    <label className={`checkbox${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        id={id}
        className="checkbox-native"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox-box" aria-hidden="true">
        <Check size={ICON_SIZE.sm} />
      </span>
      {children && <span className="checkbox-label">{children}</span>}
    </label>
  );
}
