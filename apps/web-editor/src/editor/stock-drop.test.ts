/**
 * A Pexels photo or video tile dropped on the timeline (plan/elements EL9, 02 §3): it downloads
 * through the panel's own Add flow — the same registry, so the tile shows the same progress,
 * Cancel and failure — then one patch places it at the drop time: on the picture lane it was
 * dropped on when that lane has room, else on a new lane in front. When the timeline changed
 * during the download so the lane no longer has room, it still lands, and says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProjectPatch, invertProjectPatch, validatePatch } from '@framepilot/editor-core';
import type {
  StockDownloadedAssetWire,
  StockDownloadRequest,
  StockDownloadResult,
} from '@framepilot/shared-types';
import type { Asset, Project, Timeline } from '@framepilot/timeline-schema';
import { resetDownloadRegistriesForTests, stockDownloads } from './download-registry.js';
import { placeDroppedStock, type StockDrop } from './stock-drop.js';
import { stockErrorText } from './stock-download.js';

const CAMERA: Asset = { id: 'cam', path: 'media/p/cam.mp4', kind: 'video', durationSeconds: 60 };

const downloaded: StockDownloadedAssetWire = {
  relativePath: 'media/p/city-3129671.mp4',
  kind: 'video',
  durationSeconds: 6,
  media: { width: 1920, height: 1080, proxyPath: 'media/p/city.proxy.mp4' },
  source: {
    provider: 'pexels',
    remoteId: '3129671',
    license: 'pexels',
    attributionRequired: false,
    attribution: 'Video by Ruvim on Pexels',
    fetchedAt: '2026-09-26T12:00:00.000Z',
  },
  deduped: false,
};

const clip = (id: string, start: number, end: number) => ({
  id,
  assetId: 'cam',
  trackId: 'video_1',
  start,
  end,
  sourceStart: start,
  sourceEnd: end,
  effects: [],
  keyframes: [],
});

/** Footage 0–5s, then a gap: a drop at 5s on `video_1` has room there. */
const GAP: Timeline = {
  tracks: [
    { id: 'graphics', type: 'overlay', clips: [] },
    { id: 'video_1', type: 'video', clips: [clip('c1', 0, 5)] },
  ],
} as unknown as Timeline;

/** The same lane, filled while the download ran. */
const FILLED: Timeline = {
  tracks: [
    { id: 'graphics', type: 'overlay', clips: [] },
    { id: 'video_1', type: 'video', clips: [clip('c1', 0, 5), clip('c2', 5, 20)] },
  ],
} as unknown as Timeline;

function projectOf(timeline: Timeline): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [CAMERA],
    folders: [],
    timeline,
  } as unknown as Project;
}

function deps(answer: StockDownloadResult | Promise<StockDownloadResult>) {
  return {
    download: vi.fn(async (_request: StockDownloadRequest) => answer),
    registry: stockDownloads,
  };
}

function drop(overrides: Partial<StockDrop> = {}): StockDrop {
  return {
    projectId: 'p',
    remoteId: '3129671',
    atSeconds: 5,
    trackId: 'video_1',
    targetHeight: 1080,
    targetFps: 30,
    atDrop: { timeline: GAP, assets: [CAMERA] },
    target: () => ({ timeline: GAP, assets: [CAMERA] }),
    ...overrides,
  };
}

afterEach(() => resetDownloadRegistriesForTests());

