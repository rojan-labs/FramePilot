/**
 * Project history panel (the "edit reel").
 *
 * A right-side drawer that lists every committed edit — manual and AI — end to
 * end, as a vertical timeline the user can scrub. Clicking any node time-travels
 * the project to that point via {@link UseEditor.goto} (which folds the tested
 * undo/redo primitives, so a jump can never produce an invalid state).
 *
 * It is a pure *view* over the store's history: it reads `editor.history`
 * (entries + cursor) and reconstructs the intermediate states for the hover
 * before/after preview by folding each entry's already-stored `patch`/`inverse`
 * — no re-inversion, no store mutation. Author (you vs AI), the patch `reason`,
 * per-operation labels/chips (via the AI layer's {@link describeOperation}), and
 * a relative timestamp make each edit legible at a glance.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyProjectPatch,
  diffTimeline,
  type EditHistory,
  type HistoryEntry,
} from '@framepilot/editor-core';
import { describeOperation, projectNames, type ProjectNames } from '@framepilot/ai-sdk';
import type { AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { Tooltip } from './Tooltip.js';
import {
  ArrowLeftRight,
  Captions,
  Crop,
  Film,
  Flag,
  Folder,
  FolderPlus,
  Gauge,
  ICON_SIZE,
  Image as ImageIcon,
  Layers,
  ListX,
  Palette,
  Pencil,
  RotateCcw,
  Scan,
  Scissors,
  SkipBack,
  SkipForward,
  Sparkles,
  Type as TypeIcon,
  Undo2,
  Redo2,
  Volume2,
  Wand2,
  X,
} from './icons.js';

/** Who a patch came from — drives the author badge + the You/AI filter. */
type Author = 'user' | 'agent';

/** The three history filters. */
type Filter = 'all' | 'user' | 'agent';

export interface HistoryPanelProps {
  readonly editor: UseEditor;
  /** The app-level project — merged with the store's live slices to name ids. */
  readonly project: Project;
  readonly open: boolean;
  readonly onClose: () => void;
}

/** Icon per operation type, so the reel reads at a glance. */
function opIcon(type: string): JSX.Element {
  const size = ICON_SIZE.sm;
  switch (type) {
    case 'trim_clip':
    case 'split_clip':
      return <Scissors size={size} aria-hidden="true" />;
    case 'delete_range':
    case 'ripple_delete':
      return <ListX size={size} aria-hidden="true" />;
    case 'move_clip':
    case 'move_layer':
      return <ArrowLeftRight size={size} aria-hidden="true" />;
    case 'add_clip':
      return <Film size={size} aria-hidden="true" />;
    case 'add_text_overlay':
      return <TypeIcon size={size} aria-hidden="true" />;
    case 'add_caption_layer':
    case 'set_caption_style':
      return <Captions size={size} aria-hidden="true" />;
    case 'apply_color_grade':
      return <Palette size={size} aria-hidden="true" />;
    case 'adjust_audio':
      return <Volume2 size={size} aria-hidden="true" />;
    case 'add_transition':
      return <ArrowLeftRight size={size} aria-hidden="true" />;
    case 'add_mask':
    case 'track_object':
      return <Scan size={size} aria-hidden="true" />;
    case 'set_clip_speed':
      return <Gauge size={size} aria-hidden="true" />;
    case 'set_clip_crop':
      return <Crop size={size} aria-hidden="true" />;
    case 'set_clip_blend_mode':
    case 'add_layer':
    case 'remove_layer':
      return <Layers size={size} aria-hidden="true" />;
    case 'add_asset':
      return <ImageIcon size={size} aria-hidden="true" />;
    case 'create_folder':
      return <FolderPlus size={size} aria-hidden="true" />;
    case 'rename_folder':
      return <Pencil size={size} aria-hidden="true" />;
    case 'move_folder':
    case 'move_asset':
      return <Folder size={size} aria-hidden="true" />;
    case 'add_marker':
    case 'remove_marker':
      return <Flag size={size} aria-hidden="true" />;
    case 'restore_clips':
      return <RotateCcw size={size} aria-hidden="true" />;
    default:
      return <Wand2 size={size} aria-hidden="true" />;
  }
}

