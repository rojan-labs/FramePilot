import { describe, expect, it } from 'vitest';
import { fitClosedStroke } from './mask-curve-fit.js';
import type { MaskPathVertex } from './mask-geometry.js';
import { cubicPoint, nearestPointOnPath, segmentControlPoints } from './mask-path-editing.js';

/** Largest distance from any sample to the fitted outline. */
function worstDeviation(vertices: MaskPathVertex[], samples: { x: number; y: number }[]): number {
  return Math.max(...samples.map((sample) => nearestPointOnPath(vertices, sample)!.distance));
}

const circle = (cx: number, cy: number, r: number, count: number): { x: number; y: number }[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });

describe('fitClosedStroke (Schneider)', () => {
  it('fits a sampled circle within tolerance with few smooth vertices', () => {
    const samples = circle(960, 540, 300, 400);
    const vertices = fitClosedStroke(samples, 1)!;
    expect(vertices.length).toBeGreaterThanOrEqual(3);
    expect(vertices.length).toBeLessThan(20);
    expect(vertices.every((vertex) => vertex.type === 'smooth')).toBe(true);
    expect(worstDeviation(vertices, samples)).toBeLessThan(1.5);
  });

  it('keeps every join smooth: in and out tangents are collinear and opposite', () => {
    const vertices = fitClosedStroke(circle(0, 0, 100, 200), 0.5)!;
    for (const vertex of vertices) {
      const cross = vertex.inX * vertex.outY - vertex.inY * vertex.outX;
      const dot = vertex.inX * vertex.outX + vertex.inY * vertex.outY;
      const scale = Math.hypot(vertex.inX, vertex.inY) * Math.hypot(vertex.outX, vertex.outY);
      expect(Math.abs(cross) / scale).toBeLessThan(1e-6);
      expect(dot).toBeLessThan(0);
    }
  });

  it('fits a noisy freehand blob and closes it', () => {
    let seed = 7;
    const noise = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 1.5;
    };
    const samples = circle(500, 400, 150, 300).map((point, index) => ({
      x: point.x + 40 * Math.sin(index / 20) + noise(),
      y: point.y + noise(),
    }));
    const vertices = fitClosedStroke(samples, 3)!;
    expect(worstDeviation(vertices, samples)).toBeLessThan(4);
    const last = cubicPoint(segmentControlPoints(vertices, vertices.length - 1), 1);
    expect(last.x).toBeCloseTo(vertices[0]!.x, 9);
  });

  it('returns at least three vertices for a stroke that fits in one curve', () => {
    const vertices = fitClosedStroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 80 },
    ])!;
    expect(vertices.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses strokes without three distinct samples, ignoring jitter and non-finite input', () => {
    expect(
      fitClosedStroke([
        { x: 0, y: 0 },
        { x: 0.1, y: 0.1 },
        { x: 10, y: 10 },
      ]),
    ).toBeNull();
    expect(
      fitClosedStroke([
        { x: Number.NaN, y: 0 },
        { x: 1, y: 1 },
        { x: 5, y: 5 },
      ]),
    ).toBeNull();
  });
});
