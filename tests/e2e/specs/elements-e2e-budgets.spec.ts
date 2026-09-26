/**
 * Elements budgets measured in the browser (plan/elements 02 §9):
 *
 * - opening the Stickers tab again paints its first tile within 100 ms;
 * - a click on a sticker puts its clip on the timeline within 300 ms (main copies the file into
 *   the project, then one patch places it), and a click on a shape within 50 ms;
 * - a search keystroke redraws the grid over the whole library (1,595 stickers) within 16 ms;
 * - scrolling the whole grid draws only the rows in view, and asks main for thumbnails in batches
 *   main accepts.
 *
 * The budgets are the app's, so they are measured where the app runs: in Chromium, inside the
 * page, from the event to the frame that shows its result, so no Playwright round trip is
 * counted. jsdom times React against a DOM without layout, two to three times slower on a CI
 * runner than on a laptop, so a wall-clock gate there measured the runner;
 * `StickersBrowser.perf.test.tsx` keeps what jsdom can judge exactly (only the rows in view are
 * drawn) and the search's own work.
 *
 * Gates. The runner is a shared machine with a software GPU, where the reference is an M-series
 * Mac (docs/guides/performance-budgets.md). The open gates at its budget: CI measured a 28 ms warm
 * median against 100. Every other timing here is new, so it is logged and gated at its budget ×2
 * until the logged numbers show at least 2× headroom, when its gate moves to the budget itself.
 * The 60 Hz scroll is judged on a real display (a release step); here its frames and long tasks
 * are logged, and only what the grid draws and asks for is gated.
 *
 * What is real: the editor and its Elements panel, over main's own `ElementsLibrary` through the
 * desktop harness (`masking/fake-desktop.ts`); Electron itself is simulated there. A sticker's
 * copy crosses Playwright's page binding instead of Electron's IPC, which only adds to its time.
 *
 * CI ONLY (`elements-e2e` job).
 */
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  attachDiagnostics,
  clip,
  clipsById,
  openInDesktop,
  project,
  savedProject,
  sidecarUrl,
  video,
  type OpenedEditor,
} from './masking/session.js';
import { REPO, Workspace } from './masking/workspace.js';
import type { Project } from '../../../packages/timeline-schema/dist/index.js';
import { loadStickerCatalog, searchStickers } from '../../../packages/ai-sdk/dist/index.js';
import { MAX_THUMBNAILS_PER_REQUEST } from '../../../apps/desktop/dist/media/elements-library.js';

/** 02 §9 budgets, on the reference machine. */
const FIRST_TILES_BUDGET_MS = 100;
const STICKER_CLICK_BUDGET_MS = 300;
const SHAPE_CLICK_BUDGET_MS = 50;
const SEARCH_BUDGET_MS = 16;
/** A timing whose headroom on the runner is not known yet is gated at its budget × this. */
const UNPROVEN_GATE_FACTOR = 2;
const WARM_OPENS = 5;
/**
 * Five different stickers, one click each: a second add of the same sticker finds its file
 * already in the project and copies nothing, which would time less than the budget covers.
 */
const STICKERS = ['Fire', 'Red heart', 'Thumbs up', 'Rocket', 'Party popper'] as const;
const SHAPE_CLICKS = 5;
/** Typed a key at a time; after each word the search is cleared, which lists the library again. */
const SEARCH_WORDS = ['party', 'heart', 'rocket', '🔥'] as const;
/** A screenful of tiles and its overscan: the grid never draws the library. */
const MAX_DRAWN_TILES = 200;
/** A frame this late at 60 Hz is one the display missed (logged, never gated here). */
const LATE_FRAME_MS = 25;
const SECONDS = 3;
const NAME = 'Elements budgets';
const SHIPPED = join(REPO, 'apps', 'web-editor', 'public', 'elements', 'stickers');