/** A compact "2m ago" style timestamp; falls back to "earlier" for unstamped entries. */
function relativeTime(committedAt: number | undefined, now: number): string {
  if (committedAt === undefined) return 'earlier';
  const secs = Math.max(0, Math.round((now - committedAt) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * The project with exactly `target` edits applied, folded from the current state.
 *
 * Only ever asked for the row the pointer is on, which is why it folds to ONE
 * position instead of materialising them all. It used to reconstruct every cursor
 * position into an array of `entries.length + 1` complete projects, inside a memo
 * keyed on the live project — so a value read for a single hovered row was rebuilt,
 * in full, on every committed edit, and every intermediate project stayed resident
 * until the next rebuild. During an AI run that is quadratic work and hundreds of
 * retained project graphs, and the panel is mounted (its `open` check comes after
 * the hooks) even when the user has never opened it, so it was paid whether or not
 * anything could see the result.
 *
 * Pure — never touches the store. Returns `null` if a fold throws (a defensive
 * guard; the stored patches applied cleanly once already).
 */
function stateAt(
  entries: readonly HistoryEntry[],
  current: Project,
  cursor: number,
  target: number,
): Project | null {
  let state = current;
  try {
    // Undo back toward `target`, or redo forward to it — whichever side it is on.
    for (let c = cursor; c > target; c--) {
      state = applyProjectPatch(state, entries[c - 1]!.inverse);
    }
    for (let c = cursor; c < target; c++) {
      state = applyProjectPatch(state, entries[c]!.patch);
    }
  } catch {
    return null;
  }
  return state;
}

/** Reference chips for an operation, resolved to friendly names. */
function OpChips({ op, names }: { op: AnyOperation; names: ProjectNames }): JSX.Element | null {
  const { refs } = describeOperation(op, names);
  if (refs.length === 0) return null;
  return (
    <span className="hist-chips">
      {refs.map((ref) => (
        <span key={`${ref.kind}:${ref.id}`} className="hist-chip" data-kind={ref.kind}>
          {ref.label}
        </span>
      ))}
    </span>
  );
}

interface RowProps {
  readonly entry: HistoryEntry;
  readonly index: number;
  readonly applied: boolean;
  readonly current: boolean;
  readonly names: ProjectNames;
  readonly now: number;
  readonly beforeAfter: readonly string[] | null;
  readonly onJump: (cursor: number) => void;
  readonly onHover: (index: number | null) => void;
}

function EditRow({
  entry,
  index,
  applied,
  current,
  names,
  now,
  beforeAfter,
  onJump,
  onHover,
}: RowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const ops = entry.patch.operations;
  const primary = ops[0];
  const author: Author = entry.patch.createdBy;
  const label = primary ? describeOperation(primary, names).action : 'Edit';
  const extra = ops.length - 1;

  return (
    <li
      className="hist-row"
      data-applied={applied}
      data-current={current}
      data-author={author}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="hist-rail" aria-hidden="true">
        <span className="hist-dot" />
      </span>
      <div className="hist-body">
        <button
          type="button"
          className="hist-jump"
          onClick={() => onJump(index + 1)}
          title={applied ? 'Jump to this point' : 'Redo to this point'}
        >
          <span className="hist-icon">{opIcon(primary?.type ?? '')}</span>
          <span className="hist-main">
            <span className="hist-label">
              {label}
              {primary && <OpChips op={primary} names={names} />}
            </span>
            <span className="hist-sub">
              <span className="hist-author-badge" data-author={author}>
                {author === 'agent' ? (
                  <>
                    <Sparkles size={12} aria-hidden="true" /> AI
                  </>
                ) : (
                  'You'
                )}
              </span>
              <span className="hist-time">{relativeTime(entry.committedAt, now)}</span>
              {extra > 0 && <span className="hist-count">+{extra} more</span>}
            </span>
          </span>
        </button>
        {author === 'agent' && entry.patch.reason && (
          <p className="hist-reason">{entry.patch.reason}</p>
        )}
        {extra > 0 && (
          <button
            type="button"
            className="hist-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide' : `Show all ${ops.length} operations`}
          </button>
        )}
        {expanded && (
          <ul className="hist-ops">
            {ops.map((op, i) => {
              const d = describeOperation(op, names);
              return (
                <li key={i} className="hist-op">
                  <span className="hist-op-icon">{opIcon(op.type)}</span>
                  <span className="hist-op-label">{d.action}</span>
                  {d.detail && <span className="hist-op-detail">{d.detail}</span>}
                  <OpChips op={op} names={names} />
                </li>
              );
            })}
          </ul>
        )}
        {beforeAfter && beforeAfter.length > 0 && (
          <div className="hist-diff" role="note">
            {beforeAfter.slice(0, 4).map((line, i) => (
              <span key={i} className="hist-diff-line">
                {line}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export function HistoryPanel({
  editor,
  project,
  open,
  onClose,
}: HistoryPanelProps): JSX.Element | null {
  const history: EditHistory = editor.history;
  const { entries, cursor } = history;
  const [filter, setFilter] = useState<Filter>('all');
  const [hovered, setHovered] = useState<number | null>(null);
  // A stable "now" per open so relative times don't churn every render.
  const nowRef = useRef<number>(Date.now());
  useEffect(() => {
    if (open) nowRef.current = Date.now();
  }, [open, entries.length, cursor]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Merge the app project with the store's live slices so id→name resolution and
  // state reconstruction see the *current* timeline/bin.
  const currentProject = useMemo<Project>(
    () => ({
      ...project,
      timeline: editor.state.timeline,
      assets: editor.state.assets as Project['assets'],
      folders: editor.state.folders as Project['folders'],
      markers: editor.state.markers as Project['markers'],
    }),
    [
      project,
      editor.state.timeline,
      editor.state.assets,
      editor.state.folders,
      editor.state.markers,
    ],
  );
  const names = useMemo(() => projectNames(currentProject), [currentProject]);

  // Folded on demand for the hovered row only — see `stateAt`. `after` is one more
  // step from `before`, so the pair costs one extra apply rather than a second fold.
  const beforeAfterFor = (index: number): readonly string[] | null => {
    const before = stateAt(entries, currentProject, cursor, index);
    if (!before) return null;
    try {
      const after = applyProjectPatch(before, entries[index]!.patch);
      return diffTimeline(before.timeline, after.timeline).summary;
    } catch {
      return null;
    }
  };

  if (!open) return null;

  const canJumpStart = cursor > 0;
  const canJumpEnd = cursor < entries.length;
  const now = nowRef.current;

  return (
    <>
      <div className="history-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="history-panel" role="dialog" aria-label="Project history">
        <header className="history-head">
          <h2 className="history-title">History</h2>
          <Tooltip label="Close history" shortcut="Esc" placement="bottom">
            <button
              type="button"
              className="history-close"
              aria-label="Close history"
              onClick={onClose}
            >
              <X size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>

        <div className="history-controls">
          <div className="history-nav" role="group" aria-label="history navigation">
            <Tooltip label="Jump to start" placement="bottom">
              <button
                type="button"
                className="history-btn"
                aria-label="Jump to start"
                onClick={() => editor.goto(0)}
                disabled={!canJumpStart}
              >
                <SkipBack size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Undo" shortcut="⌘Z" placement="bottom">
              <button
                type="button"
                className="history-btn"
                aria-label="Undo"
                onClick={editor.undo}
                disabled={!editor.canUndo}
              >
                <Undo2 size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Redo" shortcut="⌘⇧Z" placement="bottom">
              <button
                type="button"
                className="history-btn"
                aria-label="Redo"
                onClick={editor.redo}
                disabled={!editor.canRedo}
              >
                <Redo2 size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Jump to latest" placement="bottom">
              <button
                type="button"
                className="history-btn"
                aria-label="Jump to latest"
                onClick={() => editor.goto(entries.length)}
                disabled={!canJumpEnd}
              >
                <SkipForward size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
          <div className="history-filters" role="group" aria-label="filter by author">
            {(['all', 'user', 'agent'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className="history-chip"
                data-active={filter === f}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'user' ? 'You' : 'AI'}
              </button>
            ))}
          </div>
        </div>

        <div className="history-scroll">
          {entries.length === 0 ? (
            <div className="history-empty">
              <Sparkles size={ICON_SIZE.md} aria-hidden="true" />
              <p className="history-empty-title">No edits yet</p>
              <p className="history-empty-sub">
                Every change you make is saved here and fully reversible.
              </p>
            </div>
          ) : (
            <ol className="hist-reel">
              <li className="hist-row hist-origin" data-applied="true" data-current={cursor === 0}>
                <span className="hist-rail" aria-hidden="true">
                  <span className="hist-dot" />
                </span>
                <div className="hist-body">
                  <button
                    type="button"
                    className="hist-jump"
                    onClick={() => editor.goto(0)}
                    title="Jump to the original"
                  >
                    <span className="hist-icon">
                      <RotateCcw size={ICON_SIZE.sm} aria-hidden="true" />
                    </span>
                    <span className="hist-main">
                      <span className="hist-label">Project opened</span>
                      <span className="hist-sub">
                        <span className="hist-time">the starting point</span>
                      </span>
                    </span>
                  </button>
                </div>
              </li>
              {entries.map((entry, index) => {
                const author: Author = entry.patch.createdBy;
                if (filter !== 'all' && filter !== author) return null;
                return (
                  <EditRow
                    key={entry.patch.patchId}
                    entry={entry}
                    index={index}
                    applied={index < cursor}
                    current={index === cursor - 1}
                    names={names}
                    now={now}
                    beforeAfter={hovered === index ? beforeAfterFor(index) : null}
                    onJump={(target) => editor.goto(target)}
                    onHover={setHovered}
                  />
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </>
  );
}
