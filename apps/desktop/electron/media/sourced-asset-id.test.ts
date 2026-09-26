/**
 * One formula for a sourced asset's id, in main and in the renderer: the renderer's copies are
 * pinned here so a placed asset and the file main wrote always share an id.
 */
import { describe, expect, it } from 'vitest';
import { elementAssetId } from '@framepilot/editor-core';
import { sourcedAssetId } from './sourced-asset-id.js';

describe('sourcedAssetId', () => {
  it('mints stock, music and element ids with only [A-Za-z0-9_]', () => {
    expect(sourcedAssetId('stock', 'pexels', '4321')).toBe('stock_pexels_4321');
    expect(sourcedAssetId('music', 'openverse', 'a-b/c')).toBe('music_openverse_a_b_c');
    expect(sourcedAssetId('element', 'fluent3d', 'thumbs_up')).toBe('element_fluent3d_thumbs_up');
  });

  it('agrees with the renderer’s element ids (editor-core elementAssetId)', () => {
    for (const itemId of ['fire', 'thumbs_up', 'face_with_tears_of_joy', '1st_place_medal']) {
      expect(sourcedAssetId('element', 'fluent3d', itemId)).toBe(
        elementAssetId('fluent3d', itemId),
      );
    }
  });
});
