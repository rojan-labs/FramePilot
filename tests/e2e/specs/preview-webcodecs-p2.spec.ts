/**
 * P2 real-editor integration test (plan PREVIEW-WEBCODECS-COMPOSITOR.md) —
 * verifies multi-clip continuity: two video clips from DIFFERENT sources
 * with a gap between them, played continuously through
 * `WebCodecsPreviewEngine`'s multi-segment EDL.
 *
 * Runs in the `preview-spike` Playwright project (real Google Chrome). See
 * preview-webcodecs-p1.spec.ts's header for why a project is injected via
 * localStorage with https:// asset paths rather than using the shared Demo
 * Project (`fp-media://` has no handler in a plain browser).
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
const CLIP_A = join(FIXTURE_DIR, 'p2-clip-a.mp4');
const CLIP_B = join(FIXTURE_DIR, 'p2-clip-b.mp4');
const CLIP_A_URL = 'https://fixtures.internal/clip-a.mp4';
const CLIP_B_URL = 'https://fixtures.internal/clip-b.mp4';

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(CLIP_A)) {
    execFileSync('node', [GEN_SCRIPT, CLIP_A, '90', '1280', '720', '440', '20,20,60'], { stdio: 'inherit' });
  }
  if (!existsSync(CLIP_B)) {
    execFileSync('node', [GEN_SCRIPT, CLIP_B, '90', '1280', '720', '880', '60,20,20'], { stdio: 'inherit' });
  }
});

// Timeline: clip_a [0,3) -> gap [3,4) -> clip_b [4,7). Total duration 7s.
const MULTI_CLIP_PROJECT = {
  id: 'project_p2_multi_clip',
  name: 'P2 Multi Clip',
  version: 1,
  fps: 30,
  resolution: { width: 1280, height: 720 },
  assets: [
    { id: 'asset_a', path: CLIP_A_URL, kind: 'video', durationSeconds: 3 },
    { id: 'asset_b', path: CLIP_B_URL, kind: 'video', durationSeconds: 3 },
    // Reuses clip A's own file as a stand-alone AUDIO-only asset (it has a
    // real AAC track) — proves P2's "reuse PreviewAudioMixer for non-footage
    // audio" wiring actually mounts an <audio> element for it, independent of
    // the WebCodecs engine's own footage-audio handling for the video track.
    { id: 'asset_music', path: CLIP_A_URL, kind: 'audio', durationSeconds: 3 },
  ],
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
          {
            id: 'clip_b',
            assetId: 'asset_b',
            trackId: 'video_1',
            start: 4,
            end: 7,
            sourceStart: 0,
            sourceEnd: 3,
            effects: [],
            keyframes: [],
          },
        ],
      },
      {
        id: 'audio_1',
        type: 'audio',
        clips: [
          {
            id: 'clip_music',
            assetId: 'asset_music',
            trackId: 'audio_1',
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

test('P2: WebCodecs canvas playback continues across a cut and a gap', async ({ page }) => {
  await page.route('**/fixtures.internal/clip-a.mp4', (route) => route.fulfill({ path: CLIP_A }));
  await page.route('**/fixtures.internal/clip-b.mp4', (route) => route.fulfill({ path: CLIP_B }));

  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, MULTI_CLIP_PROJECT);

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P2 Multi Clip');
  await expect(clip(page, 'clip_a')).toBeVisible();
  await expect(clip(page, 'clip_b')).toBeVisible();
  await expect(clip(page, 'clip_music')).toBeVisible();

  const canvas = page.getByRole('img', { name: 'preview' });
  await expect(canvas).toBeVisible();
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);

  // PreviewAudioMixer mounts a hidden <audio> for the audio-only clip,
  // proving P2's "reuse PreviewAudioMixer for non-footage audio" wiring
  // actually took effect — independent of the WebCodecs engine's own
  // footage-audio handling for the video track.
  await expect(page.locator('audio[src*="clip-a.mp4"]')).toHaveCount(1);

  const timeReadout = page.locator('.preview-transport .transport-time');
  // Total duration across both clips + the gap: 7s.
  await expect(timeReadout).toHaveText('00:00:00:00 / 00:00:07:00');

  // Play from the start and let it run through clip_a, the gap, and into
  // clip_b — real wall-clock playback, not a seek, so continuity across
  // BOTH boundaries is genuinely exercised.
  await page.getByRole('button', { name: 'play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'pause' })).toBeVisible();

  // Poll until playback has clearly entered clip_b's span (> 4s project time).
  await expect
    .poll(
      () =>
        timeReadout.textContent().then((text) => {
          const match = /^(\d\d):(\d\d):(\d\d):(\d\d)/.exec(text ?? '');
          if (!match) return -1;
          const [, hh, mm, ss] = match;
          return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
        }),
      { timeout: 8000 }
    )
    .toBeGreaterThanOrEqual(4);

  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);

  await page.getByRole('button', { name: 'pause' }).click();
  await expect(page.getByRole('button', { name: 'play', exact: true })).toBeVisible();

  // Scrub directly into the gap (t=3.5s) — should clear to a blank frame,
  // not error.
  const seekInput = page.getByRole('slider', { name: 'Seek' });
  await seekInput.evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '3.5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => timeReadout.textContent()).toContain('00:00:03');
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);

  // Scrub into clip_b directly (t=5s).
  await seekInput.evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => timeReadout.textContent()).toContain('00:00:05');
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});
