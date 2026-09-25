/**
 * Tile outlines (plan/elements EL5.1): every preset in the catalogue draws a tile, icons draw once
 * their outlines have loaded, and catalogue paths map onto the tile box.
 */
import { describe, expect, it } from 'vitest';
import { SHAPE_PRESETS, iconShapeDescriptor } from '@framepilot/timeline-schema';
import { boxTileOutline, mapCataloguePath, tileBoxFor } from './shape-tile-outline.js';
import { loadShapeIconPaths } from './useShapeIconPaths.js';

describe('shape tile outlines', () => {
  it('draws every box preset once the icon outlines are loaded', async () => {
    const icons = await loadShapeIconPaths();
    for (const { shape, preset } of SHAPE_PRESETS) {
      if (shape.frame !== 'box') continue;
      const outline = boxTileOutline(shape, preset, tileBoxFor(shape, 64), icons);
      expect(outline?.d, preset.id).toMatch(/^M /);
    }
  });

  it('waits for an icon outline, then draws it open (stroke only)', async () => {
    const check = iconShapeDescriptor('icon/check')!;
    const box = tileBoxFor(check, 64);
    expect(boxTileOutline(check, check.presets[0]!, box, null)).toBeNull();
    const outline = boxTileOutline(check, check.presets[0]!, box, await loadShapeIconPaths());
    expect(outline).toMatchObject({ fills: false });
  });

  it('cuts a ring out even-odd and leaves corner marks unfilled', () => {
    const ring = SHAPE_PRESETS.find(({ preset }) => preset.id === 'circle-frame/white')!;
    const corners = SHAPE_PRESETS.find(({ preset }) => preset.id === 'viewfinder-corners/yellow')!;
    expect(boxTileOutline(ring.shape, ring.preset, [0, 0, 64, 64], null)).toMatchObject({
      fillRule: 'evenodd',
      fills: true,
    });
    expect(boxTileOutline(corners.shape, corners.preset, [0, 0, 64, 64], null)?.fills).toBe(false);
  });

  it('maps a 0–100 catalogue path onto the tile box', () => {
    expect(mapCataloguePath('M 0 0 L 100 50 C 0 0 50 50 100 100 Z', [10, 20, 30, 60])).toBe(
      'M 10 20 L 30 40 C 10 20 20 40 30 60 Z',
    );
  });

  it('keeps a wide shape wide and a tall one tall inside the tile', () => {
    const pill = SHAPE_PRESETS.find(({ shape }) => shape.id === 'pill')!.shape;
    const [left, top, right, bottom] = tileBoxFor(pill, 64);
    expect(right - left).toBeGreaterThan(bottom - top);
  });
});
