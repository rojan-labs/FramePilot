import { describe, expect, it } from 'vitest';
import {
  MaskPathEncodingError,
  SourceGeometryError,
  assetDisplaySize,
  codedToDisplay,
  decodeMaskPath,
  displayCorrectedSize,
  displayPxToNormalized,
  displayToCoded,
  encodeMaskPath,
  normalizeQuarterTurn,
  normalizedToDisplayPx,
  type MaskPathVertex,
  type SourcePictureGeometry,
} from './mask-geometry.js';

const square: MaskPathVertex[] = [
  { x: 0, y: 0, inX: 0, inY: 0, outX: 5, outY: 0, type: 'corner' },
  { x: 10, y: 0, inX: -5, inY: 0, outX: 0, outY: 5, type: 'smooth' },
  { x: 10, y: 10, inX: 0, inY: -5, outX: -2, outY: 1, type: 'broken' },
];

describe('compact mask path storage', () => {
  it('encodes six numbers and one type code per vertex and decodes back exactly', () => {
    const encoded = encodeMaskPath(square);
    expect(encoded).toEqual({
      points: [0, 0, 0, 0, 5, 0, 10, 0, -5, 0, 0, 5, 10, 10, 0, -5, -2, 1],
      vertexTypes: [0, 1, 2],
    });
    expect(decodeMaskPath(encoded)).toEqual(square);
  });

  it('writes per-vertex feather only when a vertex has one, filling the rest with 0', () => {
    const feathered = square.map((vertex, index) =>
      index === 1 ? { ...vertex, featherPx: 4 } : vertex,
    );
    const encoded = encodeMaskPath(feathered);
    expect(encoded.featherPx).toEqual([0, 4, 0]);
    expect(decodeMaskPath(encoded).map((vertex) => vertex.featherPx)).toEqual([0, 4, 0]);
  });

  it('is several times smaller on disk than an object per vertex', () => {
    const vertices = Array.from({ length: 200 }, (_, index) => ({
      x: index * 1.5,
      y: index * 2.25,
      inX: -1.25,
      inY: 0.5,
      outX: 1.25,
      outY: -0.5,
      type: 'smooth' as const,
    }));
    const compact = JSON.stringify(encodeMaskPath(vertices)).length;
    const verbose = JSON.stringify(vertices).length;
    expect(compact * 2).toBeLessThan(verbose);
  });

  it('refuses arrays that do not describe whole vertices, naming the fix', () => {
    expect(() => decodeMaskPath({ points: [1, 2, 3], vertexTypes: [0] })).toThrow(
      MaskPathEncodingError,
    );
    expect(() =>
      decodeMaskPath({ points: [0, 0, 0, 0, 0, 0], vertexTypes: [0], featherPx: [1, 2] }),
    ).toThrow(/set_mask_path/);
    expect(() => decodeMaskPath({ points: [0, 0, 0, 0, 0, 0], vertexTypes: [7] })).toThrow(
      /corner/,
    );
  });
});

describe('display-corrected source space', () => {
  const anamorphic: SourcePictureGeometry = {
    codedWidth: 1440,
    codedHeight: 1080,
    pixelAspectRatio: 4 / 3,
  };

  it('stretches coded width by the pixel aspect ratio', () => {
    expect(displayCorrectedSize(anamorphic)).toEqual({ width: 1920, height: 1080 });
    expect(codedToDisplay({ x: 720, y: 540 }, anamorphic)).toEqual({ x: 960, y: 540 });
  });

  it('swaps the axes for a quarter-turn phone clip', () => {
    const phone = { codedWidth: 1920, codedHeight: 1080, rotationDegrees: 90 };
    expect(displayCorrectedSize(phone)).toEqual({ width: 1080, height: 1920 });
    // The coded top-left corner lands top-right after a clockwise quarter turn.
    expect(codedToDisplay({ x: 0, y: 0 }, phone)).toEqual({ x: 1080, y: 0 });
  });

  it.each([0, 90, 180, 270, -90, 450])('round-trips every point at %i degrees', (rotation) => {
    const geometry = { ...anamorphic, rotationDegrees: rotation };
    for (const point of [
      { x: 0, y: 0 },
      { x: 1440, y: 1080 },
      { x: 333, y: 777 },
    ]) {
      const back = displayToCoded(codedToDisplay(point, geometry), geometry);
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
  });

  it('normalises rotations and refuses anything but quarter turns', () => {
    expect(normalizeQuarterTurn(-90)).toBe(270);
    expect(normalizeQuarterTurn(undefined)).toBe(0);
    expect(() => normalizeQuarterTurn(45)).toThrow(SourceGeometryError);
    expect(() => displayCorrectedSize({ codedWidth: 0, codedHeight: 10 })).toThrow(
      /Measure this media first/,
    );
  });

  it('converts between normalised coordinates and pixels', () => {
    const size = { width: 1920, height: 1080 };
    expect(normalizedToDisplayPx({ x: 0.25, y: 0.5 }, size)).toEqual({ x: 480, y: 540 });
    expect(displayPxToNormalized({ x: 480, y: 540 }, size)).toEqual({ x: 0.25, y: 0.5 });
  });

  it('reads an asset size only when both dimensions were measured', () => {
    expect(assetDisplaySize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(assetDisplaySize({ width: 1920, height: null })).toBeNull();
    expect(assetDisplaySize(null)).toBeNull();
  });
});
