/**
 * The one definition of synthetic asset ids and clip kind (plan/elements EL3). The table in
 * `tests/fixtures/clip-kind.json` is shared with `engine/python/tests/test_synthetic_assets.py`,
 * so both runtimes answer every row the same way.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTION_ASSET_ID,
  SYNTHETIC_ASSET_IDS,
  TEXT_OVERLAY_ASSET_ID,
  clipRenderKind,
  hasTimeBasedSource,
  isSyntheticAssetId,
  laneTypeForKind,
  syntheticClipKind,
} from './synthetic-assets.js';

interface ClipKindCase {
  readonly assetId: string;
  readonly assetKind: string | null;
  readonly kind: string;
  readonly synthetic: boolean;
  readonly hasTimeBasedSource: boolean;
  readonly laneType: string;
}

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/clip-kind.json',
);
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: ClipKindCase[] };

describe('synthetic assets and clip kind', () => {
  it.each(cases)('$assetId ($assetKind) → $kind', (row) => {
    const kind = clipRenderKind(row.assetId, row.assetKind);
    expect(kind).toBe(row.kind);
    expect(isSyntheticAssetId(row.assetId)).toBe(row.synthetic);
    expect(hasTimeBasedSource({ assetId: row.assetId })).toBe(row.hasTimeBasedSource);
    expect(laneTypeForKind(kind)).toBe(row.laneType);
  });

  it('names what each synthetic id draws, and nothing for media', () => {
    expect(syntheticClipKind(TEXT_OVERLAY_ASSET_ID)).toBe('text');
    expect(syntheticClipKind(CAPTION_ASSET_ID)).toBe('caption');
    expect(syntheticClipKind('cam-a')).toBeNull();
  });

  it('keeps the persisted sentinel values', () => {
    // Saved projects hold these strings; changing one orphans every title or caption in them.
    expect([...SYNTHETIC_ASSET_IDS].sort()).toEqual(['__caption__', '__text__']);
  });
});
