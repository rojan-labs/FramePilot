/**
 * MK8.3: shape presets are path generators — ordinary closed paths inside the requested box.
 */
import { describe, expect, it } from 'vitest';
import {
  MASK_SHAPE_PRESETS,
  ShapePresetError,
  shapePresetPaths,
  type MaskShapePreset,
} from './mask-shape-presets.js';

const BOX = { cx: 500, cy: 300, width: 400, height: 200 };

/** Every point a path's cubic segments can reach lies in the hull of vertices and controls. */
function controlBounds(preset: MaskShapePreset, rotation = 0) {
  const points = shapePresetPaths(preset, { ...BOX, rotation }).flatMap((path) =>
    path.vertices.flatMap((vertex) => [
      [vertex.x, vertex.y],
      [vertex.x + vertex.inX, vertex.y + vertex.inY],
      [vertex.x + vertex.outX, vertex.y + vertex.outY],
    ]),
  );
  const xs = points.map(([x]) => x!);
  const ys = points.map(([, y]) => y!);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe('shape presets', () => {
  it.each(MASK_SHAPE_PRESETS)('%s fills its box and stays inside it', (preset) => {
    const bounds = controlBounds(preset);
    const eps = 1e-9;
    expect(bounds.minX).toBeGreaterThanOrEqual(300 - eps);
    expect(bounds.maxX).toBeLessThanOrEqual(700 + eps);
    expect(bounds.minY).toBeGreaterThanOrEqual(200 - eps);
    expect(bounds.maxY).toBeLessThanOrEqual(400 + eps);
    // It touches the box on every side (a preset is sized BY its box, not floating inside it).
    expect(bounds.minX).toBeCloseTo(300, 6);
    expect(bounds.maxX).toBeCloseTo(700, 6);
    expect(bounds.maxY).toBeCloseTo(400, 6);
    for (const path of shapePresetPaths(preset, BOX)) {
      expect(path.vertices.length).toBeGreaterThanOrEqual(3);
      for (const vertex of path.vertices) {
        expect(
          Object.values(vertex)
            .filter((v) => typeof v === 'number')
            .every(Number.isFinite),
        ).toBe(true);
      }
    }
  });

  it('makes stars and polygons with the requested count, clamped to 3..64', () => {
    expect(shapePresetPaths('star', BOX)[0]!.vertices).toHaveLength(10);
    expect(shapePresetPaths('star', BOX, { points: 7 })[0]!.vertices).toHaveLength(14);
    expect(shapePresetPaths('polygon', BOX)[0]!.vertices).toHaveLength(6);
    expect(shapePresetPaths('polygon', BOX, { points: 1 })[0]!.vertices).toHaveLength(3);
    expect(shapePresetPaths('polygon', BOX, { points: 500 })[0]!.vertices).toHaveLength(64);
    // The first vertex is the top point.
    expect(shapePresetPaths('star', BOX)[0]!.vertices[0]).toMatchObject({ x: 500, y: 200 });
  });

  it('builds a rounded frame as an outer path and a subtracted inner one', () => {
    const [outer, inner] = shapePresetPaths('rounded-frame', BOX, { thickness: 0.1 });
    expect(outer!.mode).toBe('add');
    expect(inner!.mode).toBe('subtract');
    const innerXs = inner!.vertices.map((vertex) => vertex.x);
    expect(Math.min(...innerXs)).toBeCloseTo(320, 9);
    expect(Math.max(...innerXs)).toBeCloseTo(680, 9);
  });

  it('rotates about the box centre', () => {
    const upright = shapePresetPaths('arrow', BOX)[0]!.vertices;
    const turned = shapePresetPaths('arrow', { ...BOX, rotation: 90 })[0]!.vertices;
    // The tip (right middle) turns to the bottom middle.
    expect(upright[3]).toMatchObject({ x: 700, y: 300 });
    expect(turned[3]!.x).toBeCloseTo(500, 9);
    expect(turned[3]!.y).toBeCloseTo(500, 9);
  });

  it('refuses a box smaller than a pixel or not finite', () => {
    expect(() => shapePresetPaths('heart', { ...BOX, width: 0.5 })).toThrow(ShapePresetError);
    expect(() => shapePresetPaths('heart', { ...BOX, cx: Number.NaN })).toThrow(/finite/);
  });
});
