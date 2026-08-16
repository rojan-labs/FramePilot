/**
 * Select — token-styled dropdown primitive (master-prompt §4).
 *
 * A keyboard-operable listbox replacing bare `<select>` elements so dropdowns
 * match the design system (and can show icons + shortcut hints + a check on the
 * active option, which native `<option>` cannot). Presentational only: the parent
 * owns `value` and decides what a change means.
 *
 * Accessibility: a `combobox` trigger controls a `listbox` popover of `option`s;
 * the active option carries `aria-selected`. Arrow/Home/End move the highlight,
 * Enter/Space commit, Escape closes, and an outside press dismisses (mirrors
 * {@link Menu}). Typeahead jumps to options by first letter.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Check, ChevronDown, ICON_SIZE } from './icons.js';

/** Fixed-position coordinates for the portaled popover. */
interface PopoverCoords {
  readonly top: number;
  readonly left: number;
  readonly minWidth: number;
}

/** Gap between trigger and popover, and the viewport safe margin (px). */
const POPOVER_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Position the popover in viewport coordinates from the trigger rect and the
 * measured popover size. Opens on the preferred side, **auto-flips** when that
 * side lacks room, and **clamps** to the viewport so it is never off-screen — the
 * fix for the orientation menu rendering behind the preview / off the edge.
 */
function positionPopover(
  trigger: DOMRect,
  popover: { width: number; height: number },
  prefer: 'down' | 'up',
): PopoverCoords {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - trigger.bottom;
  const spaceAbove = trigger.top;
  const needed = popover.height + POPOVER_GAP + VIEWPORT_MARGIN;

  let up = prefer === 'up';
  // Flip only when the preferred side can't fit but the opposite side is roomier.
  if (up && spaceAbove < needed && spaceBelow > spaceAbove) up = false;
  else if (!up && spaceBelow < needed && spaceAbove > spaceBelow) up = true;

  const rawTop = up ? trigger.top - POPOVER_GAP - popover.height : trigger.bottom + POPOVER_GAP;
  const maxTop = Math.max(VIEWPORT_MARGIN, vh - popover.height - VIEWPORT_MARGIN);
  const top = Math.min(Math.max(rawTop, VIEWPORT_MARGIN), maxTop);

  const width = Math.max(popover.width, trigger.width);
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(trigger.left, VIEWPORT_MARGIN), maxLeft);

  return { top, left, minWidth: trigger.width };
}

export interface SelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  /** Optional leading glyph. */
  readonly icon?: ReactNode;
  /** Optional trailing hint (e.g. a keyboard shortcut). */
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly SelectOption<T>[];
  /** Accessible name for the trigger. */
  readonly label: string;
  /** Shown when no option matches `value`. */
  readonly placeholder?: string;
  readonly id?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  /**
   * Direction the option list opens. `down` (default) is normal; `up` opens above
   * the trigger — required when the Select is docked at the bottom of a region so
   * the menu is not clipped/covered by lower-stacked chrome (e.g. the timeline).
   */
  readonly popoverPlacement?: 'down' | 'up';
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  label,
  placeholder = 'Select…',
  id,
  className,
  disabled,
  popoverPlacement = 'down',
}: SelectProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  const close = useCallback(() => setOpen(false), []);
  const openMenu = useCallback(() => {
    const current = options.findIndex((o) => o.value === value);
    setActive(current >= 0 ? current : 0);
    setOpen(true);
  }, [options, value]);

  // Dismiss on outside press while open (same contract as Menu). The popover is
  // PORTALED to document.body (so no ancestor's overflow/stacking can clip or cover
  // it — the "menu renders behind the preview" bug), so an outside press must also
  // exclude the popover itself, not just the trigger's root.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Position (and keep positioning) the portaled popover from the trigger rect
  // while open. Measured after mount so the height feeds the flip/clamp decision;
  // re-runs on scroll/resize so it stays pinned to the trigger.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const reposition = (): void => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const size = {
        width: popover?.offsetWidth ?? rect.width,
        height: popover?.offsetHeight ?? 0,
      };
      setCoords(positionPopover(rect, size, popoverPlacement));
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, popoverPlacement, options.length]);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      setOpen(false);
    },
    [onChange, options],
  );

  /** Step the highlight to the next non-disabled option in `dir`. */
  const move = useCallback(
    (dir: 1 | -1) => {
      setActive((current) => {
        const n = options.length;
        for (let step = 1; step <= n; step += 1) {
          const next = (current + dir * step + n * step) % n;
          if (!options[next]?.disabled) return next;
        }
        return current;
      });
    },
    [options],
  );

  const onTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!open) {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openMenu();
        }
        return;
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'Home':
          event.preventDefault();
          setActive(0);
          break;
        case 'End':
          event.preventDefault();
          setActive(options.length - 1);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          commit(active);
          break;
        case 'Escape':
          event.preventDefault();
          setOpen(false);
          break;
        default:
          // Typeahead: jump to the first option whose label starts with the key.
          if (event.key.length === 1) {
            const idx = options.findIndex((o) =>
              o.label.toLowerCase().startsWith(event.key.toLowerCase()),
            );
            if (idx >= 0) setActive(idx);
          }
      }
    },
    [active, commit, move, open, openMenu, options],
  );

  const activeId = useMemo(() => `${listId}-opt-${active}`, [listId, active]);

  return (
    <div className={`select ${className ?? ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className="select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        aria-activedescendant={open ? activeId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select-value">
          {selected?.icon && (
            <span className="select-value-icon" aria-hidden="true">
              {selected.icon}
            </span>
          )}
          <span className="select-value-label">{selected ? selected.label : placeholder}</span>
        </span>
        <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" className="select-caret" />
      </button>
      {open &&
        createPortal(
          <ul
            ref={popoverRef}
            id={listId}
            role="listbox"
            className="select-popover select-popover--portal"
            aria-label={label}
            style={{
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              minWidth: coords?.minWidth,
              // Hide until the first measure lands so it never flashes at (0,0).
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={`select-option${index === active ? ' is-active' : ''}${
                  option.disabled ? ' is-disabled' : ''
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(index)}
              >
                {option.icon && (
                  <span className="select-option-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                )}
                <span className="select-option-label">{option.label}</span>
                {option.hint && <span className="select-option-hint">{option.hint}</span>}
                <span className="select-option-check" aria-hidden="true">
                  {option.value === value && <Check size={ICON_SIZE.sm} />}
                </span>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
