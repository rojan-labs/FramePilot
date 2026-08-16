/**
 * Project history panel e2e: open the panel, see committed edits listed, and
 * time-travel (jump to start / redo to a point) with the timeline following.
 *
 * Deterministic, offline, no engine — asserts on observable timeline state
 * (clip count) after each jump, exactly like the timeline-interaction suite.
 */
import { test, expect } from '@playwright/test';
import { clipCount, openEditor, seekTo, selectClip } from './helpers.js';

const historyButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'History', exact: true });

const historyDialog = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: 'Project history' });

test.describe('project history panel', () => {
  test('opens from the header and lists a committed edit', async ({ page }) => {
    await openEditor(page);

    // Make one edit: split clip_intro at 3s.
    await seekTo(page, 3);
    await selectClip(page, 'clip_intro');
    await page.keyboard.press('s');
    await expect(clipCount(page)).toHaveCount(4);

    await historyButton(page).click();
    await expect(historyDialog(page)).toBeVisible();
    // The origin node plus the human-labelled edit are both listed.
    await expect(page.getByText('Project opened')).toBeVisible();
    await expect(page.getByText('Split clip')).toBeVisible();
  });

  test('jump-to-start rewinds the timeline; a row redoes it', async ({ page }) => {
    await openEditor(page);
    await seekTo(page, 3);
    await selectClip(page, 'clip_intro');
    await page.keyboard.press('s');
    await expect(clipCount(page)).toHaveCount(4);

    await historyButton(page).click();
    await expect(historyDialog(page)).toBeVisible();

    // Jump to the start → the split is undone.
    await page.getByRole('button', { name: 'Jump to start', exact: true }).click();
    await expect(clipCount(page)).toHaveCount(3);

    // The now-dimmed edit row redoes it.
    await page.getByTitle('Redo to this point').click();
    await expect(clipCount(page)).toHaveCount(4);
  });

  test('⌘⇧H toggles the panel and Escape closes it', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.press('ControlOrMeta+Shift+h');
    await expect(historyDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(historyDialog(page)).toBeHidden();
  });
});
