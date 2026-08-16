/**
 * @framepilot/ui/Button — token-driven button primitive.
 *
 * The package owns both its semantic attributes and its baseline presentation;
 * hosts may refine layout at higher specificity without reimplementing states.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './tokens.css';
import './primitives.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** Control density. Defaults to `md`. */
  readonly size?: ButtonSize;
  /**
   * Show a spinner and block interaction without collapsing the button's width
   * (the label stays in layout, just hidden). Implies `disabled`.
   */
  readonly loading?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      <span className="btn-label">{children}</span>
    </button>
  );
}
