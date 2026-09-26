/**
 * Elements · Photos and Videos end to end (plan/elements EL9, ADR 0193; the manual path of
 * plan/elements 10 §2):
 *
 *  1. Pick a category in the project's own shape, lay a Pexels clip over the footage with **Add as
 *     overlay** — a picture-in-picture on a lane in front of the footage, 40% of its size, centred —
 *     undo and redo it, export it (the overlay's colour in the middle of the frame and the footage's
 *     around it), check the monitor draws what the export draws, then close the project and reopen
 *     it: nothing changed, and the monitor still matches the export.
 *  2. Drag tiles onto the timeline: over the footage a shot lands full frame on a new lane in front
 *     of it; after the footage it lands on the lane it was dropped on. Both undo.
 *  3. The same **Add as overlay** on the user's own image (ADR 0193, amendment "bin images"):
 *     import a transparent PNG into the bin, lay it over the footage from its card, export (the
 *     image where it is opaque, the footage through it where it is transparent), check the monitor
 *     draws what the export draws, and undo it with the image left in the bin.
 *
 * What is real: the editor (Elements → Videos, the category chips and orientation filter, the tile's
 * Add, Add as overlay and drag, the shared download flow and its tile registry, the timeline's drop,
 * the placement patches, History, Undo and Redo, the project's open path) and the export (`render()`
 * with validation), read back through the same parity gates as the PX4 oracle.
 *
 * SIMULATED, and why: Electron and `fp-media://` (see `masking/fake-desktop.ts`), and Pexels itself —
 * a search answers two items and a download copies a sentinel clip into the project's media folder,
 * answering as main's service does. The service's cache, quota and download are unit-tested in
 * `apps/desktop` (`stock-service.test.ts`). The drag is dispatched with a `DataTransfer` built in
 * the page: the tile's own `dragstart` writes the payload and the lane's own `drop` reads it, at an
 * exact point on the lane. Chromium does drive a real HTML5 drag from the pointer (the Stickers
 * spec drags a sticker onto the monitor that way); a page-built `DataTransfer` only cannot report a
 * drop effect — Chromium makes it a copy-and-paste transfer — so these rows check what the drop
 * placed, not the cursor. The import's probe reads the PNG's own header (see the fake host); the
 * bytes are written by main's own `importMediaFile`.
 *
 * CI ONLY (`elements-e2e` job): it renders.
 */
import { deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  COLOURS,
  HEIGHT,
  WIDTH,
  attachDiagnostics,
  clip,
  clipsById,
  expectValidExport,
  openInDesktop,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import type { FakeStockLibrary } from './masking/fake-desktop.js';
import { expectPreviewMatchesExport } from './masking/parity.js';
import { Workspace } from './masking/workspace.js';
import type { Project } from '../../../packages/timeline-schema/dist/index.js';

const SECONDS = 3;
const NAME = 'Elements photos';
/** The stand-in Pexels items: sentinel clips the "download" copies into the project. */
const RED_ID = '9000001';
const GREEN_ID = '9000002';
const RED_TITLE = 'Red sentinel skyline';
const GREEN_TITLE = 'Green sentinel field';
const assetIdOf = (remoteId: string): string => `stock_pexels_${remoteId}`;

/** As main sends a search result to the renderer: dimensions and credits, never a URL. */
function item(remoteId: string, title: string, avgColor: string): Record<string, unknown> {
  return {
    remoteId,
    provider: 'pexels',
    kind: 'video',
    title,
    width: WIDTH,
    height: HEIGHT,
    durationSeconds: SECONDS,
    avgColor,
    // No hover preview: the harness serves no tile bytes, and hovering must not ask for any.
    hasPreview: false,
    variants: [
      {
        id: 'sd',
        width: WIDTH,
        height: HEIGHT,
        fps: 30,
        contentType: 'video/mp4',
        format: 'mp4',
        approxBytes: 200_000,
      },
    ],
    license: 'pexels',
    licenseUrl: 'https://www.pexels.com/license/',
    attributionRequired: false,
    attribution: 'Video by Sentinel on Pexels',
    creator: 'Sentinel',
  };
}

const STOCK: FakeStockLibrary = {
  items: [item(RED_ID, RED_TITLE, '#aa3322'), item(GREEN_ID, GREEN_TITLE, '#22aa33')],
  files: {
    [RED_ID]: {
      path: 'media/pexels_red.mp4',
      kind: 'video',
      width: WIDTH,
      height: HEIGHT,
      durationSeconds: SECONDS,
    },
    [GREEN_ID]: {
      path: 'media/pexels_green.mp4',
      kind: 'video',
      width: WIDTH,
      height: HEIGHT,
      durationSeconds: SECONDS,
    },
  },
};

/** A project with one blue clip on `video_1`, and the sentinel clips the stand-in Pexels serves. */
async function photosWorkspace(name: string, id: string): Promise<Workspace> {
  const workspace = await Workspace.create(name);
  await workspace.media([
    video('bg', 'blue', SECONDS),
    video('pexels_red', 'red', SECONDS),
    video('pexels_green', 'green', SECONDS),
  ]);
  await workspace.writeProject(
    project({
      id,
      name: NAME,
      videos: [{ id: 'bg', seconds: SECONDS }],
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  return workspace;
}

/**
 * The Elements panel is desktop-only, so the browser `accessibility.spec` never reaches it: it is
 * scanned here, in both themes, with the same WCAG A/AA rules the Stickers spec uses (plan/elements
 * 13 §1). Run before the pointer rests on a tile, whose caption fades in over the photograph.
 */
async function expectPanelAxeClean(page: Page, label: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page })
      .include('.elements-panel')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      violations.map(({ id }) => id),
      `${label} (${colorScheme}): ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}

/** Elements → Videos → the City category; resolves once the category's own results are shown. */
async function openCityVideos(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Videos', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Video categories', exact: true })
    .getByRole('button', { name: 'City', exact: true })
    .click();
  const results = page.getByRole('list', { name: 'City — video', exact: true });
  await expect(results).toBeVisible();
  // A re-search dims the previous results (`is-stale`, half opacity) until the new ones land;
  // anything measured before then — colour contrast above all — measures the dimmed grid.
  await expect(results).not.toHaveClass(/is-stale/);
  return results;
}

const tileOf = (results: Locator, title: string): Locator =>
  results.getByRole('listitem').filter({ hasText: title });

const stockClipsOf = (document: Project, remoteId: string) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId === assetIdOf(remoteId));

const lanesOf = (document: Project): string[] => document.timeline.tracks.map((track) => track.id);

const toolbarButton = (page: Page, name: 'Undo' | 'Redo'): Locator =>
  page
    .getByRole('toolbar', { name: 'editor tools', exact: true })
    .getByRole('button', { name, exact: true });

type Rgb = readonly [number, number, number];
/** Sentinel colours differ by >= 96/255 on some channel; an encode moves them far less. */
const COLOUR_TOLERANCE = 40;

/** The colours of an engine frame at points given as fractions of its width and height. */
async function coloursAt(
  page: Page,
  url: string,
  points: readonly (readonly [number, number])[],
): Promise<Rgb[]> {
  return page.evaluate(
    async ({ url: frameUrl, points: at }) => {
      const bitmap = await createImageBitmap(await (await fetch(frameUrl)).blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const colours = at.map(([fx, fy]) => {
        const x = Math.round(fx * (bitmap.width - 1));
        const y = Math.round(fy * (bitmap.height - 1));
        const pixel = context.getImageData(x, y, 1, 1).data;
        return [pixel[0]!, pixel[1]!, pixel[2]!] as [number, number, number];
      });
      bitmap.close();
      return colours;
    },
    { url, points },
  );
}

function expectColour(actual: Rgb, expected: Rgb, where: string): void {
  const off = Math.max(...actual.map((channel, index) => Math.abs(channel - expected[index]!)));
  expect(
    off,
    `${where}: got ${actual.join(',')}, expected ${expected.join(',')}`,
  ).toBeLessThanOrEqual(COLOUR_TOLERANCE);
}

/** A fresh browser context: the reopened project shares nothing in memory with the closed one. */
async function newEditorPage(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  });
  return context.newPage();
}

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

test('Videos: a category in the project’s shape, Add as overlay over the footage, undo and redo, export, reopen', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  const workspace = await photosWorkspace('elements-photos', 'elements_photos');
  opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl(), stock: STOCK },
    NAME,
  );
  const { desktop } = opened;

  // --- the Videos tab, in the project's shape; a category is one search ------------------------
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name: 'Videos', exact: true })
    .click();
  const orientation = page.getByRole('group', { name: 'Orientation', exact: true });
  // The project is landscape, so the filter starts there.
  await expect(orientation.getByRole('button', { name: 'Landscape', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const results = await openCityVideos(page);
  await expect
    .poll(() =>
      desktop.stockSearches.filter(
        (request) => request.text === 'city' && request.orientation === 'landscape',
      ),
    )
    .toHaveLength(1);
  // What a category costs is said in its chip's tooltip, where the choice is made.
  await expect(
    page
      .getByRole('group', { name: 'Video categories', exact: true })
      .getByRole('button', { name: 'City', exact: true }),
  ).toHaveAttribute('title', /Each category is one search of your Pexels allowance\./);
  const tile = tileOf(results, RED_TITLE);
  await expect(tile).toBeVisible();
  await expectPanelAxeClean(page, 'Videos');

  // --- over the footage: Add is a cutaway and says why not; Add as overlay places it -----------
  await tile.hover();
  await expect(tile.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await tile.getByRole('button', { name: 'Add as overlay', exact: true }).click();
  const added = await savedProject(
    desktop,
    (doc) => stockClipsOf(doc, RED_ID).length === 1,
    'the overlay placed',
  );
  const overlay = stockClipsOf(added, RED_ID)[0]!;
  expect(overlay).toMatchObject({ start: 0, end: SECONDS });
  // 40% of its size, centred: the base keyframes the on-canvas handles write.
  expect(overlay.keyframes.map((key) => [key.property, key.time, key.value])).toEqual([
    ['scale', 0, 0.4],
    ['x', 0, 0],
    ['y', 0, 0],
  ]);
  // On its own lane, in front of the footage.
  expect(overlay.trackId).not.toBe('video_1');
  expect(lanesOf(added).indexOf(overlay.trackId)).toBeLessThan(lanesOf(added).indexOf('video_1'));
  expect(clipsById(added).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
  expect(added.assets.find((asset) => asset.id === assetIdOf(RED_ID))?.source?.provider).toBe(
    'pexels',
  );
  // The tile now says the clip is in the project.
  await expect(tile.getByText('In this project', { exact: true })).toBeVisible();

  // --- undo takes back the clip, its lane and the asset; redo brings back exactly that ---------
  await toolbarButton(page, 'Undo').click();
  const undone = await savedProject(
    desktop,
    (doc) => stockClipsOf(doc, RED_ID).length === 0,
    'the overlay undone',
  );
  expect(lanesOf(undone)).toEqual(['video_1']);
  expect(undone.assets.some((asset) => asset.id === assetIdOf(RED_ID))).toBe(false);
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
  await toolbarButton(page, 'Redo').click();
  const redone = await savedProject(
    desktop,
    (doc) => stockClipsOf(doc, RED_ID).length === 1,
    'the overlay redone',
  );
  expect(stockClipsOf(redone, RED_ID)).toEqual([overlay]);
  expect(lanesOf(redone)).toEqual(lanesOf(added));
  expect(redone.assets).toEqual(added.assets);

  // --- export: valid, the overlay where it belongs, and the monitor draws the same pixels ------
  expectValidExport(await workspace.export('photos-overlay.mp4'), SECONDS);
  // Parity alone would pass if both runtimes dropped or mis-sized the overlay, so one export
  // frame is read directly: the red overlay inside the 40% box centred on the frame (which spans
  // 30%–70% of each side), the blue footage outside it. Points sit in each sentinel's primary
  // colour, clear of the second colour in its top-right quadrant.
  const [frame] = await workspace.frames([1], 'photos-overlay-colours');
  const origin = new URL(page.url()).origin;
  const [inside, insideCorner, left, corner] = await coloursAt(
    page,
    `${origin}${workspace.urlPath(frame!.path)}`,
    [
      [0.4375, 0.6],
      [0.3125, 0.68],
      [0.25, 0.6],
      [0.03, 0.95],
    ],
  );
  expectColour(inside!, COLOURS.red[0], 'the overlay, inside its box');
  expectColour(insideCorner!, COLOURS.red[0], 'just inside the box’s lower-left corner');
  expectColour(left!, COLOURS.blue[0], 'the footage, a quarter of the way in');
  expectColour(corner!, COLOURS.blue[0], 'the footage, in the corner');
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'photos-overlay', testInfo);

  // --- save, close, reopen: identical, and still drawn as it exports ---------------------------
  const onDisk = await workspace.readProject();
  expect(stockClipsOf(onDisk, RED_ID)).toEqual([overlay]);
  await attachDiagnostics(testInfo, opened);
  await page.close();
  const reopenedPage = await newEditorPage(
    browser,
    testInfo.project.use.baseURL ?? 'http://127.0.0.1:5173',
  );
  opened = await openInDesktop(
    reopenedPage,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl(), stock: STOCK },
    NAME,
  );
  // What was saved is what opened: the overlay, its lane in front of the footage, and the asset
  // (an autosave on open may rewrite the file, so the parts that carry the edit are compared).
  const reread = await workspace.readProject();
  expect(stockClipsOf(reread, RED_ID)).toEqual([overlay]);
  expect(lanesOf(reread)).toEqual(lanesOf(onDisk));
  expect(reread.assets).toEqual(onDisk.assets);
  // The overlay is on the timeline where it was, and the monitor draws what the export draws.
  await expect(
    reopenedPage.getByRole('button', { name: `clip ${overlay.id}`, exact: true }),
  ).toBeVisible();
  await expectPreviewMatchesExport(
    reopenedPage,
    workspace,
    [0.5, 1.5],
    'photos-overlay-reopened',
    testInfo,
  );
});

test('Videos: a tile dragged onto the timeline lands at the drop — in front of footage, or on the lane after it', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await photosWorkspace('elements-photos-drag', 'elements_photos_drag');
  opened = await openInDesktop(
    page,
    testInfo,
    { workspace, sidecarUrl: sidecarUrl(), stock: STOCK },
    NAME,
  );
  const { desktop } = opened;
  const results = await openCityVideos(page);

  const lane = page.locator('[data-track-id="video_1"]');
  const footage = page.getByRole('button', { name: 'clip clip_bg', exact: true });
  const laneBox = (await lane.boundingBox())!;
  const footageBox = (await footage.boundingBox())!;
  const drag = async (title: string, clientX: number): Promise<void> => {
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await tileOf(results, title).dispatchEvent('dragstart', { dataTransfer });
    const at = { clientX, clientY: laneBox.y + laneBox.height / 2 };
    await lane.dispatchEvent('dragover', { dataTransfer, ...at });
    await lane.dispatchEvent('drop', { dataTransfer, ...at });
  };

  // --- over the footage: full frame, on a new lane in front of it, at the drop time -------------
  await drag(RED_TITLE, footageBox.x + footageBox.width / 2);
  const over = await savedProject(
    desktop,
    (doc) => stockClipsOf(doc, RED_ID).length === 1,
    'the red clip dropped over the footage',
  );
  const red = stockClipsOf(over, RED_ID)[0]!;
  expect(red.trackId).not.toBe('video_1');
  expect(lanesOf(over).indexOf(red.trackId)).toBeLessThan(lanesOf(over).indexOf('video_1'));
  expect(red.start).toBeGreaterThan(0);
  expect(red.start).toBeLessThan(SECONDS);
  // Full frame: no base transform, unlike an overlay.
  expect(red.keyframes).toEqual([]);

  // --- after the footage: on the lane it was dropped on, which has room there ------------------
  // The lane runs well past a 3 s programme (it is at least 10 s wide), so this is empty lane.
  const afterFootage = footageBox.x + footageBox.width + 24;
  expect(afterFootage).toBeLessThan(laneBox.x + laneBox.width);
  await drag(GREEN_TITLE, afterFootage);
  const dropped = await savedProject(
    desktop,
    (doc) => stockClipsOf(doc, GREEN_ID).length === 1,
    'the green clip dropped after the footage',
  );
  const green = stockClipsOf(dropped, GREEN_ID)[0]!;
  expect(green.trackId).toBe('video_1');
  expect(green.start).toBeGreaterThanOrEqual(SECONDS - 0.05);
  expect(green.keyframes).toEqual([]);

  // --- both undo, leaving the footage as it was --------------------------------------------------
  for (let step = 0; step < 2; step += 1) await toolbarButton(page, 'Undo').click();
  const undone = await savedProject(
    desktop,
    (doc) => stockClipsOf(doc, RED_ID).length === 0 && stockClipsOf(doc, GREEN_ID).length === 0,
    'both drops undone',
  );
  expect(lanesOf(undone)).toEqual(['video_1']);
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
});

// --- The user's own image, from the bin (ADR 0193, amendment "bin images") -----------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGBA PNG whose pixel at (x, y) is `pixel(x, y)`. */
function rgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * stride + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A 16:9 "logo" half the project's size: an opaque red block over its middle half, and fully
 * transparent around it. The transparent pixels carry green, so an export that dropped the alpha
 * would show green where the footage belongs.
 */
const LOGO_WIDTH = 320;
const LOGO_HEIGHT = 180;
const LOGO = rgbaPng(LOGO_WIDTH, LOGO_HEIGHT, (x, y) =>
  x >= LOGO_WIDTH / 4 &&
  x < (LOGO_WIDTH * 3) / 4 &&
  y >= LOGO_HEIGHT / 4 &&
  y < (LOGO_HEIGHT * 3) / 4
    ? [...COLOURS.red[0], 255]
    : [0, 255, 0, 0],
);

const clipsOfAsset = (document: Project, assetId: string) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId === assetId);

test('Bin image: a transparent PNG imported into the bin, Add as overlay, export, undo — the image stays', async ({
  page,
}, testInfo) => {
  test.setTimeout(5 * 60_000);
  const workspace = await Workspace.create('elements-bin-overlay');
  await workspace.media([video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: 'elements_bin_overlay',
      name: NAME,
      videos: [{ id: 'bg', seconds: SECONDS }],
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip('video_1', { id: 'clip_bg', assetId: 'bg', start: 0, end: SECONDS })],
        },
      ],
    }),
  );
  opened = await openInDesktop(page, testInfo, { workspace, sidecarUrl: sidecarUrl() }, NAME);
  const { desktop } = opened;

  // --- import the PNG through the bin's own Import -----------------------------------------------
  await page.getByRole('tab', { name: 'Assets', exact: true }).click();
  await page
    .getByLabel('import media', { exact: true })
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO });
  const imported = await savedProject(
    desktop,
    (doc) => doc.assets.some((asset) => asset.id === 'asset_logo'),
    'the image imported into the bin',
  );
  const logo = imported.assets.find((asset) => asset.id === 'asset_logo')!;
  expect(logo).toMatchObject({
    kind: 'image',
    media: { width: LOGO_WIDTH, height: LOGO_HEIGHT },
  });
  expect(logo.path).toMatch(/^media\/.+\/logo\.png$/);

  // --- Add as overlay from the card: over the footage, at the playhead, selected, announced -------
  const card = page.getByLabel('asset asset_logo', { exact: true });
  await card.hover();
  await card.getByRole('button', { name: 'add logo.png as an overlay', exact: true }).click();
  const added = await savedProject(
    desktop,
    (doc) => clipsOfAsset(doc, 'asset_logo').length === 1,
    'the image laid over the footage',
  );
  const overlay = clipsOfAsset(added, 'asset_logo')[0]!;
  // At the playhead, ending with the programme rather than lengthening it.
  expect(overlay).toMatchObject({ start: 0, end: SECONDS });
  expect(overlay.keyframes.map((key) => [key.property, key.time, key.value])).toEqual([
    ['scale', 0, 0.4],
    ['x', 0, 0],
    ['y', 0, 0],
  ]);
  expect(lanesOf(added).indexOf(overlay.trackId)).toBeLessThan(lanesOf(added).indexOf('video_1'));
  // The image was already in the bin: the edit added no asset.
  expect(added.assets).toEqual(imported.assets);
  await expect(
    page.getByRole('button', { name: `clip ${overlay.id}`, exact: true }),
  ).toHaveAttribute('data-selected', 'true');
  await expect(
    page.getByText('Added logo.png as an overlay at 0:00', { exact: true }),
  ).toBeAttached();

  // --- export: the image where it is opaque, the footage through it where it is transparent -------
  expectValidExport(await workspace.export('bin-overlay.mp4'), SECONDS);
  // The overlay is 40% of the frame, centred (30%–70% of each side); its opaque block is the middle
  // half of that (40%–60%). Points sit clear of the footage's second colour, top right.
  const [frame] = await workspace.frames([1], 'bin-overlay-colours');
  const origin = new URL(page.url()).origin;
  const [opaque, transparent, outside] = await coloursAt(
    page,
    `${origin}${workspace.urlPath(frame!.path)}`,
    [
      [0.45, 0.55],
      [0.33, 0.62],
      [0.2, 0.8],
    ],
  );
  expectColour(opaque!, COLOURS.red[0], 'the image, where it is opaque');
  expectColour(
    transparent!,
    COLOURS.blue[0],
    'the footage, through the image’s transparent margin',
  );
  expectColour(outside!, COLOURS.blue[0], 'the footage, outside the overlay');
  await expectPreviewMatchesExport(page, workspace, [0.5, 1.5], 'bin-overlay', testInfo);

  // --- one undo takes the overlay and its lane back; the image stays in the bin -------------------
  await toolbarButton(page, 'Undo').click();
  const undone = await savedProject(
    desktop,
    (doc) => clipsOfAsset(doc, 'asset_logo').length === 0,
    'the overlay undone',
  );
  expect(lanesOf(undone)).toEqual(['video_1']);
  expect(undone.assets.some((asset) => asset.id === 'asset_logo')).toBe(true);
  expect(clipsById(undone).get('clip_bg')).toMatchObject({ start: 0, end: SECONDS });
  await expect(page.getByLabel('asset asset_logo', { exact: true })).toBeVisible();
});
