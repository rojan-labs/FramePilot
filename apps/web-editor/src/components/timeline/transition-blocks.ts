/**
 * Where a transition block is drawn, and how much of itself it can show
 * (revamp Phase 8, F7).
 *
 * ## Why this is arithmetic and not CSS
 *
 * A transition straddles a cut, so its box is centred on the cut and is
 * `duration × zoom` wide. Two facts make that harder than it sounds:
 *
 *  1. **At low zoom a real transition is sub-pixel.** A 0.5s dissolve at 4 px/s is
 *     two pixels — unclickable. So a block has a *minimum* drawn width, which means
 *     the drawn box is no longer `duration × zoom` and can collide with its
 *     neighbour even though the two transitions do not overlap in time.
 *  2. **Adjacent transitions can legitimately touch.** The engine caps a duration at
 *     `min(incoming, outgoing)` clip length, so on `A[0,1] B[1,2] C[2,3]` with 1s
 *     transitions the two blocks meet exactly at 1.5s. Add a minimum width to that
 *     and they overlap, and the user cannot tell which one they are grabbing.
 *
 * The layout therefore resolves the whole track at once rather than each block
 * independently, which is the part a stylesheet cannot do.
 */
import type { TransitionPlacement } from '../../editor/selectors.js';

/** Smallest drawn width (px). Below this a block is not a hit target. */
export const TRANSITION_MIN_PX = 10;

/** At or above this width a block shows its icon. Below it, only a marker. */
export const TRANSITION_ICON_MIN_PX = 22;

/** At or above this width a block shows its kind and duration in words. */
export const TRANSITION_LABEL_MIN_PX = 76;

/**
 * How much of itself a block can show at its drawn width.
 *
 * `marker` is a bare shape — the transition is still *visible and grabbable* at any
 * zoom, which is the point: a cut treatment you cannot see is one you forget you
 * applied.
 */
export type TransitionDensity = 'marker' | 'icon' | 'label';

/** A resolved on-screen box for one transition. */
export interface TransitionBlockBox {
  readonly placement: TransitionPlacement;
  readonly leftPx: number;
  readonly widthPx: number;
  readonly density: TransitionDensity;
  /**
   * True when the drawn width was reduced to avoid a neighbour. Surfaced so the
   * block can drop its label rather than clipping the text mid-word.
   */
  readonly crowded: boolean;
}

/** The density a block of `widthPx` can carry. */
export function transitionDensity(widthPx: number): TransitionDensity {
  if (widthPx >= TRANSITION_LABEL_MIN_PX) return 'label';
  if (widthPx >= TRANSITION_ICON_MIN_PX) return 'icon';
  return 'marker';
}

/**
 * Lay out every transition on one track, resolving collisions between them.
 *
 * Blocks are widened to {@link TRANSITION_MIN_PX} so they stay grabbable, then any
 * pair that would overlap is pulled back to meet at the midpoint between their cuts.
 * Meeting rather than shrinking-both-to-nothing keeps each block as large as it can
 * be while guaranteeing the boundary between them is unambiguous — a click always
 * lands on exactly one transition.
 *
 * @param placements - The track's transitions, in any order.
 * @param pxPerSecond - Current zoom.
 */
export function layoutTransitionBlocks(
  placements: readonly TransitionPlacement[],
  pxPerSecond: number,
): readonly TransitionBlockBox[] {
  const ordered = placements.slice().sort((a, b) => a.cutTime - b.cutTime);
  // First pass: the ideal box, widened to the minimum hit target.
  const boxes = ordered.map((placement) => {
    const centre = placement.cutTime * pxPerSecond;
    const ideal = placement.durationSeconds * pxPerSecond;
    const width = Math.max(TRANSITION_MIN_PX, ideal);
    return { placement, centre, width, ideal };
  });

  return boxes.map((box, index) => {
    const previous = boxes[index - 1];
    const next = boxes[index + 1];
    // The furthest this block may extend either way: halfway to each neighbour's
    // cut. Symmetric, so the two sides of a boundary agree on where it is without
    // needing to coordinate.
    const leftLimit = previous ? (previous.centre + box.centre) / 2 : -Infinity;
    const rightLimit = next ? (box.centre + next.centre) / 2 : Infinity;
    const half = box.width / 2;
    const left = Math.max(box.centre - half, leftLimit);
    const right = Math.min(box.centre + half, rightLimit);
    // A degenerate span (neighbours closer than 1px) still gets a hairline, because
    // a zero-width block is an object the user cannot reach at all.
    const widthPx = Math.max(1, right - left);
    return {
      placement: box.placement,
      leftPx: left,
      widthPx,
      density: transitionDensity(widthPx),
      crowded: widthPx < box.width,
    };
  });
}

/** Human label for a transition kind — `cross-dissolve` reads badly on a block. */
export function transitionKindLabel(kind: string): string {
  return kind
    .split('-')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** The block's full description, used for its label, tooltip and accessible name. */
export function describeTransition(placement: TransitionPlacement): string {
  return `${transitionKindLabel(placement.kind)} ${placement.durationSeconds.toFixed(2)}s`;
}
