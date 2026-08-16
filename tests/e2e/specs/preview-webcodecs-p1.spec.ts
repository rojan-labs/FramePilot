/**
 * P1 real-editor integration test (plan PREVIEW-WEBCODECS-COMPOSITOR.md) —
 * verifies `WebCodecsPreviewPlayer` actually renders and plays inside the
 * real app (not the standalone spike harness), gated correctly by the
 * production program-monitor mount and the single-video-clip eligibility check.
 *
 * Runs in the `preview-spike` Playwright project (real Google Chrome — see
 * playwright.config.ts for why the bundled Chromium won't do).
 *
 * Does NOT use the shared Demo Project (`?demo`): its asset paths
 * (`/media/intro.mp4`) resolve through `mediaSrc()` to the `fp-media://`
 * scheme, which only the Electron desktop shell registers a handler for —
 * in a plain browser, `fetch('fp-media://...')` is rejected before any
 * request is even dispatched (confirmed via console: "URL scheme 'fp-media'
 * is not supported"), so `page.route` can't intercept it either. This is a
 * PRE-EXISTING gap in the browser build that equally affects the old
 * `<video>`-pool PreviewPlayer — it just fails silently there (a video
 * element with an unloadable src has no visible symptom the existing DOM/
 * geometry-only e2e specs check for), whereas WebCodecsPreviewPlayer
 * actually needs the fetch to succeed and surfaces the failure loudly. Not
 * something to paper over in production code for this test's sake.
 *
 * Instead: inject a project via the SAME localStorage schema the app itself
 * autosaves to/restores from (persistence.ts), with an asset path that is
 * already an absolute https:// URL — `mediaSrc()`'s PASSTHROUGH_SCHEME lets
 * that through unwrapped, so a normal `page.route` intercept serves real
 * bytes for it, and the resulting playback evidence is genuine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { clip } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN_SCRIPT = join(HERE, '..', 'fixtures', 'preview-spike', 'gen-proxy.mjs');
const FIXTURE_DIR = join(HERE, '..', '.tmp-preview-spike-fixtures');
const REAL_CLIP = join(FIXTURE_DIR, 'p1-real-clip.mp4');
const FAKE_CLIP_URL = 'https://fixtures.internal/clip.mp4';

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(REAL_CLIP)) {
    // 6s @ 30fps — a real, small H.264/AAC file WebCodecs can actually decode.
    execFileSync('node', [GEN_SCRIPT, REAL_CLIP, '180', '1280', '720', '440', '20,20,60'], {
      stdio: 'inherit',
    });
  }
});

const SINGLE_CLIP_PROJECT = {
  id: 'project_p1_single_clip',
  name: 'P1 Single Clip',
  version: 1,
  fps: 30,
  resolution: { width: 1280, height: 720 },
  assets: [{ id: 'asset_clip', path: FAKE_CLIP_URL, kind: 'video', durationSeconds: 6 }],
  timeline: {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          {
            id: 'clip_only',
            assetId: 'asset_clip',
            trackId: 'video_1',
            start: 0,
            end: 6,
            sourceStart: 0,
            sourceEnd: 6,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  },
  transcript: [],
  markers: [],
  aiMemory: {},
  history: [],
};

test('P1: WebCodecs canvas playback works for a real single-clip timeline', async ({ page }) => {
  await page.route('**/fixtures.internal/**', (route) => route.fulfill({ path: REAL_CLIP }));

  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, SINGLE_CLIP_PROJECT);

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P1 Single Clip');
  await expect(clip(page, 'clip_only')).toBeVisible();

  // Proxy-backed compatible media selects the WebCodecs program monitor.
  await expect(page.getByRole('region', { name: 'preview' })).toBeVisible();
  const canvas = page.getByRole('img', { name: 'preview' });
  await expect(canvas).toBeVisible();
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);

  const timeReadout = page.locator('.preview-transport .transport-time');
  await expect(timeReadout).toHaveText('00:00:00:00 / 00:00:06:00');

  // Play → time advances → pause → time holds.
  const playButton = page.getByRole('button', { name: 'play', exact: true });
  await playButton.click();
  await expect(page.getByRole('button', { name: 'pause' })).toBeVisible();
  await expect.poll(() => timeReadout.textContent(), { timeout: 3000 }).not.toBe(
    '00:00:00:00 / 00:00:06:00'
  );

  await page.getByRole('button', { name: 'pause' }).click();
  await expect(playButton).toBeVisible();
  const pausedTime = await timeReadout.textContent();
  await page.waitForTimeout(300);
  expect(await timeReadout.textContent()).toBe(pausedTime);

  // Scrub via the range input. `.fill()` on a range input drives it through
  // Playwright's keyboard-stepping heuristic (multiple intermediate `input`
  // events, not one deterministic set) — set the value and dispatch a real
  // `input` event directly instead, which is what a user's own drag produces
  // as its LAST event and is what the app's onChange actually reacts to.
  const seekInput = page.getByRole('slider', { name: 'Seek' });
  await seekInput.evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '1');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => timeReadout.textContent()).not.toBe(pausedTime);

  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});
