/**
 * Transition block layout (revamp Phase 8, F7).
 *
 * The two facts that make this arithmetic rather than CSS are both tested directly:
 * a block stays grabbable at any zoom, and two adjacent blocks never overlap even
 * when their minimum hit targets would make them.
 */
import { describe, expect, it } from 'vitest';
import type { TransitionPlacement } from '../../editor/selectors.js';
import {
  TRANSITION_ICON_MIN_PX,
  TRANSITION_LABEL_MIN_PX,
  TRANSITION_MIN_PX,
  describeTransition,
  layoutTransitionBlocks,
  transitionDensity,
  transitionKindLabel,
} from './transition-blocks.js';

const placement = (
  cutTime: number,
  durationSeconds: number,
  kind = 'cross-dissolve',
): TransitionPlacement => ({
  trackId: 'v',
  fromClipId: `from_${cutTime}`,
  toClipId: `to_${cutTime}`,
  effectId: `to_${cutTime}__transition`,
  kind,
  durationSeconds,
  disabled: false,
  cutTime,
  maxDurationSeconds: durationSeconds * 2,
});

describe('transitionDensity', () => {
  it('drops from label to icon to marker as the block narrows', () => {
    expect(transitionDensity(TRANSITION_LABEL_MIN_PX)).toBe('label');
    expect(transitionDensity(TRANSITION_LABEL_MIN_PX - 1)).toBe('icon');
    expect(transitionDensity(TRANSITION_ICON_MIN_PX)).toBe('icon');
    expect(transitionDensity(TRANSITION_ICON_MIN_PX - 1)).toBe('marker');
    expect(transitionDensity(2)).toBe('marker');
  });
});

describe('layoutTransitionBlocks', () => {
  it('centres a block on its cut, at duration × zoom', () => {
    const [box] = layoutTransitionBlocks([placement(10, 1)], 40);
    expect(box!.widthPx).toBe(40);
    expect(box!.leftPx).toBe(10 * 40 - 20);
  });

  it('widens a sub-pixel transition to a real hit target', () => {
    // A 0.5s dissolve at 4 px/s is two pixels. Unclickable is the same as absent.
    const [box] = layoutTransitionBlocks([placement(10, 0.5)], 4);
    expect(box!.widthPx).toBe(TRANSITION_MIN_PX);
    expect(box!.density).toBe('marker');
  });

  it('never lets two blocks overlap, even when their MINIMUMS would', () => {
    // Two cuts 1px apart at this zoom; both want 10px of hit target.
    const boxes = layoutTransitionBlocks([placement(1, 0.01), placement(1.25, 0.01)], 4);
    const [first, second] = boxes;
    expect(first!.leftPx + first!.widthPx).toBeLessThanOrEqual(second!.leftPx + 1e-9);
  });

  it('splits the difference at the midpoint between the two cuts', () => {
    // Symmetric, so the two sides of a boundary agree on where it is without having
    // to coordinate — a click always lands on exactly one transition.
    const boxes = layoutTransitionBlocks([placement(1, 1), placement(1.5, 1)], 40);
    const midpoint = ((1 + 1.5) / 2) * 40;
    expect(boxes[0]!.leftPx + boxes[0]!.widthPx).toBeCloseTo(midpoint, 6);
    expect(boxes[1]!.leftPx).toBeCloseTo(midpoint, 6);
  });

  it('marks a block as crowded only when it was actually pulled back', () => {
    const crowded = layoutTransitionBlocks([placement(1, 1), placement(1.2, 1)], 40);
    expect(crowded[0]!.crowded).toBe(true);
    const roomy = layoutTransitionBlocks([placement(1, 0.2), placement(10, 0.2)], 40);
    expect(roomy.every((box) => box.crowded)).toBe(false);
  });

  it('always leaves a hairline rather than a zero-width block', () => {
    // A zero-width block is an object the user cannot reach at all.
    const boxes = layoutTransitionBlocks(
      [placement(1, 0.01), placement(1.0001, 0.01), placement(1.0002, 0.01)],
      40,
    );
    for (const box of boxes) expect(box.widthPx).toBeGreaterThanOrEqual(1);
  });

  it('resolves in cut order regardless of input order', () => {
    const boxes = layoutTransitionBlocks([placement(5, 0.2), placement(1, 0.2)], 40);
    expect(boxes.map((box) => box.placement.cutTime)).toEqual([1, 5]);
  });

  it('handles an empty track', () => {
    expect(layoutTransitionBlocks([], 40)).toEqual([]);
  });
});

describe('labels', () => {
  it('turns a kind id into something readable', () => {
    expect(transitionKindLabel('cross-dissolve')).toBe('Cross dissolve');
    expect(transitionKindLabel('fade')).toBe('Fade');
  });

  it('names the kind and the duration together', () => {
    // A timeline of six transitions was six identical arrows before this.
    expect(describeTransition(placement(1, 0.5))).toBe('Cross dissolve 0.50s');
  });
});
