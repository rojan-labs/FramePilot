/**
 * On-canvas editor for the selected text overlay (#5).
 *
 * Overlays the program monitor with an interactive box for the active, selected
 * text clip. The user can:
 *  - **move** it (drag the box) → updates xPercent/yPercent,
 *  - **resize its width** (drag a side handle) → updates boxWidthPercent; the text
 *    wraps within the box,
 *  - **edit the text** (double-click → contentEditable) → commits on blur/Enter.
 *
 * Geometry is percent-based against the preview frame (the box's offset parent),
 * so a drag maps 1:1 to the stored percent params regardless of the frame's pixel
 * size. Every change is committed through the same reversible `setTextParamsPatch`
 * the Inspector uses — no second mutation path. Nothing here writes the project
 * directly (invariant 5); it calls back with a params patch.
 */
import { useEffect, useRef, useState } from 'react';
import type { TextOverlayParams } from '../editor/patch-builders.js';
import { textOverlayStyle } from '../editor/textOverlay.js';

export interface PreviewTextEditorProps {
  readonly params: TextOverlayParams;
  readonly timeInClip: number;
  readonly duration: number;
  /** Commit a params change (one reversible edit). */
  readonly onCommit: (patch: Partial<TextOverlayParams>) => void;
}

type Drag =
  | {
      readonly kind: 'move';
      readonly startX: number;
      readonly startY: number;
      readonly baseX: number;
      readonly baseY: number;
    }
  | {
      readonly kind: 'resize';
      readonly startX: number;
      readonly baseWidth: number;
      readonly dir: 1 | -1;
    };

/** Clamp a percent into [min, max]. */
const clampPct = (v: number, min = 0, max = 100): number => Math.min(max, Math.max(min, v));

export function PreviewTextEditor({
  params,
  timeInClip,
  duration,
  onCommit,
}: PreviewTextEditorProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // Live override during a drag so the box tracks the pointer before the commit.
  const [live, setLive] = useState<Partial<TextOverlayParams> | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const shown: TextOverlayParams = { ...params, ...live };

  /** The frame rect the box is positioned within (its offset parent). */
  const frameRect = (): DOMRect | null =>
    boxRef.current?.offsetParent?.getBoundingClientRect() ?? null;

  const onPointerMove = (event: PointerEvent): void => {
    const drag = dragRef.current;
    const rect = frameRect();
    if (!drag || !rect) return;
    if (drag.kind === 'move') {
      const dxPct = ((event.clientX - drag.startX) / rect.width) * 100;
      const dyPct = ((event.clientY - drag.startY) / rect.height) * 100;
      setLive({ xPercent: clampPct(drag.baseX + dxPct), yPercent: clampPct(drag.baseY + dyPct) });
    } else {
      // Dragging a side handle changes width symmetrically about the centre, so the
      // box grows/shrinks around its anchor. `dir` makes both handles feel natural.
      const dPct = ((event.clientX - drag.startX) / rect.width) * 100 * 2 * drag.dir;
      setLive({ boxWidthPercent: clampPct(drag.baseWidth + dPct, 5, 100) });
    }
  };

  const endDrag = (): void => {
    if (dragRef.current && live) onCommit(live);
    dragRef.current = null;
    setLive(null);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  };

  const beginMove = (event: React.PointerEvent): void => {
    if (editing) return;
    event.preventDefault();
    dragRef.current = {
      kind: 'move',
      startX: event.clientX,
      startY: event.clientY,
      baseX: params.xPercent,
      baseY: params.yPercent,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  };

  const beginResize = (event: React.PointerEvent, dir: 1 | -1): void => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      kind: 'resize',
      startX: event.clientX,
      baseWidth: params.boxWidthPercent,
      dir,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  };

  // Focus the editable region when entering edit mode.
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      // Place the caret at the end.
      const range = document.createRange();
      range.selectNodeContents(editRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  const commitText = (): void => {
    const next = editRef.current?.textContent ?? params.text;
    setEditing(false);
    if (next !== params.text) onCommit({ text: next });
  };

  const style = textOverlayStyle(shown, timeInClip, duration);
  // While editing/selected the box is fully opaque and interactive regardless of the
  // animation phase, so the user always sees what they are editing.
  const editStyle = { ...style, opacity: 1, pointerEvents: 'auto' as const };

  return (
    <div
      ref={boxRef}
      className={`preview-text-edit${editing ? ' is-editing' : ''}`}
      style={editStyle}
      onPointerDown={beginMove}
      onDoubleClick={() => setEditing(true)}
      role="group"
      aria-label="edit text overlay"
    >
      <div
        ref={editRef}
        className="preview-text-edit-content"
        contentEditable={editing}
        suppressContentEditableWarning
        aria-label="text overlay content"
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            commitText();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setEditing(false);
          }
        }}
      >
        {params.text}
      </div>
      {!editing && (
        <>
          <span
            className="preview-text-handle preview-text-handle--l"
            aria-label="resize text width left"
            onPointerDown={(event) => beginResize(event, -1)}
          />
          <span
            className="preview-text-handle preview-text-handle--r"
            aria-label="resize text width right"
            onPointerDown={(event) => beginResize(event, 1)}
          />
        </>
      )}
    </div>
  );
}
