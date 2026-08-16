/**
 * P4/P6 robustness (plan PREVIEW-WEBCODECS-COMPOSITOR.md). When the WebCodecs
 * engine hits a fatal error (here a decode/demux failure from deliberately
 * corrupt media), the editor keeps the single compositor mounted and shows the
 * failure in place instead of silently switching render semantics.
 *
 * Runs in the `preview-spike` Playwright project (real Google Chrome).
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
const CLIP = join(FIXTURE_DIR, 'p4-clip.mp4');
const CLIP_URL = 'https://fixtures.internal/p4-clip.mp4';

const BAD_URL = 'https://fixtures.internal/broken.mp4';

const BROKEN_MEDIA_PROJECT = {
  id: 'project_p4_fallback',
  name: 'P4 Fallback',
  version: 1,
  fps: 30,
  resolution: { width: 1280, height: 720 },
  assets: [{ id: 'asset_a', path: BAD_URL, kind: 'video', durationSeconds: 3 }],
  timeline: {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          {
            id: 'clip_a',
            assetId: 'asset_a',
            trackId: 'video_1',
            start: 0,
            end: 3,
            sourceStart: 0,
            sourceEnd: 3,
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

const VALID_PROJECT = {
  ...BROKEN_MEDIA_PROJECT,
  id: 'project_p4_valid',
  name: 'P4 Valid',
  assets: [{ id: 'asset_a', path: CLIP_URL, kind: 'video', durationSeconds: 3 }],
};

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(CLIP)) {
    execFileSync('node', [GEN_SCRIPT, CLIP, '90', '1280', '720', '440', '20,20,60'], {
      stdio: 'inherit',
    });
  }
});

test('P6: a fatal decoder error stays visible in the WebCodecs monitor', async ({ page }) => {
  // Corrupt media: a 200 response that is not a valid MP4, so the demuxer
  // rejects and the engine reports a fatal error.
  await page.route('**/fixtures.internal/broken.mp4', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: 'definitely not an mp4' }),
  );

  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, BROKEN_MEDIA_PROJECT);

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P4 Fallback');
  await expect(clip(page, 'clip_a')).toBeVisible();

  // The canvas remains the program monitor and exposes the decoder failure.
  await expect(page.locator('.webcodecs-preview')).toBeVisible();
  await expect(page.locator('.webcodecs-preview-error')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('section.preview')).toBeVisible();
});

test('P4: playback pauses when the tab is hidden', async ({ page }) => {
  await page.route('**/fixtures.internal/p4-clip.mp4', (route) => route.fulfill({ path: CLIP }));
  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, VALID_PROJECT);

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P4 Valid');
  await expect(clip(page, 'clip_a')).toBeVisible();

  await expect(page.getByRole('img', { name: 'preview' })).toBeVisible();

  // Start playback, then simulate the tab being backgrounded.
  await page.getByRole('button', { name: 'play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'pause' })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // The engine pauses on hide — the transport returns to Play.
  await expect(page.getByRole('button', { name: 'play', exact: true })).toBeVisible();
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});
