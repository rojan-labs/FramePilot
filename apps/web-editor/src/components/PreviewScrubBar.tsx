/**
 * Monitor scrub bar (revamp Phase 2, F2).
 *
 * Before this, the only way to scrub was the timeline ruler — so fine-scrubbing a
 * two-second range meant zooming the timeline in and back out again, and the
 * monitor itself had no position affordance at all.
 *
 * Three things make it a real scrub bar rather than a progress indicator:
 *
 *  - **Pointer-accurate.** The time comes from the pointer's position on the
 *    track, not from an `<input type=range>`'s stepped value, so a click lands
 *    where you clicked.
 *  - **Fine scrub.** Holding Shift damps the gesture to a fifth of its travel,
 *    *relative to where the gesture already was* — the playhead does not jump to
 *    the pointer when Shift goes down, it keeps going from where it is.
 *  - **You can see the edits.** Cut ticks are drawn from the project's own edit
 *    points, so scrubbing happens against the structure of the sequence instead
 *    of against a featureless bar. Dragging snaps onto them (Alt inverts, the
 *    same convention as timeline snapping).
 *
 * All the arithmetic lives in `preview/scrub.ts` — this is the pointer/ARIA
 * shell. It is a `role="slider"`, fully keyboard-operable: arrows step a frame,
 * Shift+arrows a second, Home/End jump to the ends.
 */
import { useRef, useState } from 'react';
import {
  FINE_SCRUB_DAMPING,
  fineScrubTime,
  fractionOfDuration,
  quantizeToFrame,
  snapToEditPoint,
  timeAtPointer,
  type ScrubTrack,
} from '../preview/scrub.js';

export interface PreviewScrubBarProps {
  /** Total sequence length (seconds). Zero renders an inert, empty track. */
  readonly durationSec: number;
  /** The live playhead (seconds) — drives the handle and the filled portion. */
  readonly currentTimeSec: number;
  /** Project frame rate, so a scrub lands on a whole frame. */
  readonly fps: number;
  /** Edit points to draw as ticks and snap to (see `editor/edit-points.ts`). */
  readonly editPoints: readonly number[];
  /** Commit a scrub position. Called continuously during a drag. */
  readonly onSeek: (timeSec: number) => void;
  /** Human-readable time, for `aria-valuetext` (timecode or seconds). */
  readonly formatTimeLabel: (timeSec: number) => string;
}

/**
 * How close (in CSS pixels) a drag must come to an edit point to snap onto it.
 * Expressed in pixels, converted to seconds per gesture, so the snap feels
 * identical whether the bar is 300px or 1200px wide.
 */
const SNAP_TOLERANCE_PX = 6;

/** Coarse keyboard step (seconds) for Shift+arrow — a second, not a frame. */
const COARSE_STEP_SECONDS = 1;

interface ScrubGesture {
  readonly pointerId: number;
  /** Track geometry captured once per gesture (no ResizeObserver needed). */
  readonly track: ScrubTrack;
  /**
   * Where the FINE portion of the gesture started. Re-anchored the moment Shift
   * goes down or comes up mid-drag, which is what lets the user flip between
   * coarse and fine within one continuous drag without the playhead jumping.
   */
  fineOriginClientX: number;
  fineOriginTime: number;
  /** Whether the previous move event was a fine (Shift-held) one. */
  wasFine: boolean;
}

