/**
 * Preview-time styling for a text overlay (#5).
 *
 * Turns a clip's {@link TextOverlayParams} plus the current time WITHIN the clip
 * into the CSS the preview draws. Positions/sizes are percent-based so they hold
 * across orientation changes; font size is expressed in `cqh` (a fraction of the
 * preview frame's height, which is a size container), so text scales with the
 * frame at any panel size with no measurement.
 *
 * In/out animations are computed from the playhead (not a mount-time CSS
 * animation), so they are scrub-accurate: the overlay eases in over its first
 * `animDurationSeconds` and eases out over its last, and reads correctly at any
 * scrubbed frame. The export draws the same envelope (plan/elements EL2a).
 *
 * Pure + deterministic — unit-tested; the component is a thin consumer.
 */
import type { CSSProperties } from 'react';
import { titleEnvelopeFromParams } from '@framepilot/editor-core';
import type { TextOverlayParams } from './patch-builders.js';

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The eased-in fraction (0→1) and eased-out fraction (1→0) at `timeInClip`. */
export function animationProgress(
  timeInClip: number,
  durationSeconds: number,
  animDurationSeconds: number,
): { inProgress: number; outProgress: number } {
  const anim = Math.max(0, animDurationSeconds);
  if (anim === 0) return { inProgress: 1, outProgress: 1 };
  const inProgress = clamp01(timeInClip / anim);
  const outProgress = clamp01((durationSeconds - timeInClip) / anim);
  return { inProgress, outProgress };
}

/**
 * The resolved animation state of an overlay at `timeInClip`: opacity, a vertical offset as a
 * fraction of the FRAME height (down +), and a scale about the box centre. It is the export's
 * own title envelope (`titleEnvelopeFromParams`, the frame plan's computation), shared by the
 * DOM `textOverlayStyle` and the WebCodecs canvas overlay painter so all three animate alike.
 */
export interface TextOverlayAnimationState {
  readonly opacity: number;
  readonly dyFrame: number;
  readonly scale: number;
}

/** Resolve an overlay's in/out animation state at `timeInClip` (pure). */
export function textOverlayAnimationState(
  params: TextOverlayParams,
  timeInClip: number,
  durationSeconds: number,
): TextOverlayAnimationState {
  const envelope = titleEnvelopeFromParams(params, timeInClip, durationSeconds);
  return { opacity: envelope.opacity, dyFrame: envelope.dy, scale: envelope.scale };
}

/**
 * The full CSS for a text overlay box at `timeInClip` seconds into a clip of
 * `durationSeconds`. Combines the static style (position, size, colour, font,
 * alignment, optional background) with the current in/out animation state.
 */
export function textOverlayStyle(
  params: TextOverlayParams,
  timeInClip: number,
  durationSeconds: number,
): CSSProperties {
  const { opacity, dyFrame, scale } = textOverlayAnimationState(
    params,
    timeInClip,
    durationSeconds,
  );

  return {
    position: 'absolute',
    left: `${params.xPercent}%`,
    top: `${params.yPercent}%`,
    width: `${params.boxWidthPercent}%`,
    // `cqh` is a percent of the preview frame's height, the unit the export's slide moves in.
    transform: `translate(-50%, -50%) translateY(${dyFrame * 100}cqh) scale(${scale})`,
    textAlign: params.align,
    color: params.color,
    fontFamily: params.fontFamily,
    fontWeight: params.fontWeight,
    fontSize: `${params.fontSizePercent}cqh`,
    lineHeight: 1.15,
    opacity,
    ...(params.background
      ? { background: params.background, padding: '0.15em 0.4em', borderRadius: '0.15em' }
      : {}),
    overflowWrap: 'break-word',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  };
}
