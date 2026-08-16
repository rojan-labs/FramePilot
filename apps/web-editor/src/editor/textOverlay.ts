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
 * scrubbed frame. Render wiring is a follow-up (this is the preview approximation).
 *
 * Pure + deterministic — unit-tested; the component is a thin consumer.
 */
import type { CSSProperties } from 'react';
import type { TextAnimation, TextOverlayParams } from './patch-builders.js';

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

/** Opacity + translate/scale contributed by an in/out animation at `progress` (0→1). */
function animationTransform(
  animation: TextAnimation,
  progress: number,
  direction: 'in' | 'out',
): { opacity: number; tx: number; ty: number; scale: number } {
  // progress 1 = fully on screen (no offset); 0 = fully animated away.
  const away = 1 - progress;
  // Slide travel as a fraction of the box; sign flips for the outro so the text
  // leaves the way it will have entered from the opposite side.
  const travel = away * 12 * (direction === 'in' ? 1 : -1);
  switch (animation) {
    case 'none':
      return { opacity: 1, tx: 0, ty: 0, scale: 1 };
    case 'fade':
      return { opacity: progress, tx: 0, ty: 0, scale: 1 };
    case 'slide-up':
      return { opacity: progress, tx: 0, ty: travel, scale: 1 };
    case 'slide-down':
      return { opacity: progress, tx: 0, ty: -travel, scale: 1 };
    case 'pop':
      return { opacity: progress, tx: 0, ty: 0, scale: 0.7 + 0.3 * progress };
  }
}

/** The resolved animation state of an overlay at `timeInClip`: opacity, a
 * translate in PERCENT of the box's own size (`txPercent`/`tyPercent`, matching
 * the CSS `translate(%,%)`), and a scale about the box centre. Shared by the
 * DOM `textOverlayStyle` and the WebCodecs canvas overlay painter so the two
 * animate identically. */
export interface TextOverlayAnimationState {
  readonly opacity: number;
  readonly txPercent: number;
  readonly tyPercent: number;
  readonly scale: number;
}

/** Resolve an overlay's in/out animation state at `timeInClip` (pure). */
export function textOverlayAnimationState(
  params: TextOverlayParams,
  timeInClip: number,
  durationSeconds: number,
): TextOverlayAnimationState {
  const { inProgress, outProgress } = animationProgress(
    timeInClip,
    durationSeconds,
    params.animDurationSeconds,
  );
  // The active phase is whichever end is nearer: the intro dominates the first
  // half, the outro the second. Compose their opacity/offset multiplicatively so a
  // very short clip that overlaps both still reads sensibly.
  const intro = animationTransform(params.inAnimation, inProgress, 'in');
  const outro = animationTransform(params.outAnimation, outProgress, 'out');
  return {
    opacity: intro.opacity * outro.opacity,
    txPercent: intro.tx + outro.tx,
    tyPercent: intro.ty + outro.ty,
    scale: intro.scale * outro.scale,
  };
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
  const {
    opacity,
    txPercent: tx,
    tyPercent: ty,
    scale,
  } = textOverlayAnimationState(params, timeInClip, durationSeconds);

  return {
    position: 'absolute',
    left: `${params.xPercent}%`,
    top: `${params.yPercent}%`,
    width: `${params.boxWidthPercent}%`,
    transform: `translate(-50%, -50%) translate(${tx}%, ${ty}%) scale(${scale})`,
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
