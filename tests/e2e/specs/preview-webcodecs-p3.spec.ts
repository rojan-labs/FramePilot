/**
 * P3a real-editor integration test (plan PREVIEW-WEBCODECS-COMPOSITOR.md) —
 * verifies the canvas compositing pass: a per-clip TRANSFORM (centered
 * scale-down) and a CROP (in-place inset mask) actually change what the
 * `WebCodecsPreviewEngine` paints, read off real canvas pixels — not just
 * "no error". The fixture paints a solid background (20,20,60) with a
 * watermark in the top-left, so:
 *   - scale 0.5 centered → the frame occupies the middle 640×360 of the
 *     1280×720 canvas; the corners are CLEARED (transparent), the centre is
 *     the video's background colour;
 *   - crop {x:0,y:0,w:0.5,h:1} → only the LEFT half is drawn; the right half
 *     is cleared.
 *
 * Runs in the `preview-spike` Playwright project (real Google Chrome). See
 * preview-webcodecs-p1.spec.ts's header for why a project is injected via
 * localStorage with https:// asset paths rather than the shared Demo Project
 * (`fp-media://` has no handler in a plain browser).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import { clip } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN_SCRIPT = join(HERE, '..', 'fixtures', 'preview-spike', 'gen-proxy.mjs');
const FIXTURE_DIR = join(HERE, '..', '.tmp-preview-spike-fixtures');
const CLIP = join(FIXTURE_DIR, 'p3-clip.mp4');
const CLIP_URL = 'https://fixtures.internal/p3-clip.mp4';
// The fixture's solid background colour (bg arg below), below the watermark.
const BG = { r: 20, g: 20, b: 60 };

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!existsSync(CLIP)) {
    execFileSync(
      'node',
      [GEN_SCRIPT, CLIP, '90', '1280', '720', '440', `${BG.r},${BG.g},${BG.b}`],
      {
        stdio: 'inherit',
      },
    );
  }
});

/** A single-video-clip project whose one clip carries `overrides` (transform
 * keyframes / crop / grade / blend), so `canvasPreviewEligible` is true and the
 * canvas compositor renders it. */
