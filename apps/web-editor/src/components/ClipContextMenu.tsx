/**
 * Right-click context menu for a clip (plan 3.4 Part 4, PROMPT §8). Exposes the
 * same patch actions as the toolbar/keyboard — split, duplicate, delete, ripple
 * delete — each committed through `useEditor` (validate→apply→record). It only
 * builds patches; it never mutates the timeline directly.
 *
 * Closes on action, outside click, or Escape.
 */
import { useEffect, useRef } from 'react';
import type { UseEditor } from '../editor/useEditor.js';
import {
  deleteClipPatch,
  duplicateClipPatch,
  rippleDeleteClipPatch,
  splitClipPatch,
} from '../editor/patch-builders.js';
import { Copy, ICON_SIZE, ListX, Scissors, Sparkles, Trash2 } from './icons.js';

/** Where the menu opened, and on which clip. */
export interface ClipMenuTarget {
  readonly clipId: string;
  readonly x: number;
  readonly y: number;
}

export interface ClipContextMenuProps {
  readonly editor: UseEditor;
  readonly target: ClipMenuTarget;
  readonly onClose: () => void;
  /**
   * Point-react-refine trigger (P13.3): "Ask AI about this clip" opens the same
   * command palette used by ⌘K, pre-scoped to this clip.
   */
  readonly onAskAi?: (clipId: string) => void;
}

export function ClipContextMenu({
  editor,
  target,
  onClose,
  onAskAi,
}: ClipContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { timeline, playhead } = editor.state;

  // Close on any outside pointer press or Escape.
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const act = (patch: ReturnType<typeof splitClipPatch>): void => {
    if (patch) editor.applyPatch(patch);
    onClose();
  };

  const canSplit = splitClipPatch(timeline, target.clipId, playhead) !== null;

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="clip actions"
      style={{ left: target.x, top: target.y }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!canSplit}
        onClick={() => act(splitClipPatch(timeline, target.clipId, playhead))}
      >
        <Scissors size={ICON_SIZE.sm} aria-hidden="true" /> Split at playhead
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => act(duplicateClipPatch(timeline, target.clipId))}
      >
        <Copy size={ICON_SIZE.sm} aria-hidden="true" /> Duplicate
      </button>
      <div className="context-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={() => act(deleteClipPatch(timeline, target.clipId))}
      >
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" /> Delete
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => act(rippleDeleteClipPatch(timeline, target.clipId))}
      >
        <ListX size={ICON_SIZE.sm} aria-hidden="true" /> Ripple delete
      </button>
      {onAskAi && (
        <>
          <div className="context-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAskAi(target.clipId);
              onClose();
            }}
          >
            <Sparkles size={ICON_SIZE.sm} aria-hidden="true" /> Ask AI about this clip
          </button>
        </>
      )}
    </div>
  );
}
