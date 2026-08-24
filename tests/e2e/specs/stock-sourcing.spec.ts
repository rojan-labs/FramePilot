/**
 * Stock photo & video sourcing — the browser-reachable slice
 * (plan/3rd-party-sourcing/photo-video P2.3, P3.8).
 *
 * Reaching a provider needs the Electron main process: the renderer's CSP forbids
 * it, deliberately and permanently (README §4). This harness boots neither
 * Electron nor the sidecar, so a real search, preview or download cannot run here
 * and is NOT attempted.
 *
 * Scope, stated plainly rather than implied. The desktop halves are covered where
 * they actually execute:
 *  - Search, tile bytes, hover preview, download, dedupe, cancel, oversize,
 *    truncated body and the shared ledger:
 *    `apps/desktop/electron/media/stock-service.test.ts` (30 tests).
 *  - The quota store, including the monthly/hourly split and its persistence:
 *    `apps/desktop/electron/media/stock-quota.test.ts` (19 tests).
 *  - Provider normalization and every HTTP arm:
 *    `packages/ai-sdk/src/providers/pexels-stock.test.ts` (36 tests).
 *  - Every row of the CONTRACTS §5 UI matrix, the hover-scrub behaviour and the
 *    keyboard model: `apps/web-editor/src/components/StockPanel.test.tsx` (38).
 *  - The placement refusal that keeps preview and export in agreement:
 *    `apps/web-editor/src/editor/stock-placement.test.ts` and
 *    `packages/editor-core/src/picture-occupancy.test.ts`.
 *  - The CSP guarantee itself: `apps/desktop/electron/security/media-protocol.test.ts`.
 *
 * What is left for THIS suite is what only a real browser can prove: that the web
 * build degrades by ABSENCE rather than by breakage, and that no provider origin
 * is reachable from the shipped page.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './helpers.js';

test.describe('stock sourcing degrades by absence in the browser build', () => {
  test('the Stock tab is not offered at all', async ({ page }) => {
    await openEditor(page);

    // Absent, not present-and-broken. A tab that opens a panel explaining it
    // cannot work costs a click to learn nothing.
    await expect(page.getByRole('tab', { name: 'Stock' })).toHaveCount(0);

    // The rest of the rail is untouched: the gate hides two tabs, not the shelf.
    for (const name of ['Assets', 'Effects', 'Transitions', 'Text', 'Captions']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
  });

  test('no provider origin is reachable from the page', async ({ page }) => {
    // Structural, not conventional: search results cross the bridge stripped of
    // every URL, and the browser build has no bridge at all. If a provider host
    // ever appears here, something upstream started handing the renderer one.
    await openEditor(page);
    const html = await page.content();
    for (const host of ['api.pexels.com', 'images.pexels.com', 'player.vimeo.com']) {
      expect(html).not.toContain(host);
    }
  });
});
