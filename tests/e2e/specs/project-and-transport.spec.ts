/**
 * PRD §16.1 — "create / load a project" + transport.
 *
 * The browser build boots into the seeded Demo Project (the in-browser stand-in
 * for an opened `project.fp.json`). This spec asserts the project loads with its
 * real timeline, that "New project" resets to an empty timeline, and that the
 * J/K/L + Space transport shortcuts drive the program-monitor play state.
 *
 * Deterministic, offline, no engine: play state is editor-store state advanced by
 * a rAF clock (no MoviePy, no real media required).
 */
import { test, expect } from '@playwright/test';
import { clipCount, openEditor } from './helpers.js';

test.describe('project load + transport', () => {
  test('boots into the demo project with its seeded timeline', async ({ page }) => {
    await openEditor(page);
    // Three seeded clips: clip_intro + clip_body (video) and clip_vo (audio).
    await expect(clipCount(page)).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'clip clip_intro', exact: true })).toBeVisible();
    await expect(page.getByLabel('playhead time')).toHaveText('00:00:00:00');
  });

  test('New project resets to an empty timeline', async ({ page }) => {
    await openEditor(page);
    await expect(clipCount(page)).toHaveCount(3);

    // File ▸ New project opens the New Project dialog; name it and Create.
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Fresh Cut');
    await page.getByRole('button', { name: 'Create' }).click();

    // The header's transient "io message" feedback was replaced by the labelled
    // save-status indicator in the topbar redesign (commit 6665b4d); the project
    // name + empty timeline below are the current confirmation of the reset.
    await expect(page.getByLabel('project name', { exact: true })).toHaveText('Fresh Cut');
    await expect(clipCount(page)).toHaveCount(0);
  });

  test('Space / K / L drive the program-monitor play state', async ({ page }) => {
    await openEditor(page);
    const transport = page.getByRole('button', { name: /^(play|pause)$/ });
    await expect(transport).toHaveAttribute('aria-label', 'play');
    await expect(transport).toHaveAttribute('aria-pressed', 'false');

    // Move keyboard focus off any text field so global shortcuts run.
    await page.locator('.framepilot-body').click();
    await page.keyboard.press('Space'); // toggle → playing
    await expect(transport).toHaveAttribute('aria-pressed', 'true');
    await expect(transport).toHaveAttribute('aria-label', 'pause');

    await page.keyboard.press('k'); // pause
    await expect(transport).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('l'); // play forward
    await expect(transport).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('j'); // pause + step back
    await expect(transport).toHaveAttribute('aria-pressed', 'false');
  });

  test('Home / End seek the playhead to the timeline bounds', async ({ page }) => {
    await openEditor(page);
    await page.locator('.framepilot-body').click();
    await page.keyboard.press('End');
    // The seeded timeline runs 0–14s.
    await expect(page.getByLabel('playhead time')).toHaveText('00:00:14:00');
    await page.keyboard.press('Home');
    await expect(page.getByLabel('playhead time')).toHaveText('00:00:00:00');
  });
});
