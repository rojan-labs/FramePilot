/**
 * PRD §16.1 — "render preview" + the boundary of "export final video / validate
 * output" in the browser build.
 *
 * What IS exercised in the browser:
 *  - The program monitor (adaptive streaming/WebCodecs preview + overlays, per the
 *    AGENTS.md render-vs-preview rule) renders and exposes transport.
 *  - The Export dialog opens and clearly degrades: in a plain browser there is no
 *    Python engine, so export is disabled with an explanatory note rather than a
 *    fake render.
 *
 * What is OUT OF SCOPE for browser e2e (documented, not faked):
 *  - Real export / render and output validation (duration/streams) run only in
 *    the Electron desktop shell spawning the deterministic Python MoviePy engine.
 *    The render engine must never run in the renderer (AGENTS.md). That flow is
 *    covered by the Python engine's golden-media + validation tests
 *    (`engine/python`) and is verified end-to-end in the desktop build's own
 *    harness — not here, where neither Electron nor the engine is present.
 *
 * Deterministic, offline, no engine.
 */
import { test, expect } from '@playwright/test';
import { openEditor } from './helpers.js';

test.describe('preview + export boundary', () => {
  test('the program monitor (preview engine) renders with transport controls', async ({ page }) => {
    await openEditor(page);
    const preview = page.getByRole('region', { name: 'preview' });
    await expect(preview).toBeVisible();
    // The transport play/pause control is the preview engine's surface, not MoviePy.
    await expect(page.getByRole('button', { name: /^(play|pause)$/ })).toBeVisible();
  });

  test('Export is desktop-only in the browser and says so (no fake render)', async ({ page }) => {
    await openEditor(page);

    // Open the export dialog from the topbar.
    await page.getByRole('button', { name: 'Export video' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export video' });
    await expect(dialog).toBeVisible();

    // In a plain browser there is no engine: the note explains the limitation and
    // the Export action is disabled (the deterministic render runs in desktop).
    await expect(dialog.getByRole('note')).toContainText('only available in the');
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();

    // Presets are still selectable (the dialog is real UI, just not wired to an
    // engine here). Real render + output validation is covered by the Python
    // engine tests and the desktop harness — out of scope for browser e2e.
    await expect(dialog.getByLabel('Export preset')).toBeEnabled();
  });
});
