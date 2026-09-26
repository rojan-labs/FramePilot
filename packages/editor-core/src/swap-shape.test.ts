/**
 * Swapping a shape's geometry in the Inspector (plan/elements EL5.2): the style and placement
 * stay, the knobs are the new shape's, and a box never turns into a line.
 */
import { describe, expect, it } from 'vitest';
import { presetShapeParams, shapeParamsProblem } from '@framepilot/timeline-schema';
import { swapShapeParams } from './element-placement.js';

describe('swapShapeParams', () => {
  const box = presetShapeParams('rounded-rect/highlight', { x: 30, y: 60 })!;

  it('keeps colours, stroke and box, and takes the new shape knobs at their defaults', () => {
    const star = swapShapeParams(box, 'star-5')!;
    expect(star).toMatchObject({
      shape: 'star-5',
      x: 30,
      y: 60,
      width: box.width,
      height: box.height,
      stroke: '#FFD400',
      fill: null,
      points: 5,
      innerRadius: 45,
    });
    expect(star).not.toHaveProperty('cornerRadius');
    expect(shapeParamsProblem(star)).toBeNull();
  });

  it('swaps a box for an icon, which has no knobs', () => {
    const icon = swapShapeParams(box, 'icon/check')!;
    expect(icon).not.toHaveProperty('cornerRadius');
    expect(shapeParamsProblem(icon)).toBeNull();
  });

  it('keeps an arrow’s ends and caps when it becomes a curved arrow', () => {
    const arrow = presetShapeParams('line-arrow/red')!;
    const curved = swapShapeParams(arrow, 'curved-arrow')!;
    expect(curved).toMatchObject({ x1: arrow.x1, y2: arrow.y2, endCap: 'arrow', curvature: 45 });
    expect(shapeParamsProblem(curved)).toBeNull();
  });

  it('refuses a box-to-line swap and an unknown shape', () => {
    expect(swapShapeParams(box, 'line-arrow')).toBeUndefined();
    expect(swapShapeParams(box, 'dodecahedron')).toBeUndefined();
  });
});
