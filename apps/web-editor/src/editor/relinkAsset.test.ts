import { describe, expect, it, vi } from 'vitest';
import type { MatteValidationIssueWire } from '@framepilot/shared-types';
import { relinkAsset, relinkedMatteIssues, relinkStatusMessage } from './relinkAsset.js';

const stale: MatteValidationIssueWire = {
  clipId: 'c1',
  maskId: 'm1',
  artifactKey: 'a'.repeat(64),
  code: 'matte_media_changed',
  status: 'stale',
  remedy: 'Media changed since background removal ran — run Remove background again.',
};

describe('relinkAsset', () => {
  it('commits a relink_asset patch for the file main chose, then re-checks mattes on that asset', async () => {
    const applyPatch = vi.fn();
    const matteRecheckMedia = vi.fn(async () => ({ ok: true as const, issues: [stale] }));
    const outcome = await relinkAsset('asset-1', {
      bridge: {
        projectChooseRelinkFile: async () => ({ ok: true, assetId: 'asset-1', path: '/new/take2.mov' }),
        matteRecheckMedia,
      },
      applyPatch,
    });
    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch.mock.calls[0]![0]).toMatchObject({
      createdBy: 'user',
      operations: [{ type: 'relink_asset', assetId: 'asset-1', path: '/new/take2.mov' }],
    });
    expect(matteRecheckMedia).toHaveBeenCalledWith({ assetIds: ['asset-1'] });
    expect(outcome).toEqual({ status: 'relinked', path: '/new/take2.mov', staleMattes: [stale] });
    expect(relinkStatusMessage(outcome)).toBe(
      'Media relinked. 1 background removal needs updating: Media changed since background removal ran — run Remove background again.',
    );
  });

  it('does nothing on cancel, reports failures, and needs the desktop bridge', async () => {
    const applyPatch = vi.fn();
    expect(
      await relinkAsset('a', { bridge: { projectChooseRelinkFile: async () => ({ ok: false, code: 'cancelled', error: 'x' }) }, applyPatch }),
    ).toEqual({ status: 'cancelled' });
    expect(relinkStatusMessage({ status: 'cancelled' })).toBeUndefined();
    expect(
      await relinkAsset('a', {
        bridge: { projectChooseRelinkFile: async () => ({ ok: false, code: 'not_a_file', error: 'Choose a media file, not a folder or link.' }) },
        applyPatch,
      }),
    ).toEqual({ status: 'failed', message: 'Choose a media file, not a folder or link.' });
    expect(await relinkAsset('a', { bridge: {}, applyPatch })).toMatchObject({ status: 'failed' });
    expect(applyPatch).not.toHaveBeenCalled();
    expect(
      relinkStatusMessage(
        await relinkAsset('a', {
          bridge: { projectChooseRelinkFile: async () => ({ ok: true, assetId: 'a', path: '/x.mov' }), matteRecheckMedia: async () => ({ ok: true, issues: [] }) },
          applyPatch,
        }),
      ),
    ).toBe('Media relinked.');
  });

  it('keeps what main found for the file it chose, until the asset points elsewhere (E2E.6)', async () => {
    await relinkAsset('asset-9', {
      bridge: {
        projectChooseRelinkFile: async () => ({ ok: true, assetId: 'asset-9', path: '/new/take3.mov' }),
        matteRecheckMedia: async () => ({ ok: true as const, issues: [stale] }),
      },
      applyPatch: vi.fn(),
    });
    // The Inspector reads it before the relink is saved (main's own re-check reads the disk).
    expect(relinkedMatteIssues('asset-9', '/new/take3.mov')).toEqual([stale]);
    // Undone (the asset points at its old file again), or another asset: nothing.
    expect(relinkedMatteIssues('asset-9', 'media/take1.mov')).toEqual([]);
    expect(relinkedMatteIssues('asset-8', '/new/take3.mov')).toEqual([]);
    expect(relinkedMatteIssues(null, undefined)).toEqual([]);
  });
});
