/**
 * `add_stock`'s host payload — the process boundary, and what survives it.
 *
 * The payload is parsed, not trusted, which means the schema REBUILDS the asset field by
 * field: anything it does not name is discarded however carefully the host sent it. That is
 * how an agent-downloaded stock clip reached the project unmeasured while the Stock panel's
 * identical download did not — the panel keeps `media.width`/`height`
 * (`StockPanel.tsx`), the wire carries them (`shared-types/ipc.ts#StockDownloadedAssetWire`),
 * and only this schema dropped them.
 *
 * It matters twice over. The placement guard decides coverage from measured shapes (ADR
 * 0170) and refuses a mixed stack it cannot measure; `add_clip`'s auto-reframe crops from
 * measured dimensions only. Stock media is overwhelmingly 16:9, so a portrait project's
 * b-roll is exactly the case both exist for — and both were disarmed by the absence.
 */
import { describe, expect, it } from 'vitest';
import { StockAssetPayloadSchema, stockOpsFromPayload } from './stock-placement.js';
import { makeProject } from './__fixtures__/project.js';

const payload = (media: Record<string, unknown>, atSeconds?: number): unknown => ({
  ...(atSeconds === undefined ? {} : { atSeconds }),
  asset: {
    id: 'stock_1',
    path: 'media/stock/pexels-1.mp4',
    kind: 'video',
    durationSeconds: 8,
    media,
    source: {
      provider: 'pexels',
      remoteId: '1',
      license: 'Pexels',
      attributionRequired: false,
      fetchedAt: '2026-09-03T00:00:00.000Z',
    },
  },
});

describe('StockAssetPayloadSchema — the measured shape crosses the boundary', () => {
  it('keeps width and height alongside the proxy', () => {
    const parsed = StockAssetPayloadSchema.parse(
      payload({ width: 1920, height: 1080, proxyPath: 'proxies/stock_1.mp4' }),
    );
    expect(parsed.asset.media).toMatchObject({
      width: 1920,
      height: 1080,
      proxyPath: 'proxies/stock_1.mp4',
    });
  });

  it('accepts a download nothing probed — half a shape is not a shape', () => {
    const parsed = StockAssetPayloadSchema.parse(payload({ proxyPath: null }));
    expect(parsed.asset.media?.width).toBeUndefined();
  });

  it('carries the shape onto the `add_asset` operation, which is where it has to land', () => {
    const parsed = StockAssetPayloadSchema.parse(payload({ width: 1920, height: 1080 }));
    const outcome = stockOpsFromPayload(makeProject({}), parsed);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.operations).toEqual([
      { type: 'add_asset', asset: expect.objectContaining({ id: 'stock_1' }) },
    ]);
    const asset = (outcome.operations[0] as { asset: { media?: { width?: number } } }).asset;
    expect(asset.media?.width).toBe(1920);
  });
});

/**
 * The cutaway `add_stock` exists to make.
 *
 * `buildAddStockOps` picks its own track and so could only ever place into empty time, which
 * left the one tool for sourcing footage the user never filmed unable to place a cutaway
 * (run 19e20922: 35 of 38 calls refused). ADR 0169 lifts a full-frame placement onto a
 * layer in front of what it covers; nothing in that rule is about which tool asked.
 */
describe('stockOpsFromPayload — an occupied span is lifted, not refused', () => {
  const measuredBase = () =>
    makeProject({
      assets: [
        {
          id: 'asset_1',
          path: 'media/a.mp4',
          kind: 'video',
          durationSeconds: 30,
          media: { width: 1920, height: 1080 },
        },
      ],
    } as never);

  it('opens a layer in front and crops the clip the lane was chosen on', () => {
    const parsed = StockAssetPayloadSchema.parse(payload({ width: 1920, height: 1080 }, 2));
    const outcome = stockOpsFromPayload(measuredBase(), parsed);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.start).toBe(2);
    const types = outcome.operations.map((op) => op.type);
    expect(types).toContain('add_asset');
    expect(types).toContain('add_layer');
    expect(types).toContain('add_clip');
    const placed = outcome.operations.find((op) => op.type === 'add_clip') as {
      trackId: string;
      start: number;
      end: number;
    };
    // In FRONT of the footage it covers, which is what makes it a cutaway rather than a
    // clip nobody will ever see.
    const layer = outcome.operations.find((op) => op.type === 'add_layer') as {
      layerId: string;
      atIndex: number;
    };
    expect(placed.trackId).toBe(layer.layerId);
    expect(layer.atIndex).toBe(0);
    expect(placed.start).toBe(2);
    expect(placed.end).toBe(10);
  });

  it('still refuses a placement that cannot be shown, and says which rule', () => {
    // Unmeasured over measured: nothing can say whether its bars line up, so lifting it
    // would preview differently from how it exports.
    const parsed = StockAssetPayloadSchema.parse(payload({ proxyPath: null }, 2));
    const outcome = stockOpsFromPayload(measuredBase(), parsed);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.refusalCause).toBe('picture_over_picture');
    expect(outcome.reason).toContain('has not been measured');
  });
});
