/**
 * @framepilot/ui/Input — token-driven text-input primitive.
 *
 * A leading `icon` renders inside the field. Native input props pass through so
 * hosts keep full form behavior while presentation remains owned by the package.
 */
import {
  forwardRef,
  type ForwardRefExoticComponent,
  type InputHTMLAttributes,
  type PropsWithoutRef,
  type ReactNode,
  type RefAttributes,
} from 'react';
import './tokens.css';
import './primitives.css';

export type InputSize = 'sm' | 'md';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Control density. Defaults to `md`. */
  readonly uiSize?: InputSize;
  /** Optional leading adornment (e.g. a search icon) rendered inside the field. */
  readonly icon?: ReactNode;
}

/**
 * React 19-style refs include `null` in the ref object's generic parameter.
 * Expose that shape while retaining the same runtime forwardRef implementation,
 * so strict consumers can pass `useRef<HTMLInputElement | null>(null)` safely.
 */
type InputComponent = ForwardRefExoticComponent<
  PropsWithoutRef<InputProps> & RefAttributes<HTMLInputElement | null>
>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { uiSize = 'md', icon, className, ...rest },
  ref,
): JSX.Element {
  const input = (
    <input ref={ref} data-ui="input" data-size={uiSize} className={className} {...rest} />
  );
  if (!icon) return input;
  return (
    <span data-ui="input-wrap" data-size={uiSize}>
      <span data-ui="input-icon" aria-hidden="true">
        {icon}
      </span>
      {input}
    </span>
  );
}) as InputComponent;