const sortedCopy = (samples: readonly number[]): number[] => [...samples].sort((a, b) => a - b);
const percentile = (samples: readonly number[], share: number): number => {
  const sorted = sortedCopy(samples);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
};
const median = (samples: readonly number[]): number => percentile(samples, 0.5);
const listed = (samples: readonly number[]): string =>
  samples.map((ms) => ms.toFixed(1)).join(', ');

const stickersOf = (document: Project) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId.startsWith('element_'));
const shapesOf = (document: Project) =>
  [...clipsById(document).values()].filter((entry) => entry.assetId === '__shape__');

let opened: OpenedEditor | undefined;
test.afterEach(async ({}, testInfo) => {
  if (opened !== undefined) await attachDiagnostics(testInfo, opened);
  opened = undefined;
});

/**
 * The installer's packaged set as `build:elements` lays it out, for the whole library: a manifest
 * entry and a tile for each of the 1,344 packaged stickers, so the grid lists all 1,595 and asks
 * main for the packaged tiles it draws. The tiles are the curated stickers' own, reused in turn
 * (the grid's cost is decoding and drawing a tile, not which emoji it shows). No full sticker
 * files are written: nothing here adds a packaged sticker.
 */
async function wholePackagedSet(root: string): Promise<string> {
  const catalog = await loadStickerCatalog();
  const bundled = catalog.items.filter((item) => item.availability === 'bundled');
  const packaged = catalog.items.filter((item) => item.availability === 'packaged');
  await mkdir(join(root, 'thumbs'), { recursive: true });
  const items: Record<string, unknown> = {};
  for (const [index, item] of packaged.entries()) {
    const standIn = bundled[index % bundled.length]!;
    const thumb = join(root, 'thumbs', `${item.id}.webp`);
    await copyFile(join(SHIPPED, standIn.thumb!), thumb);
    items[item.id] = {
      file: `full/${item.id}.webp`,
      thumb: `thumbs/${item.id}.webp`,
      sha256: standIn.sha256,
      bytes: standIn.bytes,
      thumbBytes: (await stat(thumb)).size,
      width: standIn.width,
      height: standIn.height,
      sharpSize: standIn.sharpSize,
    };
  }
  await writeFile(join(root, 'LICENSE-fluent-emoji.txt'), 'MIT');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ commit: catalog.commit, items }));
  return root;
}

/** A project with one blue clip, opened in the desktop-mode editor on the Elements tab. */
async function openBudgets(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { readonly wholeLibrary?: boolean } = {},
): Promise<OpenedEditor> {
  const workspace = await Workspace.create(name);
  await workspace.media([video('bg', 'blue', SECONDS)]);
  await workspace.writeProject(
    project({
      id: name.replaceAll('-', '_'),
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
  const packagedStickers =
    options.wholeLibrary === true
      ? await wholePackagedSet(join(workspace.root, 'resources', 'elements', 'stickers'))
      : undefined;
  const editor = await openInDesktop(
    page,
    testInfo,
    {
      workspace,
      sidecarUrl: sidecarUrl(),
      ...(packagedStickers === undefined ? {} : { packagedStickers }),
    },
    NAME,
  );
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  return editor;
}

async function showSubTab(page: Page, name: 'Stickers' | 'Shapes'): Promise<void> {
  await page
    .getByRole('tablist', { name: 'Elements', exact: true })
    .getByRole('tab', { name, exact: true })
    .click();
}

/**
 * Click the Stickers sub-tab inside the page and resolve with the milliseconds until two frames
 * after the first tile's image has decoded: by then a frame showing the picture has been painted,
 * not an empty square waiting for it.
 */
async function timeStickersOpen(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const tab = [
          ...document.querySelectorAll<HTMLElement>(
            '[role="tablist"][aria-label="Elements"] [role="tab"]',
          ),
        ].find((element) => element.textContent?.trim() === 'Stickers');
        if (tab === undefined) {
          reject(new Error('No "Stickers" tab in the Elements panel.'));
          return;
        }
        let found = false;
        let timer = 0;
        let started = 0;
        const check = (): void => {
          if (found) return;
          const image = document.querySelector<HTMLImageElement>(
            '.stickers-grid-tile[data-tile-index="0"] img',
          );
          if (image === null) return;
          found = true;
          observer.disconnect();
          image.decode().then(
            () =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  window.clearTimeout(timer);
                  resolve(performance.now() - started);
                }),
              ),
            (error: unknown) => {
              window.clearTimeout(timer);
              reject(new Error(`The first sticker tile's image did not decode: ${String(error)}`));
            },
          );
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true });
        timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error('The first sticker tile showed no picture within five seconds.'));
        }, 5_000);
        started = performance.now();
        tab.click();
        check();
      }),
  );
}