function projectWith(overrides: Record<string, unknown>) {
  return {
    id: 'project_p3_compositing',
    name: 'P3 Compositing',
    version: 1,
    fps: 30,
    resolution: { width: 1280, height: 720 },
    assets: [{ id: 'asset_a', path: CLIP_URL, kind: 'video', durationSeconds: 3 }],
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
              ...overrides,
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

/** A project with the video clip plus a text overlay (`__text__` clip carrying
 * a `text` effect with `textParams`) on a second track — exercises the P3b
 * canvas overlay layer. */
function projectWithOverlay(textParams: Record<string, unknown>) {
  const base = projectWith({});
  base.name = 'P3 Compositing';
  base.timeline.tracks.push({
    id: 'overlay_1',
    type: 'video',
    clips: [
      {
        id: 'text_1',
        assetId: '__text__',
        trackId: 'overlay_1',
        start: 0,
        end: 3,
        sourceStart: 0,
        sourceEnd: 3,
        effects: [{ id: 'text_1__text', type: 'text', params: textParams, keyframes: [] }],
        keyframes: [],
      },
    ],
  } as (typeof base.timeline.tracks)[number]);
  return base;
}

/** A 9:16 (portrait) project over the same 16:9 fixture — exercises the P3c
 * letterbox: the wide source is contain-fit into the tall frame, leaving cleared
 * bars top and bottom. Canvas buffer becomes 720×1280. */
function portraitProject() {
  const base = projectWith({});
  base.resolution = { width: 720, height: 1280 };
  return base;
}

/** Read one canvas pixel as [r,g,b,a]. */
async function pixel(canvas: Locator, x: number, y: number): Promise<number[]> {
  return canvas.evaluate(
    (el, [px, py]) => {
      const ctx = (el as HTMLCanvasElement).getContext('2d');
      if (!ctx) return [0, 0, 0, 0];
      const data = ctx.getImageData(px, py, 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    },
    [x, y] as const,
  );
}

/** Seek the custom monitor scrubber by pointer position. It is an ARIA slider,
 * not an `<input>`, so Playwright's `fill()` is intentionally unavailable. */
async function scrubTo(page: import('@playwright/test').Page, seconds: number): Promise<void> {
  const scrub = page.getByRole('slider', { name: 'Scrub' });
  const max = Number(await scrub.getAttribute('aria-valuemax'));
  const bounds = await scrub.boundingBox();
  expect(bounds).not.toBeNull();
  expect(max).toBeGreaterThan(0);
  await scrub.click({
    position: {
      x: Math.max(1, Math.min(bounds!.width - 1, (seconds / max) * bounds!.width)),
      y: bounds!.height / 2,
    },
  });
}

const near = (value: number, target: number, tol = 24): boolean => Math.abs(value - target) <= tol;

async function openProject(
  page: import('@playwright/test').Page,
  project: unknown,
): Promise<Locator> {
  await page.route('**/fixtures.internal/p3-clip.mp4', (route) => route.fulfill({ path: CLIP }));
  await page.addInitScript((p) => {
    localStorage.setItem(`framepilot:project:${(p as { id: string }).id}`, JSON.stringify(p));
    localStorage.setItem('framepilot:last-project-id', (p as { id: string }).id);
  }, project);

  await page.goto('/');
  await expect(page.getByLabel('project name')).toHaveText('P3 Compositing');
  await expect(clip(page, 'clip_a')).toBeVisible();

  const canvas = page.getByRole('img', { name: 'preview' });
  await expect(canvas).toBeVisible();
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
  return canvas;
}

test('P3a: a centered scale-down transform shrinks the frame on the canvas', async ({ page }) => {
  const canvas = await openProject(
    page,
    projectWith({
      keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 0.5, easing: 'linear' }],
    }),
  );

  // Wait for the first frame to actually paint (centre becomes the video bg).
  await expect
    .poll(async () => (await pixel(canvas, 640, 360))[2], { timeout: 8000 })
    .toBeGreaterThan(30);

  // Centre: the video's background colour (below the watermark).
  const centre = await pixel(canvas, 640, 360);
  expect(near(centre[0]!, BG.r) && near(centre[1]!, BG.g) && near(centre[2]!, BG.b)).toBe(true);

  // A corner well outside the centred 640×360 region: cleared (transparent).
  const corner = await pixel(canvas, 40, 40);
  expect(corner[3]!).toBeLessThan(20);

  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P3a: a left-half crop clears the right half of the canvas', async ({ page }) => {
  const canvas = await openProject(
    page,
    projectWith({ crop: { x: 0, y: 0, width: 0.5, height: 1 } }),
  );

  // Left half paints the video; poll until the first frame arrives.
  await expect
    .poll(async () => (await pixel(canvas, 320, 360))[2], { timeout: 8000 })
    .toBeGreaterThan(30);

  const left = await pixel(canvas, 320, 360);
  expect(near(left[0]!, BG.r) && near(left[1]!, BG.g) && near(left[2]!, BG.b)).toBe(true);

  // Right half is outside the crop rect → cleared.
  const right = await pixel(canvas, 960, 360);
  expect(right[3]!).toBeLessThan(20);

  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P3b: a text overlay with a background box composites on top of the video', async ({
  page,
}) => {
  // A big red-backed overlay box centred at 50%/50% over the dark video bg. The
  // overlay pass draws it after the picture, so the centre becomes bright (red
  // box or white text — both have red≫video bg), while a far corner stays the
  // video background (the overlay is localized, not full-frame).
  const canvas = await openProject(
    page,
    projectWithOverlay({
      text: 'HELLO',
      background: '#ff0000',
      boxWidthPercent: 40,
      fontSizePercent: 18,
      xPercent: 50,
      yPercent: 50,
    }),
  );

  // Wait for the first composited frame: the centre goes bright red.
  await expect
    .poll(async () => (await pixel(canvas, 640, 360))[0], { timeout: 8000 })
    .toBeGreaterThan(150);

  const centre = await pixel(canvas, 640, 360);
  expect(centre[0]!).toBeGreaterThan(150); // overlay present (red box or white glyph)

  // A far corner is untouched by the overlay → still the video background.
  const corner = await pixel(canvas, 40, 360);
  expect(near(corner[0]!, BG.r) && near(corner[2]!, BG.b)).toBe(true);

  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P3b: preview selection mirrors the timeline and isolates objects on double-click', async ({
  page,
}) => {
  await openProject(
    page,
    projectWithOverlay({
      text: 'SELECT ME',
      boxWidthPercent: 50,
      fontSizePercent: 14,
      xPercent: 50,
      yPercent: 50,
    }),
  );

  // Timeline selection must be visible in the program monitor, using neutral
  // white editor chrome rather than the application accent colour.
  await clip(page, 'text_1').click();
  const textSelection = page.getByRole('group', { name: 'edit text overlay' });
  await expect(textSelection).toBeVisible();
  await expect(textSelection).toHaveCSS('outline-color', 'rgba(255, 255, 255, 0.98)');

  // Return to no selection, then exercise the preview itself. One click resolves
  // to the background picture; a double-click at the same object isolates it.
  await page.keyboard.press('Escape');
  const objectHit = page.getByRole('button', {
    name: 'select text overlay text_1 in preview',
  });
  await objectHit.click();
  await expect(clip(page, 'clip_a')).toHaveAttribute('data-selected', 'true');

  await objectHit.dblclick();
  await expect(clip(page, 'text_1')).toHaveAttribute('data-selected', 'true');
  await expect(textSelection).toBeVisible();
});

