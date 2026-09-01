/**
 * Editor toolbar (plan/PLAN.md Phase 3.2 — trim/split/delete/ripple/zoom/markers
 * + undo/redo). Thin: every editing button builds a patch with the pure
 * `patch-builders` and routes it through the editor store; nothing mutates the
 * timeline directly.
 *
 * Grouped by *scope*, not proximity (TIMELINE-TOOLBAR-REORG): Tools (which
 * click behavior is active) → Clip actions (act on the selection/playhead) →
 * Markers → Edit mode (placement + ripple-on-delete) → History → view/zoom
 * (snap toggle, zoom-to-fit, zoom slider, zoom step). One row, no second
 * floating toolbar above the ruler. Export lives in the header only — it is a
 * project-level action, not a timeline one, so it does not appear here.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@framepilot/ui';
import type { UseEditor } from '../editor/useEditor.js';
import type { EditMode } from '../editor/useEditMode.js';
import { hintFor, type Tool } from '../editor/shortcuts.js';
import { Tooltip, TooltipInfo } from './Tooltip.js';
import { Menu, MenuItem } from './Menu.js';
import {
  deleteClipPatch,
  duplicateClipsPatch,
  rippleDeleteClipPatch,
  splitClipPatch,
} from '../editor/patch-builders.js';
import { KeyframeMenuItem, KeyframeToolbarButton } from './timeline/KeyframeToolbarControl.js';
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND } from '../editor/store.js';
import {
  Bookmark,
  Copy,
  ICON_SIZE,
  ListX,
  Magnet,
  Maximize2,
  MoreHorizontal,
  MousePointer2,
  Redo2,
  Repeat,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from './icons.js';

const ZOOM_STEP = 1.5;
/**
 * Toolbar container widths (px) below which the least-used groups fold into
 * the `⋯ More` menu instead of wrapping to a second row (TIMELINE-TOOLBAR-REORG).
 * Markers goes first (single, infrequent action); Clip actions follows only
 * once things are genuinely tight.
 */
const COLLAPSE_MARKERS_PX = 760;
const COLLAPSE_CLIP_ACTIONS_PX = 620;

export interface ToolbarProps {
  readonly editor: UseEditor;
  /** Current edit-mode (overwrite | insert). Rendered as a segmented toggle. */
  readonly editMode?: EditMode;
  /** Called when the user switches edit mode in the toolbar. */
  readonly onSetEditMode?: (mode: EditMode) => void;
  /** Whether Ripple-delete is on (Delete closes the gap). */
  readonly rippleOnDelete?: boolean;
  /** Toggle the ripple-delete flag. */
  readonly onToggleRippleOnDelete?: () => void;
  /** The active timeline tool (Selection | Blade). Defaults to `'select'`. */
  readonly tool?: Tool;
  /** Switch the active tool. */
  readonly onSetTool?: (tool: Tool) => void;
  /** Whether magnetic snapping is on (the same setting the Settings dialog edits). */
  readonly snapping?: boolean;
  /** Toggle magnetic snapping. */
  readonly onToggleSnapping?: () => void;
}

