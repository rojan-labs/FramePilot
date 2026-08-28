/**
 * View preferences survive a reload.
 *
 * The editor's layout knobs — which panel each rail shows, how wide the rails are,
 * how tall the timeline dock is, how big the footage thumbnails are — are view
 * state, never project state. They are the kind of thing a person sets once and
 * expects to stay set; resetting them on every open is the difference between a
 * tool and a demo.
 */
import { expect, test } from '@playwright/test';
import { openEditor } from './helpers.js';

/** The left rail's tab strip: which panel the Assets/Effects/... row is showing. */
const selectedLeftTab = (page: import('@playwright/test').Page) =>
  page.getByRole('tab', { selected: true }).first();

test.describe('view preferences persist across a reload', () => {
  test('the left rail reopens on the panel it was left on', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('tab', { name: 'Effects' }).click();
    await expect(page.getByRole('tab', { name: 'Effects' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.reload();
    await expect(page.getByLabel('project name')).toHaveText('Demo Project');
    await expect(page.getByRole('tab', { name: 'Effects' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(selectedLeftTab(page)).toBeVisible();
  });

  test('the right rail reopens on the panel it was left on', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.reload();
    await expect(page.getByLabel('project name')).toHaveText('Demo Project');
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the footage thumbnail size survives', async ({ page }) => {
    await openEditor(page);
    const sizes = page.getByRole('group', { name: 'Thumbnail size' });
    const grid = page.getByRole('region', { name: 'media bin' });
    await sizes.getByRole('button', { name: 'S', exact: true }).click();
    await expect(grid).toHaveAttribute('data-density', 'S');

    await page.reload();
    await expect(page.getByLabel('project name')).toHaveText('Demo Project');
    await expect(page.getByRole('region', { name: 'media bin' })).toHaveAttribute(
      'data-density',
      'S',
    );
  });

  test('folding a bin folder records it, so it reopens folded', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'new folder' }).click();
    await page.getByLabel('folder name').fill('Shots');
    await page.getByLabel('folder name').press('Enter');

    const fold = page.getByRole('button', { name: 'Collapse Shots' });
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await fold.click();
    await expect(page.getByRole('button', { name: 'Expand Shots' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Asserted at the store rather than across a reload: `?demo` re-seeds the fixed demo
    // project on every load, so the FOLDER itself does not survive here and there would be
    // nothing left to be folded. What this pins is the half the app owns — the fold is
    // recorded against the folder's id. `useViewPreference.test.ts` pins the read-back.
    const stored = await page.evaluate(() =>
      localStorage.getItem('framepilot.view.binCollapsedFolders'),
    );
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored ?? '[]')).toHaveLength(1);
  });

  test('the rail widths and the timeline dock height survive', async ({ page }) => {
    await openEditor(page);
    // Set them through the same storage the app writes, then prove the app READS
    // them back — a drag would test Playwright's mouse, not the persistence.
    await page.evaluate(() => {
      localStorage.setItem(
        'framepilot.rail.right',
        JSON.stringify({ width: 420, collapsed: false }),
      );
      localStorage.setItem(
        'framepilot.rail.left',
        JSON.stringify({ width: 330, collapsed: false }),
      );
      localStorage.setItem('framepilot.timelineDock.height', '320');
    });
    await page.reload();
    await expect(page.getByLabel('project name')).toHaveText('Demo Project');

    const stored = await page.evaluate(() => ({
      right: localStorage.getItem('framepilot.rail.right'),
      left: localStorage.getItem('framepilot.rail.left'),
      dock: localStorage.getItem('framepilot.timelineDock.height'),
    }));
    expect(stored.right).toContain('420');
    expect(stored.left).toContain('330');
    expect(stored.dock).toBe('320');
  });
});