describe('placeDroppedStock', () => {
  it('downloads by remote id at the project height, then lands on the lane it was dropped on', async () => {
    const d = deps({ ok: true, asset: downloaded });
    const placed = await placeDroppedStock(d, drop());
    expect(d.download).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p', remoteId: '3129671', targetHeight: 1080 }),
    );
    if (!placed.ok) throw new Error(placed.message);
    expect(placed.notice).toBeNull();
    const { patch, clipId } = placed.added;
    const check = validatePatch(GAP, patch, { assetIds: [CAMERA.id], folders: [] });
    expect(check.valid, JSON.stringify(check.issues)).toBe(true);
    const before = projectOf(GAP);
    const after = applyProjectPatch(before, patch);
    const landed = after.timeline.tracks[1]!.clips.find((c) => c.id === clipId);
    expect(landed).toMatchObject({ assetId: 'stock_pexels_3129671', start: 5, end: 11 });
    // The asset keeps the measured shape the download carried.
    expect(after.assets.find((a) => a.id === 'stock_pexels_3129671')?.media).toMatchObject({
      width: 1920,
      height: 1080,
    });
    // One undo step takes back the clip and the asset.
    const undone = applyProjectPatch(after, invertProjectPatch(before, patch));
    expect(undone.assets).toEqual(before.assets);
    expect(undone.timeline.tracks).toEqual(before.timeline.tracks);
    // The tile is idle again: nothing left in flight or failed.
    expect(stockDownloads.getSnapshot()['3129671']).toBeUndefined();
  });

  it('still lands when the lane filled up during the download, and says so without numbers', async () => {
    const placed = await placeDroppedStock(
      deps({ ok: true, asset: downloaded }),
      drop({ target: () => ({ timeline: FILLED, assets: [CAMERA] }) }),
    );
    if (!placed.ok) throw new Error(placed.message);
    expect(placed.added.onDroppedLane).toBe(false);
    expect(placed.notice).toBe(
      'The lane you dropped this on had no room by the time it downloaded, so it went on a new lane in front.',
    );
    expect(placed.notice).not.toMatch(/\d/);
    const after = applyProjectPatch(projectOf(FILLED), placed.added.patch);
    // In front of the footage, under the graphics.
    expect(after.timeline.tracks[1]!.clips[0]!.id).toBe(placed.added.clipId);
  });

  it('says nothing extra when the drop was over footage to begin with', async () => {
    const placed = await placeDroppedStock(
      deps({ ok: true, asset: downloaded }),
      drop({
        atDrop: { timeline: FILLED, assets: [CAMERA] },
        target: () => ({ timeline: FILLED, assets: [CAMERA] }),
      }),
    );
    if (!placed.ok) throw new Error(placed.message);
    expect(placed.added.onDroppedLane).toBe(false);
    expect(placed.notice).toBeNull();
  });

  it('shows a failed download on the tile as well as to the caller', async () => {
    const placed = await placeDroppedStock(deps({ ok: false, error: 'disk_full' }), drop());
    expect(placed).toEqual({ ok: false, message: stockErrorText('disk_full') });
    expect(stockDownloads.getSnapshot()['3129671']).toEqual({
      kind: 'failed',
      message: 'Not enough disk space to save this file.',
    });
  });

  it('is silent when the user cancelled it from the tile', async () => {
    const placed = await placeDroppedStock(deps({ ok: false, error: 'cancelled' }), drop());
    expect(placed).toEqual({ ok: false, message: '' });
    expect(stockDownloads.getSnapshot()['3129671']).toBeUndefined();
  });

  it('shows the download in flight on the tile, with the handle Cancel needs', async () => {
    let finish: (result: StockDownloadResult) => void = () => undefined;
    const d = deps(
      new Promise<StockDownloadResult>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = placeDroppedStock(d, drop());
    const entry = stockDownloads.getSnapshot()['3129671'];
    expect(entry).toMatchObject({ kind: 'downloading' });
    expect(d.download.mock.calls[0]![0].operationId).toBe(
      entry?.kind === 'downloading' ? entry.operationId : undefined,
    );
    finish({ ok: true, asset: downloaded });
    expect((await pending).ok).toBe(true);
  });

  it('does not start a second download of a clip already downloading', async () => {
    stockDownloads.start('3129671', 'first');
    const d = deps({ ok: true, asset: downloaded });
    const placed = await placeDroppedStock(d, drop());
    expect(d.download).not.toHaveBeenCalled();
    expect(placed).toEqual({
      ok: false,
      message: 'That clip is already downloading. Wait for it to land, then drag it from Assets.',
    });
  });

  it('says the download failed, rather than throwing, when main does not answer', async () => {
    const placed = await placeDroppedStock(
      {
        download: async () => {
          throw new Error('the window is closing');
        },
        registry: stockDownloads,
      },
      drop(),
    );
    expect(placed).toEqual({ ok: false, message: stockErrorText('download_failed') });
  });
});
