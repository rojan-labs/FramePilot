/**
 * Tooltip — the app-wide styled tooltip primitive (master-prompt §2 / §4).
 *
 * Wraps a single interactive child (typically an icon-only button) and reveals a
 * token-styled bubble on hover or keyboard focus after a short delay, optionally
 * showing the action's keyboard shortcut. Replaces native `title=` so every
 * icon-only action gets a consistent, on-brand hint (`--bg-elevated`, 200–400ms).
 *
 * The bubble is rendered in a **portal on `document.body` with fixed positioning**
 * computed from the anchor's rect, so it can never be clipped by an ancestor's
 * `overflow` or hidden behind a neighbouring panel's stacking context (the bug in
 * the rail headers / track lanes). The wrapping anchor — not the child — owns the
 * hover/focus listeners, so the tooltip still appears for **disabled** controls.
 * Motion is opacity/transform only and gated by `prefers-reduced-motion`.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement, ReactNode } from 'react';

/** Default reveal delay (ms) — within the spec's 200–400ms band. */
const DEFAULT_DELAY = 250;
/** Gap (px) between the anchor and the bubble. */
const GAP = 8;

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipInfoProps {
  /** The control's name/terminology — what the button is called (kept short). */
  readonly term: ReactNode;
  /** A plain-language explanation of what the control actually does, in terms
   *  of the editor's effect on the project — not a restatement of its name. */
  readonly children: ReactNode;
}

/**
 * A two-line {@link Tooltip} label: the terminology on top, a user-centric
 * "what this actually does" line underneath. Use for any timeline control
 * whose name alone (e.g. "Ripple delete", "Solo track") doesn't tell a new
 * editor what will happen when they click it.
 */
export function TooltipInfo({ term, children }: TooltipInfoProps): JSX.Element {
  return (
    <>
      <span className="tooltip-term">{term}</span>
      <span className="tooltip-info">{children}</span>
    </>
  );
}

export interface TooltipProps {
  readonly label: ReactNode;
  readonly shortcut?: string;
  readonly children: ReactElement;
  readonly placement?: TooltipPlacement;
  readonly delay?: number;
}

interface Coords {
  readonly top: number;
  readonly left: number;
  readonly transform: string;
}

/** Compute fixed coordinates for the bubble from the anchor rect + placement. */
function placeAt(rect: DOMRect, placement: TooltipPlacement): Coords {
  switch (placement) {
    case 'bottom':
      return {
        top: rect.bottom + GAP,
        left: rect.left + rect.width / 2,
        transform: 'translateX(-50%)',
      };
    case 'left':
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - GAP,
        transform: 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + GAP,
        transform: 'translateY(-50%)',
      };
    case 'top':
    default:
      return {
        top: rect.top - GAP,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, -100%)',
      };
  }
}

export function Tooltip({
  label,
  shortcut,
  children,
  placement = 'top',
  delay = DEFAULT_DELAY,
}: TooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const show = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [clear, delay]);
  const hide = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  // Position the bubble from the anchor rect once it opens (and keep it pinned
  // while scrolling/resizing so it tracks the control).
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setCoords(placeAt(rect, placement));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, placement]);

  // Clamp a top/bottom-placed bubble horizontally so a wide label (help/info text)
  // centred on an anchor near the viewport edge never runs off-screen. Computed from
  // the measured bubble width + the anchor centre (both position-independent), so it
  // converges in a single pre-paint pass with no jitter.
  const [shiftX, setShiftX] = useState(0);
  useLayoutEffect(() => {
    if (!open || !coords || (placement !== 'top' && placement !== 'bottom')) {
      setShiftX(0);
      return;
    }
    const width = bubbleRef.current?.offsetWidth ?? 0;
    const margin = 8;
    const leftEdge = coords.left - width / 2;
    const rightEdge = coords.left + width / 2;
    if (leftEdge < margin) setShiftX(margin - leftEdge);
    else if (rightEdge > window.innerWidth - margin)
      setShiftX(window.innerWidth - margin - rightEdge);
    else setShiftX(0);
  }, [open, coords, placement, label, shortcut]);

  const child = cloneElement(children, {
    'aria-describedby': open ? id : children.props['aria-describedby'],
  });

  return (
    <span
      ref={anchorRef}
      className="tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {child}
      {open &&
        coords &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            id={id}
            className={`tooltip tooltip--${placement}`}
            style={{ top: coords.top, left: coords.left + shiftX, transform: coords.transform }}
          >
            <span className="tooltip-label">{label}</span>
            {shortcut && <kbd className="tooltip-kbd">{shortcut}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