/**
 * Click the element `tile` (a CSS selector) inside the page and resolve with the milliseconds
 * until the frame after a clip that was not on the timeline before appears there.
 */
async function timeClickToClip(page: Page, tile: string): Promise<number> {
  return page.evaluate(
    (tile) =>
      new Promise<number>((resolve, reject) => {
        const target = document.querySelector<HTMLElement>(tile);
        if (target === null) {
          reject(new Error(`Nothing matches ${tile}.`));
          return;
        }
        const clipLabels = (): (string | null)[] =>
          [...document.querySelectorAll('button.clip-block')].map((block) =>
            block.getAttribute('aria-label'),
          );
        const before = new Set(clipLabels());
        let timer = 0;
        let started = 0;
        const observer = new MutationObserver(() => {
          if (clipLabels().every((label) => before.has(label))) return;
          observer.disconnect();
          window.clearTimeout(timer);
          requestAnimationFrame(() => resolve(performance.now() - started));
        });
        observer.observe(document.body, { childList: true, subtree: true });
        timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error(`${tile} put no clip on the timeline within ten seconds.`));
        }, 10_000);
        started = performance.now();
        target.click();
      }),
    tile,
  );
}

/** What the sticker grid shows for a search: its first tile and how many stickers match. */
interface GridResult {
  readonly first: string;
  readonly total: number;
}

/**
 * Put `value` in the sticker search as a keystroke does (the value, then one `input` event) and
 * resolve with the milliseconds until the frame after the grid shows `expected`.
 */
