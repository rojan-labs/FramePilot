import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { launchDesktop, REPO } from './launch.js';

/**
 * UX walkthrough capture (plan/system-mission P0.6): screenshots of every surface the
 * audit covers, on the desktop host with real media, for the findings report.
 */
const OUT = join(REPO, 'docs', 'reports', 'system-mission', 'ux');

test('@ux desktop surfaces screenshot walkthrough', async () => {
  const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8797 });
  const { page } = session;
  mkdirSync(OUT, { recursive: true });
  // `animations: 'disabled'` finishes every CSS animation/transition before the frame is
  // taken. Without it a dialog captured on the click lands mid-fade and reads as a
  // translucent surface with the video showing through it (the UX-10 finding, which was
  // this and not a styling bug — the app behind it was not dimmed either).
  const shot = (name: string) =>
    page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false, animations: 'disabled' });
  try {
    await page.waitForTimeout(6_000);
    await shot('01-editor-default');
    const clips = page.getByRole('button', { name: /^clip clip_/ });
    await clips.nth(1).click();
    await shot('02-clip-selected');
    await clips.nth(1).click({ button: 'right' });
    await shot('03-clip-context-menu');
    await page.keyboard.press('Escape');
    for (const tab of ['Inspector', 'AI']) {
      const t = page.getByRole('tab', { name: tab });
      if (await t.count()) {
        await t.first().click();
        await shot(`04-right-${tab.toLowerCase()}`);
      }
    }
    for (const tab of ['Assets', 'Effects', 'Text', 'Captions']) {
      const t = page.getByRole('tab', { name: tab });
      if (await t.count()) {
        await t.first().click();
        await shot(`05-left-${tab.toLowerCase()}`);
      }
    }
    const transcription = page.getByRole('button', { name: 'Transcription' });
    if (await transcription.count()) {
      await transcription.first().click();
      await shot('06-transcription');
      await page.keyboard.press('Escape');
    }
    const exportBtn = page.getByRole('button', { name: /^Export/ });
    if (await exportBtn.count()) {
      await exportBtn.first().click();
      await shot('07-export-dialog');
      await page.keyboard.press('Escape');
    }
    const settings = page.getByRole('button', { name: /Settings/ });
    if (await settings.count()) {
      await settings.first().click();
      await shot('08-settings');
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('?');
    await shot('09-shortcuts-or-help');
    await page.keyboard.press('Escape');
    await page.locator('section[aria-label="timeline"]').hover();
    for (let z = 0; z < 8; z++) await page.mouse.wheel(0, -300);
    await shot('10-timeline-zoomed-in');
    await page.setViewportSize({ width: 1024, height: 700 });
    await shot('11-narrow-1024');
  } finally {
    await session.app.close();
  }
});
