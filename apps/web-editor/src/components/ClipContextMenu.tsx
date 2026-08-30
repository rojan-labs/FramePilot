/**
 * Right-click context menu for a clip (plan 3.4 Part 4, PROMPT §8). Exposes the
 * same patch actions as the toolbar/keyboard — split, trim to playhead, speed,
 * transition, duplicate, delete, ripple delete — each committed through
 * `useEditor` (validate→apply→record). It only builds patches; it never mutates
 * the timeline directly.
 *
 * UX-08 found the menu thin: split, duplicate and the two deletes, on a surface
 * where a right-click is the fastest route to anything. The trims, the speed
 * presets, the transition and "Reveal in bin" close that — each of them an
 * action that already existed somewhere else in the app and cost a trip to
 * another panel to reach.
 *
 * Every entry is gated on the patch builder actually returning a patch, so the
 * menu never offers an edit that would be refused: no trim when the playhead is
 * outside the clip, no transition when nothing follows it on the track.
 *
 * Closes on action, outside click, or Escape.
 */
import { useEffect, useRef, type JSX } from 'react';
import type { UseEditor } from '../editor/useEditor.js';
import {
  addTransitionPatch,
  deleteClipPatch,
  duplicateClipPatch,
  rippleDeleteClipPatch,
  setClipSpeedPatch,
  splitClipPatch,
  trimClipPatch,
} from '../editor/patch-builders.js';
import {
  ArrowLeftRight,
  Copy,
  Gauge,
  ICON_SIZE,
  ListX,
  Scissors,
  Search,
  Sparkles,
  Trash2,
} from './icons.js';
import { MenuShortcut } from './Menu.js';

/** Where the menu opened, and on which clip. */
export interface ClipMenuTarget {
  readonly clipId: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The speed presets the menu offers directly.
 *
 * Deliberately short: the Inspector owns the full control (and speed ramps).
 * These are the rates an editor reaches for without thinking, and having them
 * one click from the clip is the whole point of the finding.
 */
const SPEED_PRESETS: readonly number[] = [0.5, 1, 1.5, 2];

export interface ClipContextMenuProps {
  readonly editor: UseEditor;
  readonly target: ClipMenuTarget;
  readonly onClose: () => void;
  /**
   * Point-react-refine trigger (P13.3): "Ask AI about this clip" opens the same
   * command palette used by ⌘K, pre-scoped to this clip.
   */
  readonly onAskAi?: (clipId: string) => void;
  /**
   * Open the transition picker at this cut (UX-08). Absent on hosts with no
   * picker — the entry simply is not offered rather than being offered dead.
   */
  readonly onAddTransition?: (clipId: string, x: number, y: number) => void;
  /**
   * Show the clip's source footage in the media bin (UX-08). Absent where there
   * is no bin (the AI review player, tests that render the timeline alone).
   */
  readonly onRevealInBin?: (assetId: string) => void;
}

export function ClipContextMenu({
  editor,
  target,
  onClose,
  onAskAi,
  onAddTransition,
  onRevealInBin,
}: ClipContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { timeline, playhead } = editor.state;

  // Focus the menu on mount and give focus back to whatever opened it on unmount.
  // It has declared `role="menu"` since it was written and could not be entered
  // from the keyboard at all — which matters here more than anywhere, because the
  // clip's ⋯ control opens this menu with Shift+F10 and had nowhere to send you.
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

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

  const clip = timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === target.clipId);
  const canSplit = splitClipPatch(timeline, target.clipId, playhead) !== null;
  // A trim only means something while the playhead is inside the clip; outside
  // it, "trim start to playhead" would either be a no-op or delete the clip.
  const playheadInside = clip !== undefined && playhead > clip.start && playhead < clip.end;
  const canTransition = addTransitionPatch(timeline, target.clipId, 'crossfade') !== null;
  const speed = clip?.speed ?? 1;

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="clip actions"
      tabIndex={-1}
      style={{ left: target.x, top: target.y }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!canSplit}
        onClick={() => act(splitClipPatch(timeline, target.clipId, playhead))}
      >
        <Scissors size={ICON_SIZE.sm} aria-hidden="true" /> Split at playhead
        <MenuShortcut shortcutId="edit.split" />
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!playheadInside}
        onClick={() => clip && act(trimClipPatch(timeline, target.clipId, playhead, clip.end))}
      >
        <Scissors size={ICON_SIZE.sm} aria-hidden="true" /> Trim start to playhead
        <MenuShortcut shortcutId="edit.trimIn" />
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!playheadInside}
        onClick={() => clip && act(trimClipPatch(timeline, target.clipId, clip.start, playhead))}
      >
        <Scissors size={ICON_SIZE.sm} aria-hidden="true" /> Trim end to playhead
        <MenuShortcut shortcutId="edit.trimOut" />
      </button>
      <div className="context-menu-sep" role="separator" />
      <div className="context-menu-group" role="group" aria-label="Speed">
        <span className="context-menu-group-label">
          <Gauge size={ICON_SIZE.sm} aria-hidden="true" /> Speed
        </span>
        <div className="context-menu-choices">
          {SPEED_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="menuitemradio"
              aria-checked={speed === preset}
              onClick={() =>
                act(setClipSpeedPatch(timeline, target.clipId, preset === 1 ? null : preset))
              }
            >
              {`${String(preset)}×`}
            </button>
          ))}
        </div>
      </div>
      {onAddTransition && (
        <button
          type="button"
          role="menuitem"
          disabled={!canTransition}
          onClick={() => {
            onAddTransition(target.clipId, target.x, target.y);
            onClose();
          }}
        >
          <ArrowLeftRight size={ICON_SIZE.sm} aria-hidden="true" /> Add transition
        </button>
      )}
      {onRevealInBin && clip?.assetId !== undefined && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onRevealInBin(clip.assetId);
            onClose();
          }}
        >
          <Search size={ICON_SIZE.sm} aria-hidden="true" /> Reveal in bin
        </button>
      )}
      <div className="context-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        onClick={() => act(duplicateClipPatch(timeline, target.clipId))}
      >
        <Copy size={ICON_SIZE.sm} aria-hidden="true" /> Duplicate
        <MenuShortcut shortcutId="edit.duplicate" />
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => act(deleteClipPatch(timeline, target.clipId))}
      >
        <Trash2 size={ICON_SIZE.sm} aria-hidden="true" /> Delete
        <MenuShortcut shortcutId="edit.delete" />
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => act(rippleDeleteClipPatch(timeline, target.clipId))}
      >
        <ListX size={ICON_SIZE.sm} aria-hidden="true" /> Ripple delete
        <MenuShortcut shortcutId="edit.ripple" />
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
