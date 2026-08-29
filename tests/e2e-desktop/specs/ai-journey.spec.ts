import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exportThroughDialog, launchDesktop, REPO } from './launch.js';

/**
 * UC-01 → UC-08 → UC-09 → UC-06 → UC-07 → UC-13 in ONE session on the desktop host with a
 * real provider (plan/system-mission P9.1). Runs only with MISSION_AI=1 and a provider
 * configured in the app's AI settings; the PR lane skips it. Every assertion is about the
 * timeline or the rendered file, never the chat text — a journey that only proves the
 * assistant replied is not a journey.
 *
 * The session is deliberately continuous: the value being tested is that turn three can
 * lean on what turns one and two established, and that after five turns of AI editing the
 * project still exports a real, correctly-shaped video.
 */
const FIXTURES = join(REPO, 'tests', 'fixtures', 'mission');
/**
 * How long ONE turn may take before the row calls it hung.
 *
 * Sized from the measurements, not from optimism: `docs/reports/system-mission/01-after.md`
 * puts the montage turn at a 1070 s p50 on this machine — 17.8 minutes — so a 25-minute cap
 * left barely seven minutes of headroom and a normal-but-slow run tripped it. The row then
 * reported a hang ("Stop agent still visible after 25 min") for a run that was working
 * correctly and simply not finished. Forty minutes is generous against the measured p50
 * while still catching a run that is genuinely stuck.
 */
const RUN_TIMEOUT_MS = 40 * 60_000;

test.skip(process.env.MISSION_AI !== '1', 'needs MISSION_AI=1 and a configured provider');

/**
 * Is a run in flight?
 *
 * The composer swaps Send for a Stop control for exactly as long as a run is
 * running, so the presence of that one button is the honest answer — and unlike
 * `getByRole('status')` it names one element. That locator matched SIX (the save
 * chip, the fit chip, the playhead clock, the sidebar's live region, the activity
 * label and the toast host), so every row that used it failed on strict mode
 * before it could exercise anything.
 */
function runIndicator(page: Page): Locator {
  return page.getByRole('button', { name: 'Stop agent' });
}

test('montage → refine → reference style → logo overlay on the desktop host', async () => {
  // Four turns, each allowed a full run, plus room for import and export either side.
  test.setTimeout(5 * RUN_TIMEOUT_MS);
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
      await expect(runIndicator(page)).toBeVisible({ timeout: 60_000 });
      await expect(runIndicator(page)).toBeHidden({ timeout: RUN_TIMEOUT_MS });
    };

    // UC-01: a 30-second montage from the raw assembly.
    await runTurn(
      'Create a 30-second fast-paced social montage from the raw footage on the timeline.',
    );
    const afterMontage = await clips.count();
    expect(afterMontage).not.toBe(before);
    expect(afterMontage).toBeGreaterThanOrEqual(4);
    const durationText = await page
      .getByText(/^00:00:\d\d:\d\d \/ 00:00:\d\d:\d\d$/)
      .first()
      .textContent()
      .catch(() => null);
    if (durationText) expect(durationText).toMatch(/\/ 00:00:(2[7-9]|3[0-3]):/);

    // UC-08: refine without restarting.
    const firstClipName = await clips.first().getAttribute('aria-label');
    await runTurn(
      'Tighten the middle section so it moves faster, but keep the first and last clips exactly as they are.',
    );
    expect(await clips.first().getAttribute('aria-label')).toBe(firstClipName);

    // UC-09: a third turn that says nothing about the goal. "Do that to the end as well"
    // is only answerable from what turns one and two decided, so a run that stalls asking
    // what "that" means — or that changes nothing — fails this row. The composer being
    // editable with the timeline unchanged is exactly the shape of that failure.
    const beforeMemoryTurn = await clips.evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label')),
    );
    await runTurn('Do the same to the last section as well.');
    const afterMemoryTurn = await clips.evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label')),
    );
    expect(
      afterMemoryTurn.join('|'),
      'the memory turn should have changed the edit, not asked what "the same" meant',
    ).not.toBe(beforeMemoryTurn.join('|'));

    // UC-06 + UC-07: attach a reference video and a logo, then ask for both.
    const picker = page.getByLabel('Reference files');
    await picker.setInputFiles([
      join(FIXTURES, 'ref', 'fast-cut-vertical.mp4'),
      join(FIXTURES, 'ref', 'logo.png'),
    ]);
    await expect(page.getByText('fast-cut-vertical.mp4')).toBeVisible();
    await expect(page.getByText('logo.png')).toBeVisible();
    await expect(page.getByText('analyzing…')).toHaveCount(0, { timeout: 5 * 60_000 });
    await runTurn(
      'Make the pacing feel like the reference video and put our logo in the bottom-right corner.',
    );
    expect(await clips.count()).toBeGreaterThanOrEqual(4);

    // The preview plays what was just built. Transport is the editor's own answer to
    // "did this actually land"; a timeline that cannot play is not a finished edit.
    const timecode = page.getByText(/^00:00:\d\d:\d\d \/ 00:00:\d\d:\d\d$/).first();
    const atRest = await timecode.textContent();
    await page.locator('section[aria-label="timeline"]').click();
    await page.keyboard.press('Space');
    await expect
      .poll(async () => (await timecode.textContent()) ?? '', {
        timeout: 30_000,
        message: 'the preview should advance while playing',
      })
      .not.toBe(atRest);
    await page.keyboard.press('Space');

    // UC-13: the whole point of the session — a real file, at the size asked for.
    const outputPath = await exportThroughDialog(session, {
      resolution: '1080p',
      quality: 'Low',
      container: 'MP4',
    });
    expect(existsSync(outputPath), `${outputPath} should exist on disk`).toBe(true);
    const probed = ffprobeVideo(outputPath);
    expect({ width: probed.width, height: probed.height }).toEqual({ width: 1080, height: 1920 });
    expect(probed.codec).toBe('h264');
    expect(probed.durationSeconds).toBeGreaterThan(1);
  } finally {
    await session.app.close();
  }
});

/** What ffprobe says is actually in the exported file — the only opinion this spec trusts. */
function ffprobeVideo(path: string): {
  width: number;
  height: number;
  codec: string;
  durationSeconds: number;
} {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const json = JSON.parse(raw) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    format: { duration?: string };
  };
  const video = json.streams.find((s) => s.codec_type === 'video');
  expect(video, `${path} should contain a video stream`).toBeDefined();
  return {
    width: video!.width ?? 0,
    height: video!.height ?? 0,
    codec: video!.codec_name,
    durationSeconds: Number(json.format.duration ?? 0),
  };
}
