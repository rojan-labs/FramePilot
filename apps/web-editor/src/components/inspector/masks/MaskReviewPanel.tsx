/**
 * The review list every measured mask shares (BR6.5, plan 05 "NEEDS_REVIEW").
 *
 * A background removal and a mask track both come back with the moments the measurement itself
 * flagged, and an editor clears them the same way, so there is ONE panel rather than two that
 * drift. `subject` decides which command the approval compiles to (`review_matte` or
 * `review_mask_track`); everything else — the list, the keys, the badge — is identical.
 *
 * The rules that make this a precision tool rather than a progress bar:
 *
 * - **VERIFIED is earned.** The badge appears only when nothing is flagged: every frame either
 *   passed the pipeline's own checks or was approved by the editor. It is never shown because a
 *   job merely finished.
 * - **Approving is one reversible edit**, like any other change to the project.
 * - **A brush stroke is a draft.** It paints nothing until [Apply fix] stores it as a correction
 *   input and re-runs the affected window, so an unapplied stroke cannot change a frame of output.
 * - **No correction path needs a mouse.** Looks right, Lock and the range keys work from the
 *   keyboard; the brush is the only pointer-only tool, and it is never the only way through.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { assetDisplaySize } from '@framepilot/editor-core';
import type { Clip, MaskLayer } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';
import { COMPUTE_SECONDS_PER_FOOTAGE_SECOND_1080P, createLogger } from '@framepilot/shared-types';
import type { UseEditor } from '../../../editor/useEditor.js';
import { getBridge } from '../../../editor/bridge.js';
import {
  clipSourceTimeAt,
  clipTimelineTimeForSource,
  runMaskCommand,
} from '../../../editor/mask-editing.js';
import { encodeGrayPng, paintCorrection } from './matteCorrectionPng.js';
import { formatDuration } from './matteEstimate.js';
import { reviewReasonFor } from './matteReviewReasons.js';
import { matteJobStore, type MatteJobStore } from './matteJobStore.js';
import { maskToolStore, useMaskTools, type MaskToolStore } from './useMaskTools.js';

const log = createLogger('web-editor:mask-review');

/** Source seconds kept either side of a fixed moment when the window is re-run. */
const FIX_WINDOW_PADDING_SECONDS = 0.5;

export interface Range {
  readonly start: number;
  readonly end: number;
}

const sameRange = (a: Range, b: Range): boolean => a.start === b.start && a.end === b.end;

const seconds = (value: number): string => `${value.toFixed(2)}s`;

export interface MaskReviewPanelProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly mask: MaskLayer;
  /** Which measurement is being reviewed. */
  readonly subject: 'matte' | 'tracking';
  readonly store?: MaskToolStore;
  readonly jobs?: MatteJobStore;
}