async function timeSearch(page: Page, value: string, expected: GridResult): Promise<number> {
  return page.evaluate(
    ({ value, expected }) =>
      new Promise<number>((resolve, reject) => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Search stickers"]',
        );
        if (input === null) {
          reject(new Error('No sticker search box.'));
          return;
        }
        const shows = (): boolean => {
          const first = document.querySelector('.stickers-grid-tile[data-tile-index="0"]');
          return (
            first?.getAttribute('aria-label') === `${expected.first}, sticker` &&
            first.closest('li')?.getAttribute('aria-setsize') === String(expected.total)
          );
        };
        if (shows()) {
          reject(new Error(`The grid already shows what "${value}" finds; nothing to time.`));
          return;
        }
        let timer = 0;
        let started = 0;
        const observer = new MutationObserver(() => {
          if (!shows()) return;
          observer.disconnect();
          window.clearTimeout(timer);
          requestAnimationFrame(() => resolve(performance.now() - started));
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-label', 'aria-setsize'],
        });
        timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Typing "${value}" did not update the grid within five seconds.`));
        }, 5_000);
        // The native setter: React's own `value` tracker must see the change as a keystroke's.
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        started = performance.now();
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    { value, expected },
  );
}

/** One scroll of the whole sticker grid, as {@link scrollWholeGrid} saw it. */
interface ScrollReport {
  /** Tiles in the document at each frame, from the top to the bottom. */
  readonly tilesPerFrame: readonly number[];
  readonly reachedBottom: boolean;
  /** Whether the library's last sticker was drawn once the grid reached the bottom. */
  readonly lastDrawn: boolean;
  readonly frameIntervals: readonly number[];
  readonly longTasks: readonly number[];
}

/**
 * Scroll the sticker grid from the top to the bottom, half a view per frame (so every row is on
 * screen for at least one frame), counting the tiles in the document at every frame.
 */
async function scrollWholeGrid(page: Page, lastIndex: number): Promise<ScrollReport> {
  return page.evaluate(
    (lastIndex) =>
      new Promise<ScrollReport>((resolve, reject) => {
        const area = document.querySelector<HTMLElement>('.stickers-scroll');
        if (area === null) {
          reject(new Error('No sticker grid to scroll.'));
          return;
        }
        const step = Math.max(1, Math.floor(area.clientHeight / 2));
        const maxFrames = Math.ceil(area.scrollHeight / step) + 10;
        const tilesPerFrame: number[] = [];
        const frameIntervals: number[] = [];
        const longTasks: number[] = [];
        const tasks = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        tasks.observe({ type: 'longtask' });
        const tiles = (): number => area.querySelectorAll('.stickers-grid-tile').length;
        let previous = 0;
        const finish = (reachedBottom: boolean): void => {
          // One more frame, so the rows the last step revealed are drawn.
          requestAnimationFrame(() => {
            tasks.disconnect();
            tilesPerFrame.push(tiles());
            resolve({
              tilesPerFrame,
              reachedBottom,
              lastDrawn:
                area.querySelector(`.stickers-grid-tile[data-tile-index="${lastIndex}"]`) !== null,
              frameIntervals,
              longTasks,
            });
          });
        };
        const frame = (now: number): void => {
          frameIntervals.push(now - previous);
          previous = now;
          tilesPerFrame.push(tiles());
          if (area.scrollTop + area.clientHeight >= area.scrollHeight - 1) {
            finish(true);
            return;
          }
          if (tilesPerFrame.length > maxFrames) {
            finish(false);
            return;
          }
          area.scrollTop += step;
          requestAnimationFrame(frame);
        };
        area.scrollTop = 0;
        requestAnimationFrame((now) => {
          previous = now;
          requestAnimationFrame(frame);
        });
      }),
    lastIndex,
  );
}

test('Stickers: a warm open draws its first tiles within the budget', async ({
  page,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  opened = await openBudgets(page, testInfo, 'elements-budgets-open');

  // Cold: the first open of the session loads the catalogue; 02 §9 budgets the warm open.
  const cold = await timeStickersOpen(page);
  const warm: number[] = [];
  for (let round = 0; round < WARM_OPENS; round += 1) {
    await showSubTab(page, 'Shapes');
    await expect(page.locator('.shapes-grid-tile').first()).toBeVisible();
    warm.push(await timeStickersOpen(page));
  }
  console.info(
    `[elements budgets] Stickers open to the first tile's picture (decoded + 2 frames): cold ${cold.toFixed(1)} ms (not budgeted), warm median ${median(warm).toFixed(1)} ms of ${listed(warm)} (budget and gate ${FIRST_TILES_BUDGET_MS} ms)`,
  );
  expect(median(warm)).toBeLessThanOrEqual(FIRST_TILES_BUDGET_MS);
  // Only the rows in view: the grid never draws the library to paint its first tiles.
  expect(await page.locator('.stickers-grid-tile').count()).toBeLessThan(MAX_DRAWN_TILES);
});

