/**
 * Shape params and the shape catalogue (schema v25, plan/elements EL4a). The validator messages
 * are pinned word for word: the agent's repeated-failure guard keys on them, and the engine's
 * `shape_catalog.shape_params_problem` must return the same sentences.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHAPE_CATALOG, SHAPE_PRESETS, shapePreset } from './shape-catalog.js';
import {
  ShapeParamsSchema,
  presetShapeParams,
  shapeKeysFor,
  shapeParamsProblem,
} from './shape-params.js';

const box = presetShapeParams('rounded-rect/highlight')!;
const arrow = presetShapeParams('line-arrow/red')!;

describe('the shape catalogue', () => {
  it('ships the six screen-recording staples first', () => {
    expect(SHAPE_PRESETS.map(({ preset }) => preset.name)).toEqual([
      'Highlight box',
      'Filled box',
      'Ellipse',
      'Marker',
      'Arrow',
      'Underline',
    ]);
  });

  it('has unique shape and preset ids, each preset under its own shape', () => {
    const ids = SHAPE_CATALOG.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
    const presetIds = SHAPE_PRESETS.map(({ preset }) => preset.id);
    expect(new Set(presetIds).size).toBe(presetIds.length);
    for (const { shape, preset } of SHAPE_PRESETS) {
      expect(preset.id.startsWith(`${shape.id}/`)).toBe(true);
    }
  });

  it('declares knob defaults inside their own bounds', () => {
    for (const shape of SHAPE_CATALOG) {
      for (const knob of shape.knobs) {
        expect(knob.default).toBeGreaterThanOrEqual(knob.min);
        expect(knob.default).toBeLessThanOrEqual(knob.max);
      }
    }
  });

  it('inserts every preset as params the validator accepts', () => {
    for (const { preset } of SHAPE_PRESETS) {
      const params = presetShapeParams(preset.id, { x: 30, y: 70 });
      expect(params, preset.id).toBeDefined();
      expect(shapeParamsProblem(params!), preset.id).toBeNull();
      expect(ShapeParamsSchema.safeParse(params).success, preset.id).toBe(true);
    }
  });

  it('centres a box on the target and hangs a segment off it', () => {
    expect(box).toMatchObject({ shape: 'rounded-rect', x: 50, y: 50, cornerRadius: 12 });
    expect(presetShapeParams('line-arrow/red', { x: 60, y: 40 })).toMatchObject({
      x1: 48,
      y1: 28,
      x2: 60,
      y2: 40,
      endCap: 'arrow',
      headSize: 4,
    });
    expect(presetShapeParams('nope/none')).toBeUndefined();
    expect(shapePreset('ellipse/outline')?.shape.frame).toBe('box');
  });

  it('matches the committed schema/shape-catalog.json (run `schema:generate` after editing)', () => {
    const committed = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          'schema',
          'shape-catalog.json',
        ),
        'utf8',
      ),
    ) as unknown;
    expect(committed).toEqual(JSON.parse(JSON.stringify({ shapes: SHAPE_CATALOG })));
  });
});

describe('shapeParamsProblem', () => {
  it('accepts a complete box and a complete segment', () => {
    expect(shapeParamsProblem(box)).toBeNull();
    expect(shapeParamsProblem(arrow)).toBeNull();
  });

  it('names an unknown shape and where to find one', () => {
    expect(shapeParamsProblem({ ...box, shape: 'dodecahedron' })).toBe(
      "There is no shape called 'dodecahedron'. Pick one with search_elements (kind: shape) or from the Shapes tab.",
    );
  });

  it('refuses a key the shape does not have, listing the ones it does', () => {
    expect(shapeParamsProblem({ ...box, headSize: 3 })).toBe(
      "Shape parameter 'headSize' is not one this shape has. Its parameters are: shape, x, y, width, height, fill, stroke, strokeWidth, strokeStyle, cornerRadius.",
    );
  });

  it('refuses the wrong frame for the shape', () => {
    const { x, y, width, height, ...rest } = box;
    void [x, y, width, height];
    expect(shapeParamsProblem({ ...rest, x1: 1, y1: 1, x2: 2, y2: 2 })).toBe(
      "'rounded-rect' is placed by a box (x, y, width, height), not by two ends.",
    );
    expect(shapeParamsProblem({ ...arrow, x: 50 })).toBe(
      "'line-arrow' is placed by its two ends (x1, y1, x2, y2), not a box.",
    );
  });

  it('refuses a box missing part of its frame', () => {
    const { width: _width, ...noWidth } = box;
    expect(shapeParamsProblem(noWidth)).toBe(
      "'rounded-rect' needs its box: x, y, width and height.",
    );
  });

  it('bounds knobs by the descriptor, without echoing the value', () => {
    expect(shapeParamsProblem({ ...box, cornerRadius: 80 })).toBe(
      'cornerRadius must be between 0 and 50.',
    );
    expect(shapeParamsProblem({ ...box, cornerRadius: 81 })).toBe(
      shapeParamsProblem({ ...box, cornerRadius: 80 }),
    );
  });

  it('refuses a shape that would draw nothing', () => {
    expect(shapeParamsProblem({ ...box, fill: null, stroke: null })).toBe(
      'A shape needs a fill or a stroke — with both off it draws nothing.',
    );
    expect(shapeParamsProblem({ ...arrow, stroke: null })).toBe(
      "'line-arrow' is drawn by its stroke — with the stroke off it draws nothing. Set a stroke colour.",
    );
  });

  it('refuses caps on a box and bad colours with a hint', () => {
    expect(shapeParamsProblem({ ...box, endCap: 'arrow' })).toBe(
      "'rounded-rect' has no ends to cap; startCap and endCap are for lines and arrows.",
    );
    expect(shapeParamsProblem({ ...box, stroke: 'yellow' })).toBe(
      "Shape parameter 'stroke' is out of range or the wrong type. A colour is #rrggbb or #rrggbbaa, or null for none.",
    );
    expect(shapeParamsProblem({ ...box, x: 120 })).toBe(
      "Shape parameter 'x' is out of range or the wrong type. A box centre is a percent of the frame, 0 to 100.",
    );
  });

  it('lists a segment’s caps among its keys and a box’s not', () => {
    expect(shapeKeysFor(shapePreset('line-arrow/red')!.shape)).toContain('endCap');
    expect(shapeKeysFor(shapePreset('ellipse/outline')!.shape)).not.toContain('endCap');
  });
});

describe('the shared validation vectors (tests/fixtures/shape-params.json)', () => {
  const fixture = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../tests/fixtures/shape-params.json',
      ),
      'utf8',
    ),
  ) as { cases: { name: string; params: Record<string, unknown>; problem: string | null }[] };

  it.each(fixture.cases)('$name', ({ params, problem }) => {
    // The engine's `shape_params_problem` reads the same table, so the two agree on every row.
    expect(shapeParamsProblem(params)).toBe(problem);
  });
});
