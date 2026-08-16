/**
 * Diff preview popup (product ask #3) — a focused, premium review surface for a
 * proposed AI edit, opened from a diff card's "Show preview".
 *
 * Unlike the inline before/after strip it replaces, this popup lets the editor
 * work change-by-change: the left rail lists every operation in the edit (each a
 * plain-language line — "Removed 0:04–0:06", "Trimmed Intro"), and the reviewer
 * can KEEP or REMOVE each one independently. The right stage previews exactly the
 * kept set — before vs. the timeline with only the kept changes applied — via the
 * same real {@link AiReviewPlayer} (HTML-video, render-vs-preview rule), seeked to
 * whichever change is selected so playback starts ON the edit, never at 0:00.
 *
 * Invariant safety (AGENTS.md invariant 5): "Apply kept" never half-applies a
 * patch. It re-assembles a BRAND-NEW validated patch from only the kept operations
 * via {@link assembleEdit} and applies that atomically. A kept subset that can't
 * stand on its own (e.g. a trim that depended on a removed split) fails validation
 * and is surfaced honestly — the timeline is never left inconsistent.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { assembleEdit, describeOperation } from '@framepilot/ai-sdk';
import type { DiffNode, Reference } from '@framepilot/ai-sdk';
import type { AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { toReviewCard } from '../../editor/ai.js';
import { AiReviewPlayer } from '../AiReviewPlayer.js';
import { ChevronRight, ICON_SIZE, X } from '../icons.js';
import { Tooltip } from '../Tooltip.js';
import type { RevealHandler } from './EventNode.js';
import { useModalFocusTrap } from './useModalFocusTrap.js';

/** Format seconds as a familiar `m:ss` timecode for change labels. */
function timecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** The timeline position an operation touches, for seeking preview to the change. */
function operationStart(op: AnyOperation): number | undefined {
  const record = op as unknown as Record<string, unknown>;
  for (const key of ['start', 'toStart', 'atTime', 'time'] as const) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/** Nothing is ever removed now; a shared frozen empty set keeps the memos stable. */
const EMPTY_REMOVED: ReadonlySet<number> = new Set<number>();

export interface DiffPreviewModalProps {
  readonly node: DiffNode;
  readonly project: Project;
  readonly fps: number;
  /**
   * `review` (default) lists every change with the before/after player; `compare` opens
   * on one change from a chip. Both are read-only: the edit is already on the timeline by
   * the time this can be opened, so there is nothing here to accept or discard.
   */
  readonly variant?: 'review' | 'compare';
  /** Which change to select/seek to on open (e.g. the clicked chip's op). */
  readonly initialSelected?: number;
  readonly onClose: () => void;
  /** Reveal the change in the editor (select clip) — see the parent's reveal wiring. */
  readonly onReveal?: RevealHandler;
  /** Move the editor playhead to a timeline position (Jump to timeline). */
  readonly onSeek?: (seconds: number) => void;
}

/** The change-by-change preview + review popup for a proposed edit. */
export function DiffPreviewModal({
  node,
  project,
  fps,
  variant = 'review',
  initialSelected = 0,
  onClose,
  onReveal,
  onSeek,
}: DiffPreviewModalProps): JSX.Element {
  const ops = node.edit.patch.operations;
  const descriptors = useMemo(() => ops.map((op) => describeOperation(op)), [ops]);
  const opStarts = useMemo(() => ops.map((op) => operationStart(op)), [ops]);

  const [selected, setSelected] = useState(initialSelected);
  // Always read-only. The keep/remove-a-subset surface belonged to a review step that no
  // longer exists: edits apply as they land, so by the time this opens there is nothing to
  // decide — only something to look at. Undo is how an edit is taken back.
  const removed: ReadonlySet<number> = EMPTY_REMOVED;
  const isCompare = variant === 'compare';

  const keptOps = useMemo<AnyOperation[]>(
    () => ops.filter((_, i) => !removed.has(i)),
    [ops, removed],
  );

  // Re-assemble a NEW validated patch from only the kept ops (invariant-safe apply,
  // and the exact before/after the reviewer is about to commit). Recomputed as the
  // reviewer toggles changes so the preview always matches the pending selection.
  const keptEdit = useMemo(
    () => (keptOps.length > 0 ? assembleEdit(project, keptOps, node.edit.patch.reason) : null),
    [project, keptOps, node.edit.patch.reason],
  );
  const card = keptEdit ? toReviewCard(keptEdit) : null;
  const canPreview = Boolean(card?.before && card?.after);

  const selectedStart = opStarts[selected];
  const firstRef: Reference | undefined = descriptors.flatMap((d) => d.refs)[0];

  // Close on Escape, matching the app's other dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // D3b: trap focus inside the modal (Tab/Shift+Tab wrap, no escape to the page
  // behind it), move focus in on open, and return it to the trigger on close.
  const modalRef = useModalFocusTrap<HTMLDivElement>();


  const jumpToTimeline = (): void => {
    if (firstRef) onReveal?.(firstRef);
    const start = selectedStart ?? opStarts.find((s) => s !== undefined);
    if (start !== undefined) onSeek?.(start);
    onClose();
  };

  const keptCount = keptOps.length;
  const totalCount = ops.length;

  return createPortal(
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={modalRef}
        className="ai-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Review changes"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ai-preview-head">
          <span className="ai-preview-title">
            {isCompare ? 'Before / after' : 'Review changes'}
          </span>
          <span className="ai-preview-sub">
            {isCompare ? 'Original vs. this edit' : 'Applied to your timeline'}
          </span>
          <Tooltip label="Close">
            <button type="button" className="ai-icon-action" aria-label="Close" onClick={onClose}>
              <X size={ICON_SIZE.sm} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>

        <div className="ai-preview-body">
          <ul className="ai-preview-oplist" role="list" aria-label="Changes in this edit">
            {descriptors.map((descriptor, index) => {
              const isRemoved = removed.has(index);
              const isSelected = selected === index;
              const start = opStarts[index];
              return (
                <li
                  key={index}
                  className="ai-preview-op"
                  data-removed={isRemoved}
                  data-selected={isSelected}
                >
                  <button
                    type="button"
                    className="ai-preview-op-main"
                    aria-current={isSelected}
                    onClick={() => setSelected(index)}
                  >
                    <ChevronRight
                      size={ICON_SIZE.sm}
                      aria-hidden="true"
                      className="ai-preview-op-caret"
                    />
                    <span className="ai-preview-op-text">
                      <span className="ai-preview-op-action">{descriptor.action}</span>
                      {start !== undefined && (
                        <span className="ai-preview-op-time">{timecode(start)}</span>
                      )}
                      {descriptor.detail && (
                        <span className="ai-preview-op-detail">{descriptor.detail}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="ai-preview-stage">
            {keptCount === 0 ? (
              <div className="ai-preview-empty">
                <p>No changes kept.</p>
                <p className="ai-preview-empty-sub">
                  Keep at least one change to preview and apply it.
                </p>
              </div>
            ) : canPreview ? (
              <AiReviewPlayer
                // Remount only when the KEPT SET changes (new before/after); a plain
                // selection change re-seeks live via `startAt` without a remount.
                key={keptCount === totalCount ? 'all' : [...removed].sort().join(',')}
                before={card!.before!}
                after={card!.after!}
                changedRegions={card!.changedRegions}
                assets={project.assets}
                fps={fps}
                {...(selectedStart !== undefined ? { startAt: selectedStart } : {})}
              />
            ) : (
              <div className="ai-preview-empty">
                <p>This selection can’t be applied.</p>
                {card?.problems.length ? (
                  <ul className="ai-preview-problems">
                    {card.problems.map((problem, i) => (
                      <li key={i}>{problem}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="ai-preview-empty-sub">
                    Some kept changes depend on ones you removed. Keep them together to apply.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="ai-preview-foot">
          <span className="ai-preview-hint">
            These changes are on your timeline — use Undo to revert them.
          </span>
          <div className="ai-preview-actions">
            <button type="button" className="ai-btn" onClick={jumpToTimeline}>
              Jump to timeline
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
