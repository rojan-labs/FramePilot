/**
 * The Lucide icons as shapes (plan/elements EL5.5). `scripts/elements/build_icons.mjs` writes the
 * outlines (`schema/shape-icons.json`) and their names (`shape-icon-names.ts`); the validator
 * reads only the names, so the two must list the same icons, and every icon the catalogue draws
 * must be one of them. The engine pins its own copy in `test_shape_icons.py`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SHAPE_CATALOG,
  SHAPE_ICON_PREFIX,
  catalogShape,
  iconShapeDescriptor,
  shapePreset,
} from './shape-catalog.js';
import { SHAPE_ICON_NAMES } from './shape-icon-names.js';
import { presetShapeParams, shapeParamsProblem } from './shape-params.js';

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const icons = JSON.parse(readFileSync(path.join(schemaDir, 'shape-icons.json'), 'utf8')) as {
  readonly source: string;
  readonly icons: readonly { readonly id: string; readonly path: string }[];
};

describe('shape icons', () => {
  it('lists the same icons as the outlines file, in the same order', () => {
    expect(SHAPE_ICON_NAMES.map((name) => `${SHAPE_ICON_PREFIX}${name}`)).toEqual(
      icons.icons.map((icon) => icon.id),
    );
    expect(SHAPE_ICON_NAMES.length).toBeGreaterThan(1500);
  });

  it('keeps the Lucide licence beside the data and names it in the source line', () => {
    const licence = readFileSync(path.join(schemaDir, 'LICENSE-lucide.txt'), 'utf8');
    expect(licence).toContain('ISC License');
    expect(icons.source).toContain('LICENSE-lucide.txt');
  });

  it('draws only icons that exist', () => {
    for (const shape of SHAPE_CATALOG) {
      const icon = shape.geometry?.icon;
      if (icon !== undefined) expect(SHAPE_ICON_NAMES, shape.id).toContain(icon);
    }
  });

  it('resolves an icon id to a box path shape whose id is its own preset', () => {
    const check = iconShapeDescriptor('icon/check');
    expect(check).toMatchObject({ frame: 'box', generator: 'path', geometry: { icon: 'check' } });
    expect(catalogShape('icon/check')?.id).toBe('icon/check');
    expect(iconShapeDescriptor('icon/not-an-icon')).toBeUndefined();
    expect(iconShapeDescriptor('check')).toBeUndefined();
    expect(shapePreset('icon/check')?.preset).toMatchObject({ stroke: '#FFFFFF', fill: null });
    const params = presetShapeParams('icon/check', { x: 20, y: 30 });
    expect(params).toMatchObject({ shape: 'icon/check', x: 20, y: 30, width: 24, height: 24 });
    expect(shapeParamsProblem(params!)).toBeNull();
  });
});
