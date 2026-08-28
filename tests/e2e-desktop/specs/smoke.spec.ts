import { expect, test } from '@playwright/test';
import { launchDesktop } from './launch.js';

test('desktop host opens a mission fixture project from Recent', async () => {
  const session = await launchDesktop({ projectId: 'mission-montage' });
  try {
    await expect(session.page.locator('section[aria-label="timeline"]')).toBeVisible();
    const clips = session.page.getByRole('button', { name: /^clip / });
    await expect(clips.first()).toBeVisible({ timeout: 30_000 });
    const names = await clips.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    console.log('clips on timeline:', names.length, names.slice(0, 6));
    expect(names.length).toBeGreaterThanOrEqual(1);
  } finally {
    await session.app.close();
  }
});
