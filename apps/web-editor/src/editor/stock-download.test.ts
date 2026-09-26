/**
 * The checked apply every manual placement shares (Pexels Add, Add as overlay and drops, a bin
 * image laid over the footage, a sticker or shape dropped on the monitor): a refusal is logged
 * under what was being placed, not as a stock placement whatever it was.
 */
import { describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    action: vi.fn(),
    child: () => logger,
  };
  return logger;
});
vi.mock('@framepilot/shared-types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@framepilot/shared-types')>()),
  createLogger: () => log,
}));

const { applyStockPatch, STOCK_PLACEMENT_REJECTED } = await import('./stock-download.js');

const patch = {
  patchId: 'imageoverlay_asset_logo_layer_video_2_4000',
  createdBy: 'user',
  reason: 'Add “logo.png” as an overlay',
  operations: [],
} as unknown as Parameters<typeof applyStockPatch>[1];

describe('applyStockPatch', () => {
  it('logs a refusal under what was being placed, with the validator’s reasons', () => {
    const applyChecked = () =>
      [{ code: 'overlap', severity: 'error', message: "Clips 'a' and 'b' overlap" }] as never;
    expect(applyStockPatch(applyChecked, patch, 'bin image overlay')).toBe(
      STOCK_PLACEMENT_REJECTED,
    );
    expect(log.warn).toHaveBeenCalledWith('placement refused by the timeline', {
      placement: 'bin image overlay',
      patchId: patch.patchId,
      issues: ["Clips 'a' and 'b' overlap"],
    });
  });

  it('logs nothing once the timeline takes the patch', () => {
    log.warn.mockClear();
    expect(applyStockPatch(() => [], patch, 'shape dropped on the monitor')).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