test('Stickers: a click puts the sticker on the timeline within the budget', async ({
  page,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  opened = await openBudgets(page, testInfo, 'elements-budgets-sticker-click');
  const { desktop } = opened;
  await showSubTab(page, 'Stickers');
  const search = page.getByRole('searchbox', { name: 'Search stickers', exact: true });

  const clicks: number[] = [];
  for (const name of STICKERS) {
    // Found as a person finds one, by search; only the click is timed.
    await search.fill(name.toLowerCase());
    const tile = page.getByRole('button', { name: `${name}, sticker`, exact: true });
    await expect(tile).toBeEnabled();
    clicks.push(
      await timeClickToClip(page, `button.stickers-grid-tile[aria-label="${name}, sticker"]`),
    );
    // The copy is done and the tile idle again before the next pick.
    await expect(page.locator('.stickers-grid-cell[data-state="adding"]')).toHaveCount(0);
  }

  const gate = STICKER_CLICK_BUDGET_MS * UNPROVEN_GATE_FACTOR;
  console.info(
    `[elements budgets] sticker click → clip on the timeline: median ${median(clicks).toFixed(1)} ms of ${listed(clicks)} (budget ${STICKER_CLICK_BUDGET_MS} ms, gate ${gate} ms until headroom is known)`,
  );
  // Every timed click copied a file into the project: none found it already there.
  const copies = desktop.results
    .filter((entry) => entry.method === 'elementsMaterialize')
    .map((entry) => entry.result as { ok: boolean; asset?: { deduped: boolean } });
  expect(copies.map((copy) => copy.ok && copy.asset?.deduped === false)).toEqual(
    STICKERS.map(() => true),
  );
  await savedProject(
    desktop,
    (document) => stickersOf(document).length === STICKERS.length,
    `${STICKERS.length} stickers`,
  );
  expect(median(clicks)).toBeLessThanOrEqual(gate);
});

test('Shapes: a click puts the shape on the timeline within the budget', async ({
  page,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  opened = await openBudgets(page, testInfo, 'elements-budgets-shape-click');
  const { desktop } = opened;
  await showSubTab(page, 'Shapes');
  await expect(page.locator('.shapes-grid-tile').nth(SHAPE_CLICKS - 1)).toBeVisible();

  const clicks: number[] = [];
  for (let index = 0; index < SHAPE_CLICKS; index += 1) {
    clicks.push(
      await timeClickToClip(page, `.shapes-grid > li:nth-child(${index + 1}) .shapes-grid-tile`),
    );
  }

  const gate = SHAPE_CLICK_BUDGET_MS * UNPROVEN_GATE_FACTOR;
  console.info(
    `[elements budgets] shape click → clip on the timeline: median ${median(clicks).toFixed(1)} ms of ${listed(clicks)} (budget ${SHAPE_CLICK_BUDGET_MS} ms, gate ${gate} ms until headroom is known)`,
  );
  // Five different tiles made five different shapes.
  const saved = await savedProject(
    desktop,
    (document) => shapesOf(document).length === SHAPE_CLICKS,
    `${SHAPE_CLICKS} shapes`,
  );
  const looks = shapesOf(saved).map((entry) =>
    JSON.stringify(entry.effects.find((effect) => effect.type === 'shape')?.params),
  );
  expect(new Set(looks).size).toBe(SHAPE_CLICKS);
  expect(median(clicks)).toBeLessThanOrEqual(gate);
});

test('Stickers: over the whole library, a keystroke redraws the grid within the budget and a full scroll stays bounded', async ({
  page,
}, testInfo) => {
  test.setTimeout(4 * 60_000);
  const catalog = await loadStickerCatalog();
  const packagedCount = catalog.items.filter((item) => item.availability === 'packaged').length;
  opened = await openBudgets(page, testInfo, 'elements-budgets-library', { wholeLibrary: true });
  const { desktop } = opened;
  await showSubTab(page, 'Stickers');
  // The packaged set is found: the grid lists the whole library.
  await expect(page.getByText(`${catalog.items.length} stickers`, { exact: true })).toBeAttached();

  // --- search: each keystroke, then the search cleared, timed to the grid's redraw -------------
  const resultOf = (value: string): GridResult => {
    const found = searchStickers(catalog, value, { includePackaged: true });
    return { first: found.items[0]!.name, total: found.total };
  };
  // Characters, not UTF-16 units: the glyph is one keystroke.
  const prefixes = (word: string): string[] => {
    const characters = Array.from(word);
    return characters.map((_, index) => characters.slice(0, index + 1).join(''));
  };
  const keystrokes = SEARCH_WORDS.flatMap((word) => [...prefixes(word), '']);
  const redraws: number[] = [];
  let showing = resultOf('');
  for (const value of keystrokes) {
    const expected = resultOf(value);
    if (expected.first === showing.first && expected.total === showing.total) {
      // The grid would not change, so there is no redraw to time: typed, and not counted.
      await page.getByRole('searchbox', { name: 'Search stickers', exact: true }).fill(value);
      continue;
    }
    redraws.push(await timeSearch(page, value, expected));
    showing = expected;
  }
  const searchGate = SEARCH_BUDGET_MS * UNPROVEN_GATE_FACTOR;
  console.info(
    `[elements budgets] search keystroke → grid redrawn (${catalog.items.length} stickers): median ${median(redraws).toFixed(1)} ms, p95 ${percentile(redraws, 0.95).toFixed(1)} ms, max ${Math.max(...redraws).toFixed(1)} ms over ${redraws.length} keystrokes (budget ${SEARCH_BUDGET_MS} ms, gate ${searchGate} ms on the median until headroom is known): ${listed(redraws)}`,
  );
  expect(redraws.length).toBeGreaterThanOrEqual(SEARCH_WORDS.length * 2);
  expect(median(redraws)).toBeLessThanOrEqual(searchGate);

  // --- scroll: the whole library, top to bottom, one step per frame ----------------------------
  const lastIndex = catalog.items.length - 1;
  const last = searchStickers(catalog, '', { includePackaged: true }).items[lastIndex]!;
  expect(last.availability, 'the grid ends on a packaged sticker, whose tile main sends').toBe(
    'packaged',
  );
  const scroll = await scrollWholeGrid(page, lastIndex);
  expect(scroll.reachedBottom, 'the scroll reached the bottom of the grid').toBe(true);
  expect(scroll.lastDrawn, `the last sticker (${last.name}) was drawn`).toBe(true);
  // The last tile's picture has arrived from main, so every request the scroll made is logged.
  await expect(
    page.locator(`.stickers-grid-tile[data-tile-index="${lastIndex}"] img`),
  ).toHaveAttribute('src', /^blob:/);
  const asked = desktop.calls
    .filter((call) => call.method === 'elementsThumbnail')
    .map((call) => (call.args[0] as { elementIds: readonly string[] }).elementIds)
    .filter((ids) => ids.length > 0);
  const late = scroll.frameIntervals.filter((ms) => ms > LATE_FRAME_MS);
  console.info(
    `[elements budgets] full sticker scroll: ${scroll.tilesPerFrame.length} frames, tiles drawn ${Math.min(...scroll.tilesPerFrame)}-${Math.max(...scroll.tilesPerFrame)}; frame interval p50 ${percentile(scroll.frameIntervals, 0.5).toFixed(1)} ms, p95 ${percentile(scroll.frameIntervals, 0.95).toFixed(1)} ms, ${late.length} over ${LATE_FRAME_MS} ms; long tasks ${scroll.longTasks.length} (max ${Math.max(0, ...scroll.longTasks).toFixed(0)} ms) (logged, not gated: 60 Hz is judged on a real display); thumbnail requests ${asked.length}, ${new Set(asked.flat()).size} of ${packagedCount} packaged tiles, at most ${Math.max(...asked.map((ids) => ids.length))} ids per request`,
  );
  // At every frame of the scroll, a screenful of tiles and never an empty grid or the library.
  expect(Math.max(...scroll.tilesPerFrame)).toBeLessThan(MAX_DRAWN_TILES);
  expect(Math.min(...scroll.tilesPerFrame)).toBeGreaterThan(0);
  // Main refuses a request for more tiles than this (the harness's stand-in would only truncate
  // it), so every request the scroll made must fit.
  expect(asked.length).toBeGreaterThan(0);
  expect(Math.max(...asked.map((ids) => ids.length))).toBeLessThanOrEqual(
    MAX_THUMBNAILS_PER_REQUEST,
  );
});
