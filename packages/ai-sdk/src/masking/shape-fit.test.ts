import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PATH_VERTEX_BUDGET,
  ellipseFromBox,
  ellipseFromMatte,
  pathFromMatte,
  rectangleFromBox,
  rectangleFromMatte,
  type BinaryMatte,
} from './shape-fit.js';

const SIZE = { width: 1920, height: 1080 };

/** Encode a predicate over pixels as row-major run lengths, zero run first. */
function matteOf(
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
): BinaryMatte {
  const counts: number[] = [];
  let value = 0;
  let run = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = inside(x, y) ? 1 : 0;
      if (bit === value) run += 1;
      else {
        counts.push(run);
        value = bit;
        run = 1;
      }
    }
  }
  counts.push(run);
  return { width, height, counts };
}

describe('box fitters', () => {
  it('covers the measured box exactly, in source pixels', () => {
    const fit = rectangleFromBox({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, SIZE);
    expect(fit).toEqual({
      ok: true,
      geometry: {
        kind: 'rectangle',
        cx: 960,
        cy: 675,
        width: 960,
        height: 270,
        rotation: 0,
        roundness: 0,
      },
    });
  });

  it('inscribes the ellipse in the box', () => {
    const fit = ellipseFromBox({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, SIZE);
    expect(fit).toEqual({
      ok: true,
      geometry: { kind: 'ellipse', cx: 960, cy: 675, rx: 480, ry: 135, rotation: 0 },
    });
  });

  it('clamps a box that leaves the picture instead of storing out-of-frame geometry', () => {
    const fit = rectangleFromBox({ x: -0.1, y: 0.9, width: 0.3, height: 0.3 }, SIZE);
    expect(fit.ok && fit.geometry.width).toBeCloseTo(0.2 * 1920);
    expect(fit.ok && fit.geometry.height).toBeCloseTo(0.1 * 1080);
  });

  it('refuses a box with no area or a non-finite number', () => {
    expect(rectangleFromBox({ x: 0, y: 0, width: 0, height: 1 }, SIZE)).toMatchObject({
      ok: false,
      code: 'invalid_measurement',
    });
    expect(ellipseFromBox({ x: Number.NaN, y: 0, width: 1, height: 1 }, SIZE)).toMatchObject({
      ok: false,
    });
    expect(rectangleFromBox({ x: 1.2, y: 0, width: 0.1, height: 0.1 }, SIZE)).toMatchObject({
      ok: false,
      code: 'empty_measurement',
    });
  });
});

describe('matte fitters', () => {
  it('bounds the set pixels, including a run that wraps a row', () => {
    const matte = matteOf(10, 10, (x, y) => x >= 2 && x <= 5 && y >= 3 && y <= 4);
    const fit = rectangleFromMatte(matte, { width: 100, height: 100 });
    expect(fit).toEqual({
      ok: true,
      geometry: {
        kind: 'rectangle',
        cx: 40,
        cy: 40,
        width: 40,
        height: 20,
        rotation: 0,
        roundness: 0,
      },
    });
    // Full-width rows merge into one run across the row boundary.
    const wrapped = rectangleFromMatte(
      matteOf(4, 4, (_x, y) => y >= 1 && y <= 2),
      { width: 4, height: 4 },
    );
    expect(wrapped.ok && wrapped.geometry).toMatchObject({ cx: 2, cy: 2, width: 4, height: 2 });
  });

  it('recovers a drawn ellipse from its moments, rotation included', () => {
    const angle = (30 * Math.PI) / 180;
    const matte = matteOf(400, 300, (x, y) => {
      const dx = x + 0.5 - 200;
      const dy = y + 0.5 - 150;
      const u = dx * Math.cos(angle) + dy * Math.sin(angle);
      const v = -dx * Math.sin(angle) + dy * Math.cos(angle);
      return (u / 120) ** 2 + (v / 50) ** 2 <= 1;
    });
    const fit = ellipseFromMatte(matte, { width: 400, height: 300 });
    if (!fit.ok) throw new Error(fit.message);
    expect(fit.geometry.cx).toBeCloseTo(200, 0);
    expect(fit.geometry.cy).toBeCloseTo(150, 0);
    expect(fit.geometry.rx).toBeCloseTo(120, 0);
    expect(fit.geometry.ry).toBeCloseTo(50, 0);
    expect(fit.geometry.rotation).toBeCloseTo(30, 0);
  });

  it('scales a low-resolution matte to source pixels', () => {
    const matte = matteOf(192, 108, (x, y) => (x + 0.5 - 96) ** 2 + (y + 0.5 - 54) ** 2 <= 20 ** 2);
    const fit = ellipseFromMatte(matte, SIZE);
    if (!fit.ok) throw new Error(fit.message);
    expect(fit.geometry.cx).toBeCloseTo(960, -1);
    expect(fit.geometry.rx).toBeCloseTo(200, -1);
  });

  it('refuses an empty bitmap and one whose runs do not add up', () => {
    expect(
      ellipseFromMatte(
        matteOf(8, 8, () => false),
        SIZE,
      ),
    ).toMatchObject({ code: 'empty_measurement' });
    expect(
      rectangleFromMatte(
        matteOf(8, 8, () => false),
        SIZE,
      ),
    ).toMatchObject({ code: 'empty_measurement' });
    expect(
      pathFromMatte(
        matteOf(8, 8, () => false),
        SIZE,
      ),
    ).toMatchObject({ code: 'empty_measurement' });
    expect(pathFromMatte({ width: 8, height: 8, counts: [10, 3] }, SIZE)).toMatchObject({
      code: 'invalid_measurement',
    });
  });
});

describe('pathFromMatte', () => {
  const disc = matteOf(200, 200, (x, y) => (x + 0.5 - 100) ** 2 + (y + 0.5 - 100) ** 2 <= 60 ** 2);

  it('follows the measured outline: every vertex sits on the disc boundary', () => {
    const fit = pathFromMatte(disc, { width: 200, height: 200 });
    if (!fit.ok) throw new Error(fit.message);
    expect(fit.geometry.vertices.length).toBeGreaterThanOrEqual(3);
    expect(fit.geometry.vertices.length).toBeLessThanOrEqual(DEFAULT_PATH_VERTEX_BUDGET);
    for (const vertex of fit.geometry.vertices) {
      expect(Math.hypot(vertex.x - 100, vertex.y - 100)).toBeGreaterThan(55);
      expect(Math.hypot(vertex.x - 100, vertex.y - 100)).toBeLessThan(65);
    }
  });

  it('honours a smaller vertex budget with a looser curve, not a different region', () => {
    const fit = pathFromMatte(disc, { width: 200, height: 200 }, { vertexBudget: 6 });
    if (!fit.ok) throw new Error(fit.message);
    expect(fit.geometry.vertices.length).toBeLessThanOrEqual(6);
    // Still the disc: every vertex stays near its boundary, and the path spans it.
    for (const vertex of fit.geometry.vertices) {
      expect(Math.abs(Math.hypot(vertex.x - 100, vertex.y - 100) - 60)).toBeLessThan(15);
    }
    const xs = fit.geometry.vertices.map((vertex) => vertex.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
  });

  it('traces the LARGEST region and ignores an island', () => {
    const matte = matteOf(
      100,
      100,
      (x, y) => (x >= 10 && x < 60 && y >= 10 && y < 60) || (x >= 90 && y >= 90),
    );
    const fit = pathFromMatte(matte, { width: 100, height: 100 });
    if (!fit.ok) throw new Error(fit.message);
    for (const vertex of fit.geometry.vertices) {
      expect(vertex.x).toBeLessThan(70);
      expect(vertex.y).toBeLessThan(70);
    }
  });

  it('is deterministic', () => {
    expect(pathFromMatte(disc, SIZE)).toEqual(pathFromMatte(disc, SIZE));
  });
});