export function MaskReviewPanel({
  editor,
  clip,
  mask,
  subject,
  store = maskToolStore,
  jobs = matteJobStore,
}: MaskReviewPanelProps): JSX.Element | null {
  const tools = useMaskTools(store);
  const [message, setMessage] = useState<string | null>(null);
  const [showChecked, setShowChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const review =
    subject === 'matte'
      ? mask.kind === 'matte'
        ? mask.review
        : null
      : (mask.tracking?.review ?? null);
  const artifactKey = mask.kind === 'matte' ? mask.artifact.key : null;
  const flagged: readonly Range[] = review?.flagged ?? [];
  const approved: readonly Range[] = review?.approved ?? [];
  const [current, setCurrent] = useState(0);

  // The selection is an index into a list that shrinks as ranges are cleared.
  useEffect(() => {
    if (current >= flagged.length) setCurrent(Math.max(0, flagged.length - 1));
  }, [current, flagged.length]);

  const go = useCallback(
    (index: number): void => {
      const range = flagged[index];
      if (range === undefined) return;
      setCurrent(index);
      editor.seek(clipTimelineTimeForSource(clip, range.start));
      // Overlay is the view that shows WHAT was removed, which is what a flagged moment is about.
      store.requestMaskView('overlay');
    },
    [clip, editor, flagged, store],
  );

  if (review === null) return null;

  const commitReview = (next: {
    flagged: Range[];
    approved: Range[];
    locked: number[];
  }): boolean => {
    const refusal = runMaskCommand(
      editor,
      subject === 'matte'
        ? { type: 'review_matte', clipId: clip.id, maskId: mask.id, review: next }
        : { type: 'review_mask_track', clipId: clip.id, maskId: mask.id, review: next },
    );
    setMessage(refusal);
    return refusal === null;
  };

  const approve = (range: Range): void => {
    if (
      commitReview({
        flagged: flagged.filter((candidate) => !sameRange(candidate, range)),
        approved: [...approved, range],
        locked: [...(review.locked ?? [])],
      })
    ) {
      setMessage(null);
    }
  };

  const lockFrame = async (): Promise<void> => {
    // The source instant under the playhead: the clock mask keyframes and locks both use, so
    // re-speeding or trimming the clip cannot move the frame the editor confirmed.
    const at = clipSourceTimeAt(clip, editor.state.playhead);
    if (subject === 'tracking') {
      setMessage(
        runMaskCommand(editor, {
          type: 'add_track_constraint',
          clipId: clip.id,
          maskId: mask.id,
          sourceTime: at,
        }) ?? 'This frame is locked. Re-measure to fix the range.',
      );
      return;
    }
    commitReview({
      flagged: [...flagged],
      approved: [...approved],
      locked: [...new Set([...(review.locked ?? []), at])],
    });
    setMessage('This frame is locked. Later runs cannot change it.');
  };

  /**
   * Save the drawn strokes as a correction input and re-run only the window around the moment.
   *
   * The stroke is rasterised here rather than on a canvas: the host accepts exactly four values
   * (keep, remove, edge, untouched) and a canvas would antialias the edge into values it refuses.
   */
  const applyFix = async (): Promise<void> => {
    const bridge = getBridge();
    const size = assetDisplaySize(
      editor.state.assets.find((asset) => asset.id === clip.assetId)?.media,
    );
    if (artifactKey === null || size === null || !bridge?.matteSaveCorrection) {
      setMessage('Saving a fix needs the FramePilot desktop app.');
      return;
    }
    const strokes = tools.correctionStrokes;
    if (strokes.length === 0) {
      setMessage('Draw over the mistake with the Keep, Remove or Edge brush first.');
      return;
    }
    const at = strokes[strokes.length - 1]!.sourceTime;
    setBusy(true);
    try {
      const png = await encodeGrayPng(
        paintCorrection(strokes, size.width, size.height),
        size.width,
        size.height,
      );
      const saved = await bridge.matteSaveCorrection({
        artifactKey,
        sourceTime: at,
        kind: 'brush',
        png,
      });
      if (!saved.ok) {
        setMessage(saved.error);
        return;
      }
      store.clearCorrectionStrokes();
      const range = flagged[current];
      const refusal = await jobs.start({
        assetId: clip.assetId,
        clipId: clip.id,
        maskId: mask.id,
        sourceStart: Math.max(0, (range?.start ?? at) - FIX_WINDOW_PADDING_SECONDS),
        sourceEnd: (range?.end ?? at) + FIX_WINDOW_PADDING_SECONDS,
        prompts: [
          ...(mask.kind === 'matte' ? mask.prompts : []),
          { kind: 'brush', sourceTime: at, sha256: saved.reference.sha256 },
        ],
        previousArtifactKey: artifactKey,
        timelineRevision: editor.state.timeline.revision ?? 0,
      });
      setMessage(refusal ?? 'Fixing that moment…');
      log.action('matte fix applied', { clipId: clip.id, maskId: mask.id });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ADR 0182: Fast everywhere, the models only where the checks flagged. The host reads the
   * flagged ranges from the artifact's own record; this only asks for it. It is the slow engine
   * (tens of seconds per frame), so the button says how long, and asks first.
   */
  const flaggedSeconds = flagged.reduce((total, range) => total + Math.max(range.end - range.start, 1 / 30), 0);
  const refineSeconds = flaggedSeconds * COMPUTE_SECONDS_PER_FOOTAGE_SECOND_1080P;
  const refine = async (): Promise<void> => {
    if (mask.kind !== 'matte' || artifactKey === null) return;
    if (
      !window.confirm(
        `Best quality re-does the flagged moments with the slower models: about ${formatDuration(refineSeconds)} on this computer. Everything else keeps its current result. Start it?`,
      )
    ) {
      return;
    }
    setBusy(true);
    // Said before the job is awaited: `start` answers when the job ENDS, and this one is long.
    setMessage('Refining the flagged moments…');
    try {
      const refusal = await jobs.start({
        assetId: clip.assetId,
        clipId: clip.id,
        maskId: mask.id,
        sourceStart: mask.artifact.coverage.sourceStart,
        sourceEnd: mask.artifact.coverage.sourceEnd,
        prompts: mask.prompts,
        previousArtifactKey: artifactKey,
        refineFlagged: true,
        timelineRevision: editor.state.timeline.revision ?? 0,
      });
      setMessage(refusal);
      log.action('matte refine ended', { clipId: clip.id, flagged: flagged.length });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const key = event.key.toLowerCase();
    if (key !== 'j' && key !== 'k') return;
    event.preventDefault();
    go(key === 'j' ? Math.min(flagged.length - 1, current + 1) : Math.max(0, current - 1));
  };

  const verified = flagged.length === 0;
  const checkedFrames =
    mask.kind === 'matte' ? approved.length + (review.locked?.length ?? 0) : approved.length;

  return (
    <div className="inspector-subpanel mask-review" aria-label="Review">
      {verified ? (
        <p className="mask-review-verified" role="status">
          <span className="mask-review-badge">VERIFIED</span> Every frame checked.
        </p>
      ) : (
        <p className="inspector-empty" role="status" aria-live="polite">
          {String(flagged.length)} moment{flagged.length === 1 ? ' needs' : 's need'} a look.
          Everything else was checked automatically.
          {checkedFrames > 0 && ` ${String(checkedFrames)} approved so far.`}
        </p>
      )}
      {verified && approved.length > 0 && (
        <button
          type="button"
          className="inspector-text-button"
          aria-expanded={showChecked}
          onClick={() => setShowChecked((open) => !open)}
        >
          {showChecked ? 'Hide checked moments' : 'Show checked moments'}
        </button>
      )}
      {(!verified || showChecked) && (
        <ul
          className="mask-review-list"
          aria-label="Moments to review"
          aria-keyshortcuts="J K"
          ref={listRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {(verified ? approved : flagged).map((range, index) => (
            <li key={`${String(range.start)}-${String(range.end)}`}>
              <button
                type="button"
                className="mask-review-range"
                aria-current={!verified && index === current}
                onClick={() => go(index)}
              >
                {seconds(range.start)} – {seconds(range.end)}
                {artifactKey !== null && (
                  <span className="mask-review-reason">
                    {reviewReasonFor(artifactKey, range.start, range.end)}
                  </span>
                )}
              </button>
              {!verified && (
                <Button variant="ghost" type="button" onClick={() => approve(range)}>
                  Looks right
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!verified && (
        <p className="inspector-empty">
          J and K step through the moments. Press Looks right when a moment is fine.
        </p>
      )}
      {!verified && subject === 'matte' && getBridge() !== null && (
        <Button variant="secondary" type="button" disabled={busy} onClick={() => void refine()}>
          Refine flagged moments with Best quality
        </Button>
      )}
      {subject === 'matte' && (
        <div className="mask-review-brushes" role="group" aria-label="Fix this moment">
          <button
            type="button"
            className="inspector-text-button"
            aria-pressed={tools.tool === 'correction-brush' && tools.brushKind === 'keep'}
            onClick={() => {
              store.update({ brushKind: 'keep' });
              store.setTool('correction-brush');
            }}
          >
            Keep brush
          </button>
          <button
            type="button"
            className="inspector-text-button"
            aria-pressed={tools.tool === 'correction-brush' && tools.brushKind === 'remove'}
            onClick={() => {
              store.update({ brushKind: 'remove' });
              store.setTool('correction-brush');
            }}
          >
            Remove brush
          </button>
          {/* BR6.10: marks a band to re-matte (hair, motion blur). It never sets alpha itself:
              the pack widens its matting band there and measures the edge again. */}
          <button
            type="button"
            className="inspector-text-button"
            aria-pressed={tools.tool === 'correction-brush' && tools.brushKind === 'edge'}
            title="Paint over hair or a blurred edge to have it matted again."
            onClick={() => {
              store.update({ brushKind: 'edge' });
              store.setTool('correction-brush');
            }}
          >
            Edge brush
          </button>
          <label className="mask-review-size">
            Brush size
            <input
              type="range"
              min={2}
              max={200}
              step={1}
              value={tools.brushRadiusPx}
              onChange={(event) => store.update({ brushRadiusPx: Number(event.target.value) })}
            />
            <output>{String(tools.brushRadiusPx)} px</output>
          </label>
          <Button
            variant="secondary"
            type="button"
            disabled={busy || tools.correctionStrokes.length === 0}
            onClick={() => void applyFix()}
          >
            {busy ? 'Saving…' : 'Apply fix'}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={tools.correctionStrokes.length === 0}
            onClick={() => store.clearCorrectionStrokes()}
          >
            Clear strokes
          </Button>
        </div>
      )}
      <Button variant="ghost" type="button" onClick={() => void lockFrame()}>
        Lock this frame
      </Button>
      {message !== null && (
        <p className="inspector-empty" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
