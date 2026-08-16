/**
 * P7 real-footage-shaped timeline (plan PREVIEW-WEBCODECS-COMPOSITOR.md).
 * The user-reported lag case the proxy-shaped P5/P6 fixtures didn't cover —
 * a timeline like an actual edit session:
 *   - THREE 1080p sources encoded like real camera footage (GOP 30, 2
 *     B-frames → decode order ≠ presentation order), NOT like P-1 proxies;
 *   - short (~3-frame) clips alternating across all three sources;
 *   - a STILL-IMAGE clip in the middle of the montage;
 *   - a separate MUSIC track (audio asset) under the whole thing.
 * Asserts zero missing / zero wrong-segment frames during playback and a
 * <100 ms worst-case seek→present latency across a scrub storm.
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
  { id: 'p7-a', tone: '440', bg: '60,20,20' },
  { id: 'p7-b', tone: '660', bg: '20,60,20' },
  { id: 'p7-c', tone: '880', bg: '20,20,60' },
].map((s) => ({ ...s, file: join(FIXTURE_DIR, `${s.id}.mp4`), url: `https://fixtures.internal/${s.id}.mp4` }));
const SILENT_SOURCE = {
  id: 'p7-silent',
  file: join(FIXTURE_DIR, 'p7-silent.mp4'),
  url: 'https://fixtures.internal/p7-silent.mp4',
};
const PLAYBACK_SOURCES = [SOURCES[0]!, SILENT_SOURCE, SOURCES[2]!] as const;

const IMAGE = {
  id: 'p7-img',
  file: join(FIXTURE_DIR, 'p7-still.png'),
  url: 'https://fixtures.internal/p7-still.png',
};
const MUSIC = {
  id: 'p7-music',
  file: join(FIXTURE_DIR, 'p7-music.m4a'),
  url: 'https://fixtures.internal/p7-music.m4a',
};

const FPS = 30;
const FRAME = 1 / FPS;
const CLIP_FRAMES = 3; // ~100 ms clips
const CLIP_COUNT = 45; // ~4.5 s
const IMAGE_CLIP_INDEX = 10; // a still right in the middle of the montage

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const s of SOURCES) {
    if (!existsSync(s.file)) {
      // 1080p, GOP 30, 2 B-frames — shaped like real camera footage, not a
      // P-1 proxy (gop=15, bf=0). 150 frames = 5 s of source.
      execFileSync(
        'node',
        [GEN_SCRIPT, s.file, '150', '1920', '1080', s.tone, s.bg, '30', '2'],
        { stdio: 'inherit' }
      );
    }
  }
  if (!existsSync(SILENT_SOURCE.file)) {
    // The reported project mixes stock footage with and without embedded audio.
    // Strip one generated source to reproduce that clock shape portably.
    execFileSync(
      'ffmpeg',
      ['-y', '-i', SOURCES[1]!.file, '-map', '0:v:0', '-c:v', 'copy', '-an', SILENT_SOURCE.file],
      { stdio: 'inherit' }
    );
  }
  if (!existsSync(IMAGE.file)) {
    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=1:duration=1', '-frames:v', '1', IMAGE.file],
      { stdio: 'inherit' }
    );
  }
  if (!existsSync(MUSIC.file)) {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6',
        '-c:a', 'aac', '-movflags', '+faststart',
        MUSIC.file,
      ],
      { stdio: 'inherit' }
    );
  }
});

function realFootageProject() {
  const clips = Array.from({ length: CLIP_COUNT }, (_, k) => {
    if (k === IMAGE_CLIP_INDEX) {
      return {
        id: `clip_${k}`,
        assetId: IMAGE.id,
        trackId: 'video_1',
        start: k * CLIP_FRAMES * FRAME,
        end: (k + 1) * CLIP_FRAMES * FRAME,
        sourceStart: 0,
        sourceEnd: CLIP_FRAMES * FRAME,
        effects: [],
        keyframes: [],
      };
    }
    const src = PLAYBACK_SOURCES[k % PLAYBACK_SOURCES.length]!;
    const srcFrame = (k * 7) % 130; // scattered source in-points across the GOP-30 structure
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
  const durationSec = CLIP_COUNT * CLIP_FRAMES * FRAME;
  return {
    id: 'project_p7',
    name: 'P7 Real Footage',
    version: 1,
    fps: FPS,
    resolution: { width: 1280, height: 720 },
    assets: [
      ...SOURCES.map((s) => ({ id: s.id, path: s.url, kind: 'video', durationSeconds: 5 })),
      { id: SILENT_SOURCE.id, path: SILENT_SOURCE.url, kind: 'video', durationSeconds: 5 },
      { id: IMAGE.id, path: IMAGE.url, kind: 'image', durationSeconds: 0 },
      { id: MUSIC.id, path: MUSIC.url, kind: 'audio', durationSeconds: 6 },
    ],
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips },
        {
          id: 'audio_1',
          type: 'audio',
          clips: [
            {
              id: 'clip_music',
              assetId: MUSIC.id,
              trackId: 'audio_1',
              start: 0,
              end: durationSec,
              sourceStart: 0,
              sourceEnd: durationSec,
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
}

test('P7: real-footage-shaped timeline (B-frames, image, music) never lags', async ({ page }) => {
  // Per-source media fetch counter — the engine's incremental loadSegments
  // must fetch each source exactly once for the whole session, EDITS INCLUDED
  // (re-fetching on every EDL change was the "freezes after each edit"
  // failure mode on desktop-sized media).
  const mediaFetches = new Map<string, number>();
  const countFetch = (key: string) => mediaFetches.set(key, (mediaFetches.get(key) ?? 0) + 1);
  for (const s of SOURCES) {
    await page.route(`**/fixtures.internal/${s.id}.mp4`, (route) => {
      countFetch(s.id);
      return route.fulfill({ path: s.file });
    });
  }
  await page.route(`**/fixtures.internal/${SILENT_SOURCE.id}.mp4`, (route) => {
    countFetch(SILENT_SOURCE.id);
    return route.fulfill({ path: SILENT_SOURCE.file });
  });
  await page.route(`**/fixtures.internal/p7-still.png`, (route) => {
    countFetch('image');
    return route.fulfill({ path: IMAGE.file });
  });
  await page.route(`**/fixtures.internal/p7-music.m4a`, (route) => route.fulfill({ path: MUSIC.file }));
  await page.addInitScript((project) => {
    localStorage.setItem(`framepilot:project:${project.id}`, JSON.stringify(project));
    localStorage.setItem('framepilot:last-project-id', project.id);
  }, realFootageProject());

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P7 Real Footage');
  await expect(clip(page, 'clip_0')).toBeVisible();

  await expect(page.getByRole('img', { name: 'preview' })).toBeVisible();

  // Wait for the initial paused frame before the continuity sampler starts;
  // startup black is a loading state, not a playback blank.
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.webcodecs-preview-canvas');
    const pixel = canvas?.getContext('2d')
      ?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return pixel ? pixel[0]! + pixel[1]! + pixel[2]! : 0;
  })).toBeGreaterThan(0);

  // Observe what Chrome actually presents, not only the engine's decode-ring
  // bookkeeping. The original regression could report every frame as decoded
  // while the canvas alternated picture/black on consecutive display frames.
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.webcodecs-preview-canvas');
    const samples: { luma: number; time: number; now: number; playheadX: number; dpr: number }[] = [];
    (window as unknown as { __fpCanvasSamples?: typeof samples }).__fpCanvasSamples = samples;
    const sample = (): void => {
      // Stop before the cross-origin still-image segment at 1s taints the
      // canvas for pixel readback; the mixed audible/silent video cuts that
      // reproduced the regression are all exercised before then.
      if (!canvas || samples.length >= 80) return;
      const ctx = canvas.getContext('2d');
      const pixel = ctx?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      const time = Number(document.querySelector<HTMLInputElement>('input[aria-label="Seek"]')?.value ?? 0);
      const playheadX = document.querySelector<HTMLElement>('.playhead')?.getBoundingClientRect().x ?? 0;
      samples.push({ luma: pixel ? pixel[0]! + pixel[1]! + pixel[2]! : 0, time, now: performance.now(), playheadX, dpr: devicePixelRatio });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  // --- Playback across the whole real-footage montage ---
  await page.getByRole('button', { name: 'play', exact: true }).click();
  await page.waitForTimeout(5200);

  const playback = await page.evaluate(() => {
    const engine = (
      window as unknown as { __fpPreviewEngine?: { debugStats(): Record<string, number> } }
    ).__fpPreviewEngine;
    return {
      stats: engine?.debugStats() ?? null,
      fellBack: !document.querySelector('.webcodecs-preview'),
      willReadFrequently: document.querySelector<HTMLCanvasElement>('.webcodecs-preview-canvas')
        ?.getContext('2d')?.getContextAttributes().willReadFrequently ?? true,
      canvasSamples: (window as unknown as {
        __fpCanvasSamples?: { luma: number; time: number; now: number; playheadX: number; dpr: number }[];
      }).__fpCanvasSamples ?? [],
    };
  });
  // eslint-disable-next-line no-console
  console.log('P7 playback:', JSON.stringify({
    stats: playback.stats,
    fellBack: playback.fellBack,
    canvasSamples: playback.canvasSamples.length,
    blankSamples: playback.canvasSamples.filter(({ luma }) => luma === 0).length,
  }));
  expect(playback.fellBack).toBe(false);
  expect(playback.willReadFrequently).toBe(false);
  const pb = playback.stats as Record<string, number>;
  // Read once and assert non-null: `Record<string, number>` indexing yields
  // `number | undefined` under noUncheckedIndexedAccess, and the ratio
  // assertions below do arithmetic on it. Pre-existing type error, fixed here.
  const ticks = pb.ticks ?? 0;
  expect(ticks).toBeGreaterThan(80);
  expect(pb.missing).toBe(0);
  expect(pb.wrongSegment).toBe(0);
  // A 120 Hz display must not repaint 30 fps source pixels four times. The
  // resident canvas frame is reused until the media timestamp changes.
  expect(pb.sourceDraws).toBeLessThan(ticks / 2);
  expect(pb.reusedFrames).toBeGreaterThan(ticks / 2);
  expect(playback.canvasSamples.filter(({ luma }) => luma === 0)).toEqual([]);
  const liveTimes = playback.canvasSamples.map(({ time }) => time).filter((time) => time > 0);
  const deltas = liveTimes.slice(1).map((time, index) => time - liveTimes[index]!);
  expect(deltas.filter((delta) => delta < 0)).toEqual([]);
  const displayIntervals = playback.canvasSamples.slice(1).map((sample, index) => sample.now - playback.canvasSamples[index]!.now);
  const physicalXs = playback.canvasSamples.map(({ playheadX, dpr }) => playheadX * dpr);
  expect(physicalXs.filter((x) => Math.abs(x - Math.round(x)) > 0.01)).toEqual([]);
  // eslint-disable-next-line no-console
  console.log('P7 cadence:', JSON.stringify({
    maxDisplayIntervalMs: Math.max(...displayIntervals),
    fractionalPhysicalPositions: physicalXs.filter((x) => Math.abs(x - Math.round(x)) > 0.01).length,
  }));

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
  console.log('P7 scrub:', JSON.stringify(scrub));
  // A scrub must present a frame fast enough to feel live (< 100 ms worst
  // case) even against GOP-30 B-frame footage.
  expect((scrub as Record<string, number>).maxSeekMs).toBeLessThan(100);

  // --- An edit must NOT reload media (incremental loadSegments) ---
  const fetchesBeforeEdit = new Map(mediaFetches);
  // dispatchEvent, not a pointer click: a 3-frame clip block is only a few px
  // wide at default zoom — a real pointer press lands on its trim handle and
  // starts a trim gesture instead of a selection click.
  await clip(page, 'clip_5').dispatchEvent('click');
  await expect(clip(page, 'clip_5')).toHaveAttribute('data-selected', 'true');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(clip(page, 'clip_5')).toHaveCount(0);
  // Give a hypothetical (wrong) full reload time to start re-fetching.
  await page.waitForTimeout(500);
  expect(Object.fromEntries(mediaFetches)).toEqual(Object.fromEntries(fetchesBeforeEdit));

  // The preview survived the edit: still the canvas engine (no fallback), and
  // a seek into the region after the deleted clip still presents.
  const afterEdit = await page.evaluate(() => {
    const engine = (
      window as unknown as { __fpPreviewEngine?: { debugStats(): Record<string, number> } }
    ).__fpPreviewEngine;
    return { stats: engine?.debugStats() ?? null, fellBack: !document.querySelector('.webcodecs-preview') };
  });
  expect(afterEdit.fellBack).toBe(false);
  expect((afterEdit.stats as Record<string, number>).segCount).toBeGreaterThan(0);
});
