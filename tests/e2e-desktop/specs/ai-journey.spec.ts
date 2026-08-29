import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { launchDesktop, REPO } from './launch.js';

/**
 * UC-01 → UC-08 → UC-06/UC-07 on the desktop host with a real provider
 * (plan/system-mission P9.1). Runs only with MISSION_AI=1 and a provider configured in
 * the app's AI settings (the openai-compatible bridge on this machine); the PR lane skips
 * it. Every assertion is about the timeline, not the chat text.
 */
const FIXTURES = join(REPO, 'tests', 'fixtures', 'mission');
const RUN_TIMEOUT_MS = 25 * 60_000;

test.skip(process.env.MISSION_AI !== '1', 'needs MISSION_AI=1 and a configured provider');

test('montage → refine → reference style → logo overlay on the desktop host', async () => {
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8796 });
  const { page } = session;
  try {
    const clips = page.getByRole('button', { name: /^clip / });
    const before = await clips.count();
    await page.getByRole('tab', { name: 'AI' }).first().click();
    const composer = page.getByRole('textbox', { name: 'Message FramePilot' });

    const runTurn = async (prompt: string): Promise<void> => {
      await composer.fill(prompt);
      await composer.press('Enter');
      // The composer's activity strip appears while a run is live and disappears when it settles.
      await expect(page.getByRole('status')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('status')).toBeHidden({ timeout: RUN_TIMEOUT_MS });
    };

    // UC-01: a 30-second montage from the raw assembly.
    await runTurn('Create a 30-second fast-paced social montage from the raw footage on the timeline.');
    const afterMontage = await clips.count();
    expect(afterMontage).not.toBe(before);
    expect(afterMontage).toBeGreaterThanOrEqual(4);
    const durationText = await page.getByText(/^00:00:\d\d:\d\d \/ 00:00:\d\d:\d\d$/).first().textContent().catch(() => null);
    if (durationText) expect(durationText).toMatch(/\/ 00:00:(2[7-9]|3[0-3]):/);

    // UC-08: refine without restarting.
    const firstClipName = await clips.first().getAttribute('aria-label');
    await runTurn('Tighten the middle section so it moves faster, but keep the first and last clips exactly as they are.');
    expect(await clips.first().getAttribute('aria-label')).toBe(firstClipName);

    // UC-06 + UC-07: attach a reference video and a logo, then ask for both.
    const picker = page.getByLabel('Reference files');
    await picker.setInputFiles([join(FIXTURES, 'ref', 'fast-cut-vertical.mp4'), join(FIXTURES, 'ref', 'logo.png')]);
    await expect(page.getByText('fast-cut-vertical.mp4')).toBeVisible();
    await expect(page.getByText('logo.png')).toBeVisible();
    await expect(page.getByText('analyzing…')).toHaveCount(0, { timeout: 5 * 60_000 });
    await runTurn('Make the pacing feel like the reference video and put our logo in the bottom-right corner.');
    expect(await clips.count()).toBeGreaterThanOrEqual(4);
  } finally {
    await session.app.close();
  }
});