test('P3c: a 9:16 project letterboxes the 16:9 source (cleared top/bottom bars)', async ({
  page,
}) => {
  const canvas = await openProject(page, portraitProject());

  // Canvas buffer is 720×1280 (9:16). A 16:9 source contain-fits to full width,
  // occupying the vertical band y≈[437,842]; the centre is the video, the top
  // and bottom bands are cleared (letterbox).
  await expect
    .poll(async () => (await pixel(canvas, 360, 640))[2], { timeout: 8000 })
    .toBeGreaterThan(30);

  const centre = await pixel(canvas, 360, 640);
  expect(near(centre[0]!, BG.r) && near(centre[1]!, BG.g) && near(centre[2]!, BG.b)).toBe(true);

  const topBar = await pixel(canvas, 360, 80);
  expect(topBar[3]!).toBeLessThan(20); // cleared letterbox bar
  const bottomBar = await pixel(canvas, 360, 1200);
  expect(bottomBar[3]!).toBeLessThan(20);

  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P3b: the overlay survives playback (repainted each frame, not stacked)', async ({ page }) => {
  // Play briefly, then pause: the overlay must still be there (it's repainted
  // on top of every decoded frame), and the box colour must be clean — proof
  // the per-frame clear+redraw keeps overlays from compounding.
  const canvas = await openProject(
    page,
    projectWithOverlay({
      text: 'X',
      background: '#00ff00',
      boxWidthPercent: 30,
      fontSizePercent: 20,
    }),
  );

  await expect
    .poll(async () => (await pixel(canvas, 640, 360))[1], { timeout: 8000 })
    .toBeGreaterThan(150);

  await page.getByRole('button', { name: 'play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'pause' })).toBeVisible();
  await expect
    .poll(() => page.locator('.preview-transport .transport-time').textContent())
    .toContain('00:00:0');
  await page.getByRole('button', { name: 'pause' }).click();

  const centre = await pixel(canvas, 640, 360);
  expect(centre[1]!).toBeGreaterThan(150); // green box still present after playback
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P5: the default WebCodecs monitor exposes every view action and contains portrait precisely', async ({
  page,
}) => {
  await openProject(page, portraitProject());

  await expect(page.getByRole('combobox', { name: 'Canvas orientation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'loop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'composition grid' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'safe-area guides' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'fullscreen preview' })).toBeVisible();

  await page.getByRole('button', { name: 'composition grid' }).click();
  await expect(page.locator('.preview-grid')).toBeVisible();
  await page.getByRole('button', { name: 'safe-area guides' }).click();
  await expect(page.locator('.preview-safe-area')).toBeVisible();

  const bounds = await page.evaluate(() => {
    const stage = document.querySelector('.preview-stage')?.getBoundingClientRect();
    const frame = document.querySelector('.preview-frame')?.getBoundingClientRect();
    if (!stage || !frame) return null;
    return {
      stageWidth: stage.width,
      stageHeight: stage.height,
      frameWidth: frame.width,
      frameHeight: frame.height,
    };
  });
  expect(bounds).not.toBeNull();
  expect(bounds!.frameWidth).toBeLessThanOrEqual(bounds!.stageWidth + 1);
  expect(bounds!.frameHeight).toBeLessThanOrEqual(bounds!.stageHeight + 1);
  expect(bounds!.frameWidth / bounds!.frameHeight).toBeCloseTo(9 / 16, 2);

  await page.getByRole('combobox', { name: 'Canvas orientation' }).click();
  await page.getByRole('option', { name: /^16:9/ }).click();
  await expect(page.getByRole('img', { name: 'preview' })).toHaveAttribute('width', '1280');
  await expect(page.getByRole('img', { name: 'preview' })).toHaveAttribute('height', '720');
  await expect
    .poll(() =>
      page.locator('.preview-frame').evaluate((frame) => {
        const rect = frame.getBoundingClientRect();
        return rect.width / rect.height;
      }),
    )
    .toBeCloseTo(16 / 9, 2);

  // The scrub bar occupies a full-width row above the centered transport controls.
  // Retargeted at the shared `PreviewTransport` (revamp Phase 2), which replaced
  // this monitor's own transport and its stepped `<input type=range>` seek with a
  // pointer-accurate scrub track.
  const transportLayout = await page.evaluate(() => {
    const transport = document.querySelector('.preview-transport')?.getBoundingClientRect();
    const seek = document.querySelector('.preview-scrub-track')?.getBoundingClientRect();
    const navigation = document
      .querySelector('.preview-transport .transport-nav')
      ?.getBoundingClientRect();
    if (!transport || !seek || !navigation) return null;
    return {
      transportWidth: transport.width,
      seekWidth: seek.width,
      seekBottom: seek.bottom,
      navigationTop: navigation.top,
      transportCenter: transport.left + transport.width / 2,
      navigationCenter: navigation.left + navigation.width / 2,
    };
  });
  expect(transportLayout).not.toBeNull();
  expect(transportLayout!.seekWidth).toBeGreaterThan(transportLayout!.transportWidth * 0.9);
  expect(transportLayout!.seekBottom).toBeLessThanOrEqual(transportLayout!.navigationTop + 1);
  expect(transportLayout!.navigationCenter).toBeCloseTo(transportLayout!.transportCenter, 0);
});

test('P5: an effect applied through the UI changes the default WebCodecs canvas pixels', async ({
  page,
}) => {
  const canvas = await openProject(page, projectWith({}));
  await expect
    .poll(async () => (await pixel(canvas, 640, 360))[2], { timeout: 8000 })
    .toBeGreaterThan(30);
  const before = await pixel(canvas, 640, 360);

  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.getByLabel('search effects').fill('Silver Halide');
  await page.getByRole('button', { name: /^Silver Halide\./ }).click();
  await expect(page.locator('.fx-layer')).toHaveCount(1);

  await expect
    .poll(
      async () => {
        const after = await pixel(canvas, 640, 360);
        return (
          Math.abs(after[0]! - before[0]!) +
          Math.abs(after[1]! - before[1]!) +
          Math.abs(after[2]! - before[2]!)
        );
      },
      { timeout: 8000 },
    )
    .toBeGreaterThan(12);
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P6: bypassing and removing an effect restores WebCodecs preview pixels', async ({ page }) => {
  const canvas = await openProject(page, projectWith({}));
  await expect
    .poll(async () => (await pixel(canvas, 640, 360))[2], { timeout: 8000 })
    .toBeGreaterThan(30);
  const before = await pixel(canvas, 640, 360);

  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.getByLabel('search effects').fill('Silver Halide');
  await page.getByRole('button', { name: /^Silver Halide\./ }).click();
  await expect
    .poll(
      async () => {
        const after = await pixel(canvas, 640, 360);
        return after.reduce((sum, value, index) => sum + Math.abs(value - before[index]!), 0);
      },
      { timeout: 8000 },
    )
    .toBeGreaterThan(12);

  await page.locator('.fx-layer').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bypass' }).click();
  await expect
    .poll(
      async () => {
        const after = await pixel(canvas, 640, 360);
        return after.reduce((sum, value, index) => sum + Math.abs(value - before[index]!), 0);
      },
      { timeout: 8000 },
    )
    .toBeLessThan(8);

  await page.locator('.fx-layer').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.fx-layer')).toHaveCount(0);
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});

test('P6: an effect changes pixels only inside its timeline range', async ({ page }) => {
  const canvas = await openProject(page, projectWith({}));
  await expect(page.getByRole('slider', { name: 'Scrub' })).toHaveAttribute('aria-valuemax', '3');
  await scrubTo(page, 2.5);
  await expect
    .poll(async () => (await pixel(canvas, 640, 360))[2], { timeout: 8000 })
    .toBeGreaterThan(30);
  const outsideBefore = await pixel(canvas, 640, 360);
  await scrubTo(page, 0);

  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.getByLabel('search effects').fill('Silver Halide');
  await page.getByRole('button', { name: /^Silver Halide\./ }).click();
  const layer = page.locator('.fx-layer').first();
  const layerBox = await layer.boundingBox();
  const trimHandle = await layer.locator('.fx-layer-handle--end').boundingBox();
  expect(layerBox).not.toBeNull();
  expect(trimHandle).not.toBeNull();
  await page.mouse.move(
    trimHandle!.x + trimHandle!.width / 2,
    trimHandle!.y + trimHandle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(layerBox!.x + layerBox!.width / 3, trimHandle!.y + trimHandle!.height / 2);
  await page.mouse.up();
  await scrubTo(page, 2.5);

  await expect
    .poll(
      async () => {
        const outsideAfter = await pixel(canvas, 640, 360);
        return outsideAfter.reduce(
          (sum, value, index) => sum + Math.abs(value - outsideBefore[index]!),
          0,
        );
      },
      { timeout: 8000 },
    )
    .toBeLessThan(8);
  await expect(page.locator('.webcodecs-preview-error')).toHaveCount(0);
});
