/**
 * Right-click context menu for a **track header** — the track-scope counterpart
 * to {@link ClipContextMenu} (which is clip-scope and says nothing about lanes).
 *
 * It exists because the header had no way to *remove* a lane at all: the header
 * buttons toggle flags, drag reorders, and "Add track" only ever inserts at the
 * front of the stack. Deleting a lane, and inserting one at a specific slot, were
 * simply unreachable.
 *
 * Like every other menu here it only builds patches — validate→apply→record runs
 * through `useEditor`, so removing a lane with clips on it is one undoable step
 * (`remove_layer` inverts to an `add_layer` carrying the clips back).
 *
 * Closes on action, outside click, or Escape.
 */
import { useEffect, useRef } from 'react';
import type { Track } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { addLayerPatch, removeLayerPatch } from '../editor/patch-builders.js';
import { ArrowDown, ArrowUp, ICON_SIZE, Trash2 } from './icons.js';

/** Where the menu opened, and on which track. */
export interface TrackMenuTarget {
  readonly trackId: string;
  readonly x: number;
  readonly y: number;
}

export interface TrackContextMenuProps {
  readonly editor: UseEditor;
  readonly target: TrackMenuTarget;
  readonly onClose: () => void;
}

export function TrackContextMenu({
  editor,
  target,
  onClose,
}: TrackContextMenuProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const { timeline } = editor.state;

  // Focus on mount, restore on unmount — same contract as the clip menu, and for
  // the same reason: a `role="menu"` nothing can focus is a menu no keyboard user
  // can enter, and one that drops focus at the top of the document on close.
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Close on any outside pointer press or Escape (same contract as the clip menu).
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

  // Index into `timeline.tracks`, NOT into the view's `visibleTracks`: the lane
  // list is filtered (empty non-`layer_` tracks are hidden), so a view index would
  // insert the new lane in the wrong z-order slot whenever one is filtered out.
  const index = timeline.tracks.findIndex((t) => t.id === target.trackId);
  const track: Track | undefined = timeline.tracks[index];
  // The track vanished between the right-click and this render (an undo, or an AI
  // patch landing). Rendering a menu whose actions all resolve to `null` would be
  // a dead menu, so close instead.
  if (!track) return null;

  const act = (patch: ReturnType<typeof removeLayerPatch>): void => {
    if (patch) editor.applyPatch(patch);
    onClose();
  };

  // Index 0 is the visual FRONT, so "above" (visually on top) is the lower index.
  const addAt = (at: number): void => act(addLayerPatch(timeline, track.type, at));

  const clipCount = track.clips.length + (track.effectLayers?.length ?? 0);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="track actions"
      tabIndex={-1}
      style={{ left: target.x, top: target.y }}
    >
      <button type="button" role="menuitem" onClick={() => addAt(index)}>
        <ArrowUp size={ICON_SIZE.sm} aria-hidden="true" /> Add track above
      </button>
      <button type="button" role="menuitem" onClick={() => addAt(index + 1)}>
        <ArrowDown size={ICON_SIZE.sm} aria-hidden="true" /> Add track below
      </button>
      <div className="context-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={() => act(removeLayerPatch(timeline, track.id))}
      >
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
        {/* Say what goes with it: a lane's contents are not visible from the header
            once it is collapsed, and delete is the one action here that takes
            something away. Undo restores the clips, so no confirmation step. */}
        {clipCount > 0
          ? `Delete track (${clipCount} item${clipCount === 1 ? '' : 's'})`
          : 'Delete track'}
      </button>
    </div>
  );
}
