/**
 * P5 rapid-cut jitter (plan PREVIEW-WEBCODECS-COMPOSITOR.md) — the hard case:
 * a montage of ~33 ms (single-frame) clips with SCATTERED source in-points, so
 * every cut lands on a different mid-GOP position. Measures playback quality
 * off the engine's own counters (`debugStats()`): `missing` (no frame ready at
 * the playhead) + `wrongSegment` (a stale frame from a different segment drawn)
 * over `ticks` is the jitter rate. Target: zero.
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
const CLIP = join(FIXTURE_DIR, 'p5-clip.mp4');
const CLIP_URL = 'https://fixtures.internal/p5-clip.mp4';

const FPS = 30;
const FRAME = 1 / FPS;
const CLIP_COUNT = 60; // ~2 s of single-frame cuts

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(CLIP)) {
    // 120 frames (4s) so scattered source in-points always resolve.
    execFileSync('node', [GEN_SCRIPT, CLIP, '120', '1280', '720', '440', '20,20,60'], {
      stdio: 'inherit',
    });
  }
});

function rapidCutProject() {
  const clips = Array.from({ length: CLIP_COUNT }, (_, k) => {
    // Scatter source in-points across the file's 120 frames, non-sequential so
    // each cut forces a fresh mid-GOP seek — the pathological decode case.
    const srcFrame = (k * 13) % 100;
    return {
      id: `clip_${k}`,
      assetId: 'asset_a',
      trackId: 'video_1',
      start: k * FRAME,
      end: (k + 1) * FRAME,
      sourceStart: srcFrame * FRAME,
      sourceEnd: (srcFrame + 1) * FRAME,
      effects: [],
      keyframes: [],
    };
  });
  return {
    id: 'project_p5_rapid',
    name: 'P5 Rapid',
    version: 1,
    fps: FPS,
    resolution: { width: 1280, height: 720 },
    assets: [{ id: 'asset_a', path: CLIP_URL, kind: 'video', durationSeconds: 4 }],
    timeline: { tracks: [{ id: 'video_1', type: 'video', clips }] },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  };
}

test('P5: rapid single-frame cuts play without jitter', async ({ page }) => {
  await page.route('**/fixtures.internal/p5-clip.mp4', (route) => route.fulfill({ path: CLIP }));
  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, rapidCutProject());

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P5 Rapid');
  await expect(clip(page, 'clip_0')).toBeVisible();

  await expect(page.getByRole('img', { name: 'preview' })).toBeVisible();

  // Click Play immediately — deliberately racing the (slow, many-segment) load,
  // which is exactly what used to let a deferred post-load seek pause the
  // just-started playback and freeze rapid-cut montages.
  await page.getByRole('button', { name: 'play', exact: true }).click();
  // Let it run the whole montage to completion.
  await page.waitForTimeout(2800);

  const result = await page.evaluate(() => {
    const engine = (
      window as unknown as {
        __fpPreviewEngine?: { debugStats(): Record<string, number> };
      }
    ).__fpPreviewEngine;
    return {
      stats: engine?.debugStats() ?? null,
      errorText: document.querySelector('.webcodecs-preview-error')?.textContent ?? null,
      fellBack: !document.querySelector('.webcodecs-preview'),
    };
  });

  // eslint-disable-next-line no-console
  console.log('P5 stats:', JSON.stringify(result));
  expect(result.errorText).toBeNull();
  expect(result.fellBack).toBe(false);
  expect(result.stats).not.toBeNull();

  const { ticks, presented, missing, wrongSegment, maxLagUs } = result.stats as {
    ticks: number;
    presented: number;
    missing: number;
    wrongSegment: number;
    maxLagUs: number;
  };
  // Playback actually ran the montage (didn't stall on the load/play race).
  expect(ticks).toBeGreaterThan(40);
  expect(presented).toBe(ticks); // a frame drawn on every video tick
  // Zero jitter: never a missing frame, never a stale frame from another segment.
  expect(missing).toBe(0);
  expect(wrongSegment).toBe(0);
  // And the presented frame is never more than ~one frame behind the playhead.
  expect(maxLagUs).toBeLessThan(40_000);
});
