/**
 * Right-click menu for an effect layer (schema v13, ADR 0088).
 *
 * The three actions a layer has that are not drags: duplicate, bypass, delete.
 * Move and trim are the pointer gestures on the chip itself, and parameter
 * changes live in the Inspector — a menu of sliders would be the wrong surface.
 *
 * Kept separate from `ClipContextMenu` because that component is built around a
 * clip target (split, speed, crop, fades, transitions, "ask AI about this clip");
 * an effect layer shares none of those actions, so reusing it would mean rendering
 * a menu that is mostly disabled.
 */
import { useEffect, useRef } from 'react';
import { Copy, EyeOff, ICON_SIZE, Trash2 } from './icons.js';

export type EffectMenuAction = 'duplicate' | 'toggle' | 'remove';

export interface EffectLayerMenuProps {
  readonly x: number;
  readonly y: number;
  /** Current bypass state, so the toggle names the action it performs. */
  readonly disabled: boolean;
  readonly onAction: (action: EffectMenuAction) => void;
  readonly onClose: () => void;
}

export function EffectLayerMenu({
  x,
  y,
  disabled,
  onAction,
  onClose,
}: EffectLayerMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Focus the menu so Escape and arrow keys reach it without a click, and so a
    // keyboard user is not stranded on the timeline behind an open menu.
    ref.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // `capture` so a dismiss happens before the timeline's own pointer handlers
    // start a drag underneath the menu.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      // `.context-menu`, like the clip and track menus: `.clip-menu` is not a class
      // any stylesheet defines, so this rendered as bare buttons over the timeline.
      className="context-menu"
      role="menu"
      aria-label="effect layer actions"
      tabIndex={-1}
      // Clamped into the viewport so a right-click near the right or bottom edge
      // does not open the menu off-screen.
      style={{
        position: 'fixed',
        left: `${Math.min(x, Math.max(0, globalThis.innerWidth - 200))}px`,
        top: `${Math.min(y, Math.max(0, globalThis.innerHeight - 140))}px`,
      }}
    >
      <button type="button" role="menuitem" onClick={() => onAction('duplicate')}>
        <Copy size={ICON_SIZE.sm} aria-hidden="true" />
        Duplicate
      </button>
      <button type="button" role="menuitem" onClick={() => onAction('toggle')}>
        <EyeOff size={ICON_SIZE.sm} aria-hidden="true" />
        {/* Names the ACTION, not the state — a bypassed layer offers "Enable". */}
        {disabled ? 'Enable' : 'Bypass'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="is-destructive"
        onClick={() => onAction('remove')}
      >
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
        Delete
      </button>
    </div>
  );
}