export function Toolbar({
  editor,
  editMode,
  onSetEditMode,
  rippleOnDelete,
  onToggleRippleOnDelete,
  tool = 'select',
  onSetTool,
  snapping,
  onToggleSnapping,
}: ToolbarProps): JSX.Element {
  const { state } = editor;
  // `playhead` is read via `editor.getPlayhead()` in the handlers below (not from
  // render state), so this component can be memoised out of the per-seek render
  // path (perf slice 1b, plan Phase 12.1) without going stale on split/marker.
  const { selection, pxPerSecond, timeline } = state;
  const hasSelection = selection !== null;

  // Overflow: below COLLAPSE_MARKERS_PX the Markers group folds into `⋯ More`;
  // below COLLAPSE_CLIP_ACTIONS_PX, Clip actions joins it too. Never wraps to a
  // second row (TIMELINE-TOOLBAR-REORG).
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = rootRef.current;
    // Some test environments (jsdom) have no ResizeObserver — degrade to
    // "always full width" (no collapsing) rather than crash.
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const collapseMarkers = width < COLLAPSE_MARKERS_PX;
  const collapseClipActions = width < COLLAPSE_CLIP_ACTIONS_PX;

  const split = (): void => {
    /* v8 ignore next */
    if (!selection) return;
    const patch = splitClipPatch(timeline, selection, editor.getPlayhead());
    if (patch) editor.applyPatch(patch);
  };

  const remove = (): void => {
    /* v8 ignore next */
    if (!selection) return;
    const patch = deleteClipPatch(timeline, selection);
    if (patch) editor.applyPatch(patch);
  };

  const rippleRemove = (): void => {
    /* v8 ignore next */
    if (!selection) return;
    const patch = rippleDeleteClipPatch(timeline, selection);
    if (patch) editor.applyPatch(patch);
  };

  const duplicate = (): void => {
    /* v8 ignore next */
    if (!selection) return;
    const patch = duplicateClipsPatch(timeline, editor.state.selectedIds);
    if (patch) editor.applyPatch(patch);
  };

  const zoomToFit = (): void => {
    // Decoupled from wherever the timeline view lives (same event the `⇧Z`
    // shortcut dispatches) — see `useEditorShortcuts`'s `requestZoom`.
    window.dispatchEvent(new CustomEvent('framepilot:zoom', { detail: 'fit' }));
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="editor tools" ref={rootRef}>
      <div className="toolbar-group" role="radiogroup" aria-label="Tools">
        <Tooltip
          label={
            <TooltipInfo term="Selection tool">
              Click and drag clips to select, move, or trim them — the default way to work on the
              timeline.
            </TooltipInfo>
          }
          shortcut={hintFor('tool.select')}
        >
          <Button
            variant="ghost"
            className={`icon-btn${tool === 'select' ? ' is-active' : ''}`}
            type="button"
            role="radio"
            aria-checked={tool === 'select'}
            aria-label="Selection tool"
            onClick={() => onSetTool?.('select')}
          >
            <MousePointer2 size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip
          label={
            <TooltipInfo term="Blade tool">
              Click any point on a clip to cut it into two separate clips right there — stays on
              until you switch back to Selection.
            </TooltipInfo>
          }
          shortcut={hintFor('tool.blade')}
        >
          <Button
            variant="ghost"
            className={`icon-btn${tool === 'blade' ? ' is-active' : ''}`}
            type="button"
            role="radio"
            aria-checked={tool === 'blade'}
            aria-label="Blade tool"
            onClick={() => onSetTool?.('blade')}
          >
            <Scissors size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>

      {collapseClipActions ? (
        <div className="toolbar-group" role="group" aria-label="More tools">
          <Menu
            label="More tools"
            className="toolbar-more-menu"
            trigger={<MoreHorizontal size={ICON_SIZE.sm} aria-hidden="true" />}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Scissors size={ICON_SIZE.sm} aria-hidden="true" />}
                  disabled={!hasSelection}
                  onSelect={() => {
                    split();
                    close();
                  }}
                >
                  Split at playhead
                </MenuItem>
                <KeyframeMenuItem
                  editor={editor}
                  timeline={timeline}
                  selectedIds={editor.state.selectedIds}
                  onSelected={close}
                />
                <MenuItem
                  icon={<Trash2 size={ICON_SIZE.sm} aria-hidden="true" />}
                  disabled={!hasSelection}
                  onSelect={() => {
                    remove();
                    close();
                  }}
                >
                  Delete
                </MenuItem>
                <MenuItem
                  icon={<ListX size={ICON_SIZE.sm} aria-hidden="true" />}
                  disabled={!hasSelection}
                  onSelect={() => {
                    rippleRemove();
                    close();
                  }}
                >
                  Ripple delete
                </MenuItem>
                <MenuItem
                  icon={<Copy size={ICON_SIZE.sm} aria-hidden="true" />}
                  disabled={!hasSelection}
                  onSelect={() => {
                    duplicate();
                    close();
                  }}
                >
                  Duplicate
                </MenuItem>
                <MenuItem
                  icon={<Bookmark size={ICON_SIZE.sm} aria-hidden="true" />}
                  onSelect={() => {
                    editor.toggleMarker(editor.getPlayhead());
                    close();
                  }}
                >
                  Add marker
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      ) : (
        <>
          <div className="toolbar-group" role="group" aria-label="Clip actions">
            <Tooltip
              label={
                <TooltipInfo term="Split at playhead">
                  Cuts the selected clip into two separate clips exactly where the playhead is, so
                  you can edit or remove just one part.
                </TooltipInfo>
              }
              shortcut={hintFor('edit.split')}
            >
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Split"
                onClick={split}
                disabled={!hasSelection}
              >
                <Scissors size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
            <KeyframeToolbarButton
              editor={editor}
              timeline={timeline}
              selectedIds={editor.state.selectedIds}
            />
            <Tooltip
              label={
                <TooltipInfo term="Delete clip">
                  Removes the selected clip and leaves a gap behind — clips after it don't move. Use
                  Ripple delete if you want the gap closed automatically.
                </TooltipInfo>
              }
              shortcut={hintFor('edit.delete')}
            >
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Delete"
                onClick={remove}
                disabled={!hasSelection}
              >
                <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip
              label={
                <TooltipInfo term="Ripple delete">
                  Removes the selected clip and shifts everything after it backward to close the
                  gap, so your timeline stays continuous.
                </TooltipInfo>
              }
              shortcut={hintFor('edit.ripple')}
            >
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Ripple delete"
                onClick={rippleRemove}
                disabled={!hasSelection}
              >
                <ListX size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip
              label={
                <TooltipInfo term="Duplicate clip">
                  Places a copy of the selected clip right after it on the same track.
                </TooltipInfo>
              }
              shortcut={hintFor('edit.duplicate')}
            >
              <Button
                variant="ghost"
                className="icon-btn"
                type="button"
                aria-label="Duplicate"
                onClick={duplicate}
                disabled={!hasSelection}
              >
                <Copy size={ICON_SIZE.sm} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>

          {collapseMarkers ? (
            <div className="toolbar-group" role="group" aria-label="More tools">
              <Menu
                label="More tools"
                className="toolbar-more-menu"
                trigger={<MoreHorizontal size={ICON_SIZE.sm} aria-hidden="true" />}
              >
                {(close) => (
                  <MenuItem
                    icon={<Bookmark size={ICON_SIZE.sm} aria-hidden="true" />}
                    onSelect={() => {
                      editor.toggleMarker(editor.getPlayhead());
                      close();
                    }}
                  >
                    Add marker
                  </MenuItem>
                )}
              </Menu>
            </div>
          ) : (
            <div className="toolbar-group" role="group" aria-label="Markers">
              <Tooltip
                label={
                  <TooltipInfo term="Add marker">
                    Drops a marker at the playhead position — a bookmark you can jump back to later,
                    useful for flagging a spot to revisit.
                  </TooltipInfo>
                }
                shortcut={hintFor('marker.toggle')}
              >
                <Button
                  variant="ghost"
                  className="icon-btn"
                  type="button"
                  aria-label="Marker"
                  onClick={() => editor.toggleMarker(editor.getPlayhead())}
                >
                  <Bookmark size={ICON_SIZE.sm} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
          )}
        </>
      )}

      {onSetEditMode && editMode !== undefined && (
        <div className="toolbar-group toolbar-edit-mode" role="group" aria-label="Edit mode">
          <div className="segmented segmented-xs" role="group" aria-label="Drop mode">
            <button
              type="button"
              className={editMode === 'overwrite' ? 'is-active' : ''}
              aria-pressed={editMode === 'overwrite'}
              title="Overwrite — dropped clips land where they fall"
              onClick={() => onSetEditMode('overwrite')}
            >
              Overwrite
            </button>
            <button
              type="button"
              className={editMode === 'insert' ? 'is-active' : ''}
              aria-pressed={editMode === 'insert'}
              title="Insert — dropped clips push downstream clips right"
              onClick={() => onSetEditMode('insert')}
            >
              Insert
            </button>
          </div>
          {onToggleRippleOnDelete && (
            <Tooltip
              label={
                <TooltipInfo term="Ripple on delete — Delete closes the gap (Shift inverts)">
                  When this is on, deleting a clip automatically shifts everything after it backward
                  to close the gap. Hold Shift while deleting to do the opposite just for that one
                  action.
                </TooltipInfo>
              }
            >
              <button
                type="button"
                className={`timeline-tool${rippleOnDelete ? ' is-active' : ''}`}
                aria-label="Ripple on delete"
                aria-pressed={rippleOnDelete}
                onClick={onToggleRippleOnDelete}
              >
                <Repeat size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      )}

      <div className="toolbar-group toolbar-group--end" role="group" aria-label="History">
        <Tooltip
          label={
            <TooltipInfo term="Undo">
              Reverses your last edit. You can undo multiple times to step back through your edit
              history.
            </TooltipInfo>
          }
          shortcut={hintFor('history.undo')}
        >
          <Button
            variant="ghost"
            className="icon-btn"
            type="button"
            aria-label="Undo"
            onClick={editor.undo}
            disabled={!editor.canUndo}
          >
            <Undo2 size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip
          label={<TooltipInfo term="Redo">Re-applies an edit you just undid.</TooltipInfo>}
          shortcut={hintFor('history.redo')}
        >
          <Button
            variant="ghost"
            className="icon-btn"
            type="button"
            aria-label="Redo"
            onClick={editor.redo}
            disabled={!editor.canRedo}
          >
            <Redo2 size={ICON_SIZE.sm} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>

      <div className="toolbar-group" role="group" aria-label="View and zoom">
        {onToggleSnapping && (
          <Tooltip
            label={
              <TooltipInfo term="Snapping — clips and the playhead snap to nearby edges">
                While on, dragging or trimming snaps to nearby clip edges, markers, and the
                playhead. Hold Alt to invert this for one gesture.
              </TooltipInfo>
            }
            shortcut={hintFor('view.snapToggle')}
          >
            <button
              type="button"
              className={`timeline-tool${snapping ? ' is-active' : ''}`}
              aria-label="Snapping"
              aria-pressed={snapping}
              onClick={onToggleSnapping}
            >
              <Magnet size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={
            <TooltipInfo term="Zoom to fit">
              Resizes the timeline view so your whole project — first clip to last — fits on screen
              at once.
            </TooltipInfo>
          }
          shortcut={hintFor('view.zoomFit')}
        >
          <button
            type="button"
            className="timeline-tool"
            aria-label="Zoom to fit"
            onClick={zoomToFit}
          >
            <Maximize2 size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </Tooltip>
        <button
          type="button"
          className="timeline-tool"
          aria-label="zoom out"
          onClick={() => editor.setZoom(pxPerSecond / ZOOM_STEP)}
        >
          <ZoomOut size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
        <input
          type="range"
          className="toolbar-zoom-slider"
          aria-label="timeline zoom"
          min={MIN_PX_PER_SECOND}
          max={MAX_PX_PER_SECOND}
          step={1}
          value={pxPerSecond}
          onChange={(event) => editor.setZoom(Number(event.target.value))}
        />
        <button
          type="button"
          className="timeline-tool"
          aria-label="zoom in"
          onClick={() => editor.setZoom(pxPerSecond * ZOOM_STEP)}
        >
          <ZoomIn size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
