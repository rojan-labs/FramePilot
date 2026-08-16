/**
 * Visual regression for the key editor surfaces reachable in the browser build:
 * the timeline, the captions panel, the color panel, the keyframe/inspector
 * panel, and the AI panel. (PRD §16 — visual regression tests.)
 *
 * Stability contract:
 *  - Viewport is pinned to 1280x800 (playwright.config.ts) and the app honours
 *    `prefers-reduced-motion: reduce` (set via `use.reducedMotion`), so CSS
 *    animations/transitions are disabled for deterministic frames.
 *  - We screenshot specific panels (not the whole page) to avoid coupling to the
 *    program monitor, whose `<video>` element renders no real media in-browser.
 *  - Per-pixel tolerance is configured globally (maxDiffPixelRatio) so a couple
 *    of anti-aliased pixels don't flake the suite.
 *
 * IMPORTANT — baselines are ENVIRONMENT-SENSITIVE. Font rendering and sub-pixel
 * AA differ by platform. CI runs this suite on macOS against the committed macOS
 * goldens. Regenerate only after reviewing an intentional product change:
 *
 *     pnpm --filter @framepilot/e2e exec playwright test visual --update-snapshots
 *
 * Commit the reviewed `*-snapshots/` PNGs with the product change.
 *
 * Deterministic, offline, no engine.
 */
import { test, expect } from '@playwright/test';
import { openEditor, selectClip } from './helpers.js';

async function selectAiMode(page: import('@playwright/test').Page, mode: 'Edit'): Promise<void> {
  await page.getByRole('button', { name: 'AI mode' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${mode}\\b`) }).click();
}

// Tagged `@visual` so the default CI smoke run (`pnpm test:e2e` →
// `playwright test --grep-invert @visual`) skips these platform-specific
// screenshot comparisons, while `pnpm --filter @framepilot/e2e test:visual`
// runs them on the platform whose baselines are committed.
test.describe('visual regression @visual', () => {
  test('timeline surface', async ({ page }) => {
    await openEditor(page);
    await selectClip(page, 'clip_intro');
    await expect(page.getByRole('region', { name: 'timeline' })).toHaveScreenshot('timeline.png');
  });

  test('captions panel', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('tab', { name: 'Captions' }).click();
    await page.mouse.move(640, 400);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.locator('.caption-workspace-host')).toHaveScreenshot('captions-panel.png');
  });

  // The inner inspector panels are `<div aria-label="…">` (not landmark
  // `<section>`s), so they have no implicit `region` role; `getByLabel` matches
  // the aria-label directly. `.first()` guards against a label also appearing on
  // a nested control input within the same subtree.
  test('color panel (inspector, clip selected)', async ({ page }) => {
    await openEditor(page);
    await selectClip(page, 'clip_intro');
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await page.getByRole('tab', { name: 'Color', exact: true }).click();
    await expect(page.getByLabel('color', { exact: true }).first()).toHaveScreenshot(
      'color-panel.png',
    );
  });

  test('keyframe / transform inspector panel (clip selected)', async ({ page }) => {
    await openEditor(page);
    await selectClip(page, 'clip_intro');
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.getByLabel('transform', { exact: true }).first()).toHaveScreenshot(
      'keyframe-panel.png',
    );
  });

  test('mask inspector panel (clip selected)', async ({ page }) => {
    await openEditor(page);
    await selectClip(page, 'clip_intro');
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await page.getByRole('tab', { name: 'Mask', exact: true }).click();
    const maskPanel = page.getByLabel('mask', { exact: true }).first();
    await maskPanel.locator('summary').click();
    await expect(maskPanel).toHaveScreenshot('mask-panel.png');
  });

  test('AI sidebar (idle)', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('tab', { name: 'AI' }).click();
    await expect(page.getByRole('region', { name: 'ai assistant' })).toHaveScreenshot(
      'ai-sidebar.png',
    );
  });

  test('AI sidebar (streamed edit diff)', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('tab', { name: 'AI' }).click();
    await selectAiMode(page, 'Edit');
    await page.getByLabel('Message FramePilot').fill('tighten the intro');
    await page.getByLabel('Send').click();
    // Wait for the streamed diff card so the frame is stable before snapshotting.
    await expect(page.locator('.ai-event--diff')).toBeVisible();
    await expect(page.getByRole('region', { name: 'ai assistant' })).toHaveScreenshot(
      'ai-sidebar-streamed.png',
    );
  });
});
