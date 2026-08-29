import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop, REPO, snapshot, type ResourceSnapshot } from './launch.js';

/**
 * Resource baseline (plan/system-mission P0.4, re-run as P6.6's gate). Opens the montage
 * fixture in the real desktop app and samples main-process memory/handles, renderer heap/
 * DOM/listeners, and every child process (sidecar, ffmpeg, ffprobe) at four checkpoints:
 * idle after load → after a scripted editing session → after N AI turns (only when
 * MISSION_AI=1 and a provider is configured) → after project close/reopen ×3.
 *
 * RESOURCE_SESSION_MINUTES (default 10) sets the scripted session length.
 */
const SESSION_MINUTES = Number(process.env.RESOURCE_SESSION_MINUTES ?? 10);
const OUT =
  process.env.RESOURCE_BASELINE_OUT ??
  join(REPO, 'reports', 'system-mission', 'baseline-resources.json');

test('@resources desktop resource baseline', async () => {
  test.setTimeout((SESSION_MINUTES + 12) * 60_000);
  const session = await launchDesktop({ projectId: 'mission-montage' });
  const started = Date.now();
  const snaps: ResourceSnapshot[] = [];
  const { page } = session;
  try {
    await page.waitForTimeout(8_000);
    snaps.push(await snapshot(session, 'idle-after-load', started));

    // Scripted session: seek, select clips, zoom, scroll, open/close side tabs — the moves
    // an editor makes for minutes at a time. Every loop is the same so growth is comparable.
    const clips = page.getByRole('button', { name: /^clip clip_/ });
    const clipCount = await clips.count();
    const playhead = page.getByLabel('playhead', { exact: true });
    const end = Date.now() + SESSION_MINUTES * 60_000;
    let loops = 0;
    while (Date.now() < end) {
      for (let i = 0; i < clipCount; i++) {
        await clips.nth(i).click();
        await playhead.fill(String(5 + i * 20));
        await page.keyboard.press('Space');
        await page.waitForTimeout(400);
        await page.keyboard.press('Space');
      }
      await page.locator('section[aria-label="timeline"]').hover();
      for (let z = 0; z < 6; z++) await page.mouse.wheel(0, z % 2 === 0 ? -300 : 300);
      for (const tab of ['Inspector', 'AI'] as const) {
        const t = page.getByRole('tab', { name: tab });
        if (await t.count()) await t.first().click();
      }
      loops++;
      if (loops % 10 === 0) snaps.push(await snapshot(session, `session-loop-${loops}`, started));
    }
    snaps.push(
      await snapshot(session, `after-session-${SESSION_MINUTES}min-${loops}loops`, started),
    );

    if (process.env.MISSION_AI === '1') {
      await page.getByRole('tab', { name: 'AI' }).first().click();
      const composer = page.getByRole('textbox').last();
      for (let n = 1; n <= 5; n++) {
        await composer.fill(
          n % 2
            ? 'Make the second clip two seconds shorter.'
            : 'Undo that and add a 0.5 second crossfade between the first two clips.',
        );
        await composer.press('Enter');
        await page.waitForTimeout(90_000);
        snaps.push(await snapshot(session, `after-ai-turn-${n}`, started));
      }
    }

    // Close/reopen: what a leak looks like is "reopen ×3 is bigger than open ×1".
    for (let r = 1; r <= 3; r++) {
      await page.keyboard.press('Meta+W').catch(() => undefined);
      await page.goto('http://127.0.0.1:5173/');
      await page.getByRole('button', { name: 'mission-montage' }).first().click();
      await expect(page.locator('section[aria-label="timeline"]')).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(5_000);
      snaps.push(await snapshot(session, `reopen-${r}`, started));
    }
  } finally {
    mkdirSync(join(OUT, '..'), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sessionMinutes: SESSION_MINUTES,
          snapshots: snaps,
        },
        null,
        2,
      ),
    );
    await session.app.close();
  }
  expect(snaps.length).toBeGreaterThanOrEqual(3);
  // P6.6 gate (RESOURCE_GATE=1): after warm-up, a scripted session must not grow. The
  // bounds come from the 2026-08-29 baseline (heap 43.7–48.7 MB, listeners 933–935,
  // nodes 2,913–2,967 over 376 loops) with room for ordinary variance.
  if (process.env.RESOURCE_GATE === '1') {
    const warm = snaps.find((s) => s.label.startsWith('session-loop-')) ?? snaps[0]!;
    const last = snaps.find((s) => s.label.startsWith('after-session')) ?? snaps.at(-1)!;
    expect(last.renderer.jsHeapUsedMb).toBeLessThan(warm.renderer.jsHeapUsedMb * 1.3 + 10);
    expect(last.renderer.listeners).toBeLessThan(warm.renderer.listeners * 1.1 + 20);
    expect(last.renderer.nodes).toBeLessThan(warm.renderer.nodes * 1.2 + 200);
    expect(last.renderer.documents).toBeLessThanOrEqual(warm.renderer.documents + 1);
    expect(last.main.openFiles).toBeLessThan(warm.main.openFiles * 1.2 + 20);
    expect(last.ffmpegCount).toBe(0);
  }
});
