/**
 * Third-party music sourcing — the browser-reachable slice
 * (plan/3rd-party-sourcing P2.6, P3.5).
 *
 * Reaching a provider needs the Electron main process: the renderer's CSP
 * forbids it, deliberately and permanently (README §3). This harness boots
 * neither Electron nor the sidecar (see playwright.config.ts — the web build
 * runs fully in-browser, no network, no engine), so a real search, audition or
 * download cannot run here and is NOT attempted.
 *
 * Scope, stated plainly rather than implied. The desktop halves are covered at
 * the level where they actually execute:
 *  - Search, audition, download, dedupe, cancel, ENOSPC, truncated body and the
 *    `sources.json` ledger: `apps/desktop/electron/media/music-service.test.ts`
 *    (25 tests, injected provider and fetch).
 *  - Provider normalization, both licence gates and every HTTP arm:
 *    `packages/ai-sdk/src/providers/openverse-music.test.ts` (32 tests, recorded
 *    fixtures).
 *  - Every row of the CONTRACTS §5 UI state matrix, driven by stubbed bridge
 *    calls: `apps/web-editor/src/components/SoundsPanel.test.tsx` (29 tests).
 *  - The CSP guarantee itself: `apps/desktop/electron/security/media-protocol.test.ts`.
 *
 * What is left for THIS suite is the thing only a real browser can prove: that
 * the web build degrades by ABSENCE rather than by breakage, and that the
 * Credits surface — the half of schema v20 the user touches — renders in the
 * real app. That is the music analogue of what `brain-absent-degradation.spec.ts`
 * proves for the brain.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './helpers.js';

test.describe('music sourcing degrades by absence in the browser build', () => {
  test('the Sounds tab is not offered at all', async ({ page }) => {
    await openEditor(page);

    // Absent, not present-and-broken. A tab that opens a panel explaining it
    // cannot work costs a click to learn nothing — the failure mode this gate
    // exists to avoid.
    await expect(page.getByRole('tab', { name: 'Sounds' })).toHaveCount(0);

    // The rest of the rail is untouched: the gate hides one tab, not the shelf.
    for (const name of ['Assets', 'Effects', 'Transitions', 'Text', 'Captions']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
  });

  test('no provider origin is reachable from the page', async ({ page }) => {
    // A structural check on the shipped renderer: nothing in the running app
    // holds a provider URL, because search results cross the bridge stripped of
    // `previewUrl`/`downloadUrl` and the browser build has no bridge at all.
    await openEditor(page);
    const html = await page.content();
    for (const host of ['openverse.org', 'freesound.org', 'jamendo.com']) {
      expect(html).not.toContain(host);
    }
  });
});

test.describe('Credits at export', () => {
  test('confirms there is nothing to credit rather than leaving a blank panel', async ({
    page,
  }) => {
    // The demo project's assets were imported, not fetched, so none carries an
    // `Asset.source`. "Nothing to do" is the answer to a real question — a blank
    // section would send the user off to check their licences by hand.
    await openEditor(page);
    await page.getByRole('button', { name: 'Export video' }).click();

    const dialog = page.getByRole('dialog', { name: 'Export video' });
    await expect(dialog.getByRole('heading', { name: 'Credits' })).toBeVisible();
    await expect(dialog.getByText('No tracks in this project require credit.')).toBeVisible();

    // No copy control when there is nothing to copy.
    await expect(dialog.getByRole('button', { name: 'Copy required credits' })).toHaveCount(0);
  });
});
