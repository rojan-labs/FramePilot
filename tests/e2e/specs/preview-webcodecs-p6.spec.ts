/**
 * P6 multi-source short-clip + scrub lag (plan PREVIEW-WEBCODECS-COMPOSITOR.md).
 * The remaining lag cases the single-source P5 didn't cover:
 *   - short clips (~3 frames) alternating between THREE different sources, so
 *     every cut switches decoder session — measures playback drops
 *     (missing/wrongSegment) and the worst per-window decode time;
 *   - heavy scrubbing (many seeks to scattered positions) — measures the worst
 *     seek→present latency.
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

const SOURCES = [
  { id: 'p6-a', tone: '440', bg: '60,20,20' },
  { id: 'p6-b', tone: '660', bg: '20,60,20' },
  { id: 'p6-c', tone: '880', bg: '20,20,60' },
].map((s) => ({ ...s, file: join(FIXTURE_DIR, `${s.id}.mp4`), url: `https://fixtures.internal/${s.id}.mp4` }));

const FPS = 30;
const FRAME = 1 / FPS;
const CLIP_FRAMES = 3; // ~100 ms clips
const CLIP_COUNT = 45; // ~4.5 s

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const s of SOURCES) {
    if (!existsSync(s.file)) {
      // Default gop=15, mirroring the real P-1 proxy.
      execFileSync('node', [GEN_SCRIPT, s.file, '120', '1280', '720', s.tone, s.bg], { stdio: 'inherit' });
    }
  }
});

function multiSourceProject() {
  const clips = Array.from({ length: CLIP_COUNT }, (_, k) => {
    const src = SOURCES[k % SOURCES.length]!;
    const srcFrame = (k * 7) % 100; // scattered source in-points
    return {
      id: `clip_${k}`,
      assetId: src.id,
      trackId: 'video_1',
      start: k * CLIP_FRAMES * FRAME,
      end: (k + 1) * CLIP_FRAMES * FRAME,
      sourceStart: srcFrame * FRAME,
      sourceEnd: (srcFrame + CLIP_FRAMES) * FRAME,
      effects: [],
      keyframes: [],
    };
  });
  return {
    id: 'project_p6',
    name: 'P6 Multi',
    version: 1,
    fps: FPS,
    resolution: { width: 1280, height: 720 },
    assets: SOURCES.map((s) => ({ id: s.id, path: s.url, kind: 'video', durationSeconds: 4 })),
    timeline: { tracks: [{ id: 'video_1', type: 'video', clips }] },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  };
}

test('P6: multi-source short clips + scrubbing never lag', async ({ page }) => {
  for (const s of SOURCES) {
    await page.route(`**/fixtures.internal/${s.id}.mp4`, (route) => route.fulfill({ path: s.file }));
  }
  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, multiSourceProject());

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P6 Multi');
  await expect(clip(page, 'clip_0')).toBeVisible();

  await expect(page.getByRole('img', { name: 'preview' })).toBeVisible();

  // --- Playback across many short multi-source cuts ---
  await page.getByRole('button', { name: 'play', exact: true }).click();
  await page.waitForTimeout(5200);

  const playback = await page.evaluate(() => {
    const engine = (
      window as unknown as { __fpPreviewEngine?: { debugStats(): Record<string, number> } }
    ).__fpPreviewEngine;
    return { stats: engine?.debugStats() ?? null, fellBack: !document.querySelector('.webcodecs-preview') };
  });
  // eslint-disable-next-line no-console
  console.log('P6 playback:', JSON.stringify(playback));
  expect(playback.fellBack).toBe(false);
  const pb = playback.stats as Record<string, number>;
  expect(pb.ticks).toBeGreaterThan(80);
  expect(pb.missing).toBe(0);
  expect(pb.wrongSegment).toBe(0);

  // --- Heavy scrubbing to scattered positions ---
  const seekInput = page.getByRole('slider', { name: 'Seek' });
  const positions = [4.2, 0.3, 3.1, 1.7, 4.4, 0.9, 2.5, 3.8, 0.1, 2.0, 4.0, 1.2];
  for (const pos of positions) {
    await seekInput.evaluate((el: HTMLInputElement, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, pos);
    await page.waitForTimeout(60);
  }

  const scrub = await page.evaluate(() => {
    const engine = (
      window as unknown as { __fpPreviewEngine?: { debugStats(): Record<string, number> } }
    ).__fpPreviewEngine;
    return engine?.debugStats() ?? null;
  });
  // eslint-disable-next-line no-console
  console.log('P6 scrub:', JSON.stringify(scrub));
  // A scrub must present a frame fast enough to feel live (< 100 ms worst case).
  expect((scrub as Record<string, number>).maxSeekMs).toBeLessThan(100);
});
