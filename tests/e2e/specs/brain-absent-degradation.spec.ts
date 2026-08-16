/**
 * Project Brain — the app is fully usable with no brain at all (plan B0.5, closed in B7.4).
 *
 * Invariant 1 of the brain sub-plan: `project.fp.json` is the single canonical
 * document and the brain is a *derived, rebuildable cache* — "deleting it loses
 * time, never truth. No brain row is required to open/render a project."
 *
 * This browser suite is the strongest available statement of that invariant. The
 * brain lives in the Python sidecar (invariant 2: single writer, TS never opens
 * the file), and this harness has no sidecar and no Electron — so the browser
 * build is not merely a project whose derived dir was deleted, it is one where the
 * derived dir can never exist. What follows therefore runs against a permanently
 * brain-less app, and must be indistinguishable from a normal session.
 *
 * Scope, stated plainly rather than implied — two neighbouring things are covered
 * elsewhere, not here:
 *  - The sidecar-backed flow (import → warmup → search → search-driven edit) needs
 *    a live Python engine, which this config deliberately does not boot (see
 *    playwright.config.ts). It is covered at the integration level:
 *    `engine/python/tests/test_service_brain.py` for the routes, and ai-sdk's
 *    `brain-client.test.ts` / `sidecar-executor.test.ts` for the loop.
 *  - The honest-unavailable *notice* ("No changes were made — this request needs
 *    the analysis engine…") is covered by `AiSidebar.test.tsx` against a
 *    controlled session. It cannot be provoked from here: the offline mock
 *    provider answers an editing prompt with a canned `delete_range` proposal,
 *    which needs no analysis, so no run in this harness ever reaches that gate.
 */
import { test, expect } from '@playwright/test';
import { clipCount, clipGeometry, openEditor, undoButton } from './helpers.js';

test.describe('brain absent: the editor is fully usable', () => {
  test('opens and edits a project with no brain, and undo still works', async ({ page }) => {
    // Truth comes from project.fp.json alone: the timeline renders in full with
    // no brain row in existence anywhere.
    await openEditor(page);
    await expect(clipCount(page)).toHaveCount(3); // clip_intro, clip_body, clip_vo

    const before = await clipGeometry(page, 'clip_intro');

    // A plain human edit through the normal store path. Nothing about it involves
    // analysis, so the absent brain must cost exactly nothing.
    await page.getByRole('button', { name: 'clip clip_intro', exact: true }).click();
    await page.keyboard.press('Delete');
    await expect(clipCount(page)).toHaveCount(2);

    // Reversibility is a property of the patch engine, not the brain.
    await undoButton(page).click();
    await expect(clipCount(page)).toHaveCount(3);
    expect(await clipGeometry(page, 'clip_intro')).toEqual(before);
  });
});