export function PreviewScrubBar({
  durationSec,
  currentTimeSec,
  fps,
  editPoints,
  onSeek,
  formatTimeLabel,
}: PreviewScrubBarProps): JSX.Element {
  const gesture = useRef<ScrubGesture | null>(null);
  // Purely presentational: the bar shows a grabbed state during a drag. Kept in
  // state (not a ref) because it has to repaint; kept local because no one else
  // cares that a scrub is in flight.
  const [scrubbing, setScrubbing] = useState(false);

  const clampedTime = Math.max(0, Math.min(durationSec, currentTimeSec));
  const fillFraction = fractionOfDuration(clampedTime, durationSec);

  /** Resolve a pointer event to the time to seek to, applying snap + quantize. */
  const resolveTime = (event: React.PointerEvent<HTMLElement>, active: ScrubGesture): number => {
    const fine = event.shiftKey;
    // Re-anchor whenever the modifier flips, so coarse↔fine transitions are
    // continuous rather than teleporting the playhead to the pointer.
    if (fine !== active.wasFine) {
      active.wasFine = fine;
      active.fineOriginClientX = event.clientX;
      active.fineOriginTime = clampedTime;
    }
    const raw = fine
      ? fineScrubTime(
          active.fineOriginTime,
          active.fineOriginClientX,
          event.clientX,
          active.track,
          durationSec,
          FINE_SCRUB_DAMPING,
        )
      : timeAtPointer(event.clientX, active.track, durationSec);
    // Alt inverts snapping (the timeline's convention — see EditorSettings.snapping).
    // A fine scrub never snaps: the whole point of the gesture is sub-tick control,
    // and a magnet would fight it.
    const snapped =
      event.altKey || fine || active.track.width <= 0
        ? raw
        : snapToEditPoint(raw, editPoints, (SNAP_TOLERANCE_PX / active.track.width) * durationSec);
    return quantizeToFrame(snapped, fps);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (durationSec <= 0 || event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const active: ScrubGesture = {
      pointerId: event.pointerId,
      track: { left: rect.left, width: rect.width },
      fineOriginClientX: event.clientX,
      fineOriginTime: clampedTime,
      wasFine: event.shiftKey,
    };
    gesture.current = active;
    setScrubbing(true);
    /* v8 ignore start -- setPointerCapture throws NotFoundError only for a pointer
       id with no active pointer, which a real event by definition has; the test
       environment's implementation (src/test-setup.ts) never throws either. Kept
       as a guard because losing capture must not abort the gesture. */
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is an optimisation — the drag still tracks without it. */
    }
    /* v8 ignore stop */
    // A Shift-click starts a fine gesture in place; a plain click jumps.
    if (!event.shiftKey) onSeek(resolveTime(event, active));
    event.currentTarget.focus();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    onSeek(resolveTime(event, active));
  };

  const endGesture = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    gesture.current = null;
    setScrubbing(false);
    /* v8 ignore start -- same as setPointerCapture above: only a stale pointer id
       throws, and the gesture is already over either way. */
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released (the browser releases implicitly on pointerup). */
    }
    /* v8 ignore stop */
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (durationSec <= 0) return;
    const frame = fps > 0 ? 1 / fps : 1 / 30;
    const step = event.shiftKey ? COARSE_STEP_SECONDS : frame;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = clampedTime - step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = clampedTime + step;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = durationSec;
    if (next === null) return;
    event.preventDefault();
    // Stop the editor's global shortcuts from ALSO acting on this key: the bar
    // owns arrow/Home/End while focused, and both handlers firing would move the
    // playhead twice per press.
    event.stopPropagation();
    onSeek(quantizeToFrame(Math.max(0, Math.min(durationSec, next)), fps));
  };

  return (
    <div className="preview-scrub">
      <div
        className={`preview-scrub-track${scrubbing ? ' is-scrubbing' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Scrub"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, durationSec)}
        aria-valuenow={clampedTime}
        aria-valuetext={formatTimeLabel(clampedTime)}
        aria-disabled={durationSec <= 0 ? true : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={onKeyDown}
      >
        {/* Cut ticks. aria-hidden: the positions are already conveyed by
            aria-valuetext as the handle passes them, and announcing every cut
            would bury the one thing a screen-reader user needs — the time. */}
        {durationSec > 0 &&
          editPoints.map((point) => (
            <span
              key={point}
              className="preview-scrub-tick"
              aria-hidden="true"
              style={{ left: `${fractionOfDuration(point, durationSec) * 100}%` }}
            />
          ))}
        <span
          className="preview-scrub-fill"
          aria-hidden="true"
          style={{ width: `${fillFraction * 100}%` }}
        />
        <span
          className="preview-scrub-handle"
          aria-hidden="true"
          style={{ left: `${fillFraction * 100}%` }}
        />
      </div>
    </div>
  );
}
