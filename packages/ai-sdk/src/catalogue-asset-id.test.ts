/**
 * Run `137d8fd0`: `detect_beats` was called with the catalogue `remoteId` the run had
 * just used to place the music, and refused, because the bin asset is that id with
 * `music_openverse_` in front and its hyphens underscored. The answer was in the error's
 * own list of known ids and the run did not spot it; the beat-synced cut never happened.
 */
import { describe, expect, it } from 'vitest';
import { resolveCatalogueAssetId, withResolvedAssetId } from './catalogue-asset-id.js';

const REMOTE = 'b6aa6604-0746-4048-915f-c75ed988747a';
const BIN = 'music_openverse_b6aa6604_0746_4048_915f_c75ed988747a';
const assets = [
  { id: 'asset_raw_skating' },
  { id: 'stock_pexels_30597982' },
  { id: 'stock_pexels_6501454' },
  { id: BIN },
];

describe('resolveCatalogueAssetId', () => {
  it('resolves the remoteId the run was handed to the bin asset it created', () => {
    expect(resolveCatalogueAssetId(REMOTE, assets)).toBe(BIN);
  });

  it('leaves an id that already names an asset alone', () => {
    expect(resolveCatalogueAssetId(BIN, assets)).toBeNull();
    expect(resolveCatalogueAssetId('asset_raw_skating', assets)).toBeNull();
  });

  it('resolves a bare catalogue number too', () => {
    expect(resolveCatalogueAssetId('30597982', assets)).toBe('stock_pexels_30597982');
  });

  it('refuses to guess when nothing matches', () => {
    expect(resolveCatalogueAssetId('cbbbbbbb-0000-0000-0000-000000000000', assets)).toBeNull();
  });

  it('refuses to guess when more than one asset matches', () => {
    const ambiguous = [{ id: 'stock_pexels_12345678' }, { id: 'music_openverse_12345678' }];
    expect(resolveCatalogueAssetId('12345678', ambiguous)).toBeNull();
  });

  it('refuses a suffix too short to be evidence', () => {
    // `ov_1` would otherwise match anything ending `_ov_1` — a coincidence here analyses
    // the wrong file silently, which is worse than the error it replaces.
    expect(resolveCatalogueAssetId('ov_1', [{ id: 'music_openverse_ov_1' }])).toBeNull();
  });

  it('only matches at a segment boundary', () => {
    expect(resolveCatalogueAssetId('91234567', [{ id: 'asset_x91234567' }])).toBeNull();
  });
});

describe('withResolvedAssetId', () => {
  it('rewrites the argument and leaves everything else untouched', () => {
    const args = { assetId: REMOTE, hardSync: true };
    expect(withResolvedAssetId('detect_beats', args, assets)).toEqual({
      assetId: BIN,
      hardSync: true,
    });
  });

  it('is a no-op for a call with no assetId, or with one that resolves to nothing', () => {
    const noAsset = { trackId: 'v1' };
    expect(withResolvedAssetId('get_clips', noAsset, assets)).toBe(noAsset);
    const known = { assetId: 'asset_raw_skating' };
    expect(withResolvedAssetId('detect_beats', known, assets)).toBe(known);
  });
});
