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
  /**
   * The chord to advertise, normally `hintFor('<shortcut id>')` so the glyphs come
   * from the registry and are right on Windows/Linux as well as macOS. `null` is
   * accepted (and renders nothing) because that is what `hintFor` returns for an
   * id the registry does not carry.
   */
  readonly shortcut?: string | null;
  readonly children: ReactElement;
  readonly placement?: TooltipPlacement;
  readonly delay?: number;
}

interface Coords {
  readonly top: number;
  readonly left: number;
  readonly transform: string;
}

/** Keep-clear margin from the window edge, used by both the flip and the clamp. */
const VIEWPORT_MARGIN = 8;
/**
 * Bubble height assumed on the first positioning pass, before it has been laid
 * out and can be measured. One line of tooltip text plus its padding; only ever
 * used to decide a flip, where being a few pixels out changes nothing.
 */
const ASSUMED_BUBBLE_H = 28;

/**
 * Flip a `top` bubble below its anchor when there is no room above it.
 *
 * A control in the 44px application bar sits ~14px from the window's top edge,
 * so a bubble drawn upward from it lands off-screen — the reason the topbar's
 * own controls each pass `placement="bottom"` by hand. Anything portalled INTO
 * that bar (the monitor's view controls) cannot know it is there, so the
 * decision belongs here, where the anchor rect is already in hand.
 *
 * Only `top` flips. `left`/`right` are asked for to avoid covering something
 * specific, and turning them into a `bottom` would defeat that.
 */
function resolvePlacement(
  rect: DOMRect,
  placement: TooltipPlacement,
  bubbleHeight: number,
): TooltipPlacement {
  if (placement !== 'top') return placement;
  return rect.top - GAP - bubbleHeight < VIEWPORT_MARGIN ? 'bottom' : 'top';
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

  // WCAG 1.4.13 (Content on Hover or Focus): a tooltip must be dismissable
  // without moving the pointer or the focus. `.tooltip` is `pointer-events: none`,
  // so a bubble covering the thing underneath it could not even be moved out of
  // the way — Escape was the only exit and nothing listened for it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, hide]);

  // Position the bubble from the anchor rect once it opens (and keep it pinned
  // while scrolling/resizing so it tracks the control).
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = bubbleRef.current?.offsetHeight ?? ASSUMED_BUBBLE_H;
      setCoords(placeAt(rect, resolvePlacement(rect, placement, height)));
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
    const leftEdge = coords.left - width / 2;
    const rightEdge = coords.left + width / 2;
    if (leftEdge < VIEWPORT_MARGIN) setShiftX(VIEWPORT_MARGIN - leftEdge);
    else if (rightEdge > window.innerWidth - VIEWPORT_MARGIN)
      setShiftX(window.innerWidth - VIEWPORT_MARGIN - rightEdge);
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
