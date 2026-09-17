/**
 * MK3.1: the preview rasteriser reproduces the engine's stored vectors byte for byte.
 *
 * `tests/fixtures/mask-raster/*.json` is written by the engine (`pnpm mask-raster:vectors`);
 * this file follows the same case format as `engine/python/tests/mask_raster_vectors.py`:
 * layers in SOURCE units of `sourceSize`, rasterised at each stored resolution with
 * `scale = raster / source`, zero offsets, and `min(scaleX, scaleY)` for expansion and feathers.
 * CI runs it on Linux (node-quality) and on macOS arm64 + Windows x64 (mask-raster-vectors).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FALLOFF_TABLE_SIZE,
  ellipsePath,
  flattenPath,
  gaussianFalloffTable,
  pathFromPoints,
  quantizeAlpha,
  rectanglePath,
  roundHalfEven,
  scaleFeathers,
  stackAlpha,
  toRaster,
  type BezierPath,
  type MaskCombineMode,
  type MaskFalloff,
  type RasterStackLayer,
} from './mask-raster';

const REPO = path.resolve(__dirname, '../../../../..');
const FIXTURE_DIR = path.join(REPO, 'tests', 'fixtures', 'mask-raster');
const AREAS = ['coverage', 'feather', 'stack'] as const;

interface VectorShape {
  kind: 'rectangle' | 'ellipse' | 'path';
  cx: number;
  cy: number;
  width: number;
  height: number;
  rx: number;
  ry: number;
  rotation: number;
  roundness: number;
  points: number[];
  featherPx?: number[];
  firstVertex?: number;
}

interface VectorLayer {
  shape: VectorShape;
  mode: MaskCombineMode;
  opacity: number;
  invert: boolean;
  expansionPx: number;
  featherInnerPx: number;
  featherOuterPx: number;
  falloff: MaskFalloff;
}

interface VectorDocument {
  sourceSize: [number, number];
  cases: {
    id: string;
    layers: VectorLayer[];
    expected: { width: number; height: number; alpha: string }[];
  }[];
}

function pathFor(shape: VectorShape): BezierPath {
  if (shape.kind === 'rectangle') {
    return rectanglePath(
      shape.cx,
      shape.cy,
      shape.width,
      shape.height,
      shape.rotation,
      shape.roundness,
    );
  }
  if (shape.kind === 'ellipse')
    return ellipsePath(shape.cx, shape.cy, shape.rx, shape.ry, shape.rotation);
  return pathFromPoints(shape.points, shape.featherPx ?? null, shape.firstVertex ?? 0);
}

function rasterLayers(
  layers: VectorLayer[],
  source: [number, number],
  width: number,
  height: number,
): RasterStackLayer[] {
  const scaleX = width / source[0];
  const scaleY = height / source[1];
  const distance = Math.min(scaleX, scaleY);
  return layers.map((layer) => ({
    shape: {
      polyline: scaleFeathers(
        toRaster(flattenPath(pathFor(layer.shape)), scaleX, scaleY, 0.0, 0.0),
        distance,
      ),
      expansion: layer.expansionPx * distance,
      featherInner: layer.featherInnerPx * distance,
      featherOuter: layer.featherOuterPx * distance,
      falloff: layer.falloff,
    },
    mode: layer.mode,
    opacity: layer.opacity,
    invert: layer.invert,
  }));
}

function load(area: string): VectorDocument {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${area}.json`), 'utf8')) as VectorDocument;
}

describe('mask-raster vectors (byte-exact vs the engine)', () => {
  let checked = 0;
  for (const area of AREAS) {
    it(`reproduces every ${area} vector at every stored resolution`, () => {
      const document = load(area);
      const mismatches: string[] = [];
      for (const vectorCase of document.cases) {
        for (const expected of vectorCase.expected) {
          const { width, height } = expected;
          const layers = rasterLayers(vectorCase.layers, document.sourceSize, width, height);
          const actual = quantizeAlpha(stackAlpha(layers, width, height));
          const stored = Buffer.from(expected.alpha, 'base64');
          expect(stored.length).toBe(width * height);
          let differing = 0;
          for (let i = 0; i < stored.length; i += 1) if (stored[i] !== actual[i]) differing += 1;
          if (differing > 0)
            mismatches.push(`${vectorCase.id} @${width}x${height}: ${differing} px differ`);
          checked += 1;
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('covers every stored case at three resolutions', () => {
    let cases = 0;
    for (const area of AREAS) {
      for (const vectorCase of load(area).cases) {
        expect(vectorCase.expected.map((e) => [e.width, e.height])).toEqual([
          [64, 48],
          [40, 30],
          [23, 17],
        ]);
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(36);
    expect(checked).toBe(cases * 3);
  });
});

describe('mask-raster primitives', () => {
  it('rounds half to even like numpy rint', () => {
    expect(
      [0.5, 1.5, 2.5, -0.5, -1.5, 127.5, 128.5, 0.49999999999999994].map(roundHalfEven),
    ).toEqual([0, 2, 2, 0, -2, 128, 128, 0]);
  });

  it('decodes the shipped gaussian table with pinned end points', () => {
    const table = gaussianFalloffTable();
    expect(table.length).toBe(FALLOFF_TABLE_SIZE);
    expect(table[0]).toBe(0);
    expect(table[FALLOFF_TABLE_SIZE - 1]).toBe(1);
  });

  it('refuses a path with fewer than three vertices', () => {
    expect(() => pathFromPoints([0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0])).toThrow(/three vertices/);
  });
});
