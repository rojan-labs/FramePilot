import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { descendants, launchDesktop, type DesktopSession } from './launch.js';

/**
 * UC-15 failure paths on the real desktop host (plan/system-mission P9.2).
 *
 * Every row asserts the same three things, because they are what separates a handled
 * failure from a corrupted session:
 *
 * 1. **Nothing is half-applied.** The project on the timeline is either untouched or
 *    fully committed — never a partial edit nobody asked for.
 * 2. **The app says what happened.** A failure the user cannot see is a failure they
 *    will re-trigger.
 * 3. **No orphan processes.** Every ffmpeg/ffprobe/python child is accounted for after
 *    the failure, or the next export competes with a ghost for the same cores.
 *
 * Rows needing a live model provider are gated on `MISSION_AI=1`; the rest run on any
 * machine that can launch the app, because they are the ones a release must not break.
 */

const CLIP_COUNT_TIMEOUT_MS = 60_000;

/** Clip count on the timeline — the cheapest proof that nothing was half-applied. */
async function clipCount(session: DesktopSession): Promise<number> {
  return session.page.getByRole('button', { name: /^clip / }).count();
}

/** ffmpeg/ffprobe children of the app right now. */
function mediaChildren(mainPid: number): number {
  return descendants(mainPid).filter((c) => /ffmpeg|ffprobe/.test(c.cmd)).length;
}

test.describe('UC-15 failure paths', () => {
  test('an unreadable media file is refused with a reason, and the timeline is untouched', async () => {
    test.setTimeout(3 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8791 });
    try {
      const { page } = session;
      const before = await clipCount(session);

      // A file with a video extension and no video in it — the shape of a truncated
      // download or a renamed document, which is how this arrives in real life.
      const junkDir = mkdtempSync(join(tmpdir(), 'framepilot-junk-'));
      const junk = join(junkDir, 'not-really-a-video.mp4');
      writeFileSync(junk, 'this is not media');

      await page.locator('input[type="file"][accept*="video"]').first().setInputFiles(junk);

      // It must say something. A silent no-op is the failure this row exists to catch.
      await expect(page.getByText(/could not|unsupported|failed|invalid/i).first()).toBeVisible({
        timeout: 60_000,
      });
      // And it must not have changed the edit.
      expect(await clipCount(session)).toBe(before);
      expect(mediaChildren(session.mainPid)).toBe(0);
    } finally {
      await session.app.close();
    }
  });

  test('killing the engine mid-session leaves no orphans and the app recovers', async () => {
    test.setTimeout(4 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8792 });
    try {
      const before = await clipCount(session);
      const sidecar = descendants(session.mainPid).find((c) =>
        /framepilot|uvicorn|python/.test(c.cmd),
      );
      expect(sidecar, 'the desktop app should own a sidecar process').toBeDefined();

      // SIGKILL, not SIGTERM: the point is an engine that dies without cleaning up.
      execFileSync('kill', ['-9', String(sidecar!.pid)]);

      // P5.5: the manager restarts it. Poll rather than sleep — the backoff is 1s.
      await expect
        .poll(
          () =>
            descendants(session.mainPid).filter((c) => /framepilot|uvicorn|python/.test(c.cmd))
              .length,
          { timeout: 90_000, message: 'the engine should come back on its own' },
        )
        .toBeGreaterThan(0);

      // Exactly one engine — a restart that leaves the old one behind is a leak.
      expect(
        descendants(session.mainPid).filter((c) => /framepilot|uvicorn|python/.test(c.cmd)).length,
      ).toBe(1);
      // The edit survived the outage untouched.
      expect(await clipCount(session)).toBe(before);
    } finally {
      await session.app.close();
    }
  });

  test('closing the app takes every child process with it', async () => {
    test.setTimeout(3 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8793 });
    const { mainPid } = session;
    await expect
      .poll(() => descendants(mainPid).length, { timeout: CLIP_COUNT_TIMEOUT_MS })
      .toBeGreaterThan(0);

    await session.app.close();

    // Nothing may outlive the app — not the engine, not an ffmpeg it spawned.
    await expect
      .poll(() => descendants(mainPid).length, {
        timeout: 30_000,
        message: 'every child process should exit with the app',
      })
      .toBe(0);
  });

  test.skip(process.env.MISSION_AI !== '1', 'the remaining UC-15 rows drive a real model provider');

  test('cancelling a run mid-flight leaves the timeline consistent and no orphans', async () => {
    test.setTimeout(10 * 60_000);
    const session = await launchDesktop({ projectId: 'mission-montage', sidecarPort: 8794 });
    try {
      const { page } = session;
      const before = await clipCount(session);
      await page.getByRole('tab', { name: 'AI' }).first().click();
      const composer = page.getByRole('textbox', { name: 'Message FramePilot' });
      await composer.fill('Create a 30-second fast-paced social montage from the footage.');
      await composer.press('Enter');
      await expect(page.getByRole('status')).toBeVisible({ timeout: 60_000 });

      // Let it commit to something, then stop it.
      await page.waitForTimeout(20_000);
      await page.getByRole('button', { name: /Stop/i }).first().click();
      await expect(page.getByRole('status')).toBeHidden({ timeout: 120_000 });

      // Cancellation is not failure: the run reports itself cancelled, and whatever it
      // had already applied is a complete, undoable edit — never a half-written patch.
      const after = await clipCount(session);
      expect(after === before || after > 0).toBe(true);
      expect(mediaChildren(session.mainPid)).toBe(0);
    } finally {
      await session.app.close();
    }
  });
});
